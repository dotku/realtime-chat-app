from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy import text
from datetime import datetime, date, timedelta
from typing import Union
import uuid
import json
import logging
import os
import httpx
import stripe
from jose import jwt as jose_jwt, JWTError

from pydantic import BaseModel
from database import init_db, get_db, User, Group, GroupMember, engine
from models import UserCreate, UserResponse, GroupCreate, GroupResponse, Message
from connection_manager import manager

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Real-Time Chat API")

# CORS middleware - read allowed origins from environment variables
_raw_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173")
allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

# Optional regex for wildcard subdomain support, e.g. https://.*\.jytech\.us
cors_origin_regex = os.getenv("CORS_ORIGIN_REGEX", None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Auth0 config ──────────────────────────────────────────────────────────────

AUTH0_DOMAIN = os.getenv("AUTH0_DOMAIN", "")       # e.g. dev-xxx.us.auth0.com
AUTH0_CLIENT_ID = os.getenv("AUTH0_CLIENT_ID", "")

# In-memory JWKS cache (refreshed every hour)
_jwks_cache: dict = {"keys": None, "fetched_at": None}
_JWKS_TTL = 3600


async def _get_jwks() -> list:
    now = datetime.utcnow()
    cached = _jwks_cache
    if (
        cached["keys"] is None
        or cached["fetched_at"] is None
        or (now - cached["fetched_at"]).total_seconds() > _JWKS_TTL
    ):
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"https://{AUTH0_DOMAIN}/.well-known/jwks.json", timeout=10)
            resp.raise_for_status()
            _jwks_cache["keys"] = resp.json()["keys"]
            _jwks_cache["fetched_at"] = now
    return _jwks_cache["keys"]


async def verify_id_token(token: str) -> dict:
    """Verify an Auth0 ID token (RS256) and return its claims."""
    if not AUTH0_DOMAIN or not AUTH0_CLIENT_ID:
        raise HTTPException(status_code=503, detail="Auth0 is not configured on the server.")
    try:
        keys = await _get_jwks()
        header = jose_jwt.get_unverified_header(token)
        rsa_key = next(
            (
                {"kty": k["kty"], "kid": k["kid"], "n": k["n"], "e": k["e"]}
                for k in keys
                if k["kid"] == header.get("kid")
            ),
            None,
        )
        if not rsa_key:
            raise HTTPException(status_code=401, detail="No matching signing key in Auth0 JWKS.")
        payload = jose_jwt.decode(
            token,
            rsa_key,
            algorithms=["RS256"],
            audience=AUTH0_CLIENT_ID,
            issuer=f"https://{AUTH0_DOMAIN}/",
        )
        return payload
    except JWTError as e:
        raise HTTPException(status_code=401, detail=f"Token validation failed: {e}")
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Auth0 token verification error: {e}")
        raise HTTPException(status_code=401, detail="Token verification failed.")


@app.on_event("startup")
async def startup_event():
    try:
        init_db()
        # Safely add columns that may be missing from existing tables
        with engine.connect() as conn:
            conn.execute(text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_member BOOLEAN DEFAULT FALSE"
            ))
            conn.execute(text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS auth0_sub VARCHAR"
            ))
            # Add unique index on auth0_sub if it doesn't exist yet
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_auth0_sub ON users (auth0_sub) WHERE auth0_sub IS NOT NULL"
            ))
            conn.execute(text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS credits_cents INTEGER DEFAULT 100"
            ))
            conn.commit()
        logging.info("Database initialized successfully")
    except Exception as e:
        logging.error(f"Failed to initialize database: {e}")
        logging.warning("Application will run without database persistence")


@app.get("/ping")
async def ping():
    """Lightweight liveness probe for Koyeb health check — no DB dependency."""
    return {"status": "ok"}


@app.get("/")
async def root():
    return {"message": "Real-Time Chat API", "status": "running"}


@app.get("/health")
async def health_check(db: Session = Depends(get_db)):
    db_status = "connected"
    try:
        db.execute(text("SELECT 1"))
    except Exception as e:
        db_status = f"disconnected: {str(e)}"
        logging.error(f"Database health check failed: {e}")

    return {
        "status": "healthy",
        "database": db_status,
        "active_connections": len(manager.active_connections)
    }


@app.post("/users", response_model=UserResponse)
async def create_user(user: UserCreate, db: Session = Depends(get_db)):
    """Create a new user with auto-generated UUID"""
    user_id = str(uuid.uuid4())

    try:
        db_user = User(
            user_id=user_id,
            username=user.username,
            is_online=True,
            connected_at=datetime.utcnow()
        )
        db.add(db_user)
        db.commit()
        db.refresh(db_user)
        return db_user
    except (OperationalError, SQLAlchemyError) as e:
        logging.error(f"Database error creating user: {e}")
        raise HTTPException(
            status_code=503,
            detail="Database unavailable. Please try again later."
        )


@app.get("/users/online", response_model=list[UserResponse])
async def get_online_users(db: Session = Depends(get_db)):
    """Get all currently online users"""
    try:
        users = db.query(User).filter(User.is_online == True).all()
        return users
    except (OperationalError, SQLAlchemyError) as e:
        logging.error(f"Database error fetching online users: {e}")
        raise HTTPException(
            status_code=503,
            detail="Database unavailable. Please try again later."
        )


@app.websocket("/ws/{user_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    db: Session = Depends(get_db)
):
    # Get user from database first (before accepting WebSocket)
    user = None
    try:
        user = db.query(User).filter(User.user_id == user_id).first()
        if not user:
            logging.warning(f"User {user_id} not found in database")
            # Accept, send error, and close gracefully
            try:
                await websocket.accept()
                await websocket.send_json({
                    "type": "error",
                    "code": 4004,
                    "message": "User not found. Please reconnect."
                })
                await websocket.close(code=4004, reason="User not found")
            except Exception as close_error:
                logging.error(f"Error closing websocket for user not found: {close_error}")
            return
    except (OperationalError, SQLAlchemyError) as e:
        logging.error(f"Database error in WebSocket connection: {e}")
        # Accept, send error, and close gracefully
        try:
            await websocket.accept()
            await websocket.send_json({
                "type": "error",
                "code": 1011,
                "message": "Database unavailable"
            })
            await websocket.close(code=1011, reason="Database unavailable")
        except Exception as close_error:
            logging.error(f"Error closing websocket for DB error: {close_error}")
        return

    # Connect the user (this will accept the WebSocket and register the connection)
    await manager.connect(websocket, user_id, user.username)

    # Update user status in database
    try:
        user.is_online = True
        user.last_seen = datetime.utcnow()
        db.commit()
    except (OperationalError, SQLAlchemyError) as e:
        logging.error(f"Database error updating user status: {e}")
        # Continue anyway - user can still chat even if DB is down

    # Notify other users that this user joined
    await manager.notify_user_joined(user_id, user.username)

    # Send current online users list to the newly connected user
    online_users = manager.get_online_users()
    await manager.send_personal_message(
        {
            "type": "online_users",
            "users": online_users
        },
        user_id
    )

    # Also broadcast updated online users list to all other users
    await manager.broadcast(
        {
            "type": "online_users",
            "users": online_users
        }
    )

    # Send user's groups
    try:
        memberships = db.query(GroupMember).filter(GroupMember.user_id == user_id).all()
        group_ids = [m.group_id for m in memberships]
        if group_ids:
            groups = db.query(Group).filter(Group.group_id.in_(group_ids)).all()
            groups_data = []
            for g in groups:
                members = db.query(GroupMember).filter(GroupMember.group_id == g.group_id).all()
                groups_data.append({
                    "group_id": g.group_id,
                    "name": g.name,
                    "icon": g.icon,
                    "created_by": g.created_by,
                    "members": [m.user_id for m in members],
                })
            await manager.send_personal_message(
                {"type": "user_groups", "groups": groups_data}, user_id
            )
    except Exception as e:
        logging.error(f"Error loading groups for {user_id}: {e}")

    try:
        while True:
            # Receive message from client
            data = await websocket.receive_text()
            message_data = json.loads(data)

            # Handle chat messages
            if message_data.get("type") == "chat":
                to_user = message_data.get("to_user")
                content = message_data.get("content", "")
                attachment = message_data.get("attachment")  # optional file attachment
                logging.info(f"Received chat message to {to_user}, has_attachment={attachment is not None}")

                if to_user and to_user.startswith("group:"):
                    # Group message — fan out to all members
                    try:
                        members = db.query(GroupMember).filter(
                            GroupMember.group_id == to_user
                        ).all()
                        member_ids = [m.user_id for m in members]
                        if user_id in member_ids:
                            await manager.send_group_message(
                                user_id, to_user, member_ids, content, attachment
                            )
                        else:
                            logging.warning(f"User {user_id} not a member of {to_user}")
                    except Exception as e:
                        logging.error(f"Error sending group message: {e}")
                elif to_user and (content or attachment):
                    await manager.send_chat_message(user_id, to_user, content, attachment)
                else:
                    logging.warning(f"Invalid chat message: missing to_user or content/attachment")

    except WebSocketDisconnect:
        # Handle disconnection
        manager.disconnect(user_id)

        # Update user status in database
        try:
            user.is_online = False
            user.last_seen = datetime.utcnow()
            db.commit()
        except (OperationalError, SQLAlchemyError) as e:
            logging.error(f"Database error updating disconnect status: {e}")
            # Continue to notify users even if DB update fails

        # Notify other users
        await manager.notify_user_left(user_id)

        # Broadcast updated online users list
        online_users = manager.get_online_users()
        await manager.broadcast(
            {
                "type": "online_users",
                "users": online_users
            }
        )
    except Exception as e:
        logging.error(f"Error in websocket connection: {e}")
        manager.disconnect(user_id)
        # Only update DB if user exists
        if 'user' in locals():
            try:
                user.is_online = False
                db.commit()
            except Exception as db_error:
                logging.error(f"Database error in exception handler: {db_error}")


GATEWAY_URL = "https://ai-gateway.vercel.sh/v1"
DAILY_AI_LIMIT_USD = 10.0
# Conservative average cost per token across all supported models (~$3/M)
_AVG_COST_PER_TOKEN = 0.000003
# We charge users 5× the provider cost; result in cents per token
_USER_COST_RATE_CENTS = _AVG_COST_PER_TOKEN * 5 * 100  # = 0.0015 cents/token

ANON_CREDIT_CENTS = 100    # $1.00 — anonymous users
NEW_USER_CREDIT_CENTS = 500  # $5.00 — new registered users


def _calc_user_cost_cents(total_tokens: int) -> int:
    """Cost charged to the user in cents (minimum 1 cent per request)."""
    return max(1, round(total_tokens * _USER_COST_RATE_CENTS))

# In-memory daily usage tracker — resets naturally each new day
_daily_ai_costs: dict[str, float] = {}


def _today() -> str:
    return date.today().isoformat()


def _get_daily_cost() -> float:
    return _daily_ai_costs.get(_today(), 0.0)


def _add_daily_cost(total_tokens: int) -> None:
    key = _today()
    _daily_ai_costs[key] = _daily_ai_costs.get(key, 0.0) + total_tokens * _AVG_COST_PER_TOKEN
    # Prune entries older than 7 days to avoid unbounded growth
    cutoff = (date.today() - timedelta(days=7)).isoformat()
    for k in list(_daily_ai_costs.keys()):
        if k < cutoff:
            del _daily_ai_costs[k]


class AIChatMessage(BaseModel):
    role: str  # "user" | "assistant" | "system"
    content: Union[str, list]  # str for text, list for multimodal (images)


class AIChatRequest(BaseModel):
    model: str
    messages: list[AIChatMessage]
    system_prompt: str = ""
    user_id: str = ""  # used to check membership status


@app.post("/ai/chat")
async def ai_chat(req: AIChatRequest, db: Session = Depends(get_db)):
    """Proxy AI chat to Vercel AI Gateway."""
    is_member = False
    user = None
    if req.user_id:
        try:
            user = db.query(User).filter(User.user_id == req.user_id).first()
            is_member = bool(getattr(user, "is_member", False))
        except Exception:
            pass

    if not is_member:
        # Platform-wide safety net
        if _get_daily_cost() >= DAILY_AI_LIMIT_USD:
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "DAILY_LIMIT_EXCEEDED",
                    "message": f"Platform AI credit limit of ${DAILY_AI_LIMIT_USD:.0f}/day has been reached.",
                    "limit_usd": DAILY_AI_LIMIT_USD,
                    "used_usd": round(_get_daily_cost(), 4),
                },
            )
        # Per-user credit check
        if user is not None:
            credits = getattr(user, "credits_cents", 0) or 0
            if credits <= 0:
                is_anonymous = not bool(getattr(user, "auth0_sub", None))
                raise HTTPException(
                    status_code=402,
                    detail={
                        "code": "NO_CREDITS",
                        "is_anonymous": is_anonymous,
                        "message": (
                            "Sign in to get $5 in free AI credits."
                            if is_anonymous
                            else "You've used all your AI credits. Buy more to continue."
                        ),
                        "credits_cents": 0,
                    },
                )

    api_key = os.getenv("GATEWAY_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="AI Gateway API key not configured on server.")

    messages = []
    if req.system_prompt:
        messages.append({"role": "system", "content": req.system_prompt})
    messages.extend([{"role": m.role, "content": m.content} for m in req.messages])

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{GATEWAY_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={"model": req.model, "messages": messages},
            )
            if response.status_code != 200:
                logging.error(f"Gateway error {response.status_code}: {response.text}")
                raise HTTPException(status_code=502, detail=f"Gateway returned {response.status_code}")
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            usage = data.get("usage", {})
            total_tokens = usage.get("total_tokens", 200)
            _add_daily_cost(total_tokens)

            # Deduct per-user credits (members are exempt)
            credits_remaining = None
            if not is_member and user is not None:
                cost = _calc_user_cost_cents(total_tokens)
                try:
                    user.credits_cents = max(0, (getattr(user, "credits_cents", 0) or 0) - cost)
                    db.commit()
                    credits_remaining = user.credits_cents
                except Exception as e:
                    logging.error(f"Credits deduction error: {e}")

            return {"content": content, "credits_cents": credits_remaining}
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="AI request timed out.")
    except httpx.RequestError as e:
        logging.error(f"AI gateway request error: {e}")
        raise HTTPException(status_code=502, detail="Failed to reach AI gateway.")


# ── Auth0 login ───────────────────────────────────────────────────────────────

class AuthLoginRequest(BaseModel):
    token: str           # raw Auth0 ID token (JWT)
    username: str = ""   # display name from Auth0 profile


@app.post("/auth/login")
async def auth_login(req: AuthLoginRequest, db: Session = Depends(get_db)):
    """Exchange an Auth0 ID token for a chat user_id. Creates the user on first login."""
    payload = await verify_id_token(req.token)
    sub = payload.get("sub")  # e.g. "auth0|abc123" or "google-oauth2|123"
    if not sub:
        raise HTTPException(status_code=401, detail="Token missing 'sub' claim.")

    # Derive display name: prefer explicit param, then Auth0 profile fields
    display_name = (
        req.username.strip()
        or payload.get("nickname")
        or payload.get("name")
        or (payload.get("email") or "").split("@")[0]
        or f"user_{uuid.uuid4().hex[:6]}"
    )

    try:
        # Find existing user by auth0_sub
        user = db.query(User).filter(User.auth0_sub == sub).first()
        if user:
            # Update username in case it changed in Auth0
            if req.username.strip() and user.username != display_name:
                user.username = display_name
                db.commit()
        else:
            user = User(
                user_id=str(uuid.uuid4()),
                username=display_name,
                auth0_sub=sub,
                is_online=True,
                connected_at=datetime.utcnow(),
                credits_cents=NEW_USER_CREDIT_CENTS,  # $5.00 for new registered users
            )
            db.add(user)
            db.commit()
            db.refresh(user)
        return {
            "user_id": user.user_id,
            "username": user.username,
            "is_member": user.is_member,
            "credits_cents": user.credits_cents or 0,
            "is_anonymous": False,
        }
    except (OperationalError, SQLAlchemyError) as e:
        logging.error(f"DB error in auth_login: {e}")
        raise HTTPException(status_code=503, detail="Database unavailable.")


# ── Groups ────────────────────────────────────────────────────────────────────

@app.post("/groups")
async def create_group(group: GroupCreate, db: Session = Depends(get_db)):
    """Create a new group. The creator is automatically a member."""
    group_id = f"group:{uuid.uuid4()}"
    try:
        db_group = Group(
            group_id=group_id,
            name=group.name,
            icon=group.icon,
            created_by=group.created_by,
        )
        db.add(db_group)

        # Add creator + initial members
        all_member_ids = list(dict.fromkeys([group.created_by] + group.member_ids))
        for mid in all_member_ids:
            db.add(GroupMember(group_id=group_id, user_id=mid))
        db.commit()

        # Notify all online members about the new group
        group_data = {
            "group_id": group_id,
            "name": group.name,
            "icon": group.icon,
            "created_by": group.created_by,
            "members": all_member_ids,
        }
        for mid in all_member_ids:
            await manager.send_personal_message(
                {"type": "group_created", "group": group_data}, mid
            )

        return group_data
    except (OperationalError, SQLAlchemyError) as e:
        logging.error(f"DB error creating group: {e}")
        raise HTTPException(status_code=503, detail="Database unavailable.")


@app.get("/groups/{user_id}")
async def get_user_groups(user_id: str, db: Session = Depends(get_db)):
    """Get all groups a user belongs to."""
    try:
        memberships = db.query(GroupMember).filter(GroupMember.user_id == user_id).all()
        group_ids = [m.group_id for m in memberships]
        if not group_ids:
            return []
        groups = db.query(Group).filter(Group.group_id.in_(group_ids)).all()
        result = []
        for g in groups:
            members = db.query(GroupMember).filter(GroupMember.group_id == g.group_id).all()
            result.append({
                "group_id": g.group_id,
                "name": g.name,
                "icon": g.icon,
                "created_by": g.created_by,
                "members": [m.user_id for m in members],
            })
        return result
    except Exception as e:
        logging.error(f"Error fetching groups: {e}")
        raise HTTPException(status_code=503, detail="Database unavailable.")


class AddMemberRequest(BaseModel):
    user_id: str


@app.post("/groups/{group_id}/members")
async def add_group_member(group_id: str, req: AddMemberRequest, db: Session = Depends(get_db)):
    """Add a member to an existing group."""
    try:
        group = db.query(Group).filter(Group.group_id == group_id).first()
        if not group:
            raise HTTPException(status_code=404, detail="Group not found")

        existing = db.query(GroupMember).filter(
            GroupMember.group_id == group_id, GroupMember.user_id == req.user_id
        ).first()
        if existing:
            raise HTTPException(status_code=409, detail="Already a member")

        db.add(GroupMember(group_id=group_id, user_id=req.user_id))
        db.commit()

        # Build updated group data
        members = db.query(GroupMember).filter(GroupMember.group_id == group_id).all()
        group_data = {
            "group_id": group_id,
            "name": group.name,
            "icon": group.icon,
            "created_by": group.created_by,
            "members": [m.user_id for m in members],
        }

        # Notify all members (including the new one)
        for m in members:
            await manager.send_personal_message(
                {"type": "group_updated", "group": group_data}, m.user_id
            )

        return group_data
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Error adding member to group: {e}")
        raise HTTPException(status_code=503, detail="Database unavailable.")


# ── Stripe membership ─────────────────────────────────────────────────────────

@app.get("/user/{user_id}/credits")
async def get_user_credits(user_id: str, db: Session = Depends(get_db)):
    """Return a user's current credit balance and account type."""
    try:
        user = db.query(User).filter(User.user_id == user_id).first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        return {
            "credits_cents": getattr(user, "credits_cents", 0) or 0,
            "is_member": bool(user.is_member),
            "is_anonymous": not bool(user.auth0_sub),
        }
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Error fetching credits: {e}")
        raise HTTPException(status_code=503, detail="Database unavailable")


class BuyCreditsRequest(BaseModel):
    user_id: str
    amount_dollars: int = 5  # minimum purchase $5


@app.post("/stripe/buy-credits")
async def buy_credits(req: BuyCreditsRequest, request: Request):
    """Create a Stripe one-time Checkout session to top up AI credits."""
    stripe_key = os.getenv("STRIPE_SECRET_KEY", "")
    if not stripe_key:
        raise HTTPException(status_code=503, detail="Payment not configured on server.")

    stripe.api_key = stripe_key
    origin = request.headers.get("origin", "https://chat.jytech.us")
    amount_dollars = max(5, min(200, req.amount_dollars))
    amount_stripe_cents = amount_dollars * 100  # Stripe uses cents

    try:
        session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": f"SphareChat AI Credits (${amount_dollars})"},
                    "unit_amount": amount_stripe_cents,
                },
                "quantity": 1,
            }],
            mode="payment",
            metadata={"user_id": req.user_id, "credit_cents": str(amount_stripe_cents)},
            success_url=f"{origin}?credits=success",
            cancel_url=f"{origin}?credits=cancelled",
        )
        return {"checkout_url": session.url}
    except stripe.StripeError as e:
        logging.error(f"Stripe buy-credits error: {e}")
        raise HTTPException(status_code=502, detail="Payment service error.")


@app.post("/stripe/checkout")
async def create_checkout(request: Request):
    """Create a Stripe Checkout session for membership upgrade."""
    stripe_key = os.getenv("STRIPE_SECRET_KEY", "")
    price_id = os.getenv("STRIPE_PRICE_ID", "")
    if not stripe_key or not price_id:
        raise HTTPException(status_code=503, detail="Payment not configured on server.")

    stripe.api_key = stripe_key
    body = await request.json()
    user_id = body.get("user_id", "")
    origin = request.headers.get("origin", "https://chat.jytech.us")

    try:
        session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            line_items=[{"price": price_id, "quantity": 1}],
            mode="subscription",
            metadata={"user_id": user_id},
            success_url=f"{origin}?membership=success",
            cancel_url=f"{origin}?membership=cancelled",
        )
        return {"checkout_url": session.url}
    except stripe.StripeError as e:
        logging.error(f"Stripe error: {e}")
        raise HTTPException(status_code=502, detail="Payment service error.")


@app.post("/stripe/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    """Handle Stripe webhook events (e.g. successful payment → grant membership)."""
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    webhook_secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")

    try:
        event = stripe.Webhook.construct_event(payload, sig, webhook_secret)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid payload")
    except stripe.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="Invalid signature")

    if event["type"] == "checkout.session.completed":
        session_obj = event["data"]["object"]
        # Verify payment actually succeeded
        if session_obj.get("payment_status") != "paid":
            logging.warning(f"Checkout completed but payment_status={session_obj.get('payment_status')}")
            return {"received": True}

        meta = session_obj.get("metadata") or {}
        user_id = meta.get("user_id")
        credit_cents_str = meta.get("credit_cents")
        stripe_session_id = session_obj.get("id", "")

        if user_id:
            try:
                user = db.query(User).filter(User.user_id == user_id).first()
                if user:
                    if credit_cents_str:
                        add = int(credit_cents_str)
                        user.credits_cents = (getattr(user, "credits_cents", 0) or 0) + add
                        logging.info(f"Added {add} credit cents to user {user_id} (session {stripe_session_id})")
                    else:
                        user.is_member = True
                        logging.info(f"Membership granted to user {user_id} (session {stripe_session_id})")
                    db.commit()
            except Exception as e:
                logging.error(f"DB error processing payment for {user_id}: {e}")

    return {"received": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

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

from pydantic import BaseModel, Field
from typing import Optional
from database import init_db, get_db, User, Group, GroupMember, ChatMessage, make_conversation_id, engine
from models import UserCreate, UserResponse, GroupCreate, GroupResponse, Message
from connection_manager import manager
from rate_limiter import limiter, rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from middleware import SecurityHeadersMiddleware, RequestSizeLimitMiddleware

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Real-Time Chat API")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

# CORS middleware - read allowed origins from environment variables
_raw_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173")
allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

# Optional regex for wildcard subdomain support, e.g. https://.*\.jytech\.us
cors_origin_regex = os.getenv("CORS_ORIGIN_REGEX", None)

app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RequestSizeLimitMiddleware, max_bytes=10 * 1024 * 1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=cors_origin_regex,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "Stripe-Signature"],
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
            # Membership tier columns
            conn.execute(text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_tier VARCHAR DEFAULT 'free'"
            ))
            conn.execute(text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_billing VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS membership_expires_at TIMESTAMP"
            ))
            conn.execute(text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_users_stripe_customer ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL"
            ))
            conn.execute(text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_ai_usage_cents INTEGER DEFAULT 0"
            ))
            conn.execute(text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_ai_usage_date VARCHAR"
            ))
            # Backfill: existing is_member=true users become 'pro'
            conn.execute(text(
                "UPDATE users SET membership_tier = 'pro' WHERE is_member = TRUE AND (membership_tier IS NULL OR membership_tier = 'free')"
            ))
            # Ensure messages table and indexes exist
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS messages (
                    id SERIAL PRIMARY KEY,
                    message_id VARCHAR NOT NULL UNIQUE,
                    conversation_id VARCHAR NOT NULL,
                    from_user VARCHAR NOT NULL,
                    from_username VARCHAR NOT NULL,
                    to_user VARCHAR NOT NULL,
                    group_id VARCHAR,
                    content TEXT NOT NULL DEFAULT '',
                    timestamp TIMESTAMP NOT NULL,
                    has_attachment BOOLEAN DEFAULT FALSE,
                    attachment_type VARCHAR,
                    attachment_name VARCHAR,
                    attachment_size INTEGER,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_messages_conversation_ts ON messages (conversation_id, timestamp DESC)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_messages_to_user_ts ON messages (to_user, timestamp)"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_messages_message_id ON messages (message_id)"
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
@limiter.limit("10/minute")
async def create_user(request: Request, user: UserCreate, db: Session = Depends(get_db)):
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


def persist_message(db: Session, message: dict):
    """Save a chat message to the database. Non-blocking — logs errors but doesn't raise."""
    try:
        attachment = message.get("attachment")
        attachment_size = len(attachment["data"]) if attachment and attachment.get("data") else None
        db_msg = ChatMessage(
            message_id=message["message_id"],
            conversation_id=make_conversation_id(
                message["from_user"], message["to_user"], message.get("group_id")
            ),
            from_user=message["from_user"],
            from_username=message["from_username"],
            to_user=message["to_user"],
            group_id=message.get("group_id"),
            content=message.get("content", ""),
            timestamp=datetime.fromisoformat(message["timestamp"]),
            has_attachment=bool(attachment),
            attachment_type=attachment.get("type") if attachment else None,
            attachment_name=attachment.get("name") if attachment else None,
            attachment_size=attachment_size,
        )
        db.add(db_msg)
        db.commit()
    except Exception as e:
        db.rollback()
        logging.error(f"Failed to persist message {message.get('message_id')}: {e}")


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

    # Check per-IP connection limit
    client_ip = websocket.client.host if websocket.client else ""
    if not manager.check_ip_limit(client_ip):
        try:
            await websocket.accept()
            await websocket.send_json({
                "type": "error", "code": 4029,
                "message": "Too many connections from your IP."
            })
            await websocket.close(code=4029, reason="Too many connections")
        except Exception:
            pass
        return

    # Connect the user (this will accept the WebSocket and register the connection)
    await manager.connect(websocket, user_id, user.username, client_ip=client_ip)

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

    # WebSocket message rate limiting: 30 msgs/min per user
    _ws_msg_timestamps: list[float] = []
    _WS_RATE_LIMIT = 30
    _WS_RATE_WINDOW = 60.0  # seconds

    try:
        while True:
            # Receive message from client
            data = await websocket.receive_text()

            # Validate message size (50 KB max)
            if len(data) > 50 * 1024:
                await manager.send_personal_message(
                    {"type": "error", "message": "Message too large (max 50KB)."}, user_id
                )
                continue

            message_data = json.loads(data)

            # Rate limit check
            import time as _time
            now = _time.time()
            _ws_msg_timestamps[:] = [t for t in _ws_msg_timestamps if now - t < _WS_RATE_WINDOW]
            if len(_ws_msg_timestamps) >= _WS_RATE_LIMIT:
                await manager.send_personal_message(
                    {"type": "error", "message": "Rate limit exceeded. Please slow down."}, user_id
                )
                continue
            _ws_msg_timestamps.append(now)

            # Handle chat messages
            if message_data.get("type") == "chat":
                to_user = message_data.get("to_user")
                content = message_data.get("content", "")
                attachment = message_data.get("attachment")  # optional file attachment

                # Validate content length per tier
                ws_tier = _get_effective_tier(user)
                max_chars = TIER_CONFIG[ws_tier]['max_chars']
                if content and len(content) > max_chars:
                    await manager.send_personal_message(
                        {"type": "error", "message": f"Message too long (max {max_chars:,} chars for {ws_tier} tier)."}, user_id
                    )
                    continue

                # Validate attachment size (max 5 MB base64)
                if attachment and attachment.get("data") and len(attachment["data"]) > 5 * 1024 * 1024:
                    await manager.send_personal_message(
                        {"type": "error", "message": "Attachment too large (max 5MB)."}, user_id
                    )
                    continue

                message_id = str(uuid.uuid4())
                logging.info(f"Received chat message to {to_user}, has_attachment={attachment is not None}")

                if to_user and to_user.startswith("group:"):
                    # Group message — fan out to all members
                    try:
                        members = db.query(GroupMember).filter(
                            GroupMember.group_id == to_user
                        ).all()
                        member_ids = [m.user_id for m in members]
                        if user_id in member_ids:
                            msg = await manager.send_group_message(
                                user_id, to_user, member_ids, content, attachment,
                                message_id=message_id
                            )
                            persist_message(db, msg)
                        else:
                            logging.warning(f"User {user_id} not a member of {to_user}")
                    except Exception as e:
                        logging.error(f"Error sending group message: {e}")
                elif to_user and (content or attachment):
                    msg = await manager.send_chat_message(
                        user_id, to_user, content, attachment, message_id=message_id
                    )
                    persist_message(db, msg)
                else:
                    logging.warning(f"Invalid chat message: missing to_user or content/attachment")

            # Handle sync request — deliver missed messages from DB
            elif message_data.get("type") == "sync":
                last_timestamp = message_data.get("last_timestamp")
                try:
                    query = db.query(ChatMessage).filter(
                        ChatMessage.to_user == user_id,
                    )
                    if last_timestamp:
                        query = query.filter(
                            ChatMessage.timestamp > datetime.fromisoformat(last_timestamp)
                        )
                    else:
                        # New device — send last 50 messages
                        query = query.order_by(ChatMessage.timestamp.desc()).limit(50)
                        results = query.all()
                        results.reverse()
                        for msg in results:
                            await manager.send_personal_message({
                                "type": "chat",
                                "message_id": msg.message_id,
                                "from_user": msg.from_user,
                                "from_username": msg.from_username,
                                "to_user": msg.to_user,
                                "group_id": msg.group_id,
                                "content": msg.content,
                                "timestamp": msg.timestamp.isoformat(),
                                "has_attachment": msg.has_attachment,
                                "attachment_type": msg.attachment_type,
                                "attachment_name": msg.attachment_name,
                            }, user_id)
                        continue

                    missed = query.order_by(ChatMessage.timestamp.asc()).limit(200).all()
                    for msg in missed:
                        await manager.send_personal_message({
                            "type": "chat",
                            "message_id": msg.message_id,
                            "from_user": msg.from_user,
                            "from_username": msg.from_username,
                            "to_user": msg.to_user,
                            "group_id": msg.group_id,
                            "content": msg.content,
                            "timestamp": msg.timestamp.isoformat(),
                            "has_attachment": msg.has_attachment,
                            "attachment_type": msg.attachment_type,
                            "attachment_name": msg.attachment_name,
                        }, user_id)
                except Exception as e:
                    logging.error(f"Error syncing messages for {user_id}: {e}")

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

# ── Membership tier configuration ────────────────────────────────────────────
TIER_CONFIG = {
    'free':  {'daily_limit_cents': 0,    'rate_limit': 20, 'max_chars': 10_000},
    'pro':   {'daily_limit_cents': 500,  'rate_limit': 40, 'max_chars': 20_000},
    'team':  {'daily_limit_cents': 2000, 'rate_limit': 60, 'max_chars': 50_000},
}

STRIPE_PRICES = {
    'pro_monthly':  os.getenv('STRIPE_PRICE_PRO_MONTHLY', ''),
    'pro_yearly':   os.getenv('STRIPE_PRICE_PRO_YEARLY', ''),
    'team_monthly': os.getenv('STRIPE_PRICE_TEAM_MONTHLY', ''),
    'team_yearly':  os.getenv('STRIPE_PRICE_TEAM_YEARLY', ''),
}

# Reverse lookup: price_id → (tier, billing)
PRICE_TO_TIER: dict[str, tuple[str, str]] = {}
for _key, _pid in STRIPE_PRICES.items():
    if _pid:
        _tier, _billing = _key.split('_', 1)
        PRICE_TO_TIER[_pid] = (_tier, _billing)


def _get_effective_tier(user) -> str:
    """Return the user's effective tier, checking expiration."""
    tier = getattr(user, 'membership_tier', 'free') or 'free'
    if tier != 'free':
        expires = getattr(user, 'membership_expires_at', None)
        if expires and expires < datetime.utcnow():
            return 'free'
    return tier


def _get_user_daily_usage(user) -> int:
    """Return user's AI usage in cents for today, resetting if date changed."""
    today = _today()
    if getattr(user, 'daily_ai_usage_date', None) != today:
        return 0
    return getattr(user, 'daily_ai_usage_cents', 0) or 0


# In-memory per-user AI request timestamps for tier-based rate limiting
_ai_rate_timestamps: dict[str, list[float]] = {}


def _check_ai_rate_limit(user_id: str, tier: str) -> bool:
    """Return True if within rate limit for the user's tier."""
    import time
    max_per_min = TIER_CONFIG.get(tier, TIER_CONFIG['free'])['rate_limit']
    now = time.time()
    timestamps = _ai_rate_timestamps.get(user_id, [])
    timestamps = [t for t in timestamps if now - t < 60]
    _ai_rate_timestamps[user_id] = timestamps
    if len(timestamps) >= max_per_min:
        return False
    timestamps.append(now)
    return True


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
@limiter.limit("60/minute")  # ceiling; per-tier enforcement below
async def ai_chat(request: Request, req: AIChatRequest, db: Session = Depends(get_db)):
    """Proxy AI chat to Vercel AI Gateway with per-tier limits."""
    user = None
    tier = 'free'
    if req.user_id:
        try:
            user = db.query(User).filter(User.user_id == req.user_id).first()
            if user:
                tier = _get_effective_tier(user)
        except Exception:
            pass

    tier_config = TIER_CONFIG[tier]

    # Per-tier rate limit
    if not _check_ai_rate_limit(req.user_id or (request.client.host if request.client else ""), tier):
        raise HTTPException(status_code=429, detail={
            "code": "RATE_LIMITED",
            "message": f"Rate limit: {tier_config['rate_limit']}/min for {tier} tier.",
            "tier": tier,
        })

    # Per-tier message character limit
    total_chars = sum(len(m.content) if isinstance(m.content, str) else 0 for m in req.messages)
    if total_chars > tier_config['max_chars']:
        raise HTTPException(status_code=413, detail={
            "code": "MESSAGE_TOO_LONG",
            "message": f"Message too long. {tier} tier limit: {tier_config['max_chars']:,} chars.",
            "tier": tier,
        })

    if tier == 'free':
        # Platform-wide safety net
        if _get_daily_cost() >= DAILY_AI_LIMIT_USD:
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "DAILY_LIMIT_EXCEEDED",
                    "message": f"Platform AI credit limit of ${DAILY_AI_LIMIT_USD:.0f}/day has been reached.",
                    "limit_usd": DAILY_AI_LIMIT_USD,
                    "used_usd": round(_get_daily_cost(), 4),
                    "tier": tier,
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
                        "tier": tier,
                    },
                )
    else:
        # Pro/Team: personal daily limit check
        if user:
            usage = _get_user_daily_usage(user)
            if usage >= tier_config['daily_limit_cents']:
                raise HTTPException(
                    status_code=402,
                    detail={
                        "code": "DAILY_LIMIT_EXCEEDED",
                        "message": f"Your {tier} daily limit (${tier_config['daily_limit_cents'] / 100:.0f}/day) has been reached.",
                        "tier": tier,
                        "limit_cents": tier_config['daily_limit_cents'],
                        "used_cents": usage,
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

            credits_remaining = None
            daily_usage = None

            if tier == 'free':
                # Deduct per-user credits
                if user is not None:
                    cost = _calc_user_cost_cents(total_tokens)
                    try:
                        user.credits_cents = max(0, (getattr(user, "credits_cents", 0) or 0) - cost)
                        db.commit()
                        credits_remaining = user.credits_cents
                    except Exception as e:
                        logging.error(f"Credits deduction error: {e}")
            else:
                # Pro/Team: track personal daily usage
                if user is not None:
                    cost_cents = _calc_user_cost_cents(total_tokens)
                    today = _today()
                    try:
                        if getattr(user, 'daily_ai_usage_date', None) != today:
                            user.daily_ai_usage_cents = cost_cents
                            user.daily_ai_usage_date = today
                        else:
                            user.daily_ai_usage_cents = (user.daily_ai_usage_cents or 0) + cost_cents
                        db.commit()
                        daily_usage = user.daily_ai_usage_cents
                    except Exception as e:
                        logging.error(f"Daily usage tracking error: {e}")

            return {
                "content": content,
                "credits_cents": credits_remaining,
                "tier": tier,
                "daily_usage_cents": daily_usage,
            }
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
@limiter.limit("5/minute")
async def auth_login(request: Request, req: AuthLoginRequest, db: Session = Depends(get_db)):
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
        tier = _get_effective_tier(user)
        return {
            "user_id": user.user_id,
            "username": user.username,
            "is_member": tier != 'free',
            "credits_cents": user.credits_cents or 0,
            "is_anonymous": False,
            "tier": tier,
            "billing": getattr(user, 'membership_billing', None),
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


@app.delete("/groups/{group_id}/members/{member_id}")
async def remove_group_member(
    group_id: str,
    member_id: str,
    user_id: str,
    db: Session = Depends(get_db),
):
    """Remove a member from a group. Only the group creator can do this."""
    try:
        group = db.query(Group).filter(Group.group_id == group_id).first()
        if not group:
            raise HTTPException(status_code=404, detail="Group not found")

        if group.created_by != user_id:
            raise HTTPException(status_code=403, detail="Only the group creator can remove members")

        if member_id == group.created_by:
            raise HTTPException(status_code=400, detail="Cannot remove the group creator")

        membership = db.query(GroupMember).filter(
            GroupMember.group_id == group_id, GroupMember.user_id == member_id
        ).first()
        if not membership:
            raise HTTPException(status_code=404, detail="Member not found in group")

        db.delete(membership)
        db.commit()

        # Build updated group data
        remaining = db.query(GroupMember).filter(GroupMember.group_id == group_id).all()
        group_data = {
            "group_id": group_id,
            "name": group.name,
            "icon": group.icon,
            "created_by": group.created_by,
            "members": [m.user_id for m in remaining],
        }

        # Notify remaining members
        for m in remaining:
            await manager.send_personal_message(
                {"type": "group_updated", "group": group_data}, m.user_id
            )

        # Notify the kicked member
        await manager.send_personal_message(
            {"type": "group_kicked", "group_id": group_id, "kicked_by": user_id},
            member_id,
        )

        return group_data
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Error removing member from group: {e}")
        raise HTTPException(status_code=503, detail="Database unavailable.")


# ── Message history ───────────────────────────────────────────────────────────

@app.get("/messages/{conversation_id}")
async def get_messages(
    conversation_id: str,
    user_id: str,
    before: Optional[str] = None,
    limit: int = 50,
    db: Session = Depends(get_db),
):
    """Fetch paginated message history for a conversation (cursor-based)."""
    limit = min(limit, 100)

    # Authorization: user must be part of the conversation
    if conversation_id.startswith("dm:"):
        if user_id not in conversation_id:
            raise HTTPException(status_code=403, detail="Not authorized")
    elif conversation_id.startswith("group:"):
        member = db.query(GroupMember).filter(
            GroupMember.group_id == conversation_id,
            GroupMember.user_id == user_id,
        ).first()
        if not member:
            raise HTTPException(status_code=403, detail="Not authorized")

    try:
        query = db.query(ChatMessage).filter(
            ChatMessage.conversation_id == conversation_id
        )
        if before:
            query = query.filter(ChatMessage.timestamp < datetime.fromisoformat(before))

        results = query.order_by(ChatMessage.timestamp.desc()).limit(limit + 1).all()
        has_more = len(results) > limit
        messages = results[:limit]
        messages.reverse()  # chronological order

        return {
            "messages": [
                {
                    "message_id": m.message_id,
                    "conversation_id": m.conversation_id,
                    "from_user": m.from_user,
                    "from_username": m.from_username,
                    "to_user": m.to_user,
                    "group_id": m.group_id,
                    "content": m.content,
                    "timestamp": m.timestamp.isoformat(),
                    "has_attachment": m.has_attachment,
                    "attachment_type": m.attachment_type,
                    "attachment_name": m.attachment_name,
                }
                for m in messages
            ],
            "has_more": has_more,
            "oldest_timestamp": messages[0].timestamp.isoformat() if messages else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Error fetching messages for {conversation_id}: {e}")
        raise HTTPException(status_code=503, detail="Database unavailable.")


# ── Stripe membership ─────────────────────────────────────────────────────────

@app.get("/user/{user_id}/credits")
async def get_user_credits(user_id: str, db: Session = Depends(get_db)):
    """Return a user's current credit balance and account type."""
    try:
        user = db.query(User).filter(User.user_id == user_id).first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        tier = _get_effective_tier(user)
        return {
            "credits_cents": getattr(user, "credits_cents", 0) or 0,
            "is_member": tier != 'free',
            "is_anonymous": not bool(user.auth0_sub),
            "tier": tier,
            "billing": getattr(user, "membership_billing", None),
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
@limiter.limit("5/minute")
async def buy_credits(request: Request, req: BuyCreditsRequest):
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


class SubscriptionCheckoutRequest(BaseModel):
    user_id: str
    tier: str = 'pro'
    billing: str = 'monthly'


@app.post("/stripe/subscribe")
@limiter.limit("5/minute")
async def create_subscription_checkout(request: Request, req: SubscriptionCheckoutRequest, db: Session = Depends(get_db)):
    """Create a Stripe Checkout session for a subscription plan."""
    stripe_key = os.getenv("STRIPE_SECRET_KEY", "")
    if not stripe_key:
        raise HTTPException(status_code=503, detail="Payment not configured.")

    if req.tier not in ('pro', 'team') or req.billing not in ('monthly', 'yearly'):
        raise HTTPException(status_code=400, detail="Invalid tier or billing cycle.")

    price_key = f"{req.tier}_{req.billing}"
    price_id = STRIPE_PRICES.get(price_key)
    if not price_id:
        raise HTTPException(status_code=400, detail=f"Price not configured for {req.tier}/{req.billing}.")

    stripe.api_key = stripe_key
    origin = request.headers.get("origin", "https://chat.jytech.us")

    user = db.query(User).filter(User.user_id == req.user_id).first()
    customer_id = getattr(user, 'stripe_customer_id', None) if user else None

    checkout_params = {
        "payment_method_types": ["card"],
        "line_items": [{"price": price_id, "quantity": 1}],
        "mode": "subscription",
        "metadata": {"user_id": req.user_id, "tier": req.tier, "billing": req.billing},
        "success_url": f"{origin}?membership=success&tier={req.tier}",
        "cancel_url": f"{origin}?membership=cancelled",
    }
    if customer_id:
        checkout_params["customer"] = customer_id
    else:
        checkout_params["customer_creation"] = "always"

    try:
        session = stripe.checkout.Session.create(**checkout_params)
        return {"checkout_url": session.url}
    except stripe.StripeError as e:
        logging.error(f"Stripe subscription error: {e}")
        raise HTTPException(status_code=502, detail="Payment service error.")


@app.post("/stripe/checkout")
@limiter.limit("5/minute")
async def create_checkout(request: Request):
    """Legacy endpoint — redirects to /stripe/subscribe with pro/monthly defaults."""
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
            metadata={"user_id": user_id, "tier": "pro", "billing": "monthly"},
            success_url=f"{origin}?membership=success&tier=pro",
            cancel_url=f"{origin}?membership=cancelled",
        )
        return {"checkout_url": session.url}
    except stripe.StripeError as e:
        logging.error(f"Stripe error: {e}")
        raise HTTPException(status_code=502, detail="Payment service error.")


@app.post("/stripe/manage")
@limiter.limit("5/minute")
async def create_customer_portal(request: Request, db: Session = Depends(get_db)):
    """Create a Stripe Customer Portal session for managing subscription."""
    stripe_key = os.getenv("STRIPE_SECRET_KEY", "")
    if not stripe_key:
        raise HTTPException(status_code=503, detail="Payment not configured.")

    body = await request.json()
    user_id = body.get("user_id", "")
    user = db.query(User).filter(User.user_id == user_id).first()
    if not user or not getattr(user, 'stripe_customer_id', None):
        raise HTTPException(status_code=404, detail="No subscription found.")

    stripe.api_key = stripe_key
    origin = request.headers.get("origin", "https://chat.jytech.us")

    try:
        session = stripe.billing_portal.Session.create(
            customer=user.stripe_customer_id,
            return_url=origin,
        )
        return {"portal_url": session.url}
    except stripe.StripeError as e:
        logging.error(f"Stripe portal error: {e}")
        raise HTTPException(status_code=502, detail="Payment service error.")


@app.get("/user/{user_id}/subscription")
async def get_user_subscription(user_id: str, db: Session = Depends(get_db)):
    """Return a user's subscription details."""
    user = db.query(User).filter(User.user_id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    tier = _get_effective_tier(user)
    tier_config = TIER_CONFIG[tier]

    return {
        "tier": tier,
        "billing": getattr(user, 'membership_billing', None),
        "expires_at": getattr(user, 'membership_expires_at', None).isoformat() if getattr(user, 'membership_expires_at', None) else None,
        "daily_limit_cents": tier_config['daily_limit_cents'],
        "daily_usage_cents": _get_user_daily_usage(user) if tier != 'free' else None,
        "rate_limit_per_min": tier_config['rate_limit'],
        "max_message_chars": tier_config['max_chars'],
        "credits_cents": getattr(user, 'credits_cents', 0) or 0,
        "is_member": tier != 'free',
    }


# ── Webhook idempotency ────────────────────────────────────────────────────
_processed_events: dict[str, datetime] = {}
_EVENT_TTL_HOURS = 24


def _is_duplicate_event(event_id: str) -> bool:
    """Check if a webhook event was already processed (24h window)."""
    now = datetime.utcnow()
    # Prune stale entries
    cutoff = now - timedelta(hours=_EVENT_TTL_HOURS)
    for eid in list(_processed_events.keys()):
        if _processed_events[eid] < cutoff:
            del _processed_events[eid]
    if event_id in _processed_events:
        return True
    _processed_events[event_id] = now
    return False


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

    # Idempotency: skip already-processed events
    event_id = event.get("id", "")
    if event_id and _is_duplicate_event(event_id):
        logging.info(f"Skipping duplicate webhook event {event_id}")
        return {"received": True, "duplicate": True}

    event_type = event["type"]

    if event_type == "checkout.session.completed":
        session_obj = event["data"]["object"]
        if session_obj.get("payment_status") != "paid":
            logging.warning(f"Checkout completed but payment_status={session_obj.get('payment_status')}")
            return {"received": True}

        meta = session_obj.get("metadata") or {}
        user_id = meta.get("user_id")
        credit_cents_str = meta.get("credit_cents")
        tier = meta.get("tier")
        billing = meta.get("billing")
        stripe_session_id = session_obj.get("id", "")

        if user_id:
            try:
                user = db.query(User).filter(User.user_id == user_id).first()
                if user:
                    if credit_cents_str:
                        add = int(credit_cents_str)
                        user.credits_cents = (getattr(user, "credits_cents", 0) or 0) + add
                        logging.info(f"Added {add} credit cents to user {user_id} (session {stripe_session_id})")
                    elif tier:
                        user.membership_tier = tier
                        user.membership_billing = billing
                        user.is_member = True
                        user.stripe_customer_id = session_obj.get("customer")
                        user.stripe_subscription_id = session_obj.get("subscription")
                        if billing == 'yearly':
                            user.membership_expires_at = datetime.utcnow() + timedelta(days=366)
                        else:
                            user.membership_expires_at = datetime.utcnow() + timedelta(days=32)
                        logging.info(f"Subscription {tier}/{billing} granted to user {user_id}")
                    else:
                        # Legacy single-membership
                        user.is_member = True
                        user.membership_tier = 'pro'
                        logging.info(f"Legacy membership granted to user {user_id}")
                    db.commit()
            except Exception as e:
                logging.error(f"DB error processing payment for {user_id}: {e}")

    elif event_type == "customer.subscription.updated":
        sub = event["data"]["object"]
        customer_id = sub.get("customer")
        try:
            user = db.query(User).filter(User.stripe_customer_id == customer_id).first()
            if user:
                items = sub.get("items", {}).get("data", [])
                if items:
                    price_id = items[0].get("price", {}).get("id", "")
                    tier_info = PRICE_TO_TIER.get(price_id)
                    if tier_info:
                        user.membership_tier = tier_info[0]
                        user.membership_billing = tier_info[1]
                        user.is_member = True
                period_end = sub.get("current_period_end")
                if period_end:
                    user.membership_expires_at = datetime.utcfromtimestamp(period_end)
                if sub.get("cancel_at_period_end"):
                    logging.info(f"Subscription cancel scheduled for customer {customer_id}")
                db.commit()
        except Exception as e:
            logging.error(f"Error updating subscription for customer {customer_id}: {e}")

    elif event_type == "customer.subscription.deleted":
        sub = event["data"]["object"]
        customer_id = sub.get("customer")
        try:
            user = db.query(User).filter(User.stripe_customer_id == customer_id).first()
            if user:
                user.membership_tier = 'free'
                user.is_member = False
                user.membership_billing = None
                user.stripe_subscription_id = None
                user.membership_expires_at = None
                db.commit()
                logging.info(f"Subscription cancelled for customer {customer_id}, user {user.user_id}")
        except Exception as e:
            logging.error(f"Error cancelling subscription for customer {customer_id}: {e}")

    elif event_type == "invoice.payment_failed":
        invoice = event["data"]["object"]
        customer_id = invoice.get("customer")
        logging.warning(f"Payment failed for customer {customer_id} — Stripe will retry automatically.")

    return {"received": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

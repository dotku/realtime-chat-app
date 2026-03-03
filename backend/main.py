from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy import text
from datetime import datetime
import uuid
import json
import logging
import os
import httpx

from pydantic import BaseModel
from database import init_db, get_db, User
from models import UserCreate, UserResponse, Message
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


@app.on_event("startup")
async def startup_event():
    try:
        init_db()
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

                if to_user and (content or attachment):
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


class AIChatMessage(BaseModel):
    role: str  # "user" | "assistant" | "system"
    content: str


class AIChatRequest(BaseModel):
    model: str
    messages: list[AIChatMessage]
    system_prompt: str = ""


@app.post("/ai/chat")
async def ai_chat(request: AIChatRequest):
    """Proxy AI chat to Vercel AI Gateway (or Anthropic directly as fallback)."""
    api_key = os.getenv("GATEWAY_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="AI Gateway API key not configured on server.")

    messages = []
    if request.system_prompt:
        messages.append({"role": "system", "content": request.system_prompt})
    messages.extend([{"role": m.role, "content": m.content} for m in request.messages])

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{GATEWAY_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={"model": request.model, "messages": messages},
            )
            if response.status_code != 200:
                logging.error(f"Gateway error {response.status_code}: {response.text}")
                raise HTTPException(status_code=502, detail=f"Gateway returned {response.status_code}")
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            return {"content": content}
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="AI request timed out.")
    except httpx.RequestError as e:
        logging.error(f"AI gateway request error: {e}")
        raise HTTPException(status_code=502, detail="Failed to reach AI gateway.")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

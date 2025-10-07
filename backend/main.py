from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from datetime import datetime
import uuid
import json

from database import init_db, get_db, User
from models import UserCreate, UserResponse, Message
from connection_manager import manager

app = FastAPI(title="Real-Time Chat API")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    init_db()


@app.get("/")
async def root():
    return {"message": "Real-Time Chat API", "status": "running"}


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


@app.post("/users", response_model=UserResponse)
async def create_user(user: UserCreate, db: Session = Depends(get_db)):
    """Create a new user with auto-generated UUID"""
    user_id = str(uuid.uuid4())
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


@app.get("/users/online", response_model=list[UserResponse])
async def get_online_users(db: Session = Depends(get_db)):
    """Get all currently online users"""
    users = db.query(User).filter(User.is_online == True).all()
    return users


@app.websocket("/ws/{user_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    db: Session = Depends(get_db)
):
    # Get user from database
    user = db.query(User).filter(User.user_id == user_id).first()
    if not user:
        await websocket.close(code=4004, reason="User not found")
        return

    # Connect the user
    await manager.connect(websocket, user_id, user.username)

    # Update user status in database
    user.is_online = True
    user.last_seen = datetime.utcnow()
    db.commit()

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
                content = message_data.get("content")

                if to_user and content:
                    await manager.send_chat_message(user_id, to_user, content)

    except WebSocketDisconnect:
        # Handle disconnection
        manager.disconnect(user_id)

        # Update user status in database
        user.is_online = False
        user.last_seen = datetime.utcnow()
        db.commit()

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
        print(f"Error in websocket connection: {e}")
        manager.disconnect(user_id)
        user.is_online = False
        db.commit()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

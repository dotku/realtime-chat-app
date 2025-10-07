from fastapi import WebSocket
from typing import Dict, Set
import json
from datetime import datetime


class ConnectionManager:
    def __init__(self):
        # Maps user_id to WebSocket connection
        self.active_connections: Dict[str, WebSocket] = {}
        # Maps user_id to their username
        self.user_names: Dict[str, str] = {}
        # Track active chat sessions: {user_id: set of user_ids they're chatting with}
        self.active_chats: Dict[str, Set[str]] = {}

    async def connect(self, websocket: WebSocket, user_id: str, username: str):
        await websocket.accept()
        self.active_connections[user_id] = websocket
        self.user_names[user_id] = username
        self.active_chats[user_id] = set()

    def disconnect(self, user_id: str):
        if user_id in self.active_connections:
            del self.active_connections[user_id]
        if user_id in self.user_names:
            del self.user_names[user_id]
        if user_id in self.active_chats:
            del self.active_chats[user_id]

    async def send_personal_message(self, message: dict, user_id: str):
        if user_id in self.active_connections:
            websocket = self.active_connections[user_id]
            await websocket.send_json(message)

    async def broadcast(self, message: dict, exclude: str = None):
        """Broadcast message to all connected users except the excluded one"""
        for user_id, websocket in self.active_connections.items():
            if user_id != exclude:
                try:
                    await websocket.send_json(message)
                except Exception as e:
                    print(f"Error broadcasting to {user_id}: {e}")

    async def send_chat_message(self, from_user: str, to_user: str, content: str):
        """Send a chat message between two users"""
        message = {
            "type": "chat",
            "from_user": from_user,
            "from_username": self.user_names.get(from_user, "Unknown"),
            "to_user": to_user,
            "content": content,
            "timestamp": datetime.utcnow().isoformat()
        }

        # Send to both sender and recipient
        await self.send_personal_message(message, from_user)
        await self.send_personal_message(message, to_user)

    def get_online_users(self):
        """Get list of all online users"""
        return [
            {
                "user_id": user_id,
                "username": username,
                "is_online": True
            }
            for user_id, username in self.user_names.items()
        ]

    async def notify_user_joined(self, user_id: str, username: str):
        """Notify all users that a new user has joined"""
        message = {
            "type": "user_joined",
            "user_id": user_id,
            "username": username,
            "timestamp": datetime.utcnow().isoformat()
        }
        await self.broadcast(message, exclude=user_id)

    async def notify_user_left(self, user_id: str):
        """Notify all users that a user has left"""
        username = self.user_names.get(user_id, "Unknown")
        message = {
            "type": "user_left",
            "user_id": user_id,
            "username": username,
            "timestamp": datetime.utcnow().isoformat()
        }
        await self.broadcast(message)


manager = ConnectionManager()

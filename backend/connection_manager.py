from fastapi import WebSocket
from typing import Dict, Set
from collections import defaultdict
import uuid
from datetime import datetime

MAX_CONNECTIONS_PER_IP = 10


class ConnectionManager:
    def __init__(self):
        # Maps user_id to WebSocket connection
        self.active_connections: Dict[str, WebSocket] = {}
        # Maps user_id to their username
        self.user_names: Dict[str, str] = {}
        # Track active chat sessions: {user_id: set of user_ids they're chatting with}
        self.active_chats: Dict[str, Set[str]] = {}
        # Track connections per IP for rate limiting
        self._ip_connections: Dict[str, int] = defaultdict(int)
        # Maps user_id to IP for cleanup on disconnect
        self._user_ips: Dict[str, str] = {}

    def check_ip_limit(self, client_ip: str) -> bool:
        """Return True if the IP is within connection limits."""
        return self._ip_connections[client_ip] < MAX_CONNECTIONS_PER_IP

    async def connect(self, websocket: WebSocket, user_id: str, username: str, client_ip: str = ""):
        # Always accept the WebSocket connection
        await websocket.accept()

        self.active_connections[user_id] = websocket
        self.user_names[user_id] = username
        self.active_chats[user_id] = set()
        if client_ip:
            self._ip_connections[client_ip] += 1
            self._user_ips[user_id] = client_ip

    def disconnect(self, user_id: str):
        if user_id in self.active_connections:
            del self.active_connections[user_id]
        if user_id in self.user_names:
            del self.user_names[user_id]
        if user_id in self.active_chats:
            del self.active_chats[user_id]
        # Decrement IP counter
        ip = self._user_ips.pop(user_id, None)
        if ip and self._ip_connections[ip] > 0:
            self._ip_connections[ip] -= 1
            if self._ip_connections[ip] == 0:
                del self._ip_connections[ip]

    async def send_personal_message(self, message: dict, user_id: str):
        if user_id in self.active_connections:
            websocket = self.active_connections[user_id]
            try:
                await websocket.send_json(message)
            except Exception as e:
                print(f"Error sending message to {user_id}: {e}")
        # Offline users will receive missed messages via DB sync on reconnect

    async def broadcast(self, message: dict, exclude: str = None):
        """Broadcast message to all connected users except the excluded one"""
        for user_id, websocket in self.active_connections.items():
            if user_id != exclude:
                try:
                    await websocket.send_json(message)
                except Exception as e:
                    print(f"Error broadcasting to {user_id}: {e}")

    async def send_chat_message(self, from_user: str, to_user: str, content: str,
                                attachment: dict = None, message_id: str = None):
        """Send a chat message between two users. Returns the full message dict."""
        message = {
            "type": "chat",
            "message_id": message_id or str(uuid.uuid4()),
            "from_user": from_user,
            "from_username": self.user_names.get(from_user, "Unknown"),
            "to_user": to_user,
            "content": content,
            "timestamp": datetime.utcnow().isoformat()
        }
        if attachment:
            message["attachment"] = attachment

        print(f"Sending chat message from {from_user} to {to_user}: {content}")
        print(f"Active connections: {list(self.active_connections.keys())}")

        # Send to both sender and recipient
        await self.send_personal_message(message, from_user)
        await self.send_personal_message(message, to_user)

        return message

    async def send_group_message(self, from_user: str, group_id: str,
                                   member_ids: list, content: str,
                                   attachment: dict = None, message_id: str = None):
        """Send a chat message to all members of a group. Returns the full message dict."""
        message = {
            "type": "chat",
            "message_id": message_id or str(uuid.uuid4()),
            "from_user": from_user,
            "from_username": self.user_names.get(from_user, "Unknown"),
            "to_user": group_id,
            "group_id": group_id,
            "content": content,
            "timestamp": datetime.utcnow().isoformat(),
        }
        if attachment:
            message["attachment"] = attachment

        for member_id in member_ids:
            await self.send_personal_message(message, member_id)

        return message

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

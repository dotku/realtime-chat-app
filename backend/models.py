from pydantic import BaseModel
from datetime import datetime
from typing import Optional


class UserCreate(BaseModel):
    username: str


class UserResponse(BaseModel):
    user_id: str
    username: str
    is_online: bool
    connected_at: datetime

    class Config:
        from_attributes = True


class Message(BaseModel):
    type: str  # "chat", "user_joined", "user_left", "online_users"
    from_user: Optional[str] = None
    to_user: Optional[str] = None
    content: Optional[str] = None
    timestamp: Optional[datetime] = None
    users: Optional[list] = None

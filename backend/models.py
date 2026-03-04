from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional, List


class UserCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=50)


class UserResponse(BaseModel):
    user_id: str
    username: str
    is_online: bool
    connected_at: datetime

    class Config:
        from_attributes = True


class GroupCreate(BaseModel):
    name: str
    icon: str = "👥"
    created_by: str
    member_ids: list[str] = []


class GroupResponse(BaseModel):
    group_id: str
    name: str
    icon: str
    created_by: str
    members: list[str]

    class Config:
        from_attributes = True


class Message(BaseModel):
    type: str  # "chat", "user_joined", "user_left", "online_users"
    from_user: Optional[str] = None
    to_user: Optional[str] = None
    content: Optional[str] = None
    timestamp: Optional[datetime] = None
    users: Optional[list] = None


class MessageResponse(BaseModel):
    message_id: str
    conversation_id: str
    from_user: str
    from_username: str
    to_user: str
    group_id: Optional[str] = None
    content: str
    timestamp: datetime
    has_attachment: bool = False
    attachment_type: Optional[str] = None
    attachment_name: Optional[str] = None

    class Config:
        from_attributes = True


class MessageHistoryResponse(BaseModel):
    messages: List[MessageResponse]
    has_more: bool
    oldest_timestamp: Optional[datetime] = None

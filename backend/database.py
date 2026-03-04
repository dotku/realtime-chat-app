from sqlalchemy import create_engine, Column, String, DateTime, Boolean, Integer, Index, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime
import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://chatuser:chatpass@db:5432/chatdb")

# Neon and other cloud PostgreSQL providers require SSL; add connect_args only when needed
_connect_args = {}
if "sslmode=require" in DATABASE_URL or "neon.tech" in DATABASE_URL:
    _connect_args = {"sslmode": "require"}

engine = create_engine(DATABASE_URL, connect_args=_connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"

    user_id = Column(String, primary_key=True, index=True)
    username = Column(String, nullable=False)
    is_online = Column(Boolean, default=True)
    connected_at = Column(DateTime, default=datetime.utcnow)
    last_seen = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    is_member = Column(Boolean, default=False)
    auth0_sub = Column(String, unique=True, nullable=True, index=True)  # e.g. "auth0|abc123"
    credits_cents = Column(Integer, default=100)  # 100 = $1.00 (anonymous); registered users get 500
    membership_tier = Column(String, default='free')         # 'free' | 'pro' | 'team'
    membership_billing = Column(String, nullable=True)       # 'monthly' | 'yearly' | None
    membership_expires_at = Column(DateTime, nullable=True)
    stripe_customer_id = Column(String, nullable=True)
    stripe_subscription_id = Column(String, nullable=True)
    daily_ai_usage_cents = Column(Integer, default=0)
    daily_ai_usage_date = Column(String, nullable=True)      # 'YYYY-MM-DD'


class Group(Base):
    __tablename__ = "groups"

    group_id = Column(String, primary_key=True, index=True)   # "group:{uuid}"
    name = Column(String, nullable=False)
    icon = Column(String, default="👥")
    created_by = Column(String, nullable=False)               # user_id of creator
    created_at = Column(DateTime, default=datetime.utcnow)


class GroupMember(Base):
    __tablename__ = "group_members"

    id = Column(Integer, primary_key=True, autoincrement=True)
    group_id = Column(String, nullable=False, index=True)
    user_id = Column(String, nullable=False, index=True)
    joined_at = Column(DateTime, default=datetime.utcnow)


class ChatMessage(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    message_id = Column(String, unique=True, nullable=False, index=True)
    conversation_id = Column(String, nullable=False)
    from_user = Column(String, nullable=False)
    from_username = Column(String, nullable=False)
    to_user = Column(String, nullable=False)
    group_id = Column(String, nullable=True)
    content = Column(Text, nullable=False, default="")
    timestamp = Column(DateTime, nullable=False)
    has_attachment = Column(Boolean, default=False)
    attachment_type = Column(String, nullable=True)
    attachment_name = Column(String, nullable=True)
    attachment_size = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index('ix_messages_conversation_ts', 'conversation_id', timestamp.desc()),
        Index('ix_messages_to_user_ts', 'to_user', 'timestamp'),
    )


def make_conversation_id(from_user: str, to_user: str, group_id: str = None) -> str:
    """Compute a canonical conversation ID for consistent lookups."""
    if group_id:
        return group_id
    pair = sorted([from_user, to_user])
    return f"dm:{pair[0]}:{pair[1]}"


def init_db():
    Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

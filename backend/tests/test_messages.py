"""Tests for message history and credits endpoints."""

import pytest
from datetime import datetime

from database import User, ChatMessage, GroupMember, Group, make_conversation_id


@pytest.fixture
def chat_pair(db):
    """Create two users and some messages between them."""
    u1 = User(user_id="u1", username="alice", is_online=True)
    u2 = User(user_id="u2", username="bob", is_online=True)
    db.add_all([u1, u2])
    db.commit()

    conv_id = make_conversation_id("u1", "u2")
    for i in range(5):
        db.add(ChatMessage(
            message_id=f"msg-{i}",
            conversation_id=conv_id,
            from_user="u1" if i % 2 == 0 else "u2",
            from_username="alice" if i % 2 == 0 else "bob",
            to_user="u2" if i % 2 == 0 else "u1",
            content=f"Message {i}",
            timestamp=datetime(2025, 1, 1, 12, i, 0),
        ))
    db.commit()
    return u1, u2, conv_id


@pytest.mark.asyncio
async def test_get_messages(client, chat_pair):
    _, _, conv_id = chat_pair
    resp = await client.get(f"/messages/{conv_id}", params={"user_id": "u1"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["messages"]) == 5
    assert data["has_more"] is False


@pytest.mark.asyncio
async def test_get_messages_pagination(client, chat_pair):
    _, _, conv_id = chat_pair
    resp = await client.get(f"/messages/{conv_id}", params={"user_id": "u1", "limit": 2})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["messages"]) == 2
    assert data["has_more"] is True


@pytest.mark.asyncio
async def test_get_messages_unauthorized(client, chat_pair):
    _, _, conv_id = chat_pair
    resp = await client.get(f"/messages/{conv_id}", params={"user_id": "stranger"})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_get_user_credits(client, sample_user):
    resp = await client.get(f"/user/{sample_user.user_id}/credits")
    assert resp.status_code == 200
    data = resp.json()
    assert "credits_cents" in data
    assert "is_member" in data
    assert "is_anonymous" in data


@pytest.mark.asyncio
async def test_get_credits_not_found(client):
    resp = await client.get("/user/nonexistent/credits")
    assert resp.status_code == 404


def test_make_conversation_id_dm():
    """DM conversation IDs should be canonical (sorted)."""
    assert make_conversation_id("b", "a") == make_conversation_id("a", "b")
    assert make_conversation_id("a", "b").startswith("dm:")


def test_make_conversation_id_group():
    """Group conversation ID should just be the group_id."""
    assert make_conversation_id("a", "b", "group:123") == "group:123"

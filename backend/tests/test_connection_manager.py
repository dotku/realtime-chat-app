"""Tests for ConnectionManager (unit tests, no DB)."""

import pytest
from unittest.mock import AsyncMock, MagicMock
from connection_manager import ConnectionManager


@pytest.fixture
def mgr():
    return ConnectionManager()


def _make_ws():
    ws = AsyncMock()
    ws.accept = AsyncMock()
    ws.send_json = AsyncMock()
    return ws


@pytest.mark.asyncio
async def test_connect_and_disconnect(mgr):
    ws = _make_ws()
    await mgr.connect(ws, "u1", "alice")
    assert "u1" in mgr.active_connections
    assert mgr.user_names["u1"] == "alice"

    mgr.disconnect("u1")
    assert "u1" not in mgr.active_connections
    assert "u1" not in mgr.user_names


@pytest.mark.asyncio
async def test_disconnect_nonexistent(mgr):
    """Disconnecting a user that doesn't exist should not raise."""
    mgr.disconnect("nonexistent")


@pytest.mark.asyncio
async def test_send_personal_message(mgr):
    ws = _make_ws()
    await mgr.connect(ws, "u1", "alice")
    await mgr.send_personal_message({"hello": "world"}, "u1")
    ws.send_json.assert_called_once_with({"hello": "world"})


@pytest.mark.asyncio
async def test_send_personal_message_offline(mgr):
    """Sending to offline user should not raise."""
    await mgr.send_personal_message({"hello": "world"}, "offline-user")


@pytest.mark.asyncio
async def test_broadcast(mgr):
    ws1 = _make_ws()
    ws2 = _make_ws()
    await mgr.connect(ws1, "u1", "alice")
    await mgr.connect(ws2, "u2", "bob")

    await mgr.broadcast({"msg": "hi"})
    ws1.send_json.assert_called_once_with({"msg": "hi"})
    ws2.send_json.assert_called_once_with({"msg": "hi"})


@pytest.mark.asyncio
async def test_broadcast_with_exclude(mgr):
    ws1 = _make_ws()
    ws2 = _make_ws()
    await mgr.connect(ws1, "u1", "alice")
    await mgr.connect(ws2, "u2", "bob")

    await mgr.broadcast({"msg": "hi"}, exclude="u1")
    ws1.send_json.assert_not_called()
    ws2.send_json.assert_called_once()


@pytest.mark.asyncio
async def test_send_chat_message(mgr):
    ws1 = _make_ws()
    ws2 = _make_ws()
    await mgr.connect(ws1, "u1", "alice")
    await mgr.connect(ws2, "u2", "bob")

    msg = await mgr.send_chat_message("u1", "u2", "hello!")
    assert msg["type"] == "chat"
    assert msg["from_user"] == "u1"
    assert msg["to_user"] == "u2"
    assert msg["content"] == "hello!"
    assert "timestamp" in msg
    assert "message_id" in msg

    # Both sender and recipient should receive the message
    assert ws1.send_json.call_count == 1
    assert ws2.send_json.call_count == 1


@pytest.mark.asyncio
async def test_send_chat_message_with_attachment(mgr):
    ws1 = _make_ws()
    ws2 = _make_ws()
    await mgr.connect(ws1, "u1", "alice")
    await mgr.connect(ws2, "u2", "bob")

    attachment = {"type": "image/png", "name": "photo.png", "data": "base64data"}
    msg = await mgr.send_chat_message("u1", "u2", "check this", attachment=attachment)
    assert msg["attachment"] == attachment


@pytest.mark.asyncio
async def test_send_group_message(mgr):
    ws1 = _make_ws()
    ws2 = _make_ws()
    ws3 = _make_ws()
    await mgr.connect(ws1, "u1", "alice")
    await mgr.connect(ws2, "u2", "bob")
    await mgr.connect(ws3, "u3", "charlie")

    msg = await mgr.send_group_message("u1", "group:abc", ["u1", "u2", "u3"], "hi team")
    assert msg["type"] == "chat"
    assert msg["group_id"] == "group:abc"
    assert ws1.send_json.call_count == 1
    assert ws2.send_json.call_count == 1
    assert ws3.send_json.call_count == 1


@pytest.mark.asyncio
async def test_get_online_users(mgr):
    ws1 = _make_ws()
    ws2 = _make_ws()
    await mgr.connect(ws1, "u1", "alice")
    await mgr.connect(ws2, "u2", "bob")

    users = mgr.get_online_users()
    assert len(users) == 2
    ids = {u["user_id"] for u in users}
    assert ids == {"u1", "u2"}
    assert all(u["is_online"] for u in users)


@pytest.mark.asyncio
async def test_notify_user_joined(mgr):
    ws1 = _make_ws()
    ws2 = _make_ws()
    await mgr.connect(ws1, "u1", "alice")
    await mgr.connect(ws2, "u2", "bob")

    await mgr.notify_user_joined("u2", "bob")
    # u1 should be notified, u2 (the joiner) excluded
    ws1.send_json.assert_called_once()
    msg = ws1.send_json.call_args[0][0]
    assert msg["type"] == "user_joined"
    assert msg["user_id"] == "u2"
    ws2.send_json.assert_not_called()


@pytest.mark.asyncio
async def test_notify_user_left(mgr):
    ws1 = _make_ws()
    ws2 = _make_ws()
    await mgr.connect(ws1, "u1", "alice")
    await mgr.connect(ws2, "u2", "bob")

    await mgr.notify_user_left("u2")
    # Both should be notified (broadcast without exclude)
    assert ws1.send_json.call_count == 1
    assert ws2.send_json.call_count == 1
    msg = ws1.send_json.call_args[0][0]
    assert msg["type"] == "user_left"

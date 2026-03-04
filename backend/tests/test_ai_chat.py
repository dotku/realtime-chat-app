"""Tests for /ai/chat endpoint."""

import pytest
from unittest.mock import patch, AsyncMock, MagicMock
import httpx

from database import User


GATEWAY_RESPONSE = {
    "choices": [{"message": {"content": "Hello from AI!"}}],
    "usage": {"total_tokens": 100},
}


def _mock_httpx_response(json_data=GATEWAY_RESPONSE, status_code=200):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data
    resp.text = str(json_data)
    return resp


@pytest.mark.asyncio
@patch("main.httpx.AsyncClient")
async def test_ai_chat_success(MockClient, client, sample_user):
    mock_client_instance = AsyncMock()
    mock_client_instance.post.return_value = _mock_httpx_response()
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=False)
    MockClient.return_value = mock_client_instance

    resp = await client.post("/ai/chat", json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Hi"}],
        "user_id": "user-1",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["content"] == "Hello from AI!"
    assert "credits_cents" in data


@pytest.mark.asyncio
async def test_ai_chat_no_credits(client, db):
    user = User(user_id="broke-user", username="broke", credits_cents=0, is_online=True)
    db.add(user)
    db.commit()

    resp = await client.post("/ai/chat", json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Hi"}],
        "user_id": "broke-user",
    })
    assert resp.status_code == 402
    detail = resp.json()["detail"]
    assert detail["code"] == "NO_CREDITS"


@pytest.mark.asyncio
@patch("main.httpx.AsyncClient")
async def test_ai_chat_member_exempt_from_credits(MockClient, client, db):
    """Members should be able to chat even with 0 credits."""
    user = User(user_id="member-user", username="member", credits_cents=0,
                is_online=True, is_member=True, auth0_sub="auth0|member")
    db.add(user)
    db.commit()

    mock_client_instance = AsyncMock()
    mock_client_instance.post.return_value = _mock_httpx_response()
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=False)
    MockClient.return_value = mock_client_instance

    resp = await client.post("/ai/chat", json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Hi"}],
        "user_id": "member-user",
    })
    assert resp.status_code == 200


@pytest.mark.asyncio
@patch("main._get_daily_cost", return_value=999.0)
async def test_ai_chat_daily_limit_exceeded(mock_cost, client, sample_user):
    resp = await client.post("/ai/chat", json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Hi"}],
        "user_id": "user-1",
    })
    assert resp.status_code == 402
    assert resp.json()["detail"]["code"] == "DAILY_LIMIT_EXCEEDED"


@pytest.mark.asyncio
@patch("main.httpx.AsyncClient")
async def test_ai_chat_gateway_error(MockClient, client, sample_user):
    mock_client_instance = AsyncMock()
    mock_client_instance.post.return_value = _mock_httpx_response(status_code=500)
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=False)
    MockClient.return_value = mock_client_instance

    resp = await client.post("/ai/chat", json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Hi"}],
        "user_id": "user-1",
    })
    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_ai_chat_no_api_key(client, sample_user):
    import os
    old = os.environ.get("GATEWAY_API_KEY")
    os.environ["GATEWAY_API_KEY"] = ""
    try:
        resp = await client.post("/ai/chat", json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Hi"}],
            "user_id": "user-1",
        })
        assert resp.status_code == 503
    finally:
        if old:
            os.environ["GATEWAY_API_KEY"] = old


@pytest.mark.asyncio
@patch("main.httpx.AsyncClient")
async def test_ai_chat_with_system_prompt(MockClient, client, sample_user):
    mock_client_instance = AsyncMock()
    mock_client_instance.post.return_value = _mock_httpx_response()
    mock_client_instance.__aenter__ = AsyncMock(return_value=mock_client_instance)
    mock_client_instance.__aexit__ = AsyncMock(return_value=False)
    MockClient.return_value = mock_client_instance

    resp = await client.post("/ai/chat", json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Hi"}],
        "system_prompt": "You are a helpful assistant",
        "user_id": "user-1",
    })
    assert resp.status_code == 200
    # Verify system prompt was included in the request
    call_args = mock_client_instance.post.call_args
    messages = call_args.kwargs["json"]["messages"]
    assert messages[0]["role"] == "system"
    assert messages[0]["content"] == "You are a helpful assistant"

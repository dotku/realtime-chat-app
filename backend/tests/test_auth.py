"""Tests for Auth0 login endpoint."""

import pytest
from unittest.mock import AsyncMock, patch


FAKE_CLAIMS = {
    "sub": "google-oauth2|999",
    "nickname": "jay",
    "name": "Jay Lin",
    "email": "jay@example.com",
}


@pytest.mark.asyncio
@patch("main.verify_id_token", new_callable=AsyncMock, return_value=FAKE_CLAIMS)
async def test_auth_login_new_user(mock_verify, client):
    resp = await client.post("/auth/login", json={"token": "fake-token", "username": "jay"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["username"] == "jay"
    assert data["is_anonymous"] is False
    assert data["credits_cents"] == 500  # $5 for new registered users
    assert "user_id" in data


@pytest.mark.asyncio
@patch("main.verify_id_token", new_callable=AsyncMock, return_value=FAKE_CLAIMS)
async def test_auth_login_existing_user(mock_verify, client):
    # First login
    resp1 = await client.post("/auth/login", json={"token": "fake-token", "username": "jay"})
    user_id = resp1.json()["user_id"]

    # Second login — same user
    resp2 = await client.post("/auth/login", json={"token": "fake-token", "username": "jay"})
    assert resp2.status_code == 200
    assert resp2.json()["user_id"] == user_id  # same user


@pytest.mark.asyncio
@patch("main.verify_id_token", new_callable=AsyncMock, return_value=FAKE_CLAIMS)
async def test_auth_login_updates_username(mock_verify, client):
    await client.post("/auth/login", json={"token": "fake-token", "username": "oldname"})
    resp = await client.post("/auth/login", json={"token": "fake-token", "username": "newname"})
    assert resp.json()["username"] == "newname"


@pytest.mark.asyncio
@patch("main.verify_id_token", new_callable=AsyncMock, return_value={"sub": None})
async def test_auth_login_missing_sub(mock_verify, client):
    resp = await client.post("/auth/login", json={"token": "bad-token", "username": "x"})
    assert resp.status_code == 401


@pytest.mark.asyncio
@patch("main.verify_id_token", new_callable=AsyncMock, return_value=FAKE_CLAIMS)
async def test_auth_login_derives_name_from_token(mock_verify, client):
    """When username is blank, derive from Auth0 claims."""
    resp = await client.post("/auth/login", json={"token": "fake-token", "username": ""})
    assert resp.status_code == 200
    assert resp.json()["username"] == "jay"  # from nickname claim

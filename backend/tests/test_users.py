"""Tests for user CRUD endpoints."""

import pytest


@pytest.mark.asyncio
async def test_create_user(client):
    resp = await client.post("/users", json={"username": "testuser"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["username"] == "testuser"
    assert "user_id" in data
    assert data["is_online"] is True


@pytest.mark.asyncio
async def test_create_user_empty_name(client):
    """Empty username should be rejected by min_length=1 validation."""
    resp = await client.post("/users", json={"username": ""})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_online_users_empty(client):
    resp = await client.get("/users/online")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_online_users_returns_created(client):
    await client.post("/users", json={"username": "alice"})
    resp = await client.get("/users/online")
    assert resp.status_code == 200
    users = resp.json()
    assert len(users) == 1
    assert users[0]["username"] == "alice"


@pytest.mark.asyncio
async def test_create_multiple_users(client):
    await client.post("/users", json={"username": "alice"})
    await client.post("/users", json={"username": "bob"})
    resp = await client.get("/users/online")
    assert resp.status_code == 200
    names = {u["username"] for u in resp.json()}
    assert names == {"alice", "bob"}

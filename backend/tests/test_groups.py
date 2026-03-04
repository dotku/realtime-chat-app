"""Tests for group CRUD endpoints."""

import pytest
from database import User


@pytest.fixture
def two_users(db):
    u1 = User(user_id="u1", username="alice", is_online=True)
    u2 = User(user_id="u2", username="bob", is_online=True)
    db.add_all([u1, u2])
    db.commit()
    return u1, u2


@pytest.mark.asyncio
async def test_create_group(client, two_users):
    resp = await client.post("/groups", json={
        "name": "Test Group",
        "icon": "🎮",
        "created_by": "u1",
        "member_ids": ["u2"],
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "Test Group"
    assert data["icon"] == "🎮"
    assert "u1" in data["members"]
    assert "u2" in data["members"]
    assert data["group_id"].startswith("group:")


@pytest.mark.asyncio
async def test_get_user_groups(client, two_users):
    # Create a group first
    await client.post("/groups", json={
        "name": "Group A",
        "created_by": "u1",
        "member_ids": ["u2"],
    })

    resp = await client.get("/groups/u1")
    assert resp.status_code == 200
    groups = resp.json()
    assert len(groups) == 1
    assert groups[0]["name"] == "Group A"


@pytest.mark.asyncio
async def test_get_groups_empty(client, sample_user):
    resp = await client.get(f"/groups/{sample_user.user_id}")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_add_group_member(client, db, two_users):
    u3 = User(user_id="u3", username="charlie", is_online=True)
    db.add(u3)
    db.commit()

    # Create group with u1, u2
    create_resp = await client.post("/groups", json={
        "name": "Trio",
        "created_by": "u1",
        "member_ids": ["u2"],
    })
    group_id = create_resp.json()["group_id"]

    # Add u3
    resp = await client.post(f"/groups/{group_id}/members", json={"user_id": "u3"})
    assert resp.status_code == 200
    assert "u3" in resp.json()["members"]


@pytest.mark.asyncio
async def test_add_duplicate_member(client, two_users):
    create_resp = await client.post("/groups", json={
        "name": "Dup Test",
        "created_by": "u1",
        "member_ids": ["u2"],
    })
    group_id = create_resp.json()["group_id"]

    resp = await client.post(f"/groups/{group_id}/members", json={"user_id": "u2"})
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_add_member_nonexistent_group(client, two_users):
    resp = await client.post("/groups/group:nonexistent/members", json={"user_id": "u1"})
    assert resp.status_code == 404

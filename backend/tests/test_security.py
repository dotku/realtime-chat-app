"""Tests for security hardening: rate limits, headers, CORS, validation, idempotency."""

import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timedelta

from main import _is_duplicate_event, _processed_events
from connection_manager import ConnectionManager, MAX_CONNECTIONS_PER_IP


# ── Security headers ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_security_headers(client):
    resp = await client.get("/ping")
    assert resp.headers.get("x-content-type-options") == "nosniff"
    assert resp.headers.get("x-frame-options") == "DENY"
    assert resp.headers.get("x-xss-protection") == "1; mode=block"
    assert resp.headers.get("referrer-policy") == "strict-origin-when-cross-origin"


# ── Input validation ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_username_too_long(client):
    resp = await client.post("/users", json={"username": "x" * 51})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_username_min_length(client):
    resp = await client.post("/users", json={"username": ""})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_username_valid(client):
    resp = await client.post("/users", json={"username": "a" * 50})
    assert resp.status_code == 200


# ── Webhook idempotency ──────────────────────────────────────────────────────

def test_duplicate_event_detection():
    _processed_events.clear()
    assert _is_duplicate_event("evt_001") is False  # first time
    assert _is_duplicate_event("evt_001") is True   # duplicate
    assert _is_duplicate_event("evt_002") is False  # different event


def test_event_ttl_pruning():
    _processed_events.clear()
    # Insert an old event manually
    _processed_events["evt_old"] = datetime.utcnow() - timedelta(hours=25)
    # New event triggers pruning
    _is_duplicate_event("evt_new")
    assert "evt_old" not in _processed_events
    assert "evt_new" in _processed_events


@pytest.mark.asyncio
@patch("main.stripe.Webhook.construct_event")
async def test_webhook_idempotency(mock_construct, client, db, sample_user):
    """Same event ID should be processed only once."""
    import os
    os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_test"
    _processed_events.clear()

    event = {
        "id": "evt_test_dup",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_test",
                "payment_status": "paid",
                "metadata": {"user_id": "user-1", "credit_cents": "100"},
            }
        },
    }
    mock_construct.return_value = event

    try:
        # First call processes
        resp1 = await client.post("/stripe/webhook", content=b"body", headers={"stripe-signature": "sig"})
        assert resp1.status_code == 200
        assert resp1.json().get("duplicate") is None or resp1.json().get("duplicate") is not True

        # Second call skipped as duplicate
        resp2 = await client.post("/stripe/webhook", content=b"body", headers={"stripe-signature": "sig"})
        assert resp2.status_code == 200
        assert resp2.json().get("duplicate") is True
    finally:
        os.environ.pop("STRIPE_WEBHOOK_SECRET", None)
        _processed_events.clear()


# ── WebSocket connection limits ───────────────────────────────────────────────

def test_ip_connection_limit():
    mgr = ConnectionManager()
    # Should allow up to MAX_CONNECTIONS_PER_IP
    for i in range(MAX_CONNECTIONS_PER_IP):
        assert mgr.check_ip_limit("1.2.3.4") is True
        mgr._ip_connections["1.2.3.4"] += 1
    assert mgr.check_ip_limit("1.2.3.4") is False
    # Different IP should still be allowed
    assert mgr.check_ip_limit("5.6.7.8") is True


def test_ip_cleanup_on_disconnect():
    mgr = ConnectionManager()
    mgr._ip_connections["1.2.3.4"] = 2
    mgr._user_ips["u1"] = "1.2.3.4"
    mgr._user_ips["u2"] = "1.2.3.4"
    mgr.active_connections["u1"] = "ws_fake"
    mgr.user_names["u1"] = "alice"

    mgr.disconnect("u1")
    assert mgr._ip_connections["1.2.3.4"] == 1

    mgr.active_connections["u2"] = "ws_fake"
    mgr.user_names["u2"] = "bob"
    mgr.disconnect("u2")
    assert "1.2.3.4" not in mgr._ip_connections  # cleaned up when hits 0


# ── Request size limit ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_request_size_limit(client):
    """Requests over 10MB should be rejected."""
    resp = await client.post(
        "/users",
        json={"username": "test"},
        headers={"content-length": str(11 * 1024 * 1024)},
    )
    assert resp.status_code == 413

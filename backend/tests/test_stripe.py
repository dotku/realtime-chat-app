"""Tests for Stripe payment endpoints."""

import pytest
from unittest.mock import patch, MagicMock
import json

from database import User


@pytest.mark.asyncio
async def test_buy_credits_no_stripe_key(client, sample_user):
    import os
    old = os.environ.get("STRIPE_SECRET_KEY")
    os.environ.pop("STRIPE_SECRET_KEY", None)
    try:
        resp = await client.post("/stripe/buy-credits", json={
            "user_id": "user-1",
            "amount_dollars": 5,
        })
        assert resp.status_code == 503
        assert "not configured" in resp.json()["detail"]
    finally:
        if old:
            os.environ["STRIPE_SECRET_KEY"] = old


@pytest.mark.asyncio
@patch("main.stripe.checkout.Session.create")
async def test_buy_credits_success(mock_create, client, sample_user):
    import os
    os.environ["STRIPE_SECRET_KEY"] = "sk_test_fake"
    mock_create.return_value = MagicMock(url="https://checkout.stripe.com/test")

    try:
        resp = await client.post(
            "/stripe/buy-credits",
            json={"user_id": "user-1", "amount_dollars": 10},
        )
        assert resp.status_code == 200
        assert resp.json()["checkout_url"] == "https://checkout.stripe.com/test"
        # Verify correct amount
        call_kwargs = mock_create.call_args.kwargs
        assert call_kwargs["line_items"][0]["price_data"]["unit_amount"] == 1000
    finally:
        os.environ.pop("STRIPE_SECRET_KEY", None)


@pytest.mark.asyncio
@patch("main.stripe.checkout.Session.create")
async def test_buy_credits_clamps_amount(mock_create, client, sample_user):
    """Amount should be clamped between $5 and $200."""
    import os
    os.environ["STRIPE_SECRET_KEY"] = "sk_test_fake"
    mock_create.return_value = MagicMock(url="https://checkout.stripe.com/test")

    try:
        resp = await client.post(
            "/stripe/buy-credits",
            json={"user_id": "user-1", "amount_dollars": 1},  # below min
        )
        assert resp.status_code == 200
        call_kwargs = mock_create.call_args.kwargs
        assert call_kwargs["line_items"][0]["price_data"]["unit_amount"] == 500  # clamped to $5
    finally:
        os.environ.pop("STRIPE_SECRET_KEY", None)


@pytest.mark.asyncio
async def test_checkout_no_config(client):
    import os
    os.environ.pop("STRIPE_SECRET_KEY", None)
    os.environ.pop("STRIPE_PRICE_ID", None)
    resp = await client.post("/stripe/checkout", json={"user_id": "user-1"})
    assert resp.status_code == 503


@pytest.mark.asyncio
@patch("main.stripe.Webhook.construct_event")
async def test_webhook_credits(mock_construct, client, db, sample_user):
    """Webhook should add credits to user."""
    initial_credits = sample_user.credits_cents or 0

    mock_construct.return_value = {
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_test_123",
                "payment_status": "paid",
                "metadata": {
                    "user_id": "user-1",
                    "credit_cents": "500",
                },
            }
        },
    }

    import os
    os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_test"

    try:
        resp = await client.post(
            "/stripe/webhook",
            content=b"raw-body",
            headers={"stripe-signature": "fake-sig"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"received": True}

        # Verify credits were added
        db.refresh(sample_user)
        assert sample_user.credits_cents == initial_credits + 500
    finally:
        os.environ.pop("STRIPE_WEBHOOK_SECRET", None)


@pytest.mark.asyncio
@patch("main.stripe.Webhook.construct_event")
async def test_webhook_membership(mock_construct, client, db, sample_user):
    """Webhook without credit_cents should grant membership."""
    mock_construct.return_value = {
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_test_456",
                "payment_status": "paid",
                "metadata": {"user_id": "user-1"},
            }
        },
    }

    import os
    os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_test"

    try:
        resp = await client.post(
            "/stripe/webhook",
            content=b"raw-body",
            headers={"stripe-signature": "fake-sig"},
        )
        assert resp.status_code == 200
        db.refresh(sample_user)
        assert sample_user.is_member is True
    finally:
        os.environ.pop("STRIPE_WEBHOOK_SECRET", None)


@pytest.mark.asyncio
@patch("main.stripe.Webhook.construct_event")
async def test_webhook_unpaid_ignored(mock_construct, client, db, sample_user):
    """Checkout with payment_status != paid should be ignored."""
    initial_credits = sample_user.credits_cents or 0

    mock_construct.return_value = {
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_test_789",
                "payment_status": "unpaid",
                "metadata": {"user_id": "user-1", "credit_cents": "500"},
            }
        },
    }

    import os
    os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_test"

    try:
        resp = await client.post(
            "/stripe/webhook",
            content=b"raw-body",
            headers={"stripe-signature": "fake-sig"},
        )
        assert resp.status_code == 200
        db.refresh(sample_user)
        assert sample_user.credits_cents == initial_credits  # unchanged
    finally:
        os.environ.pop("STRIPE_WEBHOOK_SECRET", None)

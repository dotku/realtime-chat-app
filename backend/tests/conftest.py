"""Shared fixtures for backend tests.

Uses an in-memory SQLite database so tests never touch PostgreSQL.
"""

import os
import sys

# Ensure the backend package root is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Override DATABASE_URL *before* importing anything that reads it
os.environ["DATABASE_URL"] = "sqlite:///file::memory:?cache=shared"
os.environ["AUTH0_DOMAIN"] = "test.auth0.com"
os.environ["AUTH0_CLIENT_ID"] = "test-client-id"
os.environ["GATEWAY_API_KEY"] = "test-gateway-key"

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from httpx import AsyncClient, ASGITransport

from database import Base, User, Group, GroupMember, ChatMessage
from main import app, get_db  # get_db is imported from database but used via Depends


# ---------------------------------------------------------------------------
# SQLite in-memory engine (shared cache so multiple connections see same data)
# ---------------------------------------------------------------------------
TEST_DB_URL = "sqlite:///file::memory:?cache=shared&uri=true"
test_engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False})

# SQLite doesn't support "IF NOT EXISTS" on ALTER TABLE.  We only need
# create_all — the startup migration in main.py is PostgreSQL-specific.
Base.metadata.create_all(bind=test_engine)

TestSession = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)


# Enable WAL mode & foreign keys for SQLite
@event.listens_for(test_engine, "connect")
def _set_sqlite_pragma(dbapi_conn, connection_record):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


# ---------------------------------------------------------------------------
# Dependency override: replace PostgreSQL session with SQLite session
# ---------------------------------------------------------------------------
def _override_get_db():
    db = TestSession()
    try:
        yield db
    finally:
        db.close()


# We need to import get_db from database to override it properly
from database import get_db as _db_get_db  # noqa: E402

app.dependency_overrides[_db_get_db] = _override_get_db


@pytest.fixture(autouse=True)
def _clean_tables():
    """Truncate all rows between tests so they don't leak state."""
    yield
    db = TestSession()
    for table in reversed(Base.metadata.sorted_tables):
        db.execute(table.delete())
    db.commit()
    db.close()


@pytest.fixture
def db():
    """Provide a test database session."""
    session = TestSession()
    yield session
    session.close()


@pytest.fixture
def client():
    """Async HTTP test client for the FastAPI app."""
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture
def sample_user(db):
    """Create and return a sample user in the DB."""
    user = User(
        user_id="user-1",
        username="alice",
        is_online=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def registered_user(db):
    """Create a registered (non-anonymous) user with auth0_sub."""
    user = User(
        user_id="user-reg",
        username="bob",
        is_online=True,
        auth0_sub="google-oauth2|12345",
        credits_cents=500,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user

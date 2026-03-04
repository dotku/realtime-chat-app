const DB_NAME = 'SphareChatDB';
const DB_VERSION = 2;
const STORE_NAME = 'messages';

let _db = null;

function getDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      let store;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        store = db.createObjectStore(STORE_NAME, { keyPath: '_idbId', autoIncrement: true });
        store.createIndex('byUserId', 'userId');
        store.createIndex('byMessageId', 'message_id');
      } else {
        store = event.target.transaction.objectStore(STORE_NAME);
        if (!store.indexNames.contains('byMessageId')) {
          store.createIndex('byMessageId', 'message_id');
        }
      }
    };
    req.onsuccess = ({ target: { result } }) => {
      _db = result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function getStorageLimitBytes() {
  return parseInt(localStorage.getItem('chat_storageLimit_mb') || '200') * 1024 * 1024;
}

async function pruneIfNeeded(db, userId, limitBytes) {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.index('byUserId').getAll(userId);
    req.onsuccess = () => {
      const records = req.result;
      let total = records.reduce((s, r) => s + JSON.stringify(r).length, 0);
      if (total <= limitBytes) return;
      records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      for (const rec of records) {
        if (total <= limitBytes * 0.85) break; // prune to 85% to avoid thrashing
        total -= JSON.stringify(rec).length;
        store.delete(rec._idbId);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function saveMessage(msg, userId) {
  const db = await getDB();
  // Skip duplicates by message_id
  if (msg.message_id) {
    const existing = await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const idx = tx.objectStore(STORE_NAME).index('byMessageId');
      const req = idx.get(msg.message_id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (existing) return existing._idbId;
  }
  const limitBytes = getStorageLimitBytes();
  await pruneIfNeeded(db, userId, limitBytes);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add({ ...msg, userId }).onsuccess = (e) => resolve(e.target.result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadMessages(userId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).index('byUserId').getAll(userId);
    req.onsuccess = () => {
      resolve(req.result.map(({ _idbId, userId: _, ...msg }) => msg));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearMessages(userId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.index('byUserId').openKeyCursor(IDBKeyRange.only(userId)).onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getStorageUsage(userId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).index('byUserId').getAll(userId);
    req.onsuccess = () => {
      const size = req.result.reduce((sum, r) => sum + JSON.stringify(r).length, 0);
      resolve(size);
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Server message fetching ──────────────────────────────────────────────────

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export async function fetchMessagesFromServer(conversationId, userId, before = null, limit = 50) {
  const params = new URLSearchParams({ user_id: userId, limit: String(limit) });
  if (before) params.set('before', before);
  const res = await fetch(`${API_URL}/messages/${encodeURIComponent(conversationId)}?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
  return res.json(); // { messages, has_more, oldest_timestamp }
}

export function makeConversationId(userId, otherUserId, groupId = null) {
  if (groupId) return groupId;
  const pair = [userId, otherUserId].sort();
  return `dm:${pair[0]}:${pair[1]}`;
}

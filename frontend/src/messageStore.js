const DB_NAME = 'SphareChatDB';
const DB_VERSION = 1;
const STORE_NAME = 'messages';

let _db = null;

function getDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = ({ target: { result: db } }) => {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: '_idbId', autoIncrement: true });
        store.createIndex('byUserId', 'userId');
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

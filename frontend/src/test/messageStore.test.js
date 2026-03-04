import { describe, it, expect, beforeEach } from 'vitest';
import { saveMessage, loadMessages, clearMessages, getStorageUsage, makeConversationId } from '../messageStore';

// fake-indexeddb is loaded via setup.js — provides global indexedDB

beforeEach(async () => {
  // Clear all messages for test users so state doesn't leak
  try {
    await clearMessages('user1');
    await clearMessages('user2');
  } catch { /* first run — DB not yet created */ }
});

describe('messageStore', () => {
  it('saves and loads a message', async () => {
    const msg = { message_id: 'm1', content: 'hello', from_user: 'a', to_user: 'b', timestamp: new Date().toISOString() };
    await saveMessage(msg, 'user1');
    const loaded = await loadMessages('user1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe('hello');
  });

  it('deduplicates by message_id', async () => {
    const msg = { message_id: 'dup1', content: 'hi', timestamp: new Date().toISOString() };
    await saveMessage(msg, 'user1');
    await saveMessage(msg, 'user1');
    const loaded = await loadMessages('user1');
    expect(loaded).toHaveLength(1);
  });

  it('isolates messages by userId', async () => {
    await saveMessage({ message_id: 'm1', content: 'for user1', timestamp: new Date().toISOString() }, 'user1');
    await saveMessage({ message_id: 'm2', content: 'for user2', timestamp: new Date().toISOString() }, 'user2');
    expect(await loadMessages('user1')).toHaveLength(1);
    expect(await loadMessages('user2')).toHaveLength(1);
  });

  it('clears messages for a specific user', async () => {
    await saveMessage({ message_id: 'm1', content: 'a', timestamp: new Date().toISOString() }, 'user1');
    await saveMessage({ message_id: 'm2', content: 'b', timestamp: new Date().toISOString() }, 'user2');
    await clearMessages('user1');
    expect(await loadMessages('user1')).toHaveLength(0);
    expect(await loadMessages('user2')).toHaveLength(1);
  });

  it('reports storage usage', async () => {
    const before = await getStorageUsage('user1');
    expect(before).toBe(0);
    await saveMessage({ message_id: 'm1', content: 'hello world', timestamp: new Date().toISOString() }, 'user1');
    const after = await getStorageUsage('user1');
    expect(after).toBeGreaterThan(0);
  });
});

describe('makeConversationId', () => {
  it('returns group_id for group conversations', () => {
    expect(makeConversationId('a', 'b', 'group:123')).toBe('group:123');
  });

  it('produces canonical dm IDs', () => {
    expect(makeConversationId('b', 'a')).toBe(makeConversationId('a', 'b'));
  });

  it('dm IDs start with dm:', () => {
    expect(makeConversationId('x', 'y')).toMatch(/^dm:/);
  });
});

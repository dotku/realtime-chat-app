import { describe, it, expect, beforeEach } from 'vitest';
import { loadAgentsFromStorage, saveAgentsToStorage } from '../utils/agentStorage';

beforeEach(() => {
  localStorage.clear();
});

describe('agentStorage', () => {
  it('returns empty array when nothing stored', () => {
    expect(loadAgentsFromStorage()).toEqual([]);
  });

  it('round-trips agents through localStorage', () => {
    const agents = [
      { id: '1', name: 'Agent A', model: 'gpt-4o' },
      { id: '2', name: 'Agent B', model: 'claude-3' },
    ];
    saveAgentsToStorage(agents);
    expect(loadAgentsFromStorage()).toEqual(agents);
  });

  it('handles corrupted JSON gracefully', () => {
    localStorage.setItem('chat_agents', '{invalid json}');
    expect(loadAgentsFromStorage()).toEqual([]);
  });

  it('overwrites previous data on save', () => {
    saveAgentsToStorage([{ id: '1', name: 'Old' }]);
    saveAgentsToStorage([{ id: '2', name: 'New' }]);
    const loaded = loadAgentsFromStorage();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('New');
  });
});

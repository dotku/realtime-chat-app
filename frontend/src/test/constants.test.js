import { describe, it, expect } from 'vitest';
import {
  POPULAR_MODELS, PROVIDER_STYLES, DEFAULT_AGENTS,
  makeAiUser, makeAgentUser,
} from '../utils/constants';

describe('POPULAR_MODELS', () => {
  it('has at least 5 models', () => {
    expect(POPULAR_MODELS.length).toBeGreaterThanOrEqual(5);
  });

  it('each model has id, name, provider', () => {
    for (const m of POPULAR_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.provider).toBeTruthy();
    }
  });
});

describe('PROVIDER_STYLES', () => {
  it('has styles for all model providers', () => {
    const providers = new Set(POPULAR_MODELS.map(m => m.provider));
    for (const p of providers) {
      expect(PROVIDER_STYLES[p]).toBeDefined();
      expect(PROVIDER_STYLES[p].bg).toBeTruthy();
    }
  });
});

describe('DEFAULT_AGENTS', () => {
  it('has at least one default agent', () => {
    expect(DEFAULT_AGENTS.length).toBeGreaterThanOrEqual(1);
  });

  it('each agent has required fields', () => {
    for (const a of DEFAULT_AGENTS) {
      expect(a.id).toBeTruthy();
      expect(a.name).toBeTruthy();
      expect(a.model).toBeTruthy();
    }
  });
});

describe('makeAiUser', () => {
  it('creates an AI user with correct fields', () => {
    const model = POPULAR_MODELS[0];
    const user = makeAiUser(model);
    expect(user.user_id).toBe(`ai:${model.id}`);
    expect(user.username).toBe(model.name);
    expect(user.type).toBe('ai');
    expect(user.provider).toBe(model.provider);
    expect(user.model).toBe(model.id);
  });
});

describe('makeAgentUser', () => {
  it('creates an agent user with correct fields', () => {
    const agent = { id: 'test', name: 'Test Agent', model: 'gpt-4o', icon: '🤖', systemPrompt: 'Be helpful' };
    const user = makeAgentUser(agent);
    expect(user.user_id).toBe('agent:test');
    expect(user.username).toBe('Test Agent');
    expect(user.type).toBe('agent');
    expect(user.icon).toBe('🤖');
    expect(user.systemPrompt).toBe('Be helpful');
  });

  it('defaults icon to 🛠 if not provided', () => {
    const agent = { id: 'x', name: 'X', model: 'm' };
    const user = makeAgentUser(agent);
    expect(user.icon).toBe('🛠');
  });
});

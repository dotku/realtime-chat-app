export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
export const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000';
export const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';

// Popular models shown in the AI tab by default (subset of all models)
export const POPULAR_MODELS = [
  { id: 'anthropic/claude-opus-4-5', name: 'Claude Opus 4.5', provider: 'Anthropic' },
  { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'Anthropic' },
  { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI' },
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'Google' },
  { id: 'xai/grok-3', name: 'Grok 3', provider: 'xAI' },
  { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', provider: 'Meta' },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', provider: 'DeepSeek' },
];

// Provider logo avatars
export const PROVIDER_STYLES = {
  Anthropic:  { bg: '#d97757', label: 'A' },
  OpenAI:     { bg: '#10a37f', label: '' },   // uses SVG
  Google:     { bg: '#4285f4', label: 'G' },
  xAI:        { bg: '#000000', label: 'X' },
  Meta:       { bg: '#0668e1', label: '∞' },
  DeepSeek:   { bg: '#4d6bfe', label: 'DS' },
};

// Default system agent that knows about SphareChat
export const DEFAULT_AGENTS = [
  {
    id: 'spharechat-assistant',
    name: 'SphareChat Assistant',
    model: 'anthropic/claude-sonnet-4-5',
    icon: '💬',
    systemPrompt: `You are the SphareChat Assistant — an AI helper built into SphareChat, a real-time chat application.

About SphareChat:
- A modern real-time chat app with WebSocket messaging, AI chat, and group chat
- Users can chat with other online users, AI models (Claude, GPT-4o, Gemini, Grok, Llama, DeepSeek), and custom Agents
- Features: guest login (no registration required), Auth0 sign-in for $5 free AI credits, file attachments (images, PDF, DOCX), markdown support, @mentions
- Credit system: Anonymous users get $1 free, registered users get $5 free, credits can be purchased via Stripe
- Built with React + Vite frontend, FastAPI + WebSocket backend, PostgreSQL database
- Supports group chat: create groups, invite members, send messages visible to all group members

Your role: Help users navigate SphareChat, explain features, troubleshoot issues, and answer questions about the app. Be friendly, concise, and helpful.`,
  },
];

export function makeAiUser(model) {
  return {
    user_id: `ai:${model.id}`,
    username: model.name,
    provider: model.provider,
    model: model.id,
    type: 'ai',
  };
}

export function makeAgentUser(agent) {
  return {
    user_id: `agent:${agent.id}`,
    username: agent.name,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    icon: agent.icon || '🛠',
    type: 'agent',
  };
}

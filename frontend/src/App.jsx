import { useState, useEffect, useRef } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './App.css';
import { saveMessage, loadMessages, clearMessages, getStorageUsage } from './messageStore';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000';
const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';

// Popular models shown in the AI tab by default (subset of all models)
const POPULAR_MODELS = [
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
const PROVIDER_STYLES = {
  Anthropic:  { bg: '#d97757', label: 'A' },
  OpenAI:     { bg: '#10a37f', label: '' },   // uses SVG
  Google:     { bg: '#4285f4', label: 'G' },
  xAI:        { bg: '#000000', label: 'X' },
  Meta:       { bg: '#0668e1', label: '∞' },
  DeepSeek:   { bg: '#4d6bfe', label: 'DS' },
};

function ProviderLogo({ provider }) {
  const style = PROVIDER_STYLES[provider] || { bg: '#888', label: '?' };
  // OpenAI special SVG
  if (provider === 'OpenAI') {
    return (
      <div className="provider-logo" style={{ background: style.bg }}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="white">
          <path d="M22.282 9.821a5.985 5.985 0 00-.516-4.91 6.046 6.046 0 00-6.51-2.9A6.065 6.065 0 0011.67.014a6.048 6.048 0 00-5.771 4.17 5.985 5.985 0 00-3.998 2.9 6.046 6.046 0 00.743 7.097 5.98 5.98 0 00.51 4.911 6.051 6.051 0 006.515 2.9A5.985 5.985 0 0013.26 23.1a6.043 6.043 0 005.77-4.175 5.985 5.985 0 003.997-2.9 6.046 6.046 0 00-.745-6.204z"/>
        </svg>
      </div>
    );
  }
  return (
    <div className="provider-logo" style={{ background: style.bg }}>
      <span>{style.label}</span>
    </div>
  );
}

function makeAiUser(model) {
  return {
    user_id: `ai:${model.id}`,
    username: model.name,
    provider: model.provider,
    model: model.id,
    type: 'ai',
  };
}

// Default system agent that knows about SphareChat
const DEFAULT_AGENTS = [
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

function makeAgentUser(agent) {
  return {
    user_id: `agent:${agent.id}`,
    username: agent.name,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    icon: agent.icon || '🛠',
    type: 'agent',
  };
}

function loadAgentsFromStorage() {
  try {
    return JSON.parse(localStorage.getItem('chat_agents') || '[]');
  } catch { return []; }
}

function saveAgentsToStorage(agents) {
  localStorage.setItem('chat_agents', JSON.stringify(agents));
}

function App() {
  const {
    loginWithRedirect,
    logout: auth0Logout,
    user: auth0User,
    isAuthenticated,
    isLoading: auth0Loading,
    error: auth0Error,
    getIdTokenClaims,
  } = useAuth0();

  // Temporary debug — remove after fixing auth issue
  console.log('[Auth0]', { isAuthenticated, auth0Loading, auth0Error, auth0User: auth0User?.email });

  // Auth & connection
  const [username, setUsername] = useState(() => localStorage.getItem('chat_username') || '');
  const [userId, setUserId] = useState(() => localStorage.getItem('chat_userId') || null);
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [serverStatus, setServerStatus] = useState('checking');

  // Chat
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [unreadCounts, setUnreadCounts] = useState({});
  const [pendingAttachment, setPendingAttachment] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState(null); // null | { code, isAnonymous }
  const [userCredits, setUserCredits] = useState(null);    // cents, null = not yet loaded
  const [userIsAnonymous, setUserIsAnonymous] = useState(true);
  const [userPicture, setUserPicture] = useState(null);    // Google/social profile pic URL
  const [userEmail, setUserEmail] = useState(null);

  // Sidebar
  const [activeTab, setActiveTab] = useState('users'); // 'users' | 'ai' | 'agents'
  const [showSettings, setShowSettings] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');

  // AI Models
  const [allModels, setAllModels] = useState([]);

  // Agents
  const [agents, setAgents] = useState(loadAgentsFromStorage);
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [agentDraft, setAgentDraft] = useState({ name: '', model: POPULAR_MODELS[0].id, systemPrompt: '', icon: '🛠' });

  // Groups
  const [groups, setGroups] = useState([]);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [groupDraft, setGroupDraft] = useState({ name: '', icon: '👥', memberIds: [] });

  // Settings / storage
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem('chat_sound') !== 'off');
  const [storageLimitMb, setStorageLimitMb] = useState(() => parseInt(localStorage.getItem('chat_storageLimit_mb') || '200'));
  const [storageUsage, setStorageUsage] = useState(0);

  // @mention autocomplete
  const [mentionQuery, setMentionQuery] = useState(null); // null | string

  // Refs
  const ws = useRef(null);
  const messagesEndRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const shouldReconnect = useRef(true);
  const hasEverConnectedRef = useRef(false); // stays true after first successful WS open
  const isConnectingRef = useRef(false);
  const wsUserIdRef = useRef(null); // tracks which user_id the current WS is connected with
  const selectedUserRef = useRef(null);
  const soundEnabledRef = useRef(soundEnabled);
  const fileInputRef = useRef(null);
  const messageInputRef = useRef(null);

  // ── Effects ─────────────────────────────────────────────────────────────────

  // Fetch user credit balance from backend
  const fetchCredits = async (uid) => {
    try {
      const res = await fetch(`${API_URL}/user/${uid}/credits`);
      if (!res.ok) return;
      const data = await res.json();
      setUserCredits(data.credits_cents);
      setUserIsAnonymous(data.is_anonymous);
    } catch { /* non-critical */ }
  };

  // Membership / credits success redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('membership') === 'success') {
      window.history.replaceState({}, '', window.location.pathname);
      setTimeout(() => alert('🎉 Welcome, member! You now have unlimited AI access.'), 300);
    }
    if (params.get('credits') === 'success') {
      window.history.replaceState({}, '', window.location.pathname);
      const uid = localStorage.getItem('chat_userId');
      if (uid) fetchCredits(uid);
      setTimeout(() => alert('✅ Credits added! Your balance has been updated.'), 300);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auth0 → backend sync: exchange ID token for a stable chat user_id
  useEffect(() => {
    if (!isAuthenticated || !auth0User) return;
    const sync = async () => {
      try {
        const claims = await getIdTokenClaims();
        const idToken = claims?.__raw;
        if (!idToken) return;
        const displayName =
          auth0User.nickname || auth0User.name || auth0User.email?.split('@')[0] || '';
        const res = await fetch(`${API_URL}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: idToken, username: displayName }),
        });
        if (!res.ok) { console.error('Auth login failed', await res.text()); return; }
        const data = await res.json();
        setUserId(data.user_id);
        setUsername(data.username);
        setUserCredits(data.credits_cents ?? null);
        setUserIsAnonymous(false);
        setUserPicture(auth0User.picture || null);
        setUserEmail(auth0User.email || null);
        localStorage.setItem('chat_userId', data.user_id);
        localStorage.setItem('chat_username', data.username);
        // Reconnect if: not already connecting AND (no connection yet OR connected with a different user_id)
        if (!isConnectingRef.current && wsUserIdRef.current !== data.user_id) {
          connectWebSocket(data.user_id, data.username);
        }
      } catch (err) { console.error('Auth sync error:', err); }
    };
    sync();
  }, [isAuthenticated, auth0User]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch credits whenever userId is first set (handles auto-connect path)
  useEffect(() => {
    if (userId && userCredits === null) fetchCredits(userId);
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Health check
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(5000) });
        setServerStatus(res.ok ? 'online' : 'offline');
      } catch { setServerStatus('offline'); }
    };
    check();
    const id = setInterval(check, 30000);
    return () => clearInterval(id);
  }, []);

  // Auto-connect using cached credentials on mount
  useEffect(() => {
    const uid = localStorage.getItem('chat_userId');
    const uname = localStorage.getItem('chat_username');
    if (uid && uname && !isConnectingRef.current && !ws.current) {
      connectWebSocket(uid, uname);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load persisted messages
  useEffect(() => {
    if (!userId) return;
    loadMessages(userId).then(msgs => {
      if (msgs.length > 0) {
        setMessages(prev => {
          if (prev.length > 0) {
            const seen = new Set(prev.map(m => `${m.from_user}-${m.to_user}-${m.timestamp}`));
            const newOnes = msgs.filter(m => !seen.has(`${m.from_user}-${m.to_user}-${m.timestamp}`));
            return [...newOnes, ...prev].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
          }
          return msgs;
        });
      }
    }).catch(console.error);
    getStorageUsage(userId).then(setStorageUsage).catch(() => {});
  }, [userId]);

  // Sync refs
  useEffect(() => { selectedUserRef.current = selectedUser; }, [selectedUser]);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);

  // Tab title
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce((s, n) => s + n, 0);
    document.title = total > 0 ? `(${total}) SphareChat` : 'SphareChat';
  }, [unreadCounts]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Fetch all models when AI tab opens
  useEffect(() => {
    if (activeTab !== 'ai' || allModels.length > 0) return;
    setModelsLoading(true);
    fetch(GATEWAY_MODELS_URL)
      .then(r => r.json())
      .then(data => {
        const models = (data.data || []).map(m => ({
          id: m.id,
          name: m.id.split('/').pop().replace(/-/g, ' '),
          provider: m.id.split('/')[0],
        }));
        setAllModels(models);
      })
      .catch(() => setAllModels(POPULAR_MODELS))
      .finally(() => setModelsLoading(false));
  }, [activeTab]);

  // ── Sound ────────────────────────────────────────────────────────────────────

  const playNotificationSound = () => {
    if (!soundEnabledRef.current) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    } catch { /* ignore */ }
  };

  // ── Auth ─────────────────────────────────────────────────────────────────────

  const generateRandomUsername = () => {
    const adj = ['Happy', 'Clever', 'Bright', 'Swift', 'Brave', 'Kind', 'Wise', 'Bold'];
    const noun = ['Panda', 'Eagle', 'Tiger', 'Dolphin', 'Fox', 'Wolf', 'Hawk', 'Bear'];
    return `${adj[~~(Math.random() * adj.length)]}${noun[~~(Math.random() * noun.length)]}${~~(Math.random() * 100)}`;
  };

  const handleJoin = async () => {
    const finalUsername = username.trim() || generateRandomUsername();
    try {
      const res = await fetch(`${API_URL}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: finalUsername }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to create user');
      }
      const data = await res.json();
      setUserId(data.user_id);
      setUsername(data.username);
      localStorage.setItem('chat_userId', data.user_id);
      localStorage.setItem('chat_username', data.username);
      connectWebSocket(data.user_id, data.username);
    } catch (err) {
      console.error(err);
      alert(err.message.includes('Database') ? 'Database unavailable. Check Docker/PostgreSQL.' : 'Failed to connect. Please try again.');
    }
  };

  // ── WebSocket ────────────────────────────────────────────────────────────────

  const connectWebSocket = (uid, uname) => {
    if (isConnectingRef.current) return;
    if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
    if (ws.current && ws.current.readyState !== WebSocket.CLOSED) {
      // Null out all handlers before closing so the old socket's onclose
      // doesn't fire and trigger a spurious reconnect (race condition).
      ws.current.onopen = null;
      ws.current.onmessage = null;
      ws.current.onclose = null;
      ws.current.onerror = null;
      ws.current.close();
      ws.current = null;
    }
    shouldReconnect.current = true;
    isConnectingRef.current = true;
    ws.current = new WebSocket(`${WS_URL}/ws/${uid}`);

    ws.current.onopen = () => {
      isConnectingRef.current = false;
      wsUserIdRef.current = uid;
      hasEverConnectedRef.current = true;
      setIsConnected(true);
      setIsReconnecting(false);
      setReconnectAttempts(0);
    };

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'error') { console.error('Server error:', data); return; }
      if (data.type === 'online_users') {
        setOnlineUsers(data.users.filter(u => u.user_id !== uid));
      } else if (data.type === 'user_joined') {
        setOnlineUsers(prev => prev.find(u => u.user_id === data.user_id) ? prev :
          [...prev, { user_id: data.user_id, username: data.username, is_online: true }]);
      } else if (data.type === 'user_left') {
        setOnlineUsers(prev => prev.filter(u => u.user_id !== data.user_id));
      } else if (data.type === 'chat') {
        setMessages(prev => [...prev, data]);
        saveMessage(data, uid).then(() =>
          getStorageUsage(uid).then(setStorageUsage).catch(() => {})).catch(console.error);
        // Use group_id as unread key for group messages, from_user for 1-to-1
        const unreadKey = data.group_id || data.from_user;
        if (unreadKey !== selectedUserRef.current?.user_id) {
          setUnreadCounts(prev => ({ ...prev, [unreadKey]: (prev[unreadKey] || 0) + 1 }));
          playNotificationSound();
        }
      } else if (data.type === 'user_groups') {
        setGroups(data.groups);
      } else if (data.type === 'group_created') {
        setGroups(prev => prev.find(g => g.group_id === data.group.group_id) ? prev : [...prev, data.group]);
      } else if (data.type === 'group_updated') {
        setGroups(prev => prev.map(g => g.group_id === data.group.group_id ? data.group : g));
      }
    };

    ws.current.onclose = async (event) => {
      isConnectingRef.current = false;
      setIsConnected(false);
      if (!shouldReconnect.current) return;
      if (event.code === 4004) {
        setIsReconnecting(true);
        try {
          const res = await fetch(`${API_URL}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: uname }),
          });
          if (res.ok) {
            const data = await res.json();
            setUserId(data.user_id);
            localStorage.setItem('chat_userId', data.user_id);
            localStorage.setItem('chat_username', uname);
            setReconnectAttempts(0);
            setTimeout(() => connectWebSocket(data.user_id, uname), 500);
            return;
          }
        } catch { /* fall through */ }
      }
      const maxAttempts = 10;
      setReconnectAttempts(prev => {
        const next = prev + 1;
        if (next > maxAttempts) { setIsReconnecting(false); shouldReconnect.current = false; alert('Unable to reconnect. Please refresh.'); return next; }
        setIsReconnecting(true);
        reconnectTimeoutRef.current = setTimeout(() => connectWebSocket(uid, uname), Math.min(1000 * Math.pow(2, next - 1), 30000));
        return next;
      });
    };

    ws.current.onerror = () => { isConnectingRef.current = false; };
  };

  useEffect(() => () => {
    shouldReconnect.current = false;
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    if (ws.current) {
      ws.current.onopen = null;
      ws.current.onmessage = null;
      ws.current.onclose = null;
      ws.current.onerror = null;
      ws.current.close();
      ws.current = null;
    }
  }, []);

  // ── Messaging ────────────────────────────────────────────────────────────────

  const sendMessage = async () => {
    if (!selectedUser) return;
    const text = messageInput.trim();
    if (!text && !pendingAttachment) return;

    const isAi = selectedUser.type === 'ai' || selectedUser.type === 'agent';

    if (isAi) {
      // Build local user message
      const userMsg = {
        type: 'chat',
        from_user: userId,
        from_username: username,
        to_user: selectedUser.user_id,
        content: text || (pendingAttachment?.name ?? ''),
        ...(pendingAttachment ? { attachment: pendingAttachment } : {}),
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => [...prev, userMsg]);
      saveMessage(userMsg, userId).catch(console.error);
      setMessageInput('');
      setPendingAttachment(null);
      if (fileInputRef.current) fileInputRef.current.value = '';

      // Collect conversation history for this AI
      setAiLoading(true);
      try {
        const history = messages
          .filter(m =>
            (m.from_user === userId && m.to_user === selectedUser.user_id) ||
            (m.from_user === selectedUser.user_id && m.to_user === userId)
          )
          .map(m => {
            // Re-attach image data for past messages so AI has full context
            if (m.attachment?.type?.startsWith('image/') && m.attachment.data) {
              const parts = [];
              if (m.content) parts.push({ type: 'text', text: m.content });
              parts.push({ type: 'image_url', image_url: { url: m.attachment.data } });
              return { role: m.from_user === userId ? 'user' : 'assistant', content: parts };
            }
            return { role: m.from_user === userId ? 'user' : 'assistant', content: m.content || '' };
          });

        // Build the new user turn with attachment if present
        let newUserContent;
        if (pendingAttachment) {
          if (pendingAttachment.type?.startsWith('image/')) {
            // Vision-capable models: send image as multimodal content block
            const parts = [];
            if (text) parts.push({ type: 'text', text });
            parts.push({ type: 'image_url', image_url: { url: pendingAttachment.data } });
            newUserContent = parts;
          } else if (pendingAttachment.extractedText !== undefined) {
            // DOCX with pre-extracted text (via mammoth)
            const excerpt = pendingAttachment.extractedText
              ? `${text ? text + '\n\n' : ''}[Document: ${pendingAttachment.name}]\n${pendingAttachment.extractedText}`
              : `${text ? text + '\n\n' : ''}[Document: ${pendingAttachment.name} — no readable text found]`;
            newUserContent = excerpt;
          } else if (pendingAttachment.type === 'text/plain') {
            // Decode base64 text and include inline
            try {
              const decoded = atob(pendingAttachment.data.split(',')[1]);
              newUserContent = `${text ? text + '\n\n' : ''}[File: ${pendingAttachment.name}]\n${decoded}`;
            } catch {
              newUserContent = `${text ? text + '\n\n' : ''}[File attached: ${pendingAttachment.name}]`;
            }
          } else {
            // Binary file (PDF, etc.) — AI cannot read binary directly
            newUserContent = `${text ? text + '\n\n' : ''}[Attached file: ${pendingAttachment.name} — binary format, cannot be read directly. Please paste the text content.]`;
          }
        } else {
          newUserContent = text;
        }
        history.push({ role: 'user', content: newUserContent });

        const res = await fetch(`${API_URL}/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: selectedUser.model,
            messages: history,
            system_prompt: selectedUser.systemPrompt || '',
            user_id: userId,
          }),
        });

        const data = await res.json();
        if (res.status === 402) {
          const detail = data.detail || {};
          setUpgradeReason({
            code: detail.code || 'NO_CREDITS',
            isAnonymous: detail.is_anonymous ?? userIsAnonymous,
          });
          setMessages(prev => prev.slice(0, -1)); // remove optimistic user message
          return;
        }
        if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : (data.detail?.message || 'AI error'));

        // Update credit balance from response
        if (data.credits_cents !== null && data.credits_cents !== undefined) {
          setUserCredits(data.credits_cents);
        }

        const aiMsg = {
          type: 'chat',
          from_user: selectedUser.user_id,
          from_username: selectedUser.username,
          to_user: userId,
          content: data.content,
          timestamp: new Date().toISOString(),
        };
        setMessages(prev => [...prev, aiMsg]);
        saveMessage(aiMsg, userId).catch(console.error);
        playNotificationSound();
      } catch (err) {
        const errMsg = {
          type: 'chat',
          from_user: selectedUser.user_id,
          from_username: selectedUser.username,
          to_user: userId,
          content: `⚠️ Error: ${err.message}`,
          timestamp: new Date().toISOString(),
          isError: true,
        };
        setMessages(prev => [...prev, errMsg]);
      } finally {
        setAiLoading(false);
      }
      return;
    }

    // Regular WebSocket message
    const message = {
      type: 'chat',
      to_user: selectedUser.user_id,
      content: text || (pendingAttachment?.name ?? ''),
    };
    if (pendingAttachment) message.attachment = pendingAttachment;
    ws.current.send(JSON.stringify(message));
    setMessageInput('');
    setPendingAttachment(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  // @mention autocomplete
  const handleInputChange = (e) => {
    const val = e.target.value;
    setMessageInput(val);
    const atIdx = val.lastIndexOf('@');
    if (atIdx !== -1) {
      const after = val.slice(atIdx + 1);
      if (!after.includes(' ')) { setMentionQuery(after.toLowerCase()); return; }
    }
    setMentionQuery(null);
  };

  const getMentionCandidates = () => {
    if (mentionQuery === null) return [];
    const q = mentionQuery;
    const users = onlineUsers
      .filter(u => u.username.toLowerCase().includes(q))
      .map(u => ({ label: u.username, value: u.username, type: 'user' }));
    const aiList = (allModels.length ? allModels : POPULAR_MODELS)
      .filter(m => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      .slice(0, 5)
      .map(m => ({ label: m.name, value: m.id.split('/').pop(), type: 'ai', model: m }));
    const agentList = agents
      .filter(a => a.name.toLowerCase().includes(q))
      .map(a => ({ label: a.name, value: a.name, type: 'agent', agent: a }));
    return [...users, ...aiList, ...agentList].slice(0, 8);
  };

  const applyMention = (candidate) => {
    const atIdx = messageInput.lastIndexOf('@');
    const before = messageInput.slice(0, atIdx);
    setMessageInput(`${before}@${candidate.value} `);
    setMentionQuery(null);
    messageInputRef.current?.focus();
    // If it's an AI or agent, also select that contact
    if (candidate.type === 'ai') selectContact(makeAiUser(candidate.model));
    if (candidate.type === 'agent') selectContact(makeAgentUser(candidate.agent));
  };

  // ── File attachment ──────────────────────────────────────────────────────────

  const extractPdfText = async (arrayBuffer) => {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str).join(' '));
    }
    return pages.join('\n\n').trim();
  };

  const handleFileSelect = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('File too large. Maximum 5MB.'); e.target.value = ''; return; }

    const isDocx = file.name.toLowerCase().endsWith('.docx') ||
      file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';

    if (isDocx) {
      // Extract plain text from DOCX using mammoth
      try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        const extractedText = result.value?.trim() || '';
        setPendingAttachment({ name: file.name, type: file.type, extractedText, data: null });
      } catch (err) {
        console.error('DOCX extraction failed:', err);
        alert('Could not read the Word document. Please copy-paste the content instead.');
        e.target.value = '';
      }
      return;
    }

    if (isPdf) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const extractedText = await extractPdfText(arrayBuffer);
        if (!extractedText) {
          // Scanned PDF — no selectable text
          setPendingAttachment({
            name: file.name, type: file.type,
            extractedText: '[Scanned PDF — no selectable text could be extracted. Please copy-paste the content manually.]',
            data: null,
          });
        } else {
          setPendingAttachment({ name: file.name, type: file.type, extractedText, data: null });
        }
      } catch (err) {
        console.error('PDF extraction failed:', err);
        alert('Could not read the PDF. Please copy-paste the content instead.');
        e.target.value = '';
      }
      return;
    }

    // All other files: read as data URL (images get base64 for display + AI; text decoded inline)
    const reader = new FileReader();
    reader.onload = ev => setPendingAttachment({ name: file.name, type: file.type, data: ev.target.result });
    reader.readAsDataURL(file);
  };

  // ── Contact selection ────────────────────────────────────────────────────────

  const selectContact = (user) => {
    setSelectedUser(user);
    setUnreadCounts(prev => ({ ...prev, [user.user_id]: 0 }));
    setActiveTab('users'); // keep sidebar visible but refocus chat
  };

  // ── Agents ───────────────────────────────────────────────────────────────────

  const saveAgent = () => {
    if (!agentDraft.name.trim()) return;
    const newAgent = { ...agentDraft, id: Date.now().toString() };
    const updated = [...agents, newAgent];
    setAgents(updated);
    saveAgentsToStorage(updated);
    setAgentDraft({ name: '', model: POPULAR_MODELS[0].id, systemPrompt: '', icon: '🛠' });
    setShowAgentForm(false);
  };

  const deleteAgent = (id) => {
    const updated = agents.filter(a => a.id !== id);
    setAgents(updated);
    saveAgentsToStorage(updated);
  };

  // ── Groups ──────────────────────────────────────────────────────────────────

  const handleCreateGroup = async () => {
    if (!groupDraft.name.trim()) return;
    try {
      const res = await fetch(`${API_URL}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: groupDraft.name,
          icon: groupDraft.icon,
          created_by: userId,
          member_ids: [userId, ...groupDraft.memberIds],
        }),
      });
      if (!res.ok) throw new Error('Failed to create group');
      const data = await res.json();
      // The backend sends group_created via WebSocket too, but add locally for instant feedback
      setGroups(prev => prev.find(g => g.group_id === data.group_id) ? prev : [...prev, data]);
      setGroupDraft({ name: '', icon: '👥', memberIds: [] });
      setShowGroupForm(false);
    } catch (err) {
      console.error(err);
      alert('Failed to create group.');
    }
  };

  // ── Settings / logout ────────────────────────────────────────────────────────

  const handleLogout = () => {
    shouldReconnect.current = false;
    if (ws.current) ws.current.close();
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    setUserId(null); setUsername(''); setIsConnected(false);
    setOnlineUsers([]); setSelectedUser(null); setMessages([]);
    setReconnectAttempts(0); setIsReconnecting(false);
    setUnreadCounts({}); setShowSettings(false); setPendingAttachment(null);
    localStorage.removeItem('chat_userId');
    localStorage.removeItem('chat_username');
    auth0Logout({ logoutParams: { returnTo: window.location.origin } });
  };

  const handleClearHistory = async () => {
    if (!confirm('Clear all message history? This cannot be undone.')) return;
    await clearMessages(userId);
    setMessages([]); setStorageUsage(0); setShowSettings(false);
  };

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    localStorage.setItem('chat_sound', next ? 'on' : 'off');
  };

  const handleLimitChange = (e) => {
    const mb = Math.max(10, Math.min(2000, parseInt(e.target.value) || 200));
    setStorageLimitMb(mb);
    localStorage.setItem('chat_storageLimit_mb', mb.toString());
  };

  const formatBytes = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`;

  const handleUpgradeMembership = async () => {
    try {
      const res = await fetch(`${API_URL}/stripe/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      });
      const data = await res.json();
      if (data.checkout_url) window.location.href = data.checkout_url;
      else throw new Error(data.detail || 'No checkout URL');
    } catch (err) {
      console.error('Checkout error:', err);
      alert('Unable to start checkout. Please try again.');
    }
  };


  const handleSignIn = () => {
    loginWithRedirect();
  };

  const handleBuyCredits = async (amountDollars = 5) => {
    try {
      const res = await fetch(`${API_URL}/stripe/buy-credits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, amount_dollars: amountDollars }),
      });
      const data = await res.json();
      if (data.checkout_url) window.location.href = data.checkout_url;
      else throw new Error(data.detail || 'No checkout URL');
    } catch (err) {
      console.error('Buy credits error:', err);
      alert('Unable to start checkout. Please try again.');
    }
  };

  // ── Derived ──────────────────────────────────────────────────────────────────

  const getMessagesForCurrentChat = () => {
    if (!selectedUser) return [];
    // Group chat: all messages sent to this group
    if (selectedUser.type === 'group') {
      return messages.filter(m => m.to_user === selectedUser.user_id);
    }
    return messages.filter(m =>
      (m.from_user === userId && m.to_user === selectedUser.user_id) ||
      (m.from_user === selectedUser.user_id && m.to_user === userId)
    );
  };

  const mentionCandidates = getMentionCandidates();

  // ── Login screen ─────────────────────────────────────────────────────────────

  // Waiting for Auth0 init or no user yet
  if (auth0Loading || (!isAuthenticated && !userId)) {
    return (
      <div className="login-container">
        <div className="login-box">
          <h1>SphareChat</h1>
          <div className={`server-status server-status--${serverStatus}`}>
            <span className="server-status-dot"></span>
            {serverStatus === 'checking' && 'Checking server...'}
            {serverStatus === 'online' && 'Server online'}
            {serverStatus === 'offline' && 'Server offline — please try later'}
          </div>
          {auth0Loading ? (
            <p className="auth-loading">Checking session...</p>
          ) : (
            <>
              {/* Guest entry */}
              <div className="guest-entry">
                <input
                  className="guest-name-input"
                  type="text"
                  placeholder="Enter your name (or leave blank)"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && serverStatus !== 'offline' && handleJoin()}
                  maxLength={30}
                />
                <button
                  className="join-button guest-join-btn"
                  onClick={handleJoin}
                  disabled={serverStatus === 'offline'}
                >
                  Start Chatting
                </button>
              </div>

              <div className="login-divider"><span>or</span></div>

              {/* Auth0 sign in for $5 credits */}
              <div className="login-promo">
                <p className="login-promo-text">🎁 Sign in for <strong>$5 free</strong> AI credits</p>
                <button
                  className="join-button auth0-login-btn"
                  onClick={() => loginWithRedirect()}
                  disabled={serverStatus === 'offline'}
                >
                  Sign in with Google
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Main app ─────────────────────────────────────────────────────────────────

  return (
    <div className="app-container">
      {!isConnected && (hasEverConnectedRef.current || reconnectAttempts > 0) && (
        <div className="reconnecting-banner">
          {reconnectAttempts > 0
            ? <>🔄 Reconnecting... (Attempt {reconnectAttempts}/10)</>
            : <>⚠️ Disconnected from server...</>}
        </div>
      )}

      {/* ── Sidebar ── */}
      <div className="sidebar">
        <div className="sidebar-header">
          {/* Row 1: Title | Notification | Settings */}
          <div className="sidebar-header-row1">
            <h2>SphareChat</h2>
            <div className="sidebar-header-actions">
              <button className={`icon-button ${soundEnabled ? '' : 'muted'}`} onClick={toggleSound}
                title={soundEnabled ? 'Mute' : 'Unmute'}>
                {soundEnabled ? '🔔' : '🔕'}
              </button>
              <button className={`icon-button ${showSettings ? 'active' : ''}`}
                onClick={() => setShowSettings(v => !v)} title="Settings">⚙️</button>
            </div>
          </div>
          {/* Row 2: Avatar | Name | Credit */}
          <div className="sidebar-header-row2">
            <button
              className="header-avatar-btn"
              onClick={() => isAuthenticated ? setShowProfile(true) : handleSignIn()}
              title={isAuthenticated ? 'View profile' : 'Sign in / Register'}
            >
              {userPicture ? (
                <img src={userPicture} alt={username} className="header-avatar-img" referrerPolicy="no-referrer" />
              ) : (
                <div className="header-avatar-initials">{username.charAt(0).toUpperCase()}</div>
              )}
            </button>
            {editingName ? (
              <input
                className="header-username-input"
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    const newName = draftName.trim();
                    if (newName && newName !== username) {
                      setUsername(newName);
                      localStorage.setItem('chat_username', newName);
                    }
                    setEditingName(false);
                  }
                  if (e.key === 'Escape') setEditingName(false);
                }}
                onBlur={() => {
                  const newName = draftName.trim();
                  if (newName && newName !== username) {
                    setUsername(newName);
                    localStorage.setItem('chat_username', newName);
                  }
                  setEditingName(false);
                }}
                maxLength={30}
                autoFocus
              />
            ) : (
              <span
                className="header-username"
                onClick={() => { setDraftName(username); setEditingName(true); }}
                title="Click to edit name"
              >
                {username} ✎
              </span>
            )}
            {userCredits !== null && (
              <span
                className={`credits-badge-mini ${userCredits < 20 ? 'credits-low' : ''}`}
                title="AI credits"
              >
                💳 ${(userCredits / 100).toFixed(2)}
              </span>
            )}
            {isAuthenticated && (
              <button className="icon-button" onClick={handleLogout} title="Sign out">🚪</button>
            )}
          </div>
        </div>

        {/* Auth0 error display */}
        {auth0Error && (
          <div style={{margin:'0.5rem 1rem',padding:'0.5rem',background:'#fee2e2',borderRadius:'8px',fontSize:'0.75rem',color:'#dc2626'}}>
            Auth error: {auth0Error.message} {auth0Error.error_description || ''}
          </div>
        )}

        {/* Subtle upgrade banner for anonymous guests */}
        {!auth0Loading && userIsAnonymous && !isAuthenticated && (
          <button className="upgrade-banner" onClick={handleSignIn}>
            🎁 Sign in for <strong>$5 free</strong> AI credits →
          </button>
        )}

        {/* Auth0 authenticated but backend sync pending */}
        {isAuthenticated && userIsAnonymous && (
          <div className="sync-banner">
            <span>Syncing your account...</span>
            <button className="sync-retry-btn" onClick={async () => {
              try {
                const claims = await getIdTokenClaims();
                const idToken = claims?.__raw;
                if (!idToken) return;
                const displayName = auth0User.nickname || auth0User.name || auth0User.email?.split('@')[0] || '';
                const res = await fetch(`${import.meta.env.VITE_API_URL}/auth/login`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ token: idToken, username: displayName }),
                });
                if (!res.ok) { alert('Server sync failed — backend may not be deployed yet.'); return; }
                const data = await res.json();
                setUserId(data.user_id);
                setUsername(data.username);
                setUserCredits(data.credits_cents ?? null);
                setUserIsAnonymous(false);
                setUserPicture(auth0User.picture || null);
                setUserEmail(auth0User.email || null);
                localStorage.setItem('chat_userId', data.user_id);
                localStorage.setItem('chat_username', data.username);
                if (wsUserIdRef.current !== data.user_id) connectWebSocket(data.user_id, data.username);
              } catch (err) { alert('Connection error: ' + err.message); }
            }}>Retry</button>
            <button className="signin-link-btn" onClick={handleLogout}>Sign out</button>
          </div>
        )}

        {showSettings && (
          <div className="settings-panel">
            <div className="settings-row">
              <span className="settings-label">Sound</span>
              <button className={`toggle-button ${soundEnabled ? 'on' : 'off'}`} onClick={toggleSound}>
                {soundEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
            <div className="settings-row">
              <span className="settings-label">Storage limit (MB)</span>
              <input type="number" className="settings-input" value={storageLimitMb}
                onChange={handleLimitChange} min="10" max="2000" />
            </div>
            <div className="settings-row">
              <span className="settings-label">Used</span>
              <span className="settings-value">{formatBytes(storageUsage)} / {storageLimitMb} MB</span>
            </div>
            <button className="danger-button" onClick={handleClearHistory}>Clear history</button>
          </div>
        )}

        {/* Tabs */}
        <div className="sidebar-tabs">
          <button className={`sidebar-tab ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')}>
            💬 Chats
          </button>
          <button className={`sidebar-tab ${activeTab === 'agents' ? 'active' : ''}`} onClick={() => setActiveTab('agents')}>
            🛠 Agents
          </button>
        </div>

        {/* Tab: Users — default agent + AI + groups + humans */}
        {activeTab === 'users' && (
          <div className="users-list">
            {[
              ...DEFAULT_AGENTS.map(a => makeAgentUser(a)),
              ...POPULAR_MODELS.map(model => ({ ...makeAiUser(model), _model: model })),
              ...groups.map(g => ({ user_id: g.group_id, username: g.name, type: 'group', icon: g.icon, members: g.members })),
              ...onlineUsers,
            ].map(contact => (
              <div key={contact.user_id}
                className={`user-item ${selectedUser?.user_id === contact.user_id ? 'selected' : ''}`}
                onClick={() => selectContact(contact)}>
                <div className="user-avatar-wrapper">
                  {contact.type === 'ai' ? (
                    <ProviderLogo provider={contact._model?.provider || contact.provider} />
                  ) : contact.type === 'group' ? (
                    <div className="user-avatar group-avatar">{contact.icon || '👥'}</div>
                  ) : contact.type === 'agent' ? (
                    <div className="user-avatar agent-avatar">{contact.icon || '🛠'}</div>
                  ) : (
                    <div className="user-avatar">{contact.username.charAt(0).toUpperCase()}</div>
                  )}
                  {unreadCounts[contact.user_id] > 0 && (
                    <span className="unread-badge">{unreadCounts[contact.user_id] > 99 ? '99+' : unreadCounts[contact.user_id]}</span>
                  )}
                </div>
                <div className="user-info">
                  <div className="user-name">{contact.username}</div>
                  <div className="user-status">
                    {contact.type === 'group' ? (
                      <><span className="group-dot"></span> {contact.members?.length || 0} members</>
                    ) : contact.type === 'ai' ? (
                      <><span className="ai-dot"></span> {contact._model?.provider || 'AI'}</>
                    ) : contact.type === 'agent' ? (
                      <><span className="ai-dot"></span> Agent</>
                    ) : (
                      <><span className="online-dot"></span> Online</>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {/* New Group button + form */}
            {showGroupForm ? (
              <div className="group-form">
                <input className="agent-input" placeholder="Group name *" value={groupDraft.name}
                  onChange={e => setGroupDraft(d => ({ ...d, name: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && handleCreateGroup()} />
                <div className="icon-picker">
                  {['👥','🏠','💼','🎮','📚','🎵','⚽','🍕','💬','🌍'].map(icon => (
                    <button key={icon} type="button"
                      className={`icon-option ${groupDraft.icon === icon ? 'selected' : ''}`}
                      onClick={() => setGroupDraft(d => ({ ...d, icon }))}>{icon}</button>
                  ))}
                </div>
                <div className="member-picker">
                  <div className="member-picker-label">Add members:</div>
                  {onlineUsers.map(u => (
                    <label key={u.user_id} className="member-picker-item">
                      <input type="checkbox"
                        checked={groupDraft.memberIds.includes(u.user_id)}
                        onChange={() => setGroupDraft(d => ({
                          ...d,
                          memberIds: d.memberIds.includes(u.user_id)
                            ? d.memberIds.filter(id => id !== u.user_id)
                            : [...d.memberIds, u.user_id]
                        }))} />
                      {u.username}
                    </label>
                  ))}
                  {onlineUsers.length === 0 && <div className="no-users">No online users</div>}
                </div>
                <div className="agent-form-buttons">
                  <button className="join-button agent-save-btn" onClick={handleCreateGroup}>Create Group</button>
                  <button className="logout-button" onClick={() => setShowGroupForm(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="new-group-btn" onClick={() => setShowGroupForm(true)}>+ New Group</button>
            )}
          </div>
        )}

        {/* Tab: Agents */}
        {activeTab === 'agents' && (
          <div className="agents-panel">
            <div className="agents-list">
              {agents.length === 0 && !showAgentForm && (
                <div className="no-users">No agents yet</div>
              )}
              {agents.map(agent => (
                <div key={agent.id}
                  className={`user-item ${selectedUser?.user_id === `agent:${agent.id}` ? 'selected' : ''}`}
                  onClick={() => selectContact(makeAgentUser(agent))}>
                  <div className="user-avatar agent-avatar">{agent.icon || '🛠'}</div>
                  <div className="user-info">
                    <div className="user-name">{agent.name}</div>
                    <div className="model-id">{agent.model}</div>
                  </div>
                  <button className="agent-delete-btn" onClick={e => { e.stopPropagation(); deleteAgent(agent.id); }}>×</button>
                </div>
              ))}
            </div>

            {showAgentForm ? (
              <div className="agent-form">
                <input className="agent-input" placeholder="Agent name *" value={agentDraft.name}
                  onChange={e => setAgentDraft(d => ({ ...d, name: e.target.value }))} />
                <div className="icon-picker">
                  {['🛠','🤖','🧠','📊','✍️','🎨','🔬','💡','📝','🎯'].map(icon => (
                    <button key={icon} type="button"
                      className={`icon-option ${agentDraft.icon === icon ? 'selected' : ''}`}
                      onClick={() => setAgentDraft(d => ({ ...d, icon }))}>{icon}</button>
                  ))}
                </div>
                <select className="agent-select" value={agentDraft.model}
                  onChange={e => setAgentDraft(d => ({ ...d, model: e.target.value }))}>
                  {POPULAR_MODELS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <textarea className="agent-textarea" placeholder="System prompt (optional)"
                  value={agentDraft.systemPrompt}
                  onChange={e => setAgentDraft(d => ({ ...d, systemPrompt: e.target.value }))} />
                <div className="agent-form-buttons">
                  <button className="join-button agent-save-btn" onClick={saveAgent}>Save Agent</button>
                  <button className="logout-button" onClick={() => setShowAgentForm(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="new-agent-btn" onClick={() => setShowAgentForm(true)}>+ New Agent</button>
            )}
          </div>
        )}
      </div>

      {/* ── Chat Area ── */}
      <div className="chat-container">
        {selectedUser ? (
          <>
            <div className="chat-header">
              <div className="chat-user-info">
                {selectedUser.type === 'ai' ? (
                  <ProviderLogo provider={selectedUser.provider} />
                ) : selectedUser.type === 'group' ? (
                  <div className="user-avatar group-avatar">{selectedUser.icon || '👥'}</div>
                ) : selectedUser.type === 'agent' ? (
                  <div className="user-avatar agent-avatar">{selectedUser.icon || '🛠'}</div>
                ) : (
                  <div className="user-avatar">{selectedUser.username.charAt(0).toUpperCase()}</div>
                )}
                <div>
                  <div className="chat-username">{selectedUser.username}</div>
                  <div className="chat-status">
                    {selectedUser.type === 'group' ? (
                      <><span className="group-dot"></span> {selectedUser.members?.length || 0} members</>
                    ) : selectedUser.type === 'ai' || selectedUser.type === 'agent' ? (
                      <><span className="ai-dot"></span> {selectedUser.model}</>
                    ) : (
                      <><span className="online-dot"></span> Online</>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="messages-container">
              {getMessagesForCurrentChat().map((msg, i) => (
                <div key={i} className={`message ${msg.from_user === userId ? 'sent' : 'received'} ${msg.isError ? 'error-msg' : ''}`}>
                  {msg.from_user !== userId && selectedUser?.type === 'group' && (
                    <div className="group-msg-sender">{msg.from_username}</div>
                  )}
                  {msg.content && (
                    <div className="message-content markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    </div>
                  )}
                  {msg.attachment && (
                    <div className="message-attachment">
                      {msg.attachment.type?.startsWith('image/') ? (
                        <img src={msg.attachment.data} alt={msg.attachment.name} className="attachment-image" />
                      ) : (
                        <a href={msg.attachment.data} download={msg.attachment.name} className="attachment-file">
                          📎 {msg.attachment.name}
                        </a>
                      )}
                    </div>
                  )}
                  <div className="message-time">{new Date(msg.timestamp).toLocaleTimeString()}</div>
                </div>
              ))}
              {aiLoading && (
                <div className="message received">
                  <div className="message-content ai-typing">
                    <span></span><span></span><span></span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="input-area">
              {pendingAttachment && (
                <div className="pending-attachment-bar">
                  {pendingAttachment.type?.startsWith('image/') && pendingAttachment.data ? (
                    <img src={pendingAttachment.data} alt={pendingAttachment.name} className="pending-attachment-thumb" />
                  ) : pendingAttachment.extractedText !== undefined ? (
                    <span className="pending-attachment-name">📄 {pendingAttachment.name} <span className="extracted-ok">text extracted</span></span>
                  ) : (
                    <span className="pending-attachment-name">📎 {pendingAttachment.name}</span>
                  )}
                  <button className="remove-attachment-btn" onClick={() => { setPendingAttachment(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}>×</button>
                </div>
              )}

              {/* @mention dropdown — positioned relative to .input-area */}
              {mentionCandidates.length > 0 && (
                <div className="mention-dropdown">
                  {mentionCandidates.map((c, i) => (
                    <div key={i} className="mention-item" onClick={() => applyMention(c)}>
                      <span className="mention-type-badge">{c.type === 'ai' ? '🤖' : c.type === 'agent' ? (c.agent?.icon || '🛠') : '👤'}</span>
                      <span className="mention-label">{c.label}</span>
                      {c.type === 'ai' && <span className="mention-sublabel">{c.model?.provider}</span>}
                    </div>
                  ))}
                </div>
              )}

              <div className="message-input-container">
                <input ref={fileInputRef} type="file" onChange={handleFileSelect} style={{ display: 'none' }}
                  accept="image/*,application/pdf,.doc,.docx,.txt" />
                <button className="attach-button" onClick={() => fileInputRef.current?.click()} title="Attach file">📎</button>
                <input
                  ref={messageInputRef}
                  type="text"
                  value={messageInput}
                  onChange={handleInputChange}
                  onKeyPress={handleKeyPress}
                  placeholder={`Message ${selectedUser.username}... (use @ to mention)`}
                  className="message-input"
                />
                <button onClick={sendMessage} className="send-button"
                  disabled={(!messageInput.trim() && !pendingAttachment) || aiLoading}>
                  {aiLoading ? '...' : 'Send'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="no-chat-selected">
            <h2>Welcome to SphareChat</h2>
            <p>Select a user, AI model, or agent to start chatting</p>
          </div>
        )}
      </div>

      {/* Profile modal */}
      {showProfile && (
        <div className="modal-overlay" onClick={() => setShowProfile(false)}>
          <div className="profile-modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close-btn" onClick={() => setShowProfile(false)}>✕</button>
            <div className="profile-modal-avatar">
              {userPicture ? (
                <img src={userPicture} alt={username} referrerPolicy="no-referrer" />
              ) : (
                <div className="profile-modal-initials">{username.charAt(0).toUpperCase()}</div>
              )}
            </div>
            <div className="profile-modal-name">{username}</div>
            {userEmail && <div className="profile-modal-email">{userEmail}</div>}
            <div className="profile-modal-badge">{userIsAnonymous ? 'Anonymous' : 'Registered'}</div>

            <div className="profile-modal-credits">
              <div className="profile-modal-credits-label">AI Credits</div>
              <div className={`profile-modal-credits-value ${userCredits !== null && userCredits < 20 ? 'credits-low' : ''}`}>
                ${userCredits !== null ? (userCredits / 100).toFixed(2) : '—'}
              </div>
              {!userIsAnonymous && (
                <button className="upgrade-btn" style={{marginTop:'0.5rem'}} onClick={() => { setShowProfile(false); handleBuyCredits(5); }}>
                  Buy More Credits
                </button>
              )}
            </div>

            <div className="profile-modal-actions">
              <button className="logout-button" onClick={() => { setShowProfile(false); handleLogout(); }}>Sign out</button>
            </div>
          </div>
        </div>
      )}

      {/* Credit / upgrade modal */}
      {upgradeReason && (
        <div className="modal-overlay" onClick={() => setUpgradeReason(null)}>
          <div className="upgrade-modal" onClick={e => e.stopPropagation()}>
            {upgradeReason.code === 'DAILY_LIMIT_EXCEEDED' ? (
              <>
                <div className="upgrade-modal-icon">⏳</div>
                <h3>Platform Limit Reached</h3>
                <p>The platform's shared AI credit ($10/day) has been used up. Come back tomorrow — or buy your own credits for uninterrupted access.</p>
                <div className="upgrade-modal-actions">
                  <button className="upgrade-btn" onClick={() => handleBuyCredits(5)}>Buy $5 Credits</button>
                  <button className="dismiss-btn" onClick={() => setUpgradeReason(null)}>Maybe Later</button>
                </div>
              </>
            ) : upgradeReason.isAnonymous ? (
              <>
                <div className="upgrade-modal-icon">🎁</div>
                <h3>You've Used Your Free Credit</h3>
                <p>Anonymous users get <strong>$1</strong> in free AI credits. Sign in to get <strong>$5 free credits</strong> — no payment required.</p>
                <div className="upgrade-modal-actions">
                  <button className="upgrade-btn" onClick={() => {
                    setUpgradeReason(null);
                    loginWithRedirect({ authorizationParams: { screen_hint: 'signup' } });
                  }}>
                    Register Free (Email)
                  </button>
                  <button className="secondary-upgrade-btn" onClick={() => handleBuyCredits(5)}>Buy Credits Instead</button>
                  <button className="dismiss-btn" onClick={() => setUpgradeReason(null)}>Maybe Later</button>
                </div>
              </>
            ) : (
              <>
                <div className="upgrade-modal-icon">💳</div>
                <h3>Out of AI Credits</h3>
                <p>Your credit balance is empty. Top up to keep chatting with AI — or upgrade to a membership for unlimited access.</p>
                <div className="credit-packages">
                  {[5, 10, 20].map(amt => (
                    <button key={amt} className="credit-package-btn" onClick={() => handleBuyCredits(amt)}>
                      ${amt}
                    </button>
                  ))}
                </div>
                <div className="upgrade-modal-actions">
                  <button className="upgrade-btn" onClick={handleUpgradeMembership}>Unlimited Membership</button>
                  <button className="dismiss-btn" onClick={() => setUpgradeReason(null)}>Maybe Later</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

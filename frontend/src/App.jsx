import { useState, useEffect, useRef } from 'react';
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

function makeAiUser(model) {
  return {
    user_id: `ai:${model.id}`,
    username: model.name,
    provider: model.provider,
    model: model.id,
    type: 'ai',
  };
}

function makeAgentUser(agent) {
  return {
    user_id: `agent:${agent.id}`,
    username: agent.name,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
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

  // Sidebar
  const [activeTab, setActiveTab] = useState('users'); // 'users' | 'ai' | 'agents'
  const [showSettings, setShowSettings] = useState(false);

  // AI Models
  const [allModels, setAllModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [showAllModels, setShowAllModels] = useState(false);

  // Agents
  const [agents, setAgents] = useState(loadAgentsFromStorage);
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [agentDraft, setAgentDraft] = useState({ name: '', model: POPULAR_MODELS[0].id, systemPrompt: '' });

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
  const isConnectingRef = useRef(false);
  const selectedUserRef = useRef(null);
  const soundEnabledRef = useRef(soundEnabled);
  const fileInputRef = useRef(null);
  const messageInputRef = useRef(null);

  // ── Effects ─────────────────────────────────────────────────────────────────

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

  // Auto-connect
  useEffect(() => {
    const uid = localStorage.getItem('chat_userId');
    const uname = localStorage.getItem('chat_username');
    if (uid && uname && !isConnectingRef.current && !ws.current) {
      connectWebSocket(uid, uname);
    }
  }, []);

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
      shouldReconnect.current = false;
      ws.current.close();
      ws.current = null;
    }
    shouldReconnect.current = true;
    isConnectingRef.current = true;
    ws.current = new WebSocket(`${WS_URL}/ws/${uid}`);

    ws.current.onopen = () => {
      isConnectingRef.current = false;
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
        if (data.from_user !== selectedUserRef.current?.user_id) {
          setUnreadCounts(prev => ({ ...prev, [data.from_user]: (prev[data.from_user] || 0) + 1 }));
          playNotificationSound();
        }
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
    if (ws.current) ws.current.close();
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
          .map(m => ({
            role: m.from_user === userId ? 'user' : 'assistant',
            content: m.content || '',
          }));
        history.push({ role: 'user', content: text || pendingAttachment?.name || '' });

        const res = await fetch(`${API_URL}/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: selectedUser.model,
            messages: history,
            system_prompt: selectedUser.systemPrompt || '',
          }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'AI error');

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

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('File too large. Maximum 5MB.'); e.target.value = ''; return; }
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
    setAgentDraft({ name: '', model: POPULAR_MODELS[0].id, systemPrompt: '' });
    setShowAgentForm(false);
  };

  const deleteAgent = (id) => {
    const updated = agents.filter(a => a.id !== id);
    setAgents(updated);
    saveAgentsToStorage(updated);
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

  // ── Derived ──────────────────────────────────────────────────────────────────

  const getMessagesForCurrentChat = () => {
    if (!selectedUser) return [];
    return messages.filter(m =>
      (m.from_user === userId && m.to_user === selectedUser.user_id) ||
      (m.from_user === selectedUser.user_id && m.to_user === userId)
    );
  };

  const filteredModels = (showAllModels ? (allModels.length ? allModels : POPULAR_MODELS) : POPULAR_MODELS)
    .filter(m => !modelSearch || m.name.toLowerCase().includes(modelSearch.toLowerCase()) || m.provider.toLowerCase().includes(modelSearch.toLowerCase()));

  // Group models by provider
  const modelsByProvider = filteredModels.reduce((acc, m) => {
    (acc[m.provider] = acc[m.provider] || []).push(m);
    return acc;
  }, {});

  const mentionCandidates = getMentionCandidates();

  // ── Login screen ─────────────────────────────────────────────────────────────

  if (!userId) {
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
          <p>Enter a username or leave blank for a random one</p>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="Username (optional)"
            onKeyPress={e => e.key === 'Enter' && handleJoin()}
            className="username-input"
          />
          <button onClick={handleJoin} className="join-button" disabled={serverStatus === 'offline'}>
            Join Chat
          </button>
        </div>
      </div>
    );
  }

  // ── Main app ─────────────────────────────────────────────────────────────────

  return (
    <div className="app-container">
      {!isConnected && (
        <div className="reconnecting-banner">
          {reconnectAttempts > 0
            ? <>🔄 Reconnecting... (Attempt {reconnectAttempts}/10)</>
            : <>⚠️ Disconnected from server...</>}
        </div>
      )}

      {/* ── Sidebar ── */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-header-top">
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
          <div className="user-info-badge">
            <span className="user-badge">{username}</span>
            <span className="user-id" title="Your User ID">{userId}</span>
            <button onClick={handleLogout} className="logout-button">Logout</button>
          </div>
        </div>

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
            👥 Users
          </button>
          <button className={`sidebar-tab ${activeTab === 'ai' ? 'active' : ''}`} onClick={() => setActiveTab('ai')}>
            🤖 AI
          </button>
          <button className={`sidebar-tab ${activeTab === 'agents' ? 'active' : ''}`} onClick={() => setActiveTab('agents')}>
            🛠 Agents
          </button>
        </div>

        {/* Tab: Users */}
        {activeTab === 'users' && (
          <div className="users-list">
            {onlineUsers.length === 0 ? (
              <div className="no-users">No other users online</div>
            ) : onlineUsers.map(user => (
              <div key={user.user_id}
                className={`user-item ${selectedUser?.user_id === user.user_id ? 'selected' : ''}`}
                onClick={() => selectContact(user)}>
                <div className="user-avatar-wrapper">
                  <div className="user-avatar">{user.username.charAt(0).toUpperCase()}</div>
                  {unreadCounts[user.user_id] > 0 && (
                    <span className="unread-badge">{unreadCounts[user.user_id] > 99 ? '99+' : unreadCounts[user.user_id]}</span>
                  )}
                </div>
                <div className="user-info">
                  <div className="user-name">{user.username}</div>
                  <div className="user-status"><span className="online-dot"></span> Online</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Tab: AI Models */}
        {activeTab === 'ai' && (
          <div className="ai-panel">
            <div className="ai-search-bar">
              <input
                type="text"
                placeholder="Search models..."
                value={modelSearch}
                onChange={e => setModelSearch(e.target.value)}
                className="ai-search-input"
              />
              <button className="show-all-btn" onClick={() => setShowAllModels(v => !v)}>
                {showAllModels ? 'Popular' : 'All models'}
              </button>
            </div>
            {modelsLoading && <div className="ai-loading">Loading models...</div>}
            <div className="models-list">
              {Object.entries(modelsByProvider).map(([provider, mods]) => (
                <div key={provider} className="model-provider-group">
                  <div className="model-provider-label">{provider}</div>
                  {mods.map(model => (
                    <div key={model.id}
                      className={`model-item ${selectedUser?.model === model.id ? 'selected' : ''}`}
                      onClick={() => selectContact(makeAiUser(model))}>
                      <div className="model-avatar">🤖</div>
                      <div className="user-info">
                        <div className="user-name">{model.name || model.id.split('/').pop()}</div>
                        <div className="model-id">{model.id}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
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
                  <div className="user-avatar agent-avatar">🛠</div>
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
                <div className={`user-avatar ${selectedUser.type === 'agent' ? 'agent-avatar' : ''}`}>
                  {selectedUser.type === 'ai' ? '🤖' :
                   selectedUser.type === 'agent' ? '🛠' :
                   selectedUser.username.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="chat-username">{selectedUser.username}</div>
                  <div className="chat-status">
                    {selectedUser.type === 'ai' || selectedUser.type === 'agent' ? (
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
                  {msg.content && <div className="message-content">{msg.content}</div>}
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

            {pendingAttachment && (
              <div className="pending-attachment-bar">
                {pendingAttachment.type?.startsWith('image/') ? (
                  <img src={pendingAttachment.data} alt={pendingAttachment.name} className="pending-attachment-thumb" />
                ) : (
                  <span className="pending-attachment-name">📎 {pendingAttachment.name}</span>
                )}
                <button className="remove-attachment-btn" onClick={() => { setPendingAttachment(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}>×</button>
              </div>
            )}

            {/* @mention dropdown */}
            {mentionCandidates.length > 0 && (
              <div className="mention-dropdown">
                {mentionCandidates.map((c, i) => (
                  <div key={i} className="mention-item" onClick={() => applyMention(c)}>
                    <span className="mention-type-badge">{c.type === 'ai' ? '🤖' : c.type === 'agent' ? '🛠' : '👤'}</span>
                    <span className="mention-label">{c.label}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="message-input-container">
              <input ref={fileInputRef} type="file" onChange={handleFileSelect} style={{ display: 'none' }}
                accept="image/*,application/pdf,.doc,.docx,.txt,.zip" />
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
          </>
        ) : (
          <div className="no-chat-selected">
            <h2>Welcome to SphareChat</h2>
            <p>Select a user, AI model, or agent to start chatting</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;

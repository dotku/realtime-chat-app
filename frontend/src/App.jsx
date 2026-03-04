import { useState, useEffect, useRef } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import './App.css';
import { saveMessage, loadMessages, clearMessages, getStorageUsage, fetchMessagesFromServer, makeConversationId } from './messageStore';
import { API_URL, WS_URL, GATEWAY_MODELS_URL, POPULAR_MODELS, makeAiUser, makeAgentUser } from './utils/constants';
import { playNotificationSound } from './utils/soundUtils';
import { loadAgentsFromStorage, saveAgentsToStorage } from './utils/agentStorage';
import { handleFileSelect } from './utils/fileUtils';
import LoginScreen from './components/LoginScreen';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import ProfileModal from './components/ProfileModal';
import UpgradeModal from './components/UpgradeModal';
import CreditsModal from './components/CreditsModal';
import ToastContainer, { toast } from './components/Toast';

function App() {
  const { loginWithRedirect, logout: auth0Logout, user: auth0User, isAuthenticated, isLoading: auth0Loading, error: auth0Error, getIdTokenClaims } = useAuth0();

  const [username, setUsername] = useState(() => localStorage.getItem('chat_username') || '');
  const [userId, setUserId] = useState(() => localStorage.getItem('chat_userId') || null);
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [serverStatus, setServerStatus] = useState('checking');
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [unreadCounts, setUnreadCounts] = useState({});
  const [pendingAttachment, setPendingAttachment] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState(null);
  const [userCredits, setUserCredits] = useState(null);
  const [userIsMember, setUserIsMember] = useState(false);
  const [userIsAnonymous, setUserIsAnonymous] = useState(true);
  const [showCredits, setShowCredits] = useState(false);
  const [userPicture, setUserPicture] = useState(null);
  const [userEmail, setUserEmail] = useState(null);
  const [activeTab, setActiveTab] = useState('users');
  const [showSettings, setShowSettings] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [allModels, setAllModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [agents, setAgents] = useState(loadAgentsFromStorage);
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [agentDraft, setAgentDraft] = useState({ name: '', model: POPULAR_MODELS[0].id, systemPrompt: '', icon: '🛠' });
  const [groups, setGroups] = useState([]);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [groupDraft, setGroupDraft] = useState({ name: '', icon: '👥', memberIds: [] });
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem('chat_sound') !== 'off');
  const [storageLimitMb, setStorageLimitMb] = useState(() => parseInt(localStorage.getItem('chat_storageLimit_mb') || '200'));
  const [storageUsage, setStorageUsage] = useState(0);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [pendingMentionUsers, setPendingMentionUsers] = useState([]);
  const [hasMoreMessages, setHasMoreMessages] = useState({});
  const [loadingOlder, setLoadingOlder] = useState(false);

  const ws = useRef(null);
  const messagesEndRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const shouldReconnect = useRef(true);
  const hasEverConnectedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const wsUserIdRef = useRef(null);
  const selectedUserRef = useRef(null);
  const soundEnabledRef = useRef(soundEnabled);
  const fileInputRef = useRef(null);
  const messageInputRef = useRef(null);

  const fetchCredits = async (uid) => {
    try {
      const res = await fetch(`${API_URL}/user/${uid}/credits`);
      if (!res.ok) return;
      const data = await res.json();
      setUserCredits(data.credits_cents);
      if (data.is_member !== undefined) setUserIsMember(data.is_member);
      if (!isAuthenticated) setUserIsAnonymous(data.is_anonymous);
    } catch { /* non-critical */ }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('membership') === 'success') {
      window.history.replaceState({}, '', window.location.pathname);
      setUserIsMember(true);
      const uid = localStorage.getItem('chat_userId');
      if (uid) fetchCredits(uid);
      setTimeout(() => toast('Welcome, member! You now have unlimited AI access.', 'success', 5000), 300);
    }
    if (params.get('membership') === 'cancelled') {
      window.history.replaceState({}, '', window.location.pathname);
      setTimeout(() => toast('Membership checkout cancelled.', 'info'), 300);
    }
    if (params.get('credits') === 'success') {
      window.history.replaceState({}, '', window.location.pathname);
      const uid = localStorage.getItem('chat_userId');
      if (uid) fetchCredits(uid);
      setTimeout(() => toast('Credits added! Your balance has been updated.', 'success', 5000), 300);
    }
    if (params.get('credits') === 'cancelled') {
      window.history.replaceState({}, '', window.location.pathname);
      setTimeout(() => toast('Credit purchase cancelled.', 'info'), 300);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isAuthenticated || !auth0User) return;
    const sync = async () => {
      try {
        const claims = await getIdTokenClaims();
        const idToken = claims?.__raw;
        if (!idToken) return;
        const displayName = auth0User.nickname || auth0User.name || auth0User.email?.split('@')[0] || '';
        const res = await fetch(`${API_URL}/auth/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: idToken, username: displayName }),
        });
        if (!res.ok) { console.error('Auth login failed', await res.text()); return; }
        const data = await res.json();
        setUserId(data.user_id); setUsername(data.username);
        setUserCredits(data.credits_cents ?? null); setUserIsMember(data.is_member ?? false); setUserIsAnonymous(false);
        setUserPicture(auth0User.picture || null); setUserEmail(auth0User.email || null);
        localStorage.setItem('chat_userId', data.user_id); localStorage.setItem('chat_username', data.username);
        if (!isConnectingRef.current && wsUserIdRef.current !== data.user_id) connectWebSocket(data.user_id, data.username);
      } catch (err) { console.error('Auth sync error:', err); }
    };
    sync();
  }, [isAuthenticated, auth0User]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (userId && userCredits === null) fetchCredits(userId); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const check = async () => { try { const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(5000) }); setServerStatus(res.ok ? 'online' : 'offline'); } catch { setServerStatus('offline'); } };
    check(); const id = setInterval(check, 30000); return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const uid = localStorage.getItem('chat_userId'); const uname = localStorage.getItem('chat_username');
    if (uid && uname && !isConnectingRef.current && !ws.current) connectWebSocket(uid, uname);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!userId) return;
    loadMessages(userId).then(msgs => {
      if (msgs.length > 0) {
        setMessages(prev => {
          if (prev.length > 0) {
            const seen = new Set(prev.map(m => m.message_id || `${m.from_user}-${m.to_user}-${m.timestamp}`));
            const newOnes = msgs.filter(m => !seen.has(m.message_id || `${m.from_user}-${m.to_user}-${m.timestamp}`));
            return [...newOnes, ...prev].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
          }
          return msgs;
        });
      }
    }).catch(console.error);
    getStorageUsage(userId).then(setStorageUsage).catch(() => {});
  }, [userId]);

  useEffect(() => { selectedUserRef.current = selectedUser; }, [selectedUser]);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  useEffect(() => { const total = Object.values(unreadCounts).reduce((s, n) => s + n, 0); document.title = total > 0 ? `(${total}) SphareChat` : 'SphareChat'; }, [unreadCounts]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    if (activeTab !== 'ai' || allModels.length > 0) return;
    setModelsLoading(true);
    fetch(GATEWAY_MODELS_URL).then(r => r.json()).then(data => {
      setAllModels((data.data || []).map(m => ({ id: m.id, name: m.id.split('/').pop().replace(/-/g, ' '), provider: m.id.split('/')[0] })));
    }).catch(() => setAllModels(POPULAR_MODELS)).finally(() => setModelsLoading(false));
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const generateRandomUsername = () => {
    const adj = ['Happy', 'Clever', 'Bright', 'Swift', 'Brave', 'Kind', 'Wise', 'Bold'];
    const noun = ['Panda', 'Eagle', 'Tiger', 'Dolphin', 'Fox', 'Wolf', 'Hawk', 'Bear'];
    return `${adj[~~(Math.random() * adj.length)]}${noun[~~(Math.random() * noun.length)]}${~~(Math.random() * 100)}`;
  };

  const handleJoin = async () => {
    const finalUsername = username.trim() || generateRandomUsername();
    try {
      const res = await fetch(`${API_URL}/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: finalUsername }) });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || 'Failed to create user'); }
      const data = await res.json();
      setUserId(data.user_id); setUsername(data.username);
      localStorage.setItem('chat_userId', data.user_id); localStorage.setItem('chat_username', data.username);
      connectWebSocket(data.user_id, data.username);
    } catch (err) { console.error(err); alert(err.message.includes('Database') ? 'Database unavailable. Check Docker/PostgreSQL.' : 'Failed to connect. Please try again.'); }
  };

  const connectWebSocket = (uid, uname) => {
    if (isConnectingRef.current) return;
    if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
    if (ws.current && ws.current.readyState !== WebSocket.CLOSED) {
      ws.current.onopen = null; ws.current.onmessage = null; ws.current.onclose = null; ws.current.onerror = null;
      ws.current.close(); ws.current = null;
    }
    shouldReconnect.current = true; isConnectingRef.current = true;
    ws.current = new WebSocket(`${WS_URL}/ws/${uid}`);
    ws.current.onopen = () => {
      isConnectingRef.current = false; wsUserIdRef.current = uid; hasEverConnectedRef.current = true; setIsConnected(true); setIsReconnecting(false); setReconnectAttempts(0);
      // Request missed messages from server
      const lastTs = localStorage.getItem(`chat_lastMessageTimestamp_${uid}`);
      ws.current.send(JSON.stringify({ type: 'sync', last_timestamp: lastTs || null }));
    };
    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'error') { console.error('Server error:', data); return; }
      if (data.type === 'online_users') { setOnlineUsers(data.users.filter(u => u.user_id !== uid)); }
      else if (data.type === 'user_joined') { setOnlineUsers(prev => prev.find(u => u.user_id === data.user_id) ? prev : [...prev, { user_id: data.user_id, username: data.username, is_online: true }]); }
      else if (data.type === 'user_left') { setOnlineUsers(prev => prev.filter(u => u.user_id !== data.user_id)); }
      else if (data.type === 'chat') {
        setMessages(prev => {
          if (data.message_id && prev.some(m => m.message_id === data.message_id)) return prev;
          return [...prev, data];
        });
        saveMessage(data, uid).then(() => getStorageUsage(uid).then(setStorageUsage).catch(() => {})).catch(console.error);
        if (data.timestamp) localStorage.setItem(`chat_lastMessageTimestamp_${uid}`, data.timestamp);
        const unreadKey = data.group_id || data.from_user;
        if (unreadKey !== selectedUserRef.current?.user_id) { setUnreadCounts(prev => ({ ...prev, [unreadKey]: (prev[unreadKey] || 0) + 1 })); playNotificationSound(soundEnabledRef); }
      } else if (data.type === 'user_groups') { setGroups(data.groups); }
      else if (data.type === 'group_created') { setGroups(prev => prev.find(g => g.group_id === data.group.group_id) ? prev : [...prev, data.group]); }
      else if (data.type === 'group_updated') { setGroups(prev => prev.map(g => g.group_id === data.group.group_id ? data.group : g)); }
    };
    ws.current.onclose = async (event) => {
      isConnectingRef.current = false; setIsConnected(false);
      if (!shouldReconnect.current) return;
      if (event.code === 4004) {
        setIsReconnecting(true);
        try {
          const res = await fetch(`${API_URL}/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname }) });
          if (res.ok) { const data = await res.json(); setUserId(data.user_id); localStorage.setItem('chat_userId', data.user_id); localStorage.setItem('chat_username', uname); setReconnectAttempts(0); setTimeout(() => connectWebSocket(data.user_id, uname), 500); return; }
        } catch { /* fall through */ }
      }
      setReconnectAttempts(prev => {
        const next = prev + 1;
        if (next > 10) { setIsReconnecting(false); shouldReconnect.current = false; alert('Unable to reconnect. Please refresh.'); return next; }
        setIsReconnecting(true); reconnectTimeoutRef.current = setTimeout(() => connectWebSocket(uid, uname), Math.min(1000 * Math.pow(2, next - 1), 30000)); return next;
      });
    };
    ws.current.onerror = () => { isConnectingRef.current = false; };
  };

  useEffect(() => () => {
    shouldReconnect.current = false; if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    if (ws.current) { ws.current.onopen = null; ws.current.onmessage = null; ws.current.onclose = null; ws.current.onerror = null; ws.current.close(); ws.current = null; }
  }, []);

  const sendMessage = async () => {
    if (!selectedUser) return;
    const text = messageInput.trim();
    if (!text && !pendingAttachment) return;
    const isAi = selectedUser.type === 'ai' || selectedUser.type === 'agent';
    if (isAi) {
      const userMsg = { type: 'chat', from_user: userId, from_username: username, to_user: selectedUser.user_id, content: text || (pendingAttachment?.name ?? ''), ...(pendingAttachment ? { attachment: pendingAttachment } : {}), timestamp: new Date().toISOString() };
      setMessages(prev => [...prev, userMsg]); saveMessage(userMsg, userId).catch(console.error);
      setMessageInput(''); setPendingAttachment(null); if (fileInputRef.current) fileInputRef.current.value = '';
      setAiLoading(true);
      try {
        const history = messages.filter(m => (m.from_user === userId && m.to_user === selectedUser.user_id) || (m.from_user === selectedUser.user_id && m.to_user === userId)).map(m => {
          if (m.attachment?.type?.startsWith('image/') && m.attachment.data) { const parts = []; if (m.content) parts.push({ type: 'text', text: m.content }); parts.push({ type: 'image_url', image_url: { url: m.attachment.data } }); return { role: m.from_user === userId ? 'user' : 'assistant', content: parts }; }
          return { role: m.from_user === userId ? 'user' : 'assistant', content: m.content || '' };
        });
        let newUserContent;
        if (pendingAttachment) {
          if (pendingAttachment.type?.startsWith('image/')) { const parts = []; if (text) parts.push({ type: 'text', text }); parts.push({ type: 'image_url', image_url: { url: pendingAttachment.data } }); newUserContent = parts; }
          else if (pendingAttachment.extractedText !== undefined) { newUserContent = pendingAttachment.extractedText ? `${text ? text + '\n\n' : ''}[Document: ${pendingAttachment.name}]\n${pendingAttachment.extractedText}` : `${text ? text + '\n\n' : ''}[Document: ${pendingAttachment.name} — no readable text found]`; }
          else if (pendingAttachment.type === 'text/plain') { try { const decoded = atob(pendingAttachment.data.split(',')[1]); newUserContent = `${text ? text + '\n\n' : ''}[File: ${pendingAttachment.name}]\n${decoded}`; } catch { newUserContent = `${text ? text + '\n\n' : ''}[File attached: ${pendingAttachment.name}]`; } }
          else { newUserContent = `${text ? text + '\n\n' : ''}[Attached file: ${pendingAttachment.name} — binary format, cannot be read directly. Please paste the text content.]`; }
        } else { newUserContent = text; }
        history.push({ role: 'user', content: newUserContent });
        const res = await fetch(`${API_URL}/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: selectedUser.model, messages: history, system_prompt: selectedUser.systemPrompt || '', user_id: userId }) });
        const data = await res.json();
        if (res.status === 402) { const detail = data.detail || {}; setUpgradeReason({ code: detail.code || 'NO_CREDITS', isAnonymous: detail.is_anonymous ?? userIsAnonymous }); setMessages(prev => prev.slice(0, -1)); return; }
        if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : (data.detail?.message || 'AI error'));
        if (data.credits_cents !== null && data.credits_cents !== undefined) {
          const prev = userCredits;
          setUserCredits(data.credits_cents);
          if (prev !== null && !userIsMember) {
            const cost = prev - data.credits_cents;
            if (cost > 0) {
              const remaining = (data.credits_cents / 100).toFixed(2);
              if (data.credits_cents < 50 && data.credits_cents > 0) toast(`-${cost}¢ · $${remaining} remaining`, 'warning', 3000);
            }
          }
        }
        const aiMsg = { type: 'chat', from_user: selectedUser.user_id, from_username: selectedUser.username, to_user: userId, content: data.content, timestamp: new Date().toISOString() };
        setMessages(prev => [...prev, aiMsg]); saveMessage(aiMsg, userId).catch(console.error); playNotificationSound(soundEnabledRef);
      } catch (err) { setMessages(prev => [...prev, { type: 'chat', from_user: selectedUser.user_id, from_username: selectedUser.username, to_user: userId, content: `⚠️ Error: ${err.message}`, timestamp: new Date().toISOString(), isError: true }]); }
      finally { setAiLoading(false); }
      return;
    }
    const content = text || (pendingAttachment?.name ?? '');
    if (pendingMentionUsers.length > 0) {
      try {
        if (selectedUser.type === 'group') {
          for (const mu of pendingMentionUsers) { try { await fetch(`${API_URL}/groups/${selectedUser.user_id}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: mu.user_id }) }); } catch { /* ignore */ } }
          const message = { type: 'chat', to_user: selectedUser.user_id, content }; if (pendingAttachment) message.attachment = pendingAttachment; ws.current.send(JSON.stringify(message));
        } else {
          const allMemberIds = [userId, selectedUser.user_id, ...pendingMentionUsers.map(u => u.user_id)]; const uniqueIds = [...new Set(allMemberIds)];
          const memberNames = uniqueIds.map(id => id === userId ? username : (onlineUsers.find(u => u.user_id === id)?.username || 'Unknown')).slice(0, 3);
          const groupName = memberNames.join(', ') + (uniqueIds.length > 3 ? ` +${uniqueIds.length - 3}` : '');
          const res = await fetch(`${API_URL}/groups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: groupName, icon: '👥', created_by: userId, member_ids: uniqueIds }) });
          if (!res.ok) throw new Error('Failed to create group');
          const groupData = await res.json(); setGroups(prev => prev.find(g => g.group_id === groupData.group_id) ? prev : [...prev, groupData]);
          const message = { type: 'chat', to_user: groupData.group_id, content }; if (pendingAttachment) message.attachment = pendingAttachment; ws.current.send(JSON.stringify(message));
          selectContact({ user_id: groupData.group_id, username: groupData.name, type: 'group', icon: groupData.icon, members: groupData.members });
        }
      } catch (err) { console.error('Auto-group creation failed:', err); alert('Failed to create group chat.'); }
      setPendingMentionUsers([]); setMessageInput(''); setPendingAttachment(null); if (fileInputRef.current) fileInputRef.current.value = ''; return;
    }
    const message = { type: 'chat', to_user: selectedUser.user_id, content }; if (pendingAttachment) message.attachment = pendingAttachment;
    ws.current.send(JSON.stringify(message)); setMessageInput(''); setPendingAttachment(null); if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleKeyPress = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
  const handleInputChange = (e) => { const val = e.target.value; setMessageInput(val); const atIdx = val.lastIndexOf('@'); if (atIdx !== -1) { const after = val.slice(atIdx + 1); if (!after.includes(' ')) { setMentionQuery(after.toLowerCase()); return; } } setMentionQuery(null); };
  const getMentionCandidates = () => {
    if (mentionQuery === null) return [];
    const q = mentionQuery;
    const users = onlineUsers.filter(u => u.username.toLowerCase().includes(q)).map(u => ({ label: u.username, value: u.username, type: 'user' }));
    const aiList = (allModels.length ? allModels : POPULAR_MODELS).filter(m => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)).slice(0, 5).map(m => ({ label: m.name, value: m.id.split('/').pop(), type: 'ai', model: m }));
    const agentList = agents.filter(a => a.name.toLowerCase().includes(q)).map(a => ({ label: a.name, value: a.name, type: 'agent', agent: a }));
    return [...users, ...aiList, ...agentList].slice(0, 8);
  };
  const applyMention = (candidate) => {
    const atIdx = messageInput.lastIndexOf('@'); const before = messageInput.slice(0, atIdx);
    setMessageInput(`${before}@${candidate.value} `); setMentionQuery(null); messageInputRef.current?.focus();
    if (candidate.type === 'ai') selectContact(makeAiUser(candidate.model));
    else if (candidate.type === 'agent') selectContact(makeAgentUser(candidate.agent));
    else if (candidate.type === 'user') { const mentionedUser = onlineUsers.find(u => u.username === candidate.value); if (mentionedUser && mentionedUser.user_id !== selectedUser?.user_id) setPendingMentionUsers(prev => prev.find(u => u.user_id === mentionedUser.user_id) ? prev : [...prev, mentionedUser]); }
  };
  const selectContact = (user) => { setSelectedUser(user); setUnreadCounts(prev => ({ ...prev, [user.user_id]: 0 })); setPendingMentionUsers([]); setActiveTab('users'); };
  const saveAgent = () => { if (!agentDraft.name.trim()) return; const updated = [...agents, { ...agentDraft, id: Date.now().toString() }]; setAgents(updated); saveAgentsToStorage(updated); setAgentDraft({ name: '', model: POPULAR_MODELS[0].id, systemPrompt: '', icon: '🛠' }); setShowAgentForm(false); };
  const deleteAgent = (id) => { const updated = agents.filter(a => a.id !== id); setAgents(updated); saveAgentsToStorage(updated); };
  const handleCreateGroup = async () => {
    if (!groupDraft.name.trim()) return;
    try { const res = await fetch(`${API_URL}/groups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: groupDraft.name, icon: groupDraft.icon, created_by: userId, member_ids: [userId, ...groupDraft.memberIds] }) }); if (!res.ok) throw new Error('Failed to create group'); const data = await res.json(); setGroups(prev => prev.find(g => g.group_id === data.group_id) ? prev : [...prev, data]); setGroupDraft({ name: '', icon: '👥', memberIds: [] }); setShowGroupForm(false); }
    catch (err) { console.error(err); alert('Failed to create group.'); }
  };
  const handleLogout = () => { shouldReconnect.current = false; if (ws.current) ws.current.close(); if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current); setUserId(null); setUsername(''); setIsConnected(false); setOnlineUsers([]); setSelectedUser(null); setMessages([]); setReconnectAttempts(0); setIsReconnecting(false); setUnreadCounts({}); setShowSettings(false); setPendingAttachment(null); localStorage.removeItem('chat_userId'); localStorage.removeItem('chat_username'); auth0Logout({ logoutParams: { returnTo: window.location.origin } }); };
  const handleClearHistory = async () => { if (!confirm('Clear all message history? This cannot be undone.')) return; await clearMessages(userId); setMessages([]); setStorageUsage(0); setShowSettings(false); };
  const toggleSound = () => { const next = !soundEnabled; setSoundEnabled(next); localStorage.setItem('chat_sound', next ? 'on' : 'off'); };
  const handleLimitChange = (e) => { const mb = Math.max(10, Math.min(2000, parseInt(e.target.value) || 200)); setStorageLimitMb(mb); localStorage.setItem('chat_storageLimit_mb', mb.toString()); };
  const formatBytes = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`;
  const handleUpgradeMembership = async () => { try { const res = await fetch(`${API_URL}/stripe/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId }) }); const data = await res.json(); if (data.checkout_url) window.location.href = data.checkout_url; else throw new Error(data.detail || 'No checkout URL'); } catch (err) { console.error('Checkout error:', err); alert('Unable to start checkout. Please try again.'); } };
  const handleSignIn = () => { loginWithRedirect(); };
  const handleBuyCredits = async (amountDollars = 5) => { try { const res = await fetch(`${API_URL}/stripe/buy-credits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, amount_dollars: amountDollars }) }); const data = await res.json(); if (data.checkout_url) window.location.href = data.checkout_url; else throw new Error(data.detail || 'No checkout URL'); } catch (err) { console.error('Buy credits error:', err); alert('Unable to start checkout. Please try again.'); } };
  const getMessagesForCurrentChat = () => { if (!selectedUser) return []; if (selectedUser.type === 'group') return messages.filter(m => m.to_user === selectedUser.user_id); return messages.filter(m => (m.from_user === userId && m.to_user === selectedUser.user_id) || (m.from_user === selectedUser.user_id && m.to_user === userId)); };

  const loadOlderMessages = async () => {
    if (!selectedUser || loadingOlder) return;
    const isGroup = selectedUser.type === 'group';
    const convId = makeConversationId(userId, selectedUser.user_id, isGroup ? selectedUser.user_id : null);
    const currentMsgs = getMessagesForCurrentChat();
    const oldestTs = currentMsgs.length > 0 ? currentMsgs[0].timestamp : null;
    setLoadingOlder(true);
    try {
      const { messages: older, has_more } = await fetchMessagesFromServer(convId, userId, oldestTs, 50);
      setHasMoreMessages(prev => ({ ...prev, [convId]: has_more }));
      if (older.length > 0) {
        setMessages(prev => {
          const seen = new Set(prev.map(m => m.message_id || `${m.from_user}-${m.to_user}-${m.timestamp}`));
          const newOnes = older.filter(m => !seen.has(m.message_id));
          return [...newOnes, ...prev].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        });
      }
    } catch (err) { console.error('Failed to load older messages:', err); }
    finally { setLoadingOlder(false); }
  };
  const mentionCandidates = getMentionCandidates();

  if (auth0Loading || (!isAuthenticated && !userId)) {
    return <LoginScreen serverStatus={serverStatus} username={username} setUsername={setUsername} handleJoin={handleJoin} auth0Loading={auth0Loading} loginWithRedirect={loginWithRedirect} />;
  }

  return (
    <div className="app-container">
      {!isConnected && (hasEverConnectedRef.current || reconnectAttempts > 0) && (
        <div className="reconnecting-banner">{reconnectAttempts > 0 ? <>🔄 Reconnecting... (Attempt {reconnectAttempts}/10)</> : <>⚠️ Disconnected from server...</>}</div>
      )}
      <Sidebar soundEnabled={soundEnabled} toggleSound={toggleSound} showSettings={showSettings} setShowSettings={setShowSettings} showProfile={showProfile} setShowProfile={setShowProfile} isAuthenticated={isAuthenticated} handleSignIn={handleSignIn} userPicture={userPicture} username={username} editingName={editingName} setEditingName={setEditingName} draftName={draftName} setDraftName={setDraftName} setUsername={setUsername} userCredits={userCredits} userIsMember={userIsMember} userIsAnonymous={userIsAnonymous} auth0Loading={auth0Loading} auth0Error={auth0Error} auth0User={auth0User} handleLogout={handleLogout} handleClearHistory={handleClearHistory} storageLimitMb={storageLimitMb} handleLimitChange={handleLimitChange} storageUsage={storageUsage} formatBytes={formatBytes} activeTab={activeTab} setActiveTab={setActiveTab} selectedUser={selectedUser} selectContact={selectContact} unreadCounts={unreadCounts} onlineUsers={onlineUsers} groups={groups} agents={agents} showGroupForm={showGroupForm} setShowGroupForm={setShowGroupForm} groupDraft={groupDraft} setGroupDraft={setGroupDraft} handleCreateGroup={handleCreateGroup} showAgentForm={showAgentForm} setShowAgentForm={setShowAgentForm} agentDraft={agentDraft} setAgentDraft={setAgentDraft} saveAgent={saveAgent} deleteAgent={deleteAgent} getIdTokenClaims={getIdTokenClaims} connectWebSocket={connectWebSocket} wsUserIdRef={wsUserIdRef} API_URL={API_URL} setUserId={setUserId} setUserCredits={setUserCredits} setUserIsAnonymous={setUserIsAnonymous} setUserPicture={setUserPicture} setUserEmail={setUserEmail} setShowCredits={setShowCredits} />
      <ChatArea selectedUser={selectedUser} userId={userId} currentMessages={getMessagesForCurrentChat()} aiLoading={aiLoading} messageInput={messageInput} handleInputChange={handleInputChange} handleKeyPress={handleKeyPress} sendMessage={sendMessage} pendingAttachment={pendingAttachment} setPendingAttachment={setPendingAttachment} fileInputRef={fileInputRef} messageInputRef={messageInputRef} handleFileSelect={(e) => handleFileSelect(e, setPendingAttachment)} mentionCandidates={mentionCandidates} applyMention={applyMention} pendingMentionUsers={pendingMentionUsers} setPendingMentionUsers={setPendingMentionUsers} messagesEndRef={messagesEndRef} loadOlderMessages={loadOlderMessages} loadingOlder={loadingOlder} hasMoreMessages={hasMoreMessages} makeConversationId={makeConversationId} />
      <ProfileModal showProfile={showProfile} setShowProfile={setShowProfile} userPicture={userPicture} username={username} userEmail={userEmail} userIsAnonymous={userIsAnonymous} userIsMember={userIsMember} userCredits={userCredits} handleBuyCredits={handleBuyCredits} handleUpgradeMembership={handleUpgradeMembership} handleLogout={handleLogout} setShowCredits={setShowCredits} />
      <UpgradeModal upgradeReason={upgradeReason} setUpgradeReason={setUpgradeReason} handleBuyCredits={handleBuyCredits} handleUpgradeMembership={handleUpgradeMembership} loginWithRedirect={loginWithRedirect} userIsAnonymous={userIsAnonymous} />
      <CreditsModal showCredits={showCredits} setShowCredits={setShowCredits} userCredits={userCredits} userIsAnonymous={userIsAnonymous} isMember={userIsMember} handleBuyCredits={handleBuyCredits} handleUpgradeMembership={handleUpgradeMembership} loginWithRedirect={loginWithRedirect} />
      <ToastContainer />
    </div>
  );
}

export default App;

import { POPULAR_MODELS, DEFAULT_AGENTS, makeAiUser, makeAgentUser } from '../utils/constants';
import ProviderLogo from './ProviderLogo';
export default function Sidebar({
  // Header
  soundEnabled, toggleSound, showSettings, setShowSettings,
  showProfile, setShowProfile, isAuthenticated, handleSignIn,
  userPicture, username, editingName, setEditingName, draftName, setDraftName, setUsername,
  userCredits, userIsMember, userIsAnonymous, auth0Loading, auth0Error, auth0User,
  handleLogout, setShowCredits,
  // Settings
  handleClearHistory, storageLimitMb, handleLimitChange, storageUsage, formatBytes,
  // Tabs
  activeTab, setActiveTab,
  // Contacts
  selectedUser, selectContact, unreadCounts,
  onlineUsers, groups, agents,
  // Groups
  showGroupForm, setShowGroupForm, groupDraft, setGroupDraft, handleCreateGroup,
  // Agents
  showAgentForm, setShowAgentForm, agentDraft, setAgentDraft, saveAgent, deleteAgent,
  // Sync retry
  getIdTokenClaims, connectWebSocket, wsUserIdRef, API_URL,
  setUserId, setUserCredits, setUserIsAnonymous, setUserPicture, setUserEmail,
}) {
  return (
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
          {userIsMember ? (
            <span
              className="credits-badge-mini credits-member"
              onClick={() => setShowCredits(true)}
              title="Unlimited Member"
              style={{ cursor: 'pointer' }}
            >
              👑 Unlimited
            </span>
          ) : userCredits !== null && (
            <span
              className={`credits-badge-mini ${userCredits < 50 ? 'credits-low' : ''}`}
              onClick={() => setShowCredits(true)}
              title="Click to manage credits"
              style={{ cursor: 'pointer' }}
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

      {/* Low credits warning */}
      {!userIsMember && !userIsAnonymous && userCredits !== null && userCredits > 0 && userCredits < 50 && (
        <button className="low-credits-banner" onClick={() => setShowCredits(true)}>
          ⚠️ Low credits: <strong>${(userCredits / 100).toFixed(2)}</strong> remaining — <span className="low-credits-cta">Top up →</span>
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
              const res = await fetch(`${API_URL}/auth/login`, {
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
  );
}

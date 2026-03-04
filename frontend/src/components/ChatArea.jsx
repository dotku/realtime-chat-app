import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ProviderLogo from './ProviderLogo';
export default function ChatArea({
  selectedUser, userId, currentMessages, aiLoading,
  messageInput, handleInputChange, handleKeyPress, sendMessage,
  pendingAttachment, setPendingAttachment, fileInputRef, messageInputRef,
  handleFileSelect, mentionCandidates, applyMention,
  pendingMentionUsers, setPendingMentionUsers, messagesEndRef,
  loadOlderMessages, loadingOlder, hasMoreMessages, makeConversationId,
  onKickMember, onlineUsers,
}) {
  const [showMembers, setShowMembers] = useState(false);

  if (!selectedUser) {
    return (
      <div className="chat-container">
        <div className="no-chat-selected">
          <h2>Welcome to SphareChat</h2>
          <p>Select a user, AI model, or agent to start chatting</p>
        </div>
      </div>
    );
  }

  const isGroupCreator = selectedUser.type === 'group' && selectedUser.created_by === userId;

  // Resolve member names from onlineUsers list
  const getMemberName = (memberId) => {
    if (memberId === userId) return 'You';
    const u = onlineUsers?.find(u => u.user_id === memberId);
    return u?.username || memberId.slice(0, 8) + '...';
  };

  return (
    <div className="chat-container">
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
                <span className="group-members-toggle" onClick={() => setShowMembers(prev => !prev)}>
                  <span className="group-dot"></span> {selectedUser.members?.length || 0} members {showMembers ? '▴' : '▾'}
                </span>
              ) : selectedUser.type === 'ai' || selectedUser.type === 'agent' ? (
                <><span className="ai-dot"></span> {selectedUser.model}</>
              ) : (
                <><span className="online-dot"></span> Online</>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Group member panel */}
      {selectedUser.type === 'group' && showMembers && (
        <div className="group-member-panel">
          {selectedUser.members?.map(memberId => (
            <div key={memberId} className="group-member-row">
              <span className="group-member-avatar">{getMemberName(memberId).charAt(0).toUpperCase()}</span>
              <span className="group-member-name">
                {getMemberName(memberId)}
                {memberId === selectedUser.created_by && <span className="group-owner-badge">Owner</span>}
              </span>
              {isGroupCreator && memberId !== userId && (
                <button
                  className="group-kick-btn"
                  onClick={() => { if (confirm(`Remove ${getMemberName(memberId)} from this group?`)) onKickMember(selectedUser.user_id, memberId); }}
                  title="Remove from group"
                >✕</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="messages-container">
        {loadOlderMessages && selectedUser && (() => {
          const isGroup = selectedUser.type === 'group';
          const convId = makeConversationId?.(userId, selectedUser.user_id, isGroup ? selectedUser.user_id : null);
          return hasMoreMessages?.[convId] !== false && currentMessages.length > 0 && (
            <button className="load-older-btn" onClick={loadOlderMessages} disabled={loadingOlder}>
              {loadingOlder ? 'Loading...' : 'Load older messages'}
            </button>
          );
        })()}
        {currentMessages.map((msg, i) => (
          <div key={i} className={`message ${msg.from_user === userId ? 'sent' : 'received'} ${msg.isError ? 'error-msg' : ''}`}>
            {msg.from_user !== userId && selectedUser?.type === 'group' && (
              <div className="group-msg-sender">{msg.from_username}</div>
            )}
            {msg.content && (
              <div className="message-content markdown-body">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  disallowedElements={['script', 'iframe', 'object', 'embed', 'form']}
                  unwrapDisallowed={true}
                  components={{
                    a: ({ node, ...props }) => (
                      <a {...props} target="_blank" rel="noopener noreferrer" />
                    ),
                  }}
                >{msg.content}</ReactMarkdown>
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
            {!msg.attachment && msg.has_attachment && (
              <div className="message-attachment attachment-unavailable">
                📎 {msg.attachment_name || 'Attachment'} ({msg.attachment_type || 'file'})
                <span className="attachment-note"> — not available on this device</span>
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

        {/* Pending @mention users indicator */}
        {pendingMentionUsers.length > 0 && (
          <div className="pending-mentions-bar">
            <span className="pending-mentions-label">Will create group with:</span>
            {pendingMentionUsers.map(u => (
              <span key={u.user_id} className="pending-mention-chip">
                @{u.username}
                <button className="remove-mention-btn" onClick={() => setPendingMentionUsers(prev => prev.filter(p => p.user_id !== u.user_id))}>×</button>
              </span>
            ))}
          </div>
        )}

        {/* @mention dropdown */}
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
    </div>
  );
}

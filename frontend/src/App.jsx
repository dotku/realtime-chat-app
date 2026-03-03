import { useState, useEffect, useRef } from 'react';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000';

function App() {
  const [username, setUsername] = useState(() => localStorage.getItem('chat_username') || '');
  const [userId, setUserId] = useState(() => localStorage.getItem('chat_userId') || null);
  const [isConnected, setIsConnected] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [serverStatus, setServerStatus] = useState('checking'); // 'checking' | 'online' | 'offline'
  const ws = useRef(null);
  const messagesEndRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const shouldReconnect = useRef(true);
  const isConnectingRef = useRef(false); // Prevent multiple simultaneous connections

  // Health check on mount and every 30 seconds
  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(5000) });
        setServerStatus(res.ok ? 'online' : 'offline');
      } catch {
        setServerStatus('offline');
      }
    };
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  // Auto-connect if user info exists in localStorage
  useEffect(() => {
    const storedUserId = localStorage.getItem('chat_userId');
    const storedUsername = localStorage.getItem('chat_username');

    if (storedUserId && storedUsername && !isConnectingRef.current && !ws.current) {
      console.log('Auto-connecting with stored credentials');
      // Try to connect, if user doesn't exist it will be recreated automatically
      connectWebSocket(storedUserId, storedUsername);
    }
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const generateRandomUsername = () => {
    const adjectives = ['Happy', 'Clever', 'Bright', 'Swift', 'Brave', 'Kind', 'Wise', 'Bold'];
    const nouns = ['Panda', 'Eagle', 'Tiger', 'Dolphin', 'Fox', 'Wolf', 'Hawk', 'Bear'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adj}${noun}${Math.floor(Math.random() * 100)}`;
  };

  const handleJoin = async () => {
    const finalUsername = username.trim() || generateRandomUsername();

    try {
      const response = await fetch(`${API_URL}/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username: finalUsername }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Failed to create user');
      }

      const userData = await response.json();
      setUserId(userData.user_id);
      setUsername(userData.username);

      // Store in localStorage for session persistence
      localStorage.setItem('chat_userId', userData.user_id);
      localStorage.setItem('chat_username', userData.username);

      connectWebSocket(userData.user_id, userData.username);
    } catch (error) {
      console.error('Error creating user:', error);
      if (error.message.includes('Database unavailable')) {
        alert('Database is currently unavailable. Please make sure Docker/PostgreSQL is running and try again.');
      } else {
        alert('Failed to connect. Please try again.');
      }
    }
  };

  const connectWebSocket = (uid, uname) => {
    // Prevent multiple simultaneous connection attempts
    if (isConnectingRef.current) {
      console.log('⚠️ Connection attempt already in progress, skipping...');
      return;
    }

    // Clear any existing reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Close existing connection if any
    if (ws.current && ws.current.readyState !== WebSocket.CLOSED) {
      console.log('🔌 Closing existing connection before creating new one');
      shouldReconnect.current = false;
      ws.current.close();
      ws.current = null;
    }

    shouldReconnect.current = true;
    isConnectingRef.current = true;
    console.log('🔄 Creating new WebSocket connection for user:', uid, 'username:', uname);
    console.log('📍 WebSocket URL:', `${WS_URL}/ws/${uid}`);
    ws.current = new WebSocket(`${WS_URL}/ws/${uid}`);

    ws.current.onopen = () => {
      console.log('✅ WebSocket connected successfully');
      isConnectingRef.current = false;
      setIsConnected(true);
      setIsReconnecting(false);
      setReconnectAttempts(0);
    };

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('Received message:', data);

      if (data.type === 'error') {
        console.error('Server error:', data);
        // Error will be handled in onclose with the proper code
        return;
      } else if (data.type === 'online_users') {
        setOnlineUsers(data.users.filter(u => u.user_id !== uid));
      } else if (data.type === 'user_joined') {
        setOnlineUsers(prev => {
          if (prev.find(u => u.user_id === data.user_id)) return prev;
          return [...prev, { user_id: data.user_id, username: data.username, is_online: true }];
        });
      } else if (data.type === 'user_left') {
        setOnlineUsers(prev => prev.filter(u => u.user_id !== data.user_id));
      } else if (data.type === 'chat') {
        setMessages(prev => [...prev, data]);
      }
    };

    ws.current.onclose = async (event) => {
      console.log('❌ WebSocket disconnected', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        shouldReconnect: shouldReconnect.current
      });
      isConnectingRef.current = false;
      setIsConnected(false);

      if (!shouldReconnect.current) {
        console.log('🚫 Reconnect disabled, not attempting to reconnect');
        return;
      }

      if (event.code === 1011) {
        console.error('💾 Database is unavailable');
        setIsReconnecting(true);
      }

      // If user not found (code 4004), recreate the user
      if (event.code === 4004) {
        console.log('👤 User not found in database (4004), recreating user...');
        setIsReconnecting(true);

        try {
          const response = await fetch(`${API_URL}/users`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ username: uname }),
          });

          if (response.ok) {
            const userData = await response.json();
            console.log('User recreated with new ID:', userData.user_id);
            setUserId(userData.user_id);

            // Update localStorage with new user ID
            localStorage.setItem('chat_userId', userData.user_id);
            localStorage.setItem('chat_username', uname);

            // Reset attempts and reconnect with new user ID
            setReconnectAttempts(0);
            setTimeout(() => {
              console.log('Reconnecting with new user ID:', userData.user_id);
              connectWebSocket(userData.user_id, uname);
            }, 500);
            return; // Don't fall through to normal reconnection
          } else {
            console.error('Failed to recreate user, status:', response.status);
          }
        } catch (error) {
          console.error('Error recreating user:', error);
        }
        // If recreation failed, fall through to normal reconnection logic
      }

      // Attempt to reconnect with exponential backoff
      const maxAttempts = 10;

      setReconnectAttempts(prev => {
        const newAttempts = prev + 1;

        if (newAttempts > maxAttempts) {
          console.log('Max reconnect attempts reached');
          setIsReconnecting(false);
          shouldReconnect.current = false; // Stop reconnection attempts
          alert('Unable to reconnect to server. Please refresh the page.');
          return newAttempts;
        }

        const delay = Math.min(1000 * Math.pow(2, newAttempts - 1), 30000); // Max 30 seconds
        console.log(`Reconnecting in ${delay}ms (attempt ${newAttempts}/${maxAttempts})`);
        setIsReconnecting(true);

        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('Attempting to reconnect...');
          connectWebSocket(uid, uname);
        }, delay);

        return newAttempts;
      });
    };

    ws.current.onerror = (error) => {
      console.error('WebSocket error:', error);
      isConnectingRef.current = false;
    };
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldReconnect.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (ws.current) {
        ws.current.close();
      }
    };
  }, []);

  const sendMessage = () => {
    if (!messageInput.trim() || !selectedUser) return;

    const message = {
      type: 'chat',
      to_user: selectedUser.user_id,
      content: messageInput,
    };

    ws.current.send(JSON.stringify(message));
    setMessageInput('');
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const selectUser = (user) => {
    setSelectedUser(user);
  };

  const handleLogout = () => {
    shouldReconnect.current = false;
    if (ws.current) {
      ws.current.close();
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    // Clear state
    setUserId(null);
    setUsername('');
    setIsConnected(false);
    setOnlineUsers([]);
    setSelectedUser(null);
    setMessages([]);
    setReconnectAttempts(0);
    setIsReconnecting(false);

    // Clear localStorage
    localStorage.removeItem('chat_userId');
    localStorage.removeItem('chat_username');
  };

  const getMessagesForCurrentChat = () => {
    if (!selectedUser) return [];
    return messages.filter(
      msg =>
        (msg.from_user === userId && msg.to_user === selectedUser.user_id) ||
        (msg.from_user === selectedUser.user_id && msg.to_user === userId)
    );
  };

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
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username (optional)"
            onKeyPress={(e) => e.key === 'Enter' && handleJoin()}
            className="username-input"
          />
          <button onClick={handleJoin} className="join-button" disabled={serverStatus === 'offline'}>
            Join Chat
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {!isConnected && (
        <div className="reconnecting-banner">
          {reconnectAttempts > 0 ? (
            <>🔄 Reconnecting to server... (Attempt {reconnectAttempts}/10)</>
          ) : (
            <>⚠️ Disconnected from server - Checking connection...</>
          )}
        </div>
      )}
      <div className="sidebar">
        <div className="sidebar-header">
          <h2>Online Users</h2>
          <div className="user-info-badge">
            <span className="user-badge">{username}</span>
            <span className="user-id" title="Your User ID">{userId}</span>
            <button onClick={handleLogout} className="logout-button">
              Logout
            </button>
          </div>
        </div>
        <div className="users-list">
          {onlineUsers.length === 0 ? (
            <div className="no-users">No other users online</div>
          ) : (
            onlineUsers.map((user) => (
              <div
                key={user.user_id}
                className={`user-item ${selectedUser?.user_id === user.user_id ? 'selected' : ''}`}
                onClick={() => selectUser(user)}
              >
                <div className="user-avatar">{user.username.charAt(0).toUpperCase()}</div>
                <div className="user-info">
                  <div className="user-name">{user.username}</div>
                  <div className="user-status">
                    <span className="online-dot"></span> Online
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="chat-container">
        {selectedUser ? (
          <>
            <div className="chat-header">
              <div className="chat-user-info">
                <div className="user-avatar">{selectedUser.username.charAt(0).toUpperCase()}</div>
                <div>
                  <div className="chat-username">{selectedUser.username}</div>
                  <div className="chat-status">
                    <span className="online-dot"></span> Online
                  </div>
                </div>
              </div>
            </div>

            <div className="messages-container">
              {getMessagesForCurrentChat().map((msg, index) => (
                <div
                  key={index}
                  className={`message ${msg.from_user === userId ? 'sent' : 'received'}`}
                >
                  <div className="message-content">{msg.content}</div>
                  <div className="message-time">
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="message-input-container">
              <input
                type="text"
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type a message..."
                className="message-input"
              />
              <button onClick={sendMessage} className="send-button">
                Send
              </button>
            </div>
          </>
        ) : (
          <div className="no-chat-selected">
            <h2>Welcome to SphareChat</h2>
            <p>Select a user from the list to start chatting</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;

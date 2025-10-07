import { useState, useEffect, useRef } from 'react';
import './App.css';

const API_URL = 'http://localhost:8000';
const WS_URL = 'ws://localhost:8000';

function App() {
  const [username, setUsername] = useState('');
  const [userId, setUserId] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const ws = useRef(null);
  const messagesEndRef = useRef(null);

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

      const userData = await response.json();
      setUserId(userData.user_id);
      setUsername(userData.username);
      connectWebSocket(userData.user_id, userData.username);
    } catch (error) {
      console.error('Error creating user:', error);
      alert('Failed to connect. Please try again.');
    }
  };

  const connectWebSocket = (uid, uname) => {
    ws.current = new WebSocket(`${WS_URL}/ws/${uid}`);

    ws.current.onopen = () => {
      console.log('WebSocket connected');
      setIsConnected(true);
    };

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('Received message:', data);

      if (data.type === 'online_users') {
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

    ws.current.onclose = () => {
      console.log('WebSocket disconnected');
      setIsConnected(false);
    };

    ws.current.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  };

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
    setMessages([]);
  };

  const getMessagesForCurrentChat = () => {
    if (!selectedUser) return [];
    return messages.filter(
      msg =>
        (msg.from_user === userId && msg.to_user === selectedUser.user_id) ||
        (msg.from_user === selectedUser.user_id && msg.to_user === userId)
    );
  };

  if (!isConnected) {
    return (
      <div className="login-container">
        <div className="login-box">
          <h1>💬 Real-Time Chat</h1>
          <p>Enter a username or leave blank for a random one</p>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username (optional)"
            onKeyPress={(e) => e.key === 'Enter' && handleJoin()}
            className="username-input"
          />
          <button onClick={handleJoin} className="join-button">
            Join Chat
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="sidebar">
        <div className="sidebar-header">
          <h2>Online Users</h2>
          <span className="user-badge">{username}</span>
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
            <h2>👋 Welcome to Real-Time Chat!</h2>
            <p>Select a user from the list to start chatting</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;

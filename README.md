# Real-Time Chat Application

A real-time 1-to-1 chat application built with FastAPI, PostgreSQL, and React. Users can see online users and exchange messages in real-time using WebSockets.

## Features

- **Real-time Communication**: WebSocket-based instant messaging
- **User Presence Tracking**: See who's online in real-time
- **1-to-1 Chat**: Direct messaging between users
- **Anonymous Access**: No authentication required - users get auto-generated names or can choose their own
- **Clean UI**: Modern, responsive interface built with React
- **Dockerized**: Easy deployment with Docker Compose

## Tech Stack

### Backend
- **FastAPI**: Modern Python web framework for building APIs
- **PostgreSQL**: Database for user presence tracking
- **WebSockets**: Real-time bidirectional communication
- **SQLAlchemy**: ORM for database operations
- **Pydantic**: Data validation and settings management

### Frontend
- **React**: UI library for building interactive interfaces
- **Vite**: Fast build tool and dev server
- **WebSocket API**: Native browser WebSocket support

## Architecture Overview

```
┌─────────────────┐         WebSocket          ┌──────────────────┐
│                 │◄─────────────────────────►│                  │
│  React Frontend │         REST API           │  FastAPI Backend │
│                 │◄─────────────────────────►│                  │
└─────────────────┘                            └────────┬─────────┘
                                                        │
                                                        │
                                                        ▼
                                                ┌──────────────┐
                                                │  PostgreSQL  │
                                                │   Database   │
                                                └──────────────┘
```

### Key Components

1. **Connection Manager**: Manages WebSocket connections and broadcasts messages
2. **User Presence**: Tracks online/offline status in PostgreSQL
3. **Message Routing**: Routes messages between specific user pairs
4. **Real-time Updates**: Broadcasts user join/leave events to all connected clients

## Setup Instructions

### Prerequisites

- Docker and Docker Compose installed
- Ports 5173 (frontend), 8000 (backend), and 5432 (database) available

### Option 1: Docker Compose (Recommended)

1. **Clone the repository and navigate to the project directory**:
   ```bash
   cd realtime-chat-app
   ```

2. **Start all services**:
   ```bash
   docker-compose up --build
   ```

3. **Access the application**:
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:8000
   - API Docs: http://localhost:8000/docs

4. **Stop the application**:
   ```bash
   docker-compose down
   ```

### Option 2: Local Development

#### Backend Setup

1. **Navigate to backend directory**:
   ```bash
   cd backend
   ```

2. **Create a virtual environment**:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Set up PostgreSQL**:
   - Install PostgreSQL locally
   - Create a database named `chatdb`
   - Update `.env` file with your database credentials:
     ```
     DATABASE_URL=postgresql://chatuser:chatpass@localhost:5432/chatdb
     ```

5. **Run the backend**:
   ```bash
   python main.py
   # Or with uvicorn directly:
   uvicorn main:app --reload --host 0.0.0.0 --port 8000
   ```

#### Frontend Setup

1. **Navigate to frontend directory**:
   ```bash
   cd frontend
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run the development server**:
   ```bash
   npm run dev
   ```

4. **Access the application**:
   - Open http://localhost:5173 in your browser

## How to Use

1. **Join the Chat**:
   - Enter a username or leave it blank for a random generated name
   - Click "Join Chat"

2. **See Online Users**:
   - The left sidebar shows all currently online users
   - Green dot indicates online status

3. **Start Chatting**:
   - Click on any user in the sidebar to open a chat
   - Type your message and press Enter or click Send
   - Messages appear in real-time for both users

4. **Multiple Windows**:
   - Open the app in multiple browser windows/tabs to simulate different users
   - Each window will get a unique user ID

## API Endpoints

### REST API

- `GET /` - Health check
- `GET /health` - Health status
- `POST /users` - Create a new user
  ```json
  {
    "username": "JohnDoe"
  }
  ```
- `GET /users/online` - Get list of online users

### WebSocket

- `WS /ws/{user_id}` - WebSocket connection for real-time messaging

#### WebSocket Message Types

**Sent by Client**:
```json
{
  "type": "chat",
  "to_user": "user_id",
  "content": "Hello!"
}
```

**Received by Client**:
- `online_users`: List of currently online users
- `user_joined`: Notification when a user connects
- `user_left`: Notification when a user disconnects
- `chat`: Chat message from another user

## Project Structure

```
realtime-chat-app/
├── backend/
│   ├── main.py                 # FastAPI application and WebSocket routes
│   ├── database.py             # Database models and connection
│   ├── models.py               # Pydantic models for validation
│   ├── connection_manager.py   # WebSocket connection management
│   ├── requirements.txt        # Python dependencies
│   ├── Dockerfile             # Backend container configuration
│   └── .env                   # Environment variables
├── frontend/
│   ├── src/
│   │   ├── App.jsx           # Main React component
│   │   ├── App.css           # Styles
│   │   └── main.jsx          # Entry point
│   ├── package.json          # Node dependencies
│   └── Dockerfile            # Frontend container configuration
├── docker-compose.yml        # Docker Compose configuration
└── README.md                 # This file
```

## Features in Detail

### User Presence Management
- Users are automatically marked online when they connect
- PostgreSQL stores user status and connection time
- Real-time updates when users join or leave
- Graceful handling of disconnections

### WebSocket Connection Manager
- In-memory tracking of active connections
- Message routing between specific users
- Broadcasting of system events (user join/leave)
- Error handling and connection cleanup

### Session-Based Messaging
- No database persistence for messages (as per requirements)
- Messages exist only during active sessions
- **Message Queue**: Up to 50 pending messages per user stored in memory
- Messages delivered automatically when recipient comes online
- Lightweight and fast communication
- Focus on real-time interaction

## Error Handling

- **Connection Errors**: Gracefully handled with user feedback
- **Disconnection**: Automatic cleanup and status updates
- **Invalid Messages**: Validated with Pydantic models
- **Database Errors**: Proper error responses and logging

## Development Notes

- The application uses FastAPI's WebSocket support for real-time features
- Pydantic models ensure type safety and validation
- SQLAlchemy ORM provides clean database interactions
- React hooks manage state and WebSocket connections
- Auto-generated usernames use a combination of adjectives and animal names

## Future Enhancements

Potential improvements (not implemented):
- Message history persistence
- User authentication
- Group chat support
- File sharing
- Typing indicators
- Read receipts
- Push notifications

## Troubleshooting

### Port Already in Use
If you get port conflicts, stop any services using ports 5173, 8000, or 5432, or modify the ports in `docker-compose.yml`.

### Database Connection Issues
Ensure PostgreSQL is running and credentials in `.env` match your database configuration.

### WebSocket Connection Failed
Check that the backend is running and accessible at http://localhost:8000.

### Frontend Not Loading
Verify Node.js is installed and run `npm install` in the frontend directory.

## License

This project is created as a take-home assignment and is available for educational purposes.

## Author

Built with FastAPI, PostgreSQL, and React following modern web development best practices.

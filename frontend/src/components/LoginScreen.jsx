export default function LoginScreen({
  serverStatus, username, setUsername, handleJoin,
  auth0Loading, loginWithRedirect,
}) {
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

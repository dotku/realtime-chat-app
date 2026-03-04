export default function ProfileModal({
  showProfile, setShowProfile,
  userPicture, username, userEmail, userIsAnonymous, userIsMember,
  userCredits, handleBuyCredits, handleUpgradeMembership, handleLogout,
  setShowCredits,
}) {
  if (!showProfile) return null;

  const creditsDollars = userCredits !== null ? (userCredits / 100).toFixed(2) : '—';
  const creditsLow = userCredits !== null && userCredits < 50;

  return (
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
        <div className="profile-modal-badge-row">
          <span className={`profile-modal-badge ${userIsMember ? 'badge-member' : ''}`}>
            {userIsAnonymous ? 'Anonymous' : userIsMember ? '👑 Member' : 'Registered'}
          </span>
        </div>

        {/* Credits Section */}
        <div className="profile-modal-credits">
          <div className="profile-modal-credits-label">AI Credits</div>
          <div className={`profile-modal-credits-value ${creditsLow ? 'credits-low' : ''}`}>
            {userIsMember ? '∞ Unlimited' : `$${creditsDollars}`}
          </div>

          {!userIsMember && !userIsAnonymous && (
            <div className="profile-credits-actions">
              <div className="profile-credit-packages">
                {[5, 10, 20].map(amt => (
                  <button key={amt} className="profile-credit-pkg-btn" onClick={() => { setShowProfile(false); handleBuyCredits(amt); }}>
                    ${amt}
                  </button>
                ))}
              </div>
              <button className="profile-view-all-btn" onClick={() => { setShowProfile(false); setShowCredits(true); }}>
                View all packages →
              </button>
            </div>
          )}

          {!userIsMember && !userIsAnonymous && (
            <button className="profile-membership-btn" onClick={() => { setShowProfile(false); handleUpgradeMembership(); }}>
              👑 Upgrade to Unlimited
            </button>
          )}
        </div>

        <div className="profile-modal-actions">
          <button className="logout-button" onClick={() => { setShowProfile(false); handleLogout(); }}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

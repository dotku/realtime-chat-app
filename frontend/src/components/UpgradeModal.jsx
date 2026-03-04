export default function UpgradeModal({
  upgradeReason, setUpgradeReason,
  handleBuyCredits, handleUpgradeMembership,
  loginWithRedirect, userIsAnonymous,
}) {
  if (!upgradeReason) return null;

  return (
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
  );
}

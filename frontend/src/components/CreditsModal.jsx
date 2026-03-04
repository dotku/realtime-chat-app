export default function CreditsModal({
  showCredits, setShowCredits,
  userCredits, userIsAnonymous, isMember,
  handleBuyCredits, handleUpgradeMembership,
  loginWithRedirect,
}) {
  if (!showCredits) return null;

  const creditsDollars = userCredits !== null ? (userCredits / 100).toFixed(2) : '—';
  const creditsLow = userCredits !== null && userCredits < 50;
  const creditsCritical = userCredits !== null && userCredits <= 0;

  return (
    <div className="modal-overlay" onClick={() => setShowCredits(false)}>
      <div className="credits-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close-btn" onClick={() => setShowCredits(false)}>✕</button>

        {/* Balance Display */}
        <div className="credits-balance-section">
          <div className="credits-balance-label">Your Balance</div>
          <div className={`credits-balance-amount ${creditsLow ? 'credits-low' : ''} ${creditsCritical ? 'credits-critical' : ''}`}>
            {isMember ? '∞' : `$${creditsDollars}`}
          </div>
          {isMember && (
            <div className="credits-member-tag">Unlimited Member</div>
          )}
          {!isMember && creditsLow && !creditsCritical && (
            <div className="credits-warning-tag">Running low</div>
          )}
          {!isMember && creditsCritical && (
            <div className="credits-empty-tag">No credits remaining</div>
          )}
        </div>

        {/* Quick Info */}
        {!isMember && (
          <div className="credits-info-row">
            <div className="credits-info-item">
              <span className="credits-info-icon">💬</span>
              <span>~{userCredits !== null ? Math.max(0, Math.floor(userCredits / 1)) : 0} AI messages left</span>
            </div>
            <div className="credits-info-item">
              <span className="credits-info-icon">📊</span>
              <span>~1¢ per message avg</span>
            </div>
          </div>
        )}

        {/* Buy Credits */}
        {!isMember && (
          <>
            <div className="credits-section-title">Top Up Credits</div>
            <div className="credits-packages-grid">
              {[
                { amount: 5, label: '$5', desc: '~500 messages' },
                { amount: 10, label: '$10', desc: '~1,000 messages', popular: true },
                { amount: 20, label: '$20', desc: '~2,000 messages' },
                { amount: 50, label: '$50', desc: '~5,000 messages' },
              ].map(pkg => (
                <button
                  key={pkg.amount}
                  className={`credits-package-card ${pkg.popular ? 'popular' : ''}`}
                  onClick={() => { setShowCredits(false); handleBuyCredits(pkg.amount); }}
                >
                  {pkg.popular && <span className="credits-popular-tag">Popular</span>}
                  <span className="credits-package-price">{pkg.label}</span>
                  <span className="credits-package-desc">{pkg.desc}</span>
                </button>
              ))}
            </div>

            {/* Membership Upsell */}
            <div className="credits-membership-section">
              <div className="credits-membership-card" onClick={() => { setShowCredits(false); handleUpgradeMembership(); }}>
                <div className="credits-membership-left">
                  <span className="credits-membership-icon">👑</span>
                  <div>
                    <div className="credits-membership-title">Unlimited Membership</div>
                    <div className="credits-membership-desc">No limits, no worries. Chat with any AI model as much as you want.</div>
                  </div>
                </div>
                <span className="credits-membership-arrow">→</span>
              </div>
            </div>
          </>
        )}

        {/* Member Section */}
        {isMember && (
          <div className="credits-member-section">
            <div className="credits-member-perks">
              <div className="credits-perk">✓ Unlimited AI messages</div>
              <div className="credits-perk">✓ All AI models</div>
              <div className="credits-perk">✓ Priority support</div>
            </div>
          </div>
        )}

        {/* Anonymous CTA */}
        {userIsAnonymous && (
          <div className="credits-anon-cta">
            <span>🎁</span>
            <span>Sign in to get <strong>$5 free</strong> credits</span>
            <button className="credits-signin-btn" onClick={() => {
              setShowCredits(false);
              loginWithRedirect({ authorizationParams: { screen_hint: 'signup' } });
            }}>Sign Up Free</button>
          </div>
        )}
      </div>
    </div>
  );
}

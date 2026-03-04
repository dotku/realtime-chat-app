import { PROVIDER_STYLES } from '../utils/constants';

export default function ProviderLogo({ provider }) {
  const style = PROVIDER_STYLES[provider] || { bg: '#888', label: '?' };
  // OpenAI special SVG
  if (provider === 'OpenAI') {
    return (
      <div className="provider-logo" style={{ background: style.bg }}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="white">
          <path d="M22.282 9.821a5.985 5.985 0 00-.516-4.91 6.046 6.046 0 00-6.51-2.9A6.065 6.065 0 0011.67.014a6.048 6.048 0 00-5.771 4.17 5.985 5.985 0 00-3.998 2.9 6.046 6.046 0 00.743 7.097 5.98 5.98 0 00.51 4.911 6.051 6.051 0 006.515 2.9A5.985 5.985 0 0013.26 23.1a6.043 6.043 0 005.77-4.175 5.985 5.985 0 003.997-2.9 6.046 6.046 0 00-.745-6.204z"/>
        </svg>
      </div>
    );
  }
  return (
    <div className="provider-logo" style={{ background: style.bg }}>
      <span>{style.label}</span>
    </div>
  );
}

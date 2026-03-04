import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LoginScreen from '../components/LoginScreen';

const defaultProps = {
  serverStatus: 'online',
  username: '',
  setUsername: vi.fn(),
  handleJoin: vi.fn(),
  auth0Loading: false,
  loginWithRedirect: vi.fn(),
};

describe('LoginScreen', () => {
  it('renders the app title', () => {
    render(<LoginScreen {...defaultProps} />);
    expect(screen.getByText('SphareChat')).toBeInTheDocument();
  });

  it('shows server online status', () => {
    render(<LoginScreen {...defaultProps} serverStatus="online" />);
    expect(screen.getByText('Server online')).toBeInTheDocument();
  });

  it('shows server offline status', () => {
    render(<LoginScreen {...defaultProps} serverStatus="offline" />);
    expect(screen.getByText('Server offline — please try later')).toBeInTheDocument();
  });

  it('shows loading message when auth0 is loading', () => {
    render(<LoginScreen {...defaultProps} auth0Loading={true} />);
    expect(screen.getByText('Checking session...')).toBeInTheDocument();
  });

  it('disables join button when server is offline', () => {
    render(<LoginScreen {...defaultProps} serverStatus="offline" />);
    const btn = screen.getByText('Start Chatting');
    expect(btn).toBeDisabled();
  });

  it('calls handleJoin on button click', () => {
    const handleJoin = vi.fn();
    render(<LoginScreen {...defaultProps} handleJoin={handleJoin} />);
    fireEvent.click(screen.getByText('Start Chatting'));
    expect(handleJoin).toHaveBeenCalledTimes(1);
  });

  it('calls loginWithRedirect on sign-in button click', () => {
    const loginWithRedirect = vi.fn();
    render(<LoginScreen {...defaultProps} loginWithRedirect={loginWithRedirect} />);
    fireEvent.click(screen.getByText('Sign in with Google'));
    expect(loginWithRedirect).toHaveBeenCalledTimes(1);
  });

  it('updates username on input change', () => {
    const setUsername = vi.fn();
    render(<LoginScreen {...defaultProps} setUsername={setUsername} />);
    const input = screen.getByPlaceholderText(/Enter your name/);
    fireEvent.change(input, { target: { value: 'Alice' } });
    expect(setUsername).toHaveBeenCalled();
  });
});

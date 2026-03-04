import { describe, it, expect, vi } from 'vitest';
import { playNotificationSound } from '../utils/soundUtils';

describe('playNotificationSound', () => {
  it('does nothing when sound is disabled', () => {
    const ref = { current: false };
    // Should not throw
    playNotificationSound(ref);
  });

  it('creates AudioContext when enabled', () => {
    const mockOsc = { connect: vi.fn(), frequency: { value: 0 }, type: '', start: vi.fn(), stop: vi.fn() };
    const mockGain = { connect: vi.fn(), gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } };
    const mockCtx = {
      createOscillator: vi.fn(() => mockOsc),
      createGain: vi.fn(() => mockGain),
      destination: {},
      currentTime: 0,
    };
    // Use a real function constructor so `new AudioContext()` works
    globalThis.AudioContext = function() { return mockCtx; };

    const ref = { current: true };
    playNotificationSound(ref);

    expect(mockCtx.createOscillator).toHaveBeenCalled();
    expect(mockOsc.start).toHaveBeenCalled();
    expect(mockOsc.stop).toHaveBeenCalled();
  });
});

import { describe, it, expect } from 'vitest';
import { localDevHostPort, windowPlacement } from '../src/features/playWindow/multiplayerPlay';

// Play › Multiplayer's window placement: every player's window somewhere else on the screen, none over another.

const area = { left: 0, top: 0, width: 1920, height: 1040 };
const size = { width: 1280, height: 720 };

describe('windowPlacement', () => {
  it('spreads the windows from the top-left corner to the bottom-right', () => {
    const at = [0, 1, 2].map(i => windowPlacement(i, 3, size, area));
    expect(at[0]).toEqual({ left: 0, top: 0 });
    expect(at[2].left + size.width).toBeLessThanOrEqual(area.width);
    expect(at[2].top + size.height).toBeLessThanOrEqual(area.height);
    expect(at[1].left).toBeGreaterThan(at[0].left);
    expect(at[1].left).toBeLessThan(at[2].left);
    expect(at[1].top).toBeGreaterThan(at[0].top);
  });

  it('places a lone window in the middle of the span', () => {
    const at = windowPlacement(0, 1, size, area);
    expect(at.left).toBeGreaterThan(0);
    expect(at.top).toBeGreaterThan(0);
  });

  it('follows the screen it is on (a second monitor) and keeps a window bigger than it at its corner', () => {
    const second = { left: 1920, top: 0, width: 1280, height: 700 };
    expect(windowPlacement(0, 2, size, second)).toEqual({ left: 1920, top: 0 });
    expect(windowPlacement(1, 2, size, second)).toEqual({ left: 1920, top: 0 });
  });
});

describe('localDevHostPort', () => {
  it('names the port of an address on this machine, which the desktop editor may start a dev host on', () => {
    expect(localDevHostPort('http://127.0.0.1:4490')).toBe(4490);
    expect(localDevHostPort('http://localhost:5000')).toBe(5000);
    expect(localDevHostPort('http://[::1]:4490')).toBe(4490);
  });

  it('refuses anything else: another machine, no port, a privileged port, not http, not an address', () => {
    expect(localDevHostPort('http://192.168.1.5:4490')).toBeNull();
    expect(localDevHostPort('http://127.0.0.1')).toBeNull();
    expect(localDevHostPort('http://127.0.0.1:80')).toBeNull();
    expect(localDevHostPort('https://127.0.0.1:4490')).toBeNull();
    expect(localDevHostPort('127.0.0.1:4490')).toBeNull();
    expect(localDevHostPort('')).toBeNull();
  });
});

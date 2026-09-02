import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearToasts, dismissToast, getSnapshot, showToast, subscribe, toast,
} from '../src/features/toasts/toastStore';

// Toasts replaced the two window.alert() validation guards. They dismiss themselves on a timer, which is
// the whole risk surface: a timer that outlives its toast fires against an id that is gone, and a toast
// dropped by the stack cap without clearing its timer leaks one. Both are asserted here via
// vi.getTimerCount() rather than trusted.

beforeEach(() => { vi.useFakeTimers(); clearToasts(); });
afterEach(() => { clearToasts(); vi.useRealTimers(); });

describe('toastStore', () => {
  it('appends a toast and dismisses it when its duration elapses', () => {
    toast.info('Saved', { duration: 1000 });
    expect(getSnapshot()).toHaveLength(1);
    expect(getSnapshot()[0].message).toBe('Saved');

    vi.advanceTimersByTime(999);
    expect(getSnapshot(), 'not yet').toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(getSnapshot()).toHaveLength(0);
    expect(vi.getTimerCount(), 'the timer is not left behind').toBe(0);
  });

  it('keeps a zero-duration toast up until the user closes it', () => {
    toast.error('Publish failed');
    vi.advanceTimersByTime(60_000);
    expect(getSnapshot(), 'an error waits for the user').toHaveLength(1);
  });

  // The reason dedupe exists: both converted call sites are validation guards on a button, so clicking
  // Add five times with nothing picked used to mean five identical dialogs.
  it('bumps a repeat rather than stacking it, and resets its clock', () => {
    toast.warning('Pick a texture for the grass billboard.', { duration: 1000 });
    vi.advanceTimersByTime(800);
    toast.warning('Pick a texture for the grass billboard.', { duration: 1000 });

    expect(getSnapshot()).toHaveLength(1);
    expect(getSnapshot()[0].count).toBe(2);

    vi.advanceTimersByTime(800);
    expect(getSnapshot(), 'the repeat restarted the clock').toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(getSnapshot()).toHaveLength(0);
  });

  it('treats a different tone or title as a different notice', () => {
    showToast({ message: 'Same words', tone: 'info' });
    showToast({ message: 'Same words', tone: 'warning' });
    showToast({ message: 'Same words', tone: 'info', title: 'Titled' });
    expect(getSnapshot()).toHaveLength(3);
  });

  it('drops the oldest past the cap without leaking its timer', () => {
    for (let i = 0; i < 7; i++) toast.info(`Notice ${i}`, { duration: 1000 });

    const live = getSnapshot();
    expect(live.length, 'capped').toBeLessThanOrEqual(4);
    expect(live[live.length - 1].message, 'the newest survives').toBe('Notice 6');
    expect(vi.getTimerCount(), 'one timer per live toast').toBe(live.length);
  });

  it('clears the pending timer when a toast is dismissed by hand', () => {
    const id = toast.info('Saved', { duration: 5000 });
    dismissToast(id);
    expect(getSnapshot()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    dismissToast(id); // already gone
    expect(getSnapshot()).toHaveLength(0);
  });

  it('clearToasts empties the stack and every timer with it', () => {
    toast.info('One', { duration: 5000 });
    toast.warning('Two', { duration: 5000 });
    clearToasts();
    expect(getSnapshot()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('notifies subscribers, and stops once unsubscribed', () => {
    let calls = 0;
    const unsubscribe = subscribe(() => { calls++; });
    toast.success('Published', { duration: 1000 });
    expect(calls).toBe(1);

    unsubscribe();
    toast.success('Published again', { duration: 1000 });
    expect(calls).toBe(1);
  });

  it('accepts a bare string, defaulting to an info notice', () => {
    showToast('Just so you know');
    expect(getSnapshot()[0].tone).toBe('info');
    expect(getSnapshot()[0].count).toBe(1);
  });

  it('replaces the snapshot array only on a real change', () => {
    toast.info('One', { duration: 5000 });
    const before = getSnapshot();
    expect(getSnapshot(), 'same array, or useSyncExternalStore spins').toBe(before);

    toast.info('Two', { duration: 5000 });
    expect(getSnapshot()).not.toBe(before);
  });
});

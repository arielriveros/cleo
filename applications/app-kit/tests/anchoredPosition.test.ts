import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ANCHOR_GAP, placeAnchored } from '../src/ui/anchoredPosition';

// Where a popover panel goes beside its trigger: on the side asked for, flipped when only the other fits.

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;

describe('placeAnchored', () => {
  beforeEach(() => { vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 }); });

  it('opens below by default', () => {
    expect(placeAnchored(rect(100, 100, 60, 20), rect(0, 0, 160, 200)).top).toBe(120 + ANCHOR_GAP);
  });

  it('opens above when asked', () => {
    expect(placeAnchored(rect(100, 700, 60, 20), rect(0, 0, 160, 200), 'left', 'above').top).toBe(700 - ANCHOR_GAP - 200);
  });

  it('flips below when there is no room above', () => {
    expect(placeAnchored(rect(100, 50, 60, 20), rect(0, 0, 160, 200), 'left', 'above').top).toBe(70 + ANCHOR_GAP);
  });

  it('flips above when there is no room below', () => {
    expect(placeAnchored(rect(100, 700, 60, 20), rect(0, 0, 160, 200)).top).toBe(700 - ANCHOR_GAP - 200);
  });
});

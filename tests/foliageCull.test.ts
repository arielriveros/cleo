import { describe, it, expect } from 'vitest';
import { foliageCullLimitSq, foliageAdmitCount } from '../src/terrain/foliage';

/**
 * Foliage is culled per spatial CELL, and crossing that boundary is a step change: the frame a cell is
 * admitted must draw its entire instance count × every prototype of the tree, with nothing amortising it.
 *
 * Two consequences this pins. A cell parked on the boundary must not flip every frame on sub-metre camera
 * jitter — the symptom was large CPU spikes that appeared only while the camera moved. And when several
 * cells cross at once, they must be let in a few per frame instead of all together, EXCEPT on a layer's
 * first sight, where rate-limiting would fade the whole landscape in rather than smooth anything.
 */

describe('foliageCullLimitSq — hysteresis on the distance cull', () => {
  const CULL = 100;
  const maxD2 = CULL * CULL;
  const H = 1.1;

  it('admits a hidden cell exactly at the authored distance', () => {
    // The EXPENSIVE transition stays where the user put it; only the free one is delayed.
    expect(foliageCullLimitSq(maxD2, false, H)).toBe(maxD2);
  });

  it('holds a visible cell out to distance × hysteresis', () => {
    expect(foliageCullLimitSq(maxD2, true, H)).toBeCloseTo((CULL * H) ** 2, 6);
  });

  it('does not flip a cell sitting inside the band', () => {
    // A cell at 105 m with a 100 m cull: already visible, it stays; hidden, it stays hidden. Neither
    // state changes, which is the whole point — an undamped `d2 > maxD2` flips here every frame.
    const d2 = 105 * 105;
    expect(d2 > foliageCullLimitSq(maxD2, true, H)).toBe(false);  // visible -> stays visible
    expect(d2 > foliageCullLimitSq(maxD2, false, H)).toBe(true);  // hidden  -> stays hidden
  });

  it('still culls a visible cell once it is past the band', () => {
    const d2 = 111 * 111;
    expect(d2 > foliageCullLimitSq(maxD2, true, H)).toBe(true);
  });

  it('still admits a hidden cell once it is inside', () => {
    const d2 = 99 * 99;
    expect(d2 > foliageCullLimitSq(maxD2, false, H)).toBe(false);
  });

  it('is a no-op at hysteresis 1 — the old undamped behaviour', () => {
    expect(foliageCullLimitSq(maxD2, true, 1)).toBe(maxD2);
    expect(foliageCullLimitSq(maxD2, false, 1)).toBe(maxD2);
  });

  it('leaves an infinite limit infinite', () => {
    // cullDistance 0 means "never cull"; multiplying Infinity must not produce NaN and start culling.
    expect(foliageCullLimitSq(Infinity, true, H)).toBe(Infinity);
    expect(foliageCullLimitSq(Infinity, false, H)).toBe(Infinity);
  });
});

describe('foliageAdmitCount — spreading newly-visible cells', () => {
  it('admits at most the budget in the steady state', () => {
    expect(foliageAdmitCount(20, 4, false)).toBe(4);
  });

  it('admits everything on a layer’s first sight', () => {
    // A scene load. Budgeting here would not smooth a spike, it would fade the landscape in over a
    // second — and the load cost is paid once either way.
    expect(foliageAdmitCount(200, 4, true)).toBe(200);
  });

  it('never invents work when fewer are waiting than the budget', () => {
    expect(foliageAdmitCount(2, 4, false)).toBe(2);
    expect(foliageAdmitCount(0, 4, false)).toBe(0);
  });

  it('treats a budget of 0 as disabled, not as "admit nothing"', () => {
    // A 0 budget must not silently stop foliage from ever appearing again.
    expect(foliageAdmitCount(20, 0, false)).toBe(20);
    expect(foliageAdmitCount(20, -1, false)).toBe(20);
  });

  it('drains a backlog over successive frames', () => {
    let waiting = 30;
    let frames = 0;
    while (waiting > 0) { waiting -= foliageAdmitCount(waiting, 4, false); frames++ }
    // Bounded and monotonic: 30 cells at 4/frame clear in 8 frames, ~130ms at 60fps, and every frame in
    // between pays a fraction of what one frame used to.
    expect(frames).toBe(8);
  });
});

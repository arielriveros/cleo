import { describe, it, expect } from 'vitest';
import {
  foliageCullLimitSq, foliageAdmitCount, createFoliageBatch, foliageBatchStale,
  foliageBatchInstances, packFoliageInstances, rememberFoliageBatch,
  foliageChunkLimit, foliageChunkBounds, foliageKeepFraction,
  FOLIAGE_DENSITY_FALLOFF, FOLIAGE_DENSITY_FLOOR,
  FOLIAGE_DRAW_TRIANGLE_BUDGET, FOLIAGE_DRAW_MAX_INSTANCES, FOLIAGE_DRAW_MIN_INSTANCES,
} from '../src/terrain/foliage';
import type { FoliageCell } from '../src/terrain/foliage';

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

/**
 * Merging a bucket's cells into ONE instance buffer is what turns "a draw per spatial cell per
 * prototype sub-model, again per shadow cascade" into "a draw per sub-model" — the difference between
 * a draw count that grows with terrain area and one that does not.
 *
 * Two properties carry it, and both fail silently. The packed buffer must tile the cells exactly, in
 * order, or instances render at another cell's transforms. And "unchanged" must be exact: a repack
 * skipped when the set really did move draws last frame's placement, while a repack run every frame
 * throws away the whole point of the cull hysteresis.
 */

// A cell whose matrices are recognisable: instance k of cell `index` is the number `index * 100 + k`,
// repeated across all 16 floats. Only `matrices`, `count` and `index` are read by the packer.
const cell = (index: number, count: number): FoliageCell => {
  const matrices = new Float32Array(count * 16);
  for (let k = 0; k < count; k++) matrices.fill(index * 100 + k, k * 16, k * 16 + 16);
  return {
    matrices, count, index,
    indices: new Int32Array(count),
    min: [0, 0, 0], max: [1, 1, 1],
    lod: 0, visible: true,
  };
};

describe('packFoliageInstances — merging cells into one instance buffer', () => {
  it('tiles the cells back to back, in the order given', () => {
    const cells = [cell(1, 2), cell(2, 1), cell(3, 3)];
    const out = new Float32Array(foliageBatchInstances(cells) * 16);
    expect(packFoliageInstances(cells, out)).toBe(6);
    // First float of each instance, in order: cell 1's two, cell 2's one, cell 3's three.
    const firsts = [0, 1, 2, 3, 4, 5].map(i => out[i * 16]);
    expect(firsts).toEqual([100, 101, 200, 300, 301, 302]);
  });

  it('writes every float of every instance, not just the first', () => {
    const cells = [cell(7, 1)];
    const out = new Float32Array(16);
    packFoliageInstances(cells, out);
    expect(Array.from(out)).toEqual(new Array(16).fill(700));
  });

  it('packs nothing for an empty bucket', () => {
    const out = new Float32Array(16).fill(-1);
    expect(packFoliageInstances([], out)).toBe(0);
    // Untouched: a bucket that lost its last cell must not leave a stale instance behind.
    expect(out[0]).toBe(-1);
  });

  it('reads only the live prefix of a cell whose array is over-allocated', () => {
    // `matrices` is sized at rebuild; nothing guarantees a later reader wants all of it.
    const c = cell(5, 1);
    const over = new Float32Array(32);
    over.set(c.matrices);
    over.fill(999, 16);
    const out = new Float32Array(16);
    packFoliageInstances([{ ...c, matrices: over }], out);
    expect(out[0]).toBe(500);
  });
});

describe('foliageBatchStale — when a repack is actually needed', () => {
  const pack = (cells: FoliageCell[], version: number) => {
    const batch = createFoliageBatch();
    rememberFoliageBatch(batch, cells, version);
    batch.count = foliageBatchInstances(cells);
    return batch;
  };

  it('is fresh for the identical set at the identical version', () => {
    // The parked-camera case, and the one that has to be free: hysteresis and the admission budget
    // exist to hold this set still, and every frame it holds still is a frame that uploads nothing.
    const cells = [cell(1, 2), cell(2, 2)];
    expect(foliageBatchStale(pack(cells, 3), cells, 3)).toBe(false);
  });

  it('is stale when a cell joins or leaves', () => {
    const batch = pack([cell(1, 2), cell(2, 2)], 3);
    expect(foliageBatchStale(batch, [cell(1, 2)], 3)).toBe(true);
    expect(foliageBatchStale(batch, [cell(1, 2), cell(2, 2), cell(4, 1)], 3)).toBe(true);
  });

  it('is stale when the same cells arrive in a different order', () => {
    // Order IS the layout of the merged buffer, so a reorder that packed nothing new would still put
    // every instance at the wrong offset.
    const batch = pack([cell(1, 2), cell(2, 2)], 3);
    expect(foliageBatchStale(batch, [cell(2, 2), cell(1, 2)], 3)).toBe(true);
  });

  it('is stale when the layer rebuilt under it', () => {
    // A scatter or erase re-buckets every instance: the cell at index 1 is not the cell it was.
    const cells = [cell(1, 2)];
    expect(foliageBatchStale(pack(cells, 3), cells, 4)).toBe(true);
  });

  it('remembers a shorter set without reading the previous tail', () => {
    // `cells` is grow-only, so the entries past `cellCount` are last frame's. Comparing them would
    // report a false change forever after any bucket shrinks.
    const batch = pack([cell(1, 1), cell(2, 1), cell(3, 1)], 1);
    const two = [cell(1, 1), cell(2, 1)];
    rememberFoliageBatch(batch, two, 1);
    expect(foliageBatchStale(batch, two, 1)).toBe(false);
  });

  it('is stale on a fresh batch, so the first frame always packs', () => {
    expect(foliageBatchStale(createFoliageBatch(), [], 0)).toBe(true);
  });
});

/**
 * Merging removed the only thing that bounded a foliage submission.
 *
 * One draw per spatial cell meant roughly a cell's worth of instances per call, and a driver could
 * preempt between them. Merged, a whole layer lands in ONE `drawElementsInstanced` — and
 * `generateFoliageEverywhere` followed by a layer's "first sight", which skips the admission budget on
 * purpose, puts every cell on screen in the same frame. With a heavy prototype that is seconds of GPU
 * work in a single submission: a TDR timeout and a removed device, not a slow frame. It removed a
 * device in practice, which is why these are here.
 */
describe('foliageChunkLimit — instances one draw may carry', () => {
  it('splits a heavy prototype hard', () => {
    // 200k triangles a copy: a few dozen instances is already the whole budget.
    const limit = foliageChunkLimit(200_000);
    expect(limit).toBe(Math.floor(FOLIAGE_DRAW_TRIANGLE_BUDGET / 200_000));
    expect(limit).toBeLessThan(100);
  });

  it('leaves a light prototype at the instance ceiling', () => {
    // A grass card is 4 triangles; the triangle budget would allow a million, which is a draw nobody
    // wants either.
    expect(foliageChunkLimit(4)).toBe(FOLIAGE_DRAW_MAX_INSTANCES);
  });

  it('never degenerates below the floor, however heavy the mesh', () => {
    // Past this the split costs more than it saves, and the per-cell drawing this replaced averaged
    // about this many instances a call anyway — so a capped merged draw is never the worse option.
    expect(foliageChunkLimit(50_000_000)).toBe(FOLIAGE_DRAW_MIN_INSTANCES);
  });

  it('treats an unknown or empty mesh as light rather than as a division by zero', () => {
    expect(foliageChunkLimit(0)).toBe(FOLIAGE_DRAW_MAX_INSTANCES);
    expect(foliageChunkLimit(NaN)).toBe(FOLIAGE_DRAW_MAX_INSTANCES);
  });
});

describe('foliageChunkBounds — where a bucket is cut', () => {
  const out: number[] = [];
  const bounds = (counts: number[], limit: number) =>
    foliageChunkBounds(counts.map((c, i) => cell(i, c)), limit, out).slice();

  it('keeps a bucket inside the limit as one run', () => {
    expect(bounds([10, 10, 10], 100)).toEqual([3]);
  });

  it('cuts before the cell that would overshoot', () => {
    // 40+40 fits; the third would make 120, so it starts the next run.
    expect(bounds([40, 40, 40], 100)).toEqual([2, 3]);
  });

  it('gives every run a whole number of cells', () => {
    // A cell's matrices are contiguous and a draw cannot start part-way into an instance buffer
    // without a base-instance offset, which WebGL2 does not have.
    const counts = [30, 30, 30, 30, 30];
    const ends = bounds(counts, 70);
    expect(ends[ends.length - 1]).toBe(counts.length);
    let prev = 0;
    for (const e of ends) { expect(e).toBeGreaterThan(prev); prev = e; }
  });

  it('lets a single oversized cell through alone rather than looping forever', () => {
    // The honest outcome: the fix for a cell bigger than a whole draw budget is a smaller cell size.
    expect(bounds([500], 100)).toEqual([1]);
    expect(bounds([500, 10], 100)).toEqual([1, 2]);
  });

  it('returns no runs for an empty bucket', () => {
    expect(bounds([], 100)).toEqual([]);
  });

  it('survives a zero limit instead of cutting between every instance forever', () => {
    expect(bounds([5, 5], 0)).toEqual([1, 2]);
  });

  it('reuses the array it is handed rather than allocating per bucket per frame', () => {
    const scratch: number[] = [];
    expect(foliageChunkBounds([cell(0, 1)], 10, scratch)).toBe(scratch);
  });
});

/**
 * Density scaling: LOD reduces what one instance costs, this reduces how many there are.
 *
 * Neither bounds a scatter on its own — density times area can ask for hundreds of millions of
 * triangles and nothing downstream refuses. What makes it usable rather than a flicker generator is
 * one property: the sets NEST. A far band draws a strict subset of what a near band draws, so an
 * instance that thinned out at one distance can never pop back in at a greater one.
 */
describe('foliageKeepFraction', () => {
  const F = FOLIAGE_DENSITY_FALLOFF;

  it('keeps every instance at the base level', () => {
    // Level 0 is what you are standing in. Thinning it would be visible and would save the least.
    expect(foliageKeepFraction(0, 3, F)).toBe(1);
  });

  it('never increases with distance', () => {
    let prev = Infinity;
    for (let bucket = 0; bucket <= 4; bucket++) {
      const keep = foliageKeepFraction(bucket, 4, F);
      expect(keep).toBeLessThanOrEqual(prev);
      prev = keep;
    }
  });

  it('holds the impostor bucket at the last mesh level rather than back at 1', () => {
    // Cards are nearly free, so keeping them all would cost little — and would mean trees reappearing
    // as the camera backs away, which reads as a bug however cheap it is.
    const levels = 3;
    expect(foliageKeepFraction(levels, levels, F)).toBe(foliageKeepFraction(levels - 1, levels, F));
  });

  it('stops at the floor however many levels deep', () => {
    expect(foliageKeepFraction(20, 21, F)).toBe(FOLIAGE_DENSITY_FLOOR);
  });

  it('is disabled by a falloff of 1, or by a nonsensical one', () => {
    // The behaviour before density scaling existed has to remain reachable exactly.
    for (const bucket of [0, 1, 2, 5])
      expect(foliageKeepFraction(bucket, 3, 1)).toBe(1);
    expect(foliageKeepFraction(2, 3, 0)).toBe(1);
    expect(foliageKeepFraction(2, 3, -1)).toBe(1);
  });
});

describe('packFoliageInstances with a keep fraction', () => {
  const cells = [cell(1, 8), cell(2, 4)];

  it('is byte-identical to no thinning at keep = 1', () => {
    const a = new Float32Array(foliageBatchInstances(cells) * 16);
    const b = new Float32Array(foliageBatchInstances(cells, 1) * 16);
    packFoliageInstances(cells, a);
    packFoliageInstances(cells, b, 1);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('takes a prefix of each cell, so the subsets nest', () => {
    // The property the whole feature rests on. Half of cell 1 is instances 100..103; a quarter is
    // 100..101 — a subset, not a different sample.
    const half = new Float32Array(foliageBatchInstances(cells, 0.5) * 16);
    packFoliageInstances(cells, half, 0.5);
    const quarter = new Float32Array(foliageBatchInstances(cells, 0.25) * 16);
    packFoliageInstances(cells, quarter, 0.25);

    const firsts = (buf: Float32Array) =>
      Array.from({ length: buf.length / 16 }, (_, i) => buf[i * 16]);
    const h = firsts(half), q = firsts(quarter);
    for (const v of q) expect(h).toContain(v);
  });

  it('reports a length that matches what it writes', () => {
    for (const keep of [1, 0.75, 0.5, 0.25, 0.1]) {
      const n = foliageBatchInstances(cells, keep);
      const out = new Float32Array(n * 16);
      expect(packFoliageInstances(cells, out, keep)).toBe(n);
    }
  });

  it('never thins a cell out of existence', () => {
    // A lone tree on a hilltop is exactly the instance whose disappearance would be noticed.
    const lone = [cell(9, 1)];
    expect(foliageBatchInstances(lone, 0.01)).toBe(1);
    const out = new Float32Array(16);
    expect(packFoliageInstances(lone, out, 0.01)).toBe(1);
  });
});

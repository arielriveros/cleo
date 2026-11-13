// -----------------------------------------------------------------------------------------------
// Sprite batching: which of a sorted list of 2D-pass draws may share one instanced draw call
// without changing a pixel.
//
// The list arrives in its final draw order (sorting order, then depth). Two items may trade places
// only if drawing them the other way round gives the same image: both are additive (adding light is
// order-free), or they cannot touch the same pixel (their screen rectangles are disjoint). A batch
// therefore opens at the first item not yet drawn and takes every later item with the same state key
// that commutes with each not-yet-drawn item it would jump over. Instances inside one draw rasterize
// in order, so a batch keeps its members' own relative order.
//
// GL-free and outside render/ on purpose: the planner is unit-tested on its own, and the contract
// tests that read the renderer's concatenated source have no business with it.
// -----------------------------------------------------------------------------------------------

import { rectsOverlap } from '../core/math';

/**
 * A draw's screen rectangle, written on demand into `out[offset..offset+3]` as [x0, y0, x1, y1] in any one
 * consistent space. Returns false when the draw has no bounded rectangle (it may cover anything).
 */
export type BatchBoundsFn = (item: number, out: Float64Array, offset: number) => boolean;

/** How far ahead a batch looks for members, in list positions. */
export const BATCH_WINDOW = 64;
/** How many non-members a batch may jump over before it stops looking. */
export const BATCH_MAX_SKIPPED = 16;

const UNKNOWN = 0, BOUNDED = 1, UNBOUNDED = 2;

/**
 * Plans the batches of one pass. Reused frame to frame: its buffers only grow.
 *
 * After {@link plan}, `order[0..count)` is the draw order (a permutation of the input positions) and batch
 * `b` is the run `order[runStart[b] .. runStart[b] + runCount[b])`.
 */
export class SpriteBatchPlanner {
    public order = new Int32Array(0);
    public runStart = new Int32Array(0);
    public runCount = new Int32Array(0);
    /** Batches the last {@link plan} produced. */
    public runs = 0;

    private _taken = new Uint8Array(0);
    private _boundsState = new Uint8Array(0);
    private _rects = new Float64Array(0);
    private readonly _skipped: number[] = [];
    private _bounds: BatchBoundsFn | null = null;

    /**
     * @param count    items in draw order
     * @param keys     per item, its state key: only equal keys of 0 or more merge; a negative key never does
     * @param additive per item, 1 when it adds light (commutes with every other additive item)
     * @param bounds   computes an item's screen rectangle; asked only for items a candidate would jump over
     * @returns the number of batches
     */
    public plan(count: number, keys: ArrayLike<number>, additive: ArrayLike<number>, bounds: BatchBoundsFn,
                window = BATCH_WINDOW, maxSkipped = BATCH_MAX_SKIPPED): number {
        this._ensure(count);
        this._bounds = bounds;
        const taken = this._taken, order = this.order, skipped = this._skipped;
        taken.fill(0, 0, count);
        this._boundsState.fill(UNKNOWN, 0, count);
        let written = 0, runs = 0;
        for (let i = 0; i < count; i++) {
            if (taken[i]) continue;
            taken[i] = 1;
            this.runStart[runs] = written;
            order[written++] = i;
            let members = 1;
            const key = keys[i];
            if (key >= 0) {
                skipped.length = 0;
                const end = Math.min(count - 1, i + window);
                for (let j = i + 1; j <= end; j++) {
                    if (taken[j]) continue;
                    if (keys[j] === key && this._commutesWithSkipped(j, additive)) {
                        taken[j] = 1;
                        order[written++] = j;
                        members++;
                    } else {
                        skipped.push(j);
                        if (skipped.length > maxSkipped) break;
                    }
                }
            }
            this.runCount[runs++] = members;
        }
        this.runs = runs;
        this._bounds = null;
        return runs;
    }

    /** Whether item `j` may be drawn ahead of every item in the skip list. */
    private _commutesWithSkipped(j: number, additive: ArrayLike<number>): boolean {
        const skipped = this._skipped;
        if (skipped.length === 0) return true;
        const jAdditive = additive[j] === 1;
        let jBounded = -1;
        for (let s = 0; s < skipped.length; s++) {
            const k = skipped[s];
            if (jAdditive && additive[k] === 1) continue;
            if (jBounded < 0) jBounded = this._boundsOf(j) ? 1 : 0;
            if (jBounded === 0 || !this._boundsOf(k) || rectsOverlap(this._rects, j * 4, this._rects, k * 4)) return false;
        }
        return true;
    }

    private _boundsOf(i: number): boolean {
        const state = this._boundsState[i];
        if (state !== UNKNOWN) return state === BOUNDED;
        const ok = this._bounds!(i, this._rects, i * 4);
        this._boundsState[i] = ok ? BOUNDED : UNBOUNDED;
        return ok;
    }


    private _ensure(count: number): void {
        if (this.order.length >= count) return;
        const size = Math.max(64, count + (count >> 1));
        this.order = new Int32Array(size);
        this.runStart = new Int32Array(size);
        this.runCount = new Int32Array(size);
        this._taken = new Uint8Array(size);
        this._boundsState = new Uint8Array(size);
        this._rects = new Float64Array(size * 4);
    }
}

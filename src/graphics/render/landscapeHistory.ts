import { mat4 } from 'gl-matrix';

/** What a landscape's history needs of it: its world matrix and the version that moves with it. */
export interface HistoryLandscape {
    readonly worldTransform: mat4;
    readonly transformVersion: number;
}

/** What a chunk's derived history needs of it: its transform relative to the landscape. */
export interface HistoryChunk {
    readonly localTransform: mat4;
}

/**
 * Last frame's transform of every landscape, from which its terrain chunks' motion history is DERIVED
 * rather than kept per chunk. A landscape is ~1,000 chunk nodes that never move on their own (nothing
 * writes a chunk's position, rotation or scale), so a chunk's previous world matrix is the landscape's
 * previous one times the chunk's local transform — the same product `updateTransforms` computed for it,
 * bit for bit — and a chunk moved exactly when its landscape did. Keeping one snapshot per chunk, and
 * comparing all of them every frame, was most of what the velocity bookkeeping cost.
 *
 * `frame` is the frame an entry was written on; as for per-node history, only an entry from exactly the
 * previous frame counts.
 */
export class LandscapeHistory {
    private readonly _entries = new WeakMap<HistoryLandscape, { world: mat4; version: number; frame: number }>();

    /** Record where `landscape` stands at the end of `frame`. */
    public capture(landscape: HistoryLandscape, frame: number): void {
        let entry = this._entries.get(landscape);
        if (!entry) {
            entry = { world: mat4.create(), version: 0, frame };
            this._entries.set(landscape, entry);
        }
        mat4.copy(entry.world, landscape.worldTransform);
        entry.version = landscape.transformVersion;
        entry.frame = frame;
    }

    /** Whether `landscape` has history from the frame before `frame`. */
    public fresh(landscape: HistoryLandscape, frame: number): boolean {
        const entry = this._entries.get(landscape);
        return entry !== undefined && entry.frame === frame - 1;
    }

    /** Whether `landscape` (and so every chunk of it) moved since the previous frame. False without history. */
    public moved(landscape: HistoryLandscape, frame: number): boolean {
        const entry = this._entries.get(landscape);
        return entry !== undefined && entry.frame === frame - 1 && entry.version !== landscape.transformVersion;
    }

    /** `chunk`'s world matrix last frame, written into `out`, or null when there is no history. */
    public prevWorld(landscape: HistoryLandscape, chunk: HistoryChunk, frame: number, out: mat4): mat4 | null {
        const entry = this._entries.get(landscape);
        if (entry === undefined || entry.frame !== frame - 1) return null;
        return mat4.multiply(out, entry.world, chunk.localTransform);
    }
}

/**
 * Draw ordering: state first, then front to back.
 *
 * Opaque draws are submitted grouped by program, then by material, then nearest first inside each group:
 *
 * - program first, because switching it is the most expensive change (a new pipeline, every uniform
 *   block rebound);
 * - material next, because consecutive draws of one material re-send nothing (see MaterialSync) and
 *   rebind no textures;
 * - depth last, so inside a group nearer surfaces fill the depth buffer first and the ones behind them
 *   fail the early depth test instead of being shaded and overwritten — which only pays off for programs
 *   without `discard`, hence the `opaque` G-buffer variants.
 *
 * The key is one float64: program and material ids interned to small integers, depth quantized into a
 * bucket. Sorting numbers instead of strings — the old order compared program NAMES — is also what keeps
 * the comparator off the per-frame profile.
 */

/** Distinct depth buckets: log-spaced, so near surfaces resolve finely and far ones coarsely. */
const DEPTH_BUCKETS = 256;
/** Ids above this alias (harmlessly: only the order suffers). */
const ID_SPACE = 4096;

export class DrawSortKeys {
    private _programs = new Map<string, number>();
    private _materials = new WeakMap<object, number>();
    private _nextMaterial = 1;

    /** A small integer per program name, stable for the session. */
    public programId(name: string): number {
        let id = this._programs.get(name);
        if (id === undefined) {
            id = this._programs.size + 1;
            this._programs.set(name, id);
        }
        return id;
    }

    /** A small integer per material object. */
    public materialId(material: object): number {
        let id = this._materials.get(material);
        if (id === undefined) {
            id = this._nextMaterial++;
            this._materials.set(material, id);
        }
        return id;
    }

    /**
     * The sort key for one draw: program, then material, then front-to-back. `viewDepth` is the distance
     * from the camera (any monotonic measure); `far` is where the buckets end.
     */
    public key(program: string, material: object, viewDepth: number, far: number): number {
        return (this.programId(program) % ID_SPACE) * ID_SPACE * DEPTH_BUCKETS
             + (this.materialId(material) % ID_SPACE) * DEPTH_BUCKETS
             + depthBucket(viewDepth, far);
    }
}

/** Quantize a view distance into [0, DEPTH_BUCKETS): log2-spaced between 0.1 and `far`. */
export function depthBucket(viewDepth: number, far: number): number {
    if (!(viewDepth > 0.1)) return 0;
    const top = Math.max(far, 0.2);
    const t = Math.log2(viewDepth / 0.1) / Math.log2(top / 0.1);
    return Math.min(DEPTH_BUCKETS - 1, Math.max(0, Math.floor(t * DEPTH_BUCKETS)));
}

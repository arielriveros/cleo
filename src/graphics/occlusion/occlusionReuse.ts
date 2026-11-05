/**
 * What a built occlusion buffer was built FROM, so a frame whose inputs are all unchanged can keep it
 * instead of rasterizing the same occluders again — the editor's parked camera paid ~1.4 ms a frame for
 * a buffer identical to the last one.
 *
 * A key is a list of numbers compared by value and a list of objects compared by identity, written in
 * the same order every frame between {@link begin} and {@link matches}. Only a COMPLETE build is
 * {@link commit}ted; anything that left an occluder out (a landscape inside its rebuild hold) leaves the
 * key invalid, so the next frame builds again.
 */
export class OcclusionReuseKey {
    private _last: number[] = [];
    private _next: number[] = [];
    private _lastRefs: unknown[] = [];
    private _nextRefs: unknown[] = [];
    private _valid = false;

    /** Start writing this frame's key. */
    public begin(): void {
        this._next.length = 0;
        this._nextRefs.length = 0;
    }

    public num(value: number): void { this._next.push(value); }

    /** The first `count` numbers of `values`. */
    public nums(values: ArrayLike<number>, count: number): void {
        for (let i = 0; i < count; i++) this._next.push(values[i]);
    }

    /** An object compared by identity (a camera, a node list that is reallocated when it changes). */
    public ref(value: unknown): void { this._nextRefs.push(value); }

    /** Whether this frame's key equals the last committed one. NaN never matches, which errs safe. */
    public matches(): boolean {
        if (!this._valid) return false;
        const a = this._next, b = this._last;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        const r = this._nextRefs, s = this._lastRefs;
        if (r.length !== s.length) return false;
        for (let i = 0; i < r.length; i++) if (r[i] !== s[i]) return false;
        return true;
    }

    /** The buffer now holds exactly what this frame's key describes. */
    public commit(): void {
        const n = this._last; this._last = this._next; this._next = n;
        const r = this._lastRefs; this._lastRefs = this._nextRefs; this._nextRefs = r;
        this._valid = true;
    }

    /** The buffer no longer matches any key (an incomplete build). */
    public invalidate(): void { this._valid = false; }
}

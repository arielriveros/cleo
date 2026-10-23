import { gl } from '../../glContext';
import type { OcclusionQuerySet } from '../resources';

/** Frames of queries in flight. WebGL never makes a result available in the frame it was issued. */
const GENERATIONS = 4;

interface Generation {
    queries: WebGLQuery[];
    tag: number;
    count: number;
    state: 'recording' | 'pending';
}

/**
 * Occlusion queries on WebGL2: `ANY_SAMPLES_PASSED_CONSERVATIVE`, a ring of query generations — one per
 * frame — polled for availability and never waited on. The conservative test may report a sample that a
 * precise one would not, which errs toward "visible": the safe side for culling.
 *
 * Immediate mode, like the rest of this backend: `begin`/`end` issue as the pass records them, so the
 * render-pass encoder calls straight through. `resolve` only closes the generation; there is nothing to
 * copy on this backend, the results are read off the query objects themselves.
 */
export class WebGL2OcclusionQuerySet implements OcclusionQuerySet {
    public readonly capacity: number;
    public readonly label: string;
    private readonly _ring: Generation[] = [];
    private _current: Generation;
    private _destroyed = false;

    constructor(capacity: number, label = 'occlusion') {
        this.capacity = Math.max(1, Math.floor(capacity));
        this.label = label;
        this._current = this._fresh();
    }

    private _fresh(): Generation {
        const gen: Generation = { queries: [], tag: -1, count: 0, state: 'recording' };
        this._ring.push(gen);
        return gen;
    }

    /** Open query `index` of the generation being recorded. */
    public begin(index: number): void {
        if (this._destroyed || index >= this.capacity) return;
        const queries = this._current.queries;
        const query = queries[index] ??= gl.createQuery()!;
        gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, query);
    }

    public end(): void {
        if (this._destroyed) return;
        gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
    }

    public resolve(_encoder: unknown, count: number, tag: number): void {
        // Nothing recorded: keep recording into the same generation.
        if (this._destroyed || count <= 0) return;
        const gen = this._current;
        gen.count = Math.min(count, this.capacity);
        gen.tag = tag;
        gen.state = 'pending';
        // The next generation: a free one if the ring has it, else a new one up to the ring's size, else
        // the OLDEST pending one is abandoned — never waited for.
        let next = this._ring.find(g => g !== gen && g.state === 'recording');
        if (!next) {
            if (this._ring.length < GENERATIONS) next = this._fresh();
            else {
                next = this._ring.filter(g => g !== gen).sort((a, b) => a.tag - b.tag)[0];
                next.state = 'recording';
                next.count = 0;
            }
        }
        this._current = next;
    }

    public poll(): { tag: number; count: number; visible: Uint8Array } | null {
        if (this._destroyed) return null;
        let oldest: Generation | null = null;
        for (const g of this._ring)
            if (g.state === 'pending' && (!oldest || g.tag < oldest.tag)) oldest = g;
        if (!oldest) return null;
        // Results arrive in submission order, so the LAST query being ready means all of them are.
        const last = oldest.queries[oldest.count - 1];
        if (!last || !gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE)) return null;
        const visible = new Uint8Array(oldest.count);
        for (let i = 0; i < oldest.count; i++) {
            const q = oldest.queries[i];
            visible[i] = q && gl.getQueryParameter(q, gl.QUERY_RESULT) ? 1 : 0;
        }
        oldest.state = 'recording';
        oldest.count = 0;
        // A generation freed while another is being recorded waits in the ring for the next resolve.
        return { tag: oldest.tag, count: visible.length, visible };
    }

    public destroy(): void {
        if (this._destroyed) return;
        this._destroyed = true;
        for (const g of this._ring) for (const q of g.queries) if (q) gl.deleteQuery(q);
        this._ring.length = 0;
    }
}

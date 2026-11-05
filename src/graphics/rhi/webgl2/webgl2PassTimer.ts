import { timerQueryExtension } from './capabilities';

/** One timed render pass: its descriptor label and the query bracketing it. */
interface TimedPass { label: string; query: WebGLQuery }

/** Passes timed per frame before the rest go untimed — WebGPU's timestamp capacity, for parity. */
const MAX_PASSES_PER_FRAME = 128;
/** Frames whose results may be outstanding before the oldest is recycled unread. */
const MAX_PENDING_FRAMES = 8;

/**
 * Per-render-pass GPU timing over `EXT_disjoint_timer_query_webgl2` — WebGL2's half of
 * `Device.setTimestampCollection` / `collectTimestamps`, so one profiler serves both backends and both
 * report the same thing: each render pass, by its descriptor label.
 *
 * A query opens at the top of `beginRenderPass` (load ops included, as WebGPU's start-of-pass timestamp
 * includes them) and closes at the pass encoder's `end()`. WebGL2 allows one TIME_ELAPSED query at a
 * time; passes never nest, and a pass left open is closed by the next one or by the collect. Results
 * are read frames late and never waited on, one resolved frame per collect; a `GPU_DISJOINT_EXT`
 * (a context switch, a power event) discards everything in flight.
 */
export class WebGL2PassTimer {
    private readonly _ext: any;
    private _sink: ((label: string, ms: number) => void) | null = null;
    private _open: TimedPass | null = null;
    /** Closed passes of the frame being recorded. */
    private _frame: TimedPass[] = [];
    /** Recorded frames whose results have not come back yet, oldest first. */
    private readonly _pending: TimedPass[][] = [];
    /** Recycled query objects: one create/delete per pass per frame would churn ~50 GL objects. */
    private readonly _pool: WebGLQuery[] = [];

    constructor(private readonly _gl: WebGL2RenderingContext) {
        this._ext = timerQueryExtension(_gl);
    }

    /** Whether the driver offers timer queries at all. */
    public get available(): boolean { return this._ext !== null && this._ext !== undefined; }

    /** Whether passes are being timed now. */
    public get enabled(): boolean { return this._sink !== null; }

    /** See `Device.setTimestampCollection`. Switching off drops every result still in flight. */
    public setEnabled(enabled: boolean, sink: (label: string, ms: number) => void): void {
        if (!enabled || !this.available) {
            this._discard();
            this._sink = null;
            return;
        }
        this._sink = sink;
    }

    /** A render pass is starting: time it under `label`. */
    public beginPass(label: string): void {
        if (!this._sink) return;
        this._close();
        if (this._frame.length >= MAX_PASSES_PER_FRAME) return;
        const query = this._pool.pop() ?? this._gl.createQuery();
        if (!query) return;
        this._gl.beginQuery(this._ext.TIME_ELAPSED_EXT, query);
        this._open = { label, query };
    }

    /** The open render pass has ended. */
    public endPass(): void {
        this._close();
    }

    /** See `Device.collectTimestamps`: seal the frame, and deliver the oldest frame that has resolved. */
    public collect(): void {
        if (!this._sink) return;
        this._close();
        if (this._frame.length > 0) {
            this._pending.push(this._frame);
            this._frame = [];
        }
        // If the driver has stopped resolving, recycle the oldest rather than grow.
        while (this._pending.length > MAX_PENDING_FRAMES) this._recycle(this._pending.shift()!);

        const gl = this._gl;
        // A disjoint anywhere in the window invalidates every timing still in flight.
        if (gl.getParameter(this._ext.GPU_DISJOINT_EXT)) { this._discard(); return; }

        const frame = this._pending[0];
        if (!frame) return;
        // Queries complete in submission order: the last one ready means the whole frame is.
        if (!gl.getQueryParameter(frame[frame.length - 1].query, gl.QUERY_RESULT_AVAILABLE)) return;
        this._pending.shift();
        for (const pass of frame) {
            // Nanoseconds to milliseconds.
            this._sink(pass.label, gl.getQueryParameter(pass.query, gl.QUERY_RESULT) / 1e6);
            this._pool.push(pass.query);
        }
    }

    /** Release every query object. */
    public destroy(): void {
        this._discard();
        for (const query of this._pool) this._gl.deleteQuery(query);
        this._pool.length = 0;
    }

    private _close(): void {
        if (!this._open) return;
        this._gl.endQuery(this._ext.TIME_ELAPSED_EXT);
        this._frame.push(this._open);
        this._open = null;
    }

    private _recycle(frame: readonly TimedPass[]): void {
        for (const pass of frame) this._pool.push(pass.query);
    }

    private _discard(): void {
        // Close an active query first: an open query returned to the pool makes the next beginQuery
        // on it an INVALID_OPERATION, which would end all timing from then on.
        this._close();
        for (const frame of this._pending) this._recycle(frame);
        this._pending.length = 0;
        this._recycle(this._frame);
        this._frame = [];
    }
}

import { Logger } from './logger';

/**
 * Counts things that arrive in a burst — textures while a project loads, animators while a scene builds — and
 * logs ONE line with the totals once the burst has gone quiet, instead of a line per item. A line per texture
 * flooded the console and evicted the warnings that matter from the log ring.
 *
 * The totals reset after each summary, so a later burst (entering Play, the next scene) reports its own.
 */
export class LogTally<K extends string> {
    private _counts: Partial<Record<K, number>> = {};
    private _timer: ReturnType<typeof setTimeout> | null = null;

    /**
     * @param scope   the Logger scope the summary is written under
     * @param keys    every count the summary reads; each starts a burst at 0
     * @param format  the summary line, from the totals of this burst
     * @param quietMs how long nothing may arrive before the burst counts as done
     */
    constructor(
        private readonly _scope: string,
        private readonly _keys: readonly K[],
        private readonly _format: (counts: Readonly<Record<K, number>>) => string,
        private readonly _quietMs: number = 1000,
    ) {}

    /** Add to this burst's totals and push the summary back until the burst goes quiet again. */
    public add(counts: Partial<Record<K, number>>): void {
        for (const key in counts) this._counts[key] = (this._counts[key] ?? 0) + (counts[key] ?? 0);
        if (this._timer !== null) clearTimeout(this._timer);
        this._timer = setTimeout(() => this.flush(), this._quietMs);
        // Node (tests, the example generators) must not wait on a log line before it can exit.
        (this._timer as { unref?: () => void }).unref?.();
    }

    /** Write the summary now, if anything was counted, and start a new burst. */
    public flush(): void {
        if (this._timer !== null) clearTimeout(this._timer);
        this._timer = null;
        const counts = this._counts;
        this._counts = {};
        if (Object.keys(counts).length === 0) return;
        const totals = {} as Record<K, number>;
        for (const key of this._keys) totals[key] = counts[key] ?? 0;
        Logger.info(this._format(totals), this._scope);
    }
}

/** `3 textures`, `1 texture`. */
export function plural(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

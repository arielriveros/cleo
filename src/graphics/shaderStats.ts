// Shader program build times, one record per program, kept for the whole session (never reset per
// frame, unlike renderStats). Written by WebGL2Device.createShaderProgram, which is the one place that
// sees both a program's label and its compile + link. Read by tooling, e.g. a published player's
// startup profile, to name which programs a slow first launch is spent on.

export interface ShaderBuildRecord {
    /** The descriptor label: a `_programTable` name, a custom material key, `particleSim#…`, … */
    label: string;
    /**
     * Submit to usable: compile + link + reflection (+ `gl.finish()` when {@link shaderStats.syncEach}).
     * A program prefetched in parallel spent most of this on driver threads alongside others, so these
     * overlap and do not sum to wall time; see {@link shaderStats.wallMs}.
     */
    ms: number;
    /** Time the caller was blocked finishing it (status checks + reflection). Equals `ms` when serial. */
    finishMs?: number;
    /** Built from a parallel prefetch. */
    parallel?: boolean;
    /** performance.now() when a completion poll first saw it done (prefetched programs only). */
    readyAt?: number;
    /** GLSL source lengths, in characters. */
    vsChars: number;
    fsChars: number;
    /** `init` while the renderer builds its program table; `lazy` for a program built on first use. */
    phase: 'init' | 'lazy';
    /** performance.now() when the build started. */
    at: number;
}

const records: ShaderBuildRecord[] = [];

export const shaderStats = {
    records,

    /** Set by the renderer around its eager program-table build. */
    phase: 'lazy' as 'init' | 'lazy',

    /**
     * Diagnostic: `gl.finish()` after each build, inside the timed span. The status checks already wait
     * for the driver's compile and link, but a GPU process can still have work for the program queued
     * behind them; finishing charges it to this program instead of to whatever call next syncs.
     */
    syncEach: false,

    record(rec: ShaderBuildRecord): void {
        records.push(rec);
    },

    /** Records, slowest first. */
    slowest(count = Infinity): ShaderBuildRecord[] {
        return records.slice().sort((a, b) => b.ms - a.ms).slice(0, count);
    },

    /** First submit to last completion, optionally for one phase: what a batch actually cost. */
    wallMs(phase?: 'init' | 'lazy'): number {
        const rs = records.filter(r => !phase || r.phase === phase);
        if (rs.length === 0) return 0;
        return Math.max(...rs.map(r => r.at + r.ms)) - Math.min(...rs.map(r => r.at));
    },

    /** Summed build time, optionally for one phase. Overlapping builds count in full. */
    totalMs(phase?: 'init' | 'lazy'): number {
        return records.reduce((sum, r) => (!phase || r.phase === phase ? sum + r.ms : sum), 0);
    },
};

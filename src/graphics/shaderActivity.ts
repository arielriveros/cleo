// Shader work the engine does in the background, as it happens: pipelines built off the main thread on WebGPU
// (PipelineCache.getOrDefer: materials, water, screen materials), the warm-up that builds a project's remembered
// pipelines ahead of use, and custom-material programs linked in parallel on WebGL2. The editor shows it in its
// progress popup, so an effect that "appears late" says why.
//
// Synchronous compiles are not here: they block the frame they run in, so nothing could be drawn while they last.
//
// A plain module-level observable with no editor concepts. A published game never subscribes, and the cost is a
// map insert per background build. The snapshot is immutable and replaced only on a change, because React's
// `useSyncExternalStore` compares it by reference.

/** One build under way. */
export interface ShaderBuild {
    readonly id: number;
    /** The program being built: an engine program name ('pbr', 'water') or a custom material's key. */
    readonly program: string;
    /** The material type it is built for, when it is one (`PipelineOptions.builtFor`). */
    readonly builtFor: string | null;
    /** 'pipeline': a WebGPU pipeline, its shader compiling. 'program': a WebGL2 program linking. */
    readonly kind: 'pipeline' | 'program';
    /** `performance.now()` when it began. */
    readonly started: number;
}

export interface ShaderActivity {
    readonly active: readonly ShaderBuild[];
    /** The warm-up's count while it runs, else null. */
    readonly warm: { readonly done: number; readonly total: number } | null;
}

const builds = new Map<number, ShaderBuild>();
let warm: ShaderActivity['warm'] = null;
let snapshot: ShaderActivity = { active: [], warm: null };
const listeners = new Set<() => void>();
let nextId = 1;

function publish(): void {
    snapshot = { active: [...builds.values()], warm };
    for (const listener of [...listeners]) listener();
}

export const shaderActivity = {
    /** A background build started. Returns the id `end` takes. */
    begin(build: { program: string; builtFor?: string | null; kind: ShaderBuild['kind'] }): number {
        const id = nextId++;
        const started = performance.now(); // wall-clock: how long the driver has been compiling, not game time
        builds.set(id, { id, program: build.program, builtFor: build.builtFor ?? null, kind: build.kind, started });
        publish();
        return id;
    },
    /** It finished (or failed: the builder logs why). Unknown ids are ignored. */
    end(id: number): void {
        if (builds.delete(id)) publish();
    },
    /** The warm-up's progress, or null once it is over. */
    setWarm(done: number | null, total = 0): void {
        const next = done === null ? null : { done, total };
        if (next === warm || (next && warm && next.done === warm.done && next.total === warm.total)) return;
        warm = next;
        publish();
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
    snapshot(): ShaderActivity {
        return snapshot;
    },
    /** Forget everything (tests). */
    reset(): void {
        builds.clear();
        warm = null;
        publish();
    },
};

import { shaderOptimizerStats } from './stats';

/**
 * Programs compiled in the background, with a stand-in drawn meanwhile.
 *
 * ## The hitch it removes
 *
 * A program nobody built at boot — a variant a published list missed, a particle module combination, the
 * other side of a shadow-filter switch, a custom material that just appeared — used to be compiled and
 * linked synchronously the first time something bound it, in the middle of a frame. On Windows (ANGLE →
 * D3D) one link is tens to hundreds of milliseconds.
 *
 * ## What happens instead
 *
 * With KHR_parallel_shader_compile, the compile is SUBMITTED (`prepareShaderProgram`) and the frame goes
 * on drawing with a stand-in: the family's uber program — the base program whose runtime branches cover
 * what the variant compiled out, which is exactly Dolphin's "ubershader while the specialized shader
 * compiles". Each frame `poll` asks the driver, without blocking, whether the compile has finished, and
 * hands a finished program over; the renderer then swaps it in under its name.
 *
 * Without the extension there is nothing to gain from waiting, and the caller builds synchronously as
 * before. A program with no acceptable stand-in is also built synchronously.
 */

/** The slice of the device this needs. Structural, so it can be tested with a fake. */
export interface CompileDevice<D, P> {
    prepareShaderProgram?(descriptor: D): void;
    isShaderProgramReady?(descriptor: D): boolean;
    createShaderProgram(descriptor: D): P;
}

interface Job<D, P> {
    name: string;
    descriptor: D;
    requestedAt: number;
    onReady: (program: P) => void;
    onError?: (error: unknown) => void;
}

export class ProgramCompileQueue<D, P> {
    private readonly _jobs = new Map<string, Job<D, P>>();

    constructor(private readonly _device: CompileDevice<D, P>, private readonly _parallel: () => boolean) {}

    /** Whether background compiles are possible on this device at all. */
    public get supported(): boolean {
        return this._parallel() && !!this._device.prepareShaderProgram && !!this._device.isShaderProgramReady;
    }

    /** Whether `name` is compiling in the background. */
    public isPending(name: string): boolean { return this._jobs.has(name); }

    public get pendingCount(): number { return this._jobs.size; }

    /**
     * Start compiling `name` in the background. Returns false when that is not possible here (the
     * caller then builds synchronously). Asking again for a pending name is a no-op that returns true.
     */
    public request(name: string, descriptor: D, onReady: (program: P) => void, onError?: (error: unknown) => void): boolean {
        if (this._jobs.has(name)) return true;
        if (!this.supported) return false;
        this._device.prepareShaderProgram!(descriptor);
        this._jobs.set(name, { name, descriptor, requestedAt: performance.now(), onReady, onError });
        shaderOptimizerStats.pendingCompiles = this._jobs.size;
        return true;
    }

    /**
     * Hand over every compile the driver has finished, without blocking on the rest. Called once a
     * frame. Finishing one (`createShaderProgram` on a completed compile) is a status read plus
     * reflection, so `budgetMs` bounds how many are taken in one frame. Returns how many finished.
     */
    public poll(budgetMs = 4): number {
        if (this._jobs.size === 0) return 0;
        const start = performance.now();
        let finished = 0;
        for (const [name, job] of this._jobs) {
            if (finished > 0 && performance.now() - start > budgetMs) break;
            if (!this._device.isShaderProgramReady!(job.descriptor)) continue;
            this._jobs.delete(name);
            finished++;
            try {
                const program = this._device.createShaderProgram(job.descriptor);
                shaderOptimizerStats.asyncCompiles++;
                job.onReady(program);
            } catch (error) {
                job.onError?.(error);
            }
        }
        shaderOptimizerStats.pendingCompiles = this._jobs.size;
        return finished;
    }

    /** Drop every pending job (a device teardown). The driver's work is simply abandoned. */
    public clear(): void {
        this._jobs.clear();
        shaderOptimizerStats.pendingCompiles = 0;
    }
}

import type { PhysicsWorld } from '../pal/world';
import { physicsStats } from '../physicsStats';
import { NO_CONTACTS, type PhysicsExecutor, type StepResult } from './physicsExecutor';

/**
 * The step on this thread. The world advances by EXACTLY the frame's delta, in equal substeps no longer
 * than 1/60 s — the same time scripts, locomotion and the animator are about to advance by. It used to be
 * cannon's accumulator, `step(1/60, dt, 5)`, which kept its own clock: it stopped at 5 substeps (0.083 s)
 * while scripts got up to 0.333 s, it abandoned the loop once the substeps took 16.7 ms of wall time, and
 * it threw the leftover away. So below 60 fps — or whenever physics got heavy — bodies covered less ground
 * than the game believed, and a speed-driven locomotion blend slid from sprint to walk; above 60 fps the
 * body moved in 1/60 s jumps that read as 0 and 2x speed on alternate frames. Equal substeps that sum to
 * the frame have none of that, and stay at or under the 1/60 s that keeps ragdoll joints and contacts stable.
 */
export class InlineExecutor implements PhysicsExecutor {
    public readonly kind = 'inline' as const;

    constructor(
        private readonly _world: () => PhysicsWorld | undefined,
        private readonly _substepsFor: (dt: number) => number,
        private readonly _profile: () => boolean,
    ) {}

    public step(dt: number): StepResult {
        const world = this._world();
        const start = performance.now();
        const substeps = this._substepsFor(dt);
        const profile = this._profile();
        if (world) world.profile = profile;
        if (substeps > 0 && world) {
            const h = dt / substeps;
            for (let i = 0; i < substeps; i++) world.step(h);
            if (profile) world.readProfile(physicsStats);
        }
        physicsStats.stepMs = performance.now() - start;
        return { dt, contacts: world ?? NO_CONTACTS };
    }

    public endFrame(_dt: number): void {}
    public reset(): void {}
    public dispose(): void {}
}

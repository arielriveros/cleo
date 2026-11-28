import { afterEach, beforeEach, vi } from 'vitest';
import { EXAMPLE, dataReady } from '@tools/exampleKit/testKit';
import { TEST_PHYSICS } from '@engine-tests/helpers/testPhysics';
import { HostRuntime } from '@host/hostRuntime';
import { packExampleGame } from '@host/exampleGame';

// The Sandbox played with its NPCs (npcs.test.ts, npcsHold.test.ts): the game as Play in window packs it, run headless
// on the host runtime (real models, their animators and reactions, the scripts, physics on the game clock), with only
// the NPCs a test asks for. Not a test file: the suites that use it import it, and call useNpcHooks().

export const present = dataReady();
export const TICK = 30;
export const DEG = 180 / Math.PI;

/** A seeded Math.random, so a test plays the same way every run. */
export function seeded(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const open: HostRuntime[] = [];
/** A test file's hooks: a seeded Math.random for every test, and every game it played closed after it. */
export function useNpcHooks() {
    beforeEach(() => { vi.spyOn(Math, 'random').mockImplementation(seeded(7)); });
    afterEach(() => {
        for (const r of open.splice(0)) r.dispose();
        vi.restoreAllMocks();
    });
}

export type Vec = [number, number, number];
export interface Setup {
    /** The NPCs to keep (by placed name), and where to put them instead (with a heading, degrees). */
    npcs: Record<string, { at?: Vec, yaw?: number } | true>;
    /** Where the player stands, and its heading. */
    player?: { at: Vec, yaw?: number };
}

export const planar = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[2] - b[2]);
/** How often the NPCs perceive, probe and plan in the Sandbox itself (its Game Manager's `aiDetail`). */
export const SANDBOX_AI_DETAIL = { perceiveEvery: 2, probeEvery: 2, pathsPerFrame: 2, farDistance: 35, farFactor: 3 };
export const finite = (p: ArrayLike<number>) => Number.isFinite(p[0] + p[1] + p[2]);
export const ALL = ['Civilian 1', 'Civilian 2', 'Civilian 3', 'Civilian 4', 'Civilian 5', 'Civilian 6', 'Enemy Pillars 1', 'Enemy Pillars 2', 'Enemy Crates 1', 'Enemy Crates 2'];
/** Far from every NPC's sight: where the player waits when a test is not about it. */
export const AWAY: Vec = [-45, 0.02, 45];

/** The Sandbox, packed with only `setup.npcs` placed (where it says), and started on the host. */
export async function play(setup: Setup, options: { aiDetail?: { perceiveEvery: number; probeEvery: number; pathsPerFrame?: number }; physicsBackend?: string } = {}) {
    const bin = await packExampleGame(EXAMPLE, {
        edit: (data) => {
            const scene = data.scenes[data.entry].scene;
            const group = scene.children.find((c: any) => c.name === 'NPCs');
            group.children = group.children.filter((c: any) => c.name in setup.npcs);
            for (const c of group.children) {
                const s = setup.npcs[c.name];
                if (s === true) continue;
                if (s.at) c.position = [...s.at];
                if (s.yaw !== undefined) c.rotation = [0, s.yaw, 0];
            }
            const collider = scene.children.find((c: any) => c.name === 'Player Collider');
            if (setup.player) {
                collider.position = [...setup.player.at];
                if (setup.player.yaw !== undefined) collider.rotation = [0, setup.player.yaw, 0];
            }
        },
    });
    const r = await HostRuntime.open({ bin }, {
        tickRate: TICK, physicsBackend: options.physicsBackend ?? TEST_PHYSICS,
        // Every agent perceives every tick, and every animator poses fully: the game as one player plays it.
        aiDetail: options.aiDetail ?? { perceiveEvery: 1, probeEvery: 1, pathsPerFrame: 4 }, animationLod: false,
    });
    open.push(r);
    const nodes = [...r.scene.nodes] as any[];
    const player = nodes.find(n => n.nodeType === 'character' && n.team === 'player');
    r.focusPoints = () => [player.worldPosition];
    /** The Character of the NPC placed as `name`. */
    const npc = (name: string) => nodes.find(n => n.name === name)?.children.find((c: any) => c.nodeType === 'character');
    const named = (name: string) => nodes.find(n => n.name === name);
    /** Every state an NPC was in, in order. */
    const states = new Map<any, string[]>();
    const watched: any[] = [];
    const watch = (...who: any[]) => { for (const w of who) { watched.push(w); states.set(w, [w.state]); } };
    /**
     * Step `seconds` of game time, `each` before every tick (true from it stops early), `after` after it. It lets the
     * test runner in every second of game time: a long run in one go starves its worker's messages and times them out.
     */
    const played = { lastTickMs: 0 };
    const run = async (seconds: number, each?: (t: number) => boolean | void, after?: () => void) => {
        const ticks = Math.round(seconds * TICK);
        for (let k = 0; k < ticks; k++) {
            if (each?.(k / TICK) === true) return;
            const start = performance.now();
            r.step(1);
            played.lastTickMs = performance.now() - start;
            after?.();
            for (const w of watched) { const s = states.get(w)!; if (s[s.length - 1] !== w.state) s.push(w.state); }
            // A quarter of a game second at most between yields: a busy tick is tens of milliseconds.
            if (k % (TICK / 6) === TICK / 6 - 1) await new Promise(done => setImmediate(done));
        }
    };
    return { r, player, npc, named, run, watch, states, get lastTickMs() { return played.lastTickMs; } };
}
export type Played = Awaited<ReturnType<typeof play>>;

/**
 * Shoot one of the player's guns (its rifle, unless `grip` names another holder) from its eyes at `target`, `spread`
 * degrees round it at most (the gun's own raycasts, its push, its weapon:Shot).
 */
export function shoot(p: Played, target: ArrayLike<number>, grip = 'Rifle Grip', spread = 0) {
    const gun = p.player.children.find((c: any) => c.name === 'Weapons').children.find((c: any) => c.name === grip);
    const me = p.player.worldPosition;
    const eye = [me[0], me[1] + 1.55, me[2]];
    const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const n = Math.hypot(d[0], d[1], d[2]);
    return gun.fire(eye, [d[0] / n, d[1] / n, d[2] / n], spread, p.player.ownBodies());
}

/** The reactions' states a character went through, in order. */
export function reactionTrail(character: any) {
    const trail: string[] = [];
    return { trail, note: () => { const s = character.reactions?.state ?? 'none'; if (trail[trail.length - 1] !== s) trail.push(s); } };
}

/**
 * Every clip a character's animator was asked to play as an action, and whether it had it; and every get-up its
 * graph's Get Up state rose on (Animator.playGetUp), by the clip it played.
 */
export function actionsOf(character: any) {
    const model = character.children.find((c: any) => c.nodeType === 'model');
    const played: { clip: string, found: boolean }[] = [];
    const base = model.animator.playAction.bind(model.animator);
    model.animator.playAction = (clip: string, options: any) => {
        const handle = base(clip, options);
        played.push({ clip, found: !handle.done });
        return handle;
    };
    const getUp = model.animator.playGetUp.bind(model.animator);
    model.animator.playGetUp = (faceUp: boolean, fallback: any) => {
        const clock = getUp(faceUp, fallback);
        if (clock) played.push({ clip: model.animator.currentAnimation?.name ?? '', found: true });
        return clock;
    };
    return played;
}

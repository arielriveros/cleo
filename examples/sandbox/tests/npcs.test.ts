import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { EXAMPLE, dataReady } from '@tools/exampleKit/testKit';
import { TEST_PHYSICS } from '@engine-tests/helpers/testPhysics';
import { HostRuntime } from '@host/hostRuntime';
import { packExampleGame } from '@host/exampleGame';

// The Sandbox's NPCs, played: the game as Play in window packs it, run headless on the host runtime (real models,
// their animators and reactions, the scripts, physics on the game clock), with only the NPCs a test asks for.
//
//   Civilian (blue)  SandboxCivilian: waits at what there is to look at, walks off elsewhere, looks at the player
//                    and moves on, runs from shots and cars
//   Enemy (red)      SandboxEnemy: patrols a route in pairs with a rifle, shoots the player on sight, takes cover
//                    when shot at
//
// Both are SandboxNpc, a SandboxCharacter (the player's body, model, rig and animations) with an AI Controller for a
// brain; they never die (a knock-down always gets up), and the player is not knocked about by gunshots at all.

const present = dataReady();
const TICK = 30;
const DEG = 180 / Math.PI;

/** A seeded Math.random, so a test plays the same way every run. */
function seeded(seed: number) {
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
beforeEach(() => { vi.spyOn(Math, 'random').mockImplementation(seeded(7)); });
afterEach(() => {
    for (const r of open.splice(0)) r.dispose();
    vi.restoreAllMocks();
});

type Vec = [number, number, number];
interface Setup {
    /** The NPCs to keep (by placed name), and where to put them instead (with a heading, degrees). */
    npcs: Record<string, { at?: Vec, yaw?: number } | true>;
    /** Where the player stands, and its heading. */
    player?: { at: Vec, yaw?: number };
}

const planar = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[2] - b[2]);
/** How often the NPCs perceive, probe and plan in the Sandbox itself (its Game Manager's `aiDetail`). */
const SANDBOX_AI_DETAIL = { perceiveEvery: 2, probeEvery: 2, pathsPerFrame: 2, farDistance: 35, farFactor: 3 };
const finite = (p: ArrayLike<number>) => Number.isFinite(p[0] + p[1] + p[2]);
const ALL = ['Civilian 1', 'Civilian 2', 'Civilian 3', 'Civilian 4', 'Civilian 5', 'Civilian 6', 'Enemy Pillars 1', 'Enemy Pillars 2', 'Enemy Crates 1', 'Enemy Crates 2'];
/** Far from every NPC's sight: where the player waits when a test is not about it. */
const AWAY: Vec = [-45, 0.02, 45];

/** The Sandbox, packed with only `setup.npcs` placed (where it says), and started on the host. */
async function play(setup: Setup, options: { aiDetail?: { perceiveEvery: number; probeEvery: number; pathsPerFrame?: number } } = {}) {
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
        tickRate: TICK, physicsBackend: TEST_PHYSICS,
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
type Played = Awaited<ReturnType<typeof play>>;

/** Shoot the player's rifle from its eyes at `target` (the gun's own raycast, its push, its weapon:Shot). */
function shoot(p: Played, target: ArrayLike<number>) {
    const gun = p.player.children.find((c: any) => c.name === 'Weapons').children.find((c: any) => c.name === 'Rifle Grip');
    const me = p.player.worldPosition;
    const eye = [me[0], me[1] + 1.55, me[2]];
    const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const n = Math.hypot(d[0], d[1], d[2]);
    return gun.fire(eye, [d[0] / n, d[1] / n, d[2] / n], 0, p.player.ownBodies());
}

/** The reactions' states a character went through, in order. */
function reactionTrail(character: any) {
    const trail: string[] = [];
    return { trail, note: () => { const s = character.reactions?.state ?? 'none'; if (trail[trail.length - 1] !== s) trail.push(s); } };
}

/** Every clip a character's animator was asked to play as an action, and whether it had it. */
function actionsOf(character: any) {
    const model = character.children.find((c: any) => c.nodeType === 'model');
    const played: { clip: string, found: boolean }[] = [];
    const base = model.animator.playAction.bind(model.animator);
    model.animator.playAction = (clip: string, options: any) => {
        const handle = base(clip, options);
        played.push({ clip, found: !handle.done });
        return handle;
    };
    return played;
}

describe.skipIf(!present)(`the Sandbox's NPCs (${TEST_PHYSICS})`, { timeout: 300_000 }, () => {
    it('places six civilians and four enemies, every one the Sandbox Character underneath', async () => {
        const p = await play({ npcs: Object.fromEntries(ALL.map(n => [n, true])) });
        const characters = [...p.r.scene.characters] as any[];
        expect(characters.map(c => c.team).sort()).toEqual(['civilian', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian', 'enemy', 'enemy', 'enemy', 'enemy', 'player']);
        const machine = (c: any) => c.children.find((n: any) => n.nodeType === 'model')?.animator?.stateMachine;
        for (const c of characters) {
            // The player's body: the same Mannequin, posed by the same machine, with reactions.
            const model = c.children.find((n: any) => n.nodeType === 'model');
            expect(model?.name, c.team).toBe('Mannequin');
            expect(machine(c)?.name, c.team).toBe(machine(p.player)?.name);
            expect(c.reactions, c.team).toBeTruthy();
            expect(typeof c.struckByVehicle, c.team).toBe('function');
            expect(c.canDrive, c.team).toBe(c.team === 'player');
        }
        // Every one keeps going, on its feet: ten seconds of all of them at once.
        await p.run(10);
        for (const c of characters) {
            expect(finite(c.worldPosition), c.collider?.name).toBe(true);
            expect(c.worldPosition[1], `${c.collider?.name} on the ground`).toBeGreaterThan(-0.3);
        }
        // The enemies carry their rifles from the start; the civilians carry nothing.
        for (const c of characters.filter(c => c.team === 'enemy')) expect(c.weapon, c.collider?.name).toBe(2);
        for (const c of characters.filter(c => c.team === 'civilian')) expect(c.weapon, c.collider?.name).toBe(0);
    });

    it('a civilian waits at something to look at, then walks off to somewhere else on the nav mesh', async () => {
        const p = await play({ npcs: { 'Civilian 1': true }, player: { at: AWAY } });
        const civ = p.npc('Civilian 1');
        expect(civ.team).toBe('civilian');
        const from = [...civ.worldPosition];
        p.watch(civ);
        let farthest = 0;
        await p.run(25, () => { farthest = Math.max(farthest, planar(civ.worldPosition, from)); });
        const seen = p.states.get(civ)!;
        expect(seen[0]).toBe('wait');
        expect(seen).toContain('roam');
        expect(farthest).toBeGreaterThan(6);
        expect(finite(civ.worldPosition)).toBe(true);
        // On its feet on the ground all along, not through it.
        expect(civ.worldPosition[1]).toBeGreaterThan(-0.2);
    });

    it('a civilian looks at the player close by a few seconds, then moves on, and not at once again', async () => {
        // In the open, facing +X; the player 4 m off, 60 degrees to its right, inside its view.
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 90 } }, player: { at: [34, 0.02, -27.46], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        p.watch(civ);
        const toPlayer = () => { const me = civ.worldPosition, at = p.player.worldPosition; return Math.atan2(at[0] - me[0], at[2] - me[2]) * DEG; };
        const off = () => { const f = civ.worldForward; return Math.abs(((Math.atan2(f[0], f[2]) * DEG - toPlayer() + 540) % 360) - 180); };
        const before = off();
        let watching = -1, looking = Infinity;
        await p.run(4, (t) => {
            if (civ.state === 'watch' && watching < 0) watching = t;
            // Its head turned to the player (its look's yaw off the body), and the body turned, if at all, toward it.
            if (civ.state === 'watch' && t > watching + 1.5) looking = Math.min(looking, Math.abs(Math.abs(civ.lookYaw) - off()));
        });
        expect(watching, 'it noticed the player').toBeGreaterThanOrEqual(0);
        // Not at once: an ordinary person takes most of a second to notice someone (its noticeSeconds, 0.9).
        expect(watching).toBeGreaterThan(0.8);
        expect(watching).toBeLessThan(2.2);
        expect(before).toBeGreaterThan(45);
        expect(looking, 'its head on the player').toBeLessThan(12);
        // A few seconds, then off somewhere else; and not back to stare for a while.
        await p.run(6);
        expect(p.states.get(civ)!).toEqual(expect.arrayContaining(['wait', 'watch', 'roam']));
        const after = p.states.get(civ)!.lastIndexOf('watch');
        await p.run(8);
        expect(p.states.get(civ)!.lastIndexOf('watch'), 'it did not stare again').toBe(after);
    });

    it('a shot that nearly hits a civilian sends it running from the shooter', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 0 } }, player: { at: [32, 0.02, -36], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        p.watch(civ);
        await p.run(1);
        const start = planar(civ.worldPosition, p.player.worldPosition);
        // A metre past its shoulder.
        shoot(p, [33.2, 1.2, -24]);
        // A startle first (0.4 to 0.8 s), then it runs.
        await p.run(0.3);
        expect(civ.state).not.toBe('flee');
        await p.run(0.8);
        expect(civ.state).toBe('flee');
        let fastest = 0;
        await p.run(4, () => { fastest = Math.max(fastest, civ.groundSpeed); });
        expect(planar(civ.worldPosition, p.player.worldPosition) - start, 'farther from the shooter').toBeGreaterThan(8);
        expect(fastest, 'running').toBeGreaterThan(4);
    });

    it('a civilian shot four times falls, lies, gets up on a get-up clip, still alive, and runs', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: [32, 0.02, -34], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        p.watch(civ);
        const played = actionsOf(civ);
        const r = reactionTrail(civ);
        await p.run(1);
        // Four rifle rounds in the chest, a tenth of a second apart: they add up past its knock-down.
        let fired = 0;
        await p.run(25, (t) => {
            if (fired < 4 && t >= fired * 0.1) { shoot(p, [civ.worldPosition[0], civ.worldPosition[1] + 1.25, civ.worldPosition[2]]); fired++; }
            r.note();
            if (fired === 4 && t > 2 && civ.reactions.state === 'animated' && p.states.get(civ)!.includes('flee')) return true;
        });
        expect(r.trail.join('>')).toMatch(/falling.*down.*getUp.*animated/);
        expect(civ.reactions.alive).toBe(true);
        expect(p.states.get(civ)!).toEqual(expect.arrayContaining(['knocked', 'flee']));
        // Up on the Mannequin's own get-up clips (Getting Up face down, Stand Up face up), not on its strings alone.
        const ups = played.filter(a => a.clip === 'Getting Up' || a.clip === 'Stand Up');
        expect(ups.length).toBeGreaterThan(0);
        expect(ups.every(a => a.found)).toBe(true);
        expect(finite(civ.worldPosition)).toBe(true);
    });

    it('run over by the car, a civilian is thrown, gets up and runs from it', async () => {
        // In front of the parked car's bonnet (the car faces +X), the car sent at it at 8 m/s with nobody in it.
        const p = await play({ npcs: { 'Civilian 1': { at: [20.6, 0, 1.5], yaw: -90 } }, player: { at: AWAY } });
        const civ = p.npc('Civilian 1');
        const car = p.named('Car');
        p.watch(civ);
        const r = reactionTrail(civ);
        await p.run(0.5);
        car._state = 'driving';
        car.velocity = [8, 0, 0];
        let bent = 0;
        await p.run(20, (t) => {
            r.note();
            // Braced as it goes: its knees bend.
            const rg = civ.reactions.ragdoll, body = civ.reactions.body;
            if (rg && body && civ.reactions.state === 'falling' && t < 1.2) {
                const leg = body.legs.L, q = (i: number) => { const b = rg.parts[i].body.quaternion; return [b.x, b.y, b.z, b.w]; };
                const a = q(leg.root), b = q(leg.mid);
                bent = Math.max(bent, 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * DEG);
            }
            if (t > 3 && civ.reactions.state === 'animated' && p.states.get(civ)!.includes('flee')) return true;
        });
        // cannon's joint motors bend them the least.
        expect(bent, 'its knees bend').toBeGreaterThan(12);
        expect(r.trail.join('>')).toMatch(/falling.*getUp.*animated/);
        expect(civ.reactions.alive).toBe(true);
        expect(p.states.get(civ)!).toContain('flee');
        expect(finite(civ.worldPosition)).toBe(true);
    });

    it('a civilian steps out of the way of a car bearing down on it, and runs', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [33, 0, 1.5], yaw: 0 } }, player: { at: AWAY } });
        const civ = p.npc('Civilian 1');
        const car = p.named('Car');
        p.watch(civ);
        const r = reactionTrail(civ);
        await p.run(0.5);
        car._state = 'driving';
        car.velocity = [8, 0, 0];
        let off = 0;
        await p.run(3, () => { r.note(); off = Math.max(off, Math.abs(civ.worldPosition[2] - 1.5)); });
        expect(off, 'off the car\'s line').toBeGreaterThan(1.6);
        expect(r.trail.join('>'), 'not hit').not.toMatch(/falling/);
        expect(p.states.get(civ)!).toContain('flee');
    });

    it('the car does not let an NPC drive it: only the player boards', async () => {
        const p = await play({ npcs: { 'Civilian 1': true }, player: { at: AWAY } });
        const civ = p.npc('Civilian 1');
        const car = p.named('Car');
        const zone = car.children.find((c: any) => c.name === 'Door Zone');
        await p.run(0.2);
        civ.teleport([zone.worldPosition[0], 0.02, zone.worldPosition[2]]);
        await p.run(0.2);
        expect(civ.canDrive).toBe(false);
        expect(car._driverAtDoor()).toBeNull();
        p.player.teleport([zone.worldPosition[0], 0.02, zone.worldPosition[2] + 0.4]);
        await p.run(0.2);
        expect(car._driverAtDoor()).toBe(p.player);
    });

    it('an enemy pair patrols its route with rifles, the second one behind the first', async () => {
        const p = await play({ npcs: { 'Enemy Pillars 1': true, 'Enemy Pillars 2': true }, player: { at: AWAY } });
        const a = p.npc('Enemy Pillars 1'), b = p.npc('Enemy Pillars 2');
        expect([a.team, b.team]).toEqual(['enemy', 'enemy']);
        p.watch(a, b);
        const [leader, follower] = a.id < b.id ? [a, b] : [b, a];
        const from = [...leader.worldPosition];
        let farthest = 0, apart = 0;
        await p.run(30, (t) => {
            farthest = Math.max(farthest, planar(leader.worldPosition, from));
            if (t > 4) apart = Math.max(apart, planar(leader.worldPosition, follower.worldPosition));
        });
        // The leader stops to look round at the points of its route; the follower keeps up behind it.
        expect(p.states.get(leader)!).toContain('patrol');
        expect(p.states.get(leader)!.every((s: string) => s === 'patrol' || s === 'look')).toBe(true);
        expect(p.states.get(follower)!).toEqual(['patrol']);
        expect(farthest, 'the leader walks its route').toBeGreaterThan(8);
        expect(apart, 'the follower keeps close').toBeLessThan(8);
        expect([a.weapon, b.weapon]).toEqual([2, 2]);
        // At the low ready on patrol, not aiming.
        expect(a.aiming || b.aiming).toBe(false);
    });

    it('an enemy that sees the player aims and fires at it, and its rounds do not knock the player about', async () => {
        // Down the pillars' route, 14 m in front of it.
        const p = await play({ npcs: { 'Enemy Pillars 1': true }, player: { at: [6, 0.02, -15], yaw: 90 } });
        const enemy = p.npc('Enemy Pillars 1');
        p.watch(enemy);
        const gun = enemy.children.find((c: any) => c.name === 'Weapons').children.find((c: any) => c.name === 'Rifle Grip');
        const r = reactionTrail(p.player);
        const mine = (node: any) => { for (let n = node; n; n = n.parent) if (n === p.player || n === p.player.collider) return true; return false; };
        let hits = 0, last: any = null, aimed = false;
        await p.run(8, () => {
            r.note();
            if (enemy.aiming) aimed = true;
            if (gun.lastHit && gun.lastHit !== last) {
                last = gun.lastHit;
                if (mine(last.node) || p.r.scene.physics.reactionsFor?.(last.node) === p.player.reactions) hits++;
            }
        });
        expect(p.states.get(enemy)!).toContain('engage');
        expect(aimed).toBe(true);
        expect(gun.shots).toBeGreaterThan(3);
        expect(hits, 'some of its rounds reach the player').toBeGreaterThan(0);
        // The player does not react to them at all (it would take the game from the hands playing it), and has no
        // health to lose.
        expect(r.trail).toEqual(['animated']);
        expect(p.player.reactions.wounds).toHaveLength(0);
        expect(p.player.reactions.alive).toBe(true);
        expect(finite(p.player.worldPosition)).toBe(true);
    });

    it('a round in a civilian throws sparks off it and leaves no hole, where one in the ground beside it does', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: [32, 0.02, -34], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        await p.run(1);
        const count = (name: string) => [...p.r.scene.nodes].filter((n: any) => n.name === name).length;
        const holes = count('Bullet Hole'), impacts = count('Bullet Impact');
        const hit = shoot(p, [civ.worldPosition[0], civ.worldPosition[1] + 1.25, civ.worldPosition[2]]);
        expect(hit, 'the round hits the civilian').toBeTruthy();
        expect(count('Bullet Impact')).toBeGreaterThan(impacts);
        expect(count('Bullet Hole'), 'a hole on the civilian').toBe(holes);
        const ground = shoot(p, [civ.worldPosition[0] + 1.5, 0, civ.worldPosition[2] - 2]);
        expect(ground, 'the round hits the ground').toBeTruthy();
        expect(count('Bullet Hole'), 'a hole in the ground').toBe(holes + 1);
    });

    it('stays within its frame budget in a firefight with all ten of them', async () => {
        // The enemies at the pillars see the player and fight; the player shoots at every NPC in turn, a round every
        // fifth of a second, for 12 s (flinches, stumbles, knock-downs); the car runs into the crowd. Counted each
        // tick: the reacting bodies (powered ragdolls), the rays, the solver's iterations, and the tick's time.
        const p = await play({ npcs: Object.fromEntries(ALL.map(n => [n, true])), player: { at: [6, 0.02, -15], yaw: 90 } },
            { aiDetail: SANDBOX_AI_DETAIL });
        const physics: any = p.r.scene.physics;
        const npcs = ALL.map(n => p.npc(n));
        const car = p.named('Car');
        await p.run(1);
        const ms: number[] = [], rays: number[] = [], powered: number[] = [], iterations: number[] = [], searches: number[] = [];
        let shot = 0, struck = 0;
        await p.run(16, (t) => {
            if (t < 12 && t >= shot * 0.2) {
                const target = npcs[shot % npcs.length];
                shoot(p, [target.worldPosition[0], target.worldPosition[1] + 1.2, target.worldPosition[2]]);
                shot++;
            }
            if (t >= 3 && !struck) { struck = 1; car._state = 'driving'; car.velocity = [8, 0, 0]; }
        }, () => {
            ms.push(p.lastTickMs);
            rays.push(physics.stats.rayCount);
            powered.push(physics.poweredRagdollCount);
            iterations.push(physics.solverIterations);
            searches.push((p.r.scene as any).pathSearchesThisFrame ?? 0);
        });
        const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
        const pct = (a: number[], q: number) => sorted(a)[Math.min(a.length - 1, Math.floor(a.length * q))];
        const report = {
            ticks: ms.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: Math.max(...ms),
            raysP95: pct(rays, 0.95), raysMax: Math.max(...rays), poweredMax: Math.max(...powered),
            poweredMean: powered.reduce((a, b) => a + b, 0) / powered.length, iterationsMax: Math.max(...iterations),
            searchesMax: Math.max(...searches), knocked: npcs.filter(n => p.states.get(n)?.includes('knocked')).length,
        };
        console.log(`[npc budget ${TEST_PHYSICS}] ${JSON.stringify(report)}`);
        expect(report.ticks).toBeGreaterThan(400);
        // The budgets hold (measured 2026-11-27, the three backends in parallel: Jolt p50 51 ms, p95 80 ms a tick,
        // rays p95 87; before them 66, 126 and 125). The times are the machine's, so only the counts are asserted.
        expect(report.poweredMax, 'reacting bodies within Reacting bodies (6)').toBeLessThanOrEqual(6);
        expect(report.searchesMax, 'path searches within pathsPerFrame').toBeLessThanOrEqual(SANDBOX_AI_DETAIL.pathsPerFrame);
        expect(report.raysP95, 'rays a tick').toBeLessThan(150);
        if (physics.capabilities?.islandIterations) expect(report.iterationsMax, 'the world keeps its own iterations').toBeLessThanOrEqual(10);
    });

    // On its feet a reacting body's legs are kinematic on the animation, and a foot's IK ray took its own shin for the
    // ground (a kinematic body is ground): shot, both feet leapt 60 cm onto its legs, again and again. Its feet stay on
    // the ground now, foot placement and all, the shove letting them go rather than holding them to snap.
    it('shot standing, a civilian keeps its feet on the ground: no foot leaps onto its own legs', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -28], yaw: 180 } }, player: { at: [32, 0.02, -34], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        const model = civ.children.find((c: any) => c.nodeType === 'model');
        const skin = model.model.skin;
        const joint = (re: RegExp) => skin.joints.findIndex((j: any) => re.test(skin.nodeNames.get(j.nodeIndex) ?? ''));
        const feet = [joint(/LeftFoot$/), joint(/RightFoot$/)];
        expect(feet.every(i => i >= 0)).toBe(true);
        const bindAt = feet.map(i => mat4.getTranslation(vec3.create(), mat4.invert(mat4.create(), skin.joints[i].inverseBindMatrix)!));
        const drawn = () => feet.map((i, k) => {
            const at = vec3.transformMat4(vec3.create(), bindAt[k], model.animator.getFinalBoneMatrices()[i]);
            return vec3.transformMat4(at, at, model.worldTransform);
        });
        await p.run(1.5);
        const standing = Math.max(...drawn().map(v => v[1] - civ.worldPosition[1]));
        let prev: vec3[] | null = null, highest = 0, leap = 0;
        shoot(p, [civ.worldPosition[0], civ.worldPosition[1] + 1.3, civ.worldPosition[2]]);
        await p.run(0.35, undefined, () => {
            const now = drawn();
            for (const v of now) highest = Math.max(highest, v[1] - civ.worldPosition[1]);
            if (prev) leap = Math.max(leap, ...now.map((v, k) => vec3.distance(v, prev![k])));
            prev = now;
        });
        expect(civ.reactions.state, 'still on its feet').not.toMatch(/falling|tumble|down/);
        expect(highest - standing, 'how far a foot rose').toBeLessThan(0.15);
        expect(leap, 'the farthest a foot moved in a tick').toBeLessThan(0.2);
    });

    // Mixamo's get-up runs eight seconds. The brain took the NPC back the moment the reaction left getUp (the clip's last
    // quarter second and the blend still to play), and a long reaction tripped the stuck rescue in the middle of the
    // clip: either way it walked off while it still climbed up.
    it('knocked down, an enemy stays put until its get-up is over, even when that takes past its stuck rescue', async () => {
        // The player in its sight: up, it would go after it at once.
        const p = await play({ npcs: { 'Enemy Pillars 1': true }, player: { at: [6, 0.02, -15], yaw: 90 } });
        const en = p.npc('Enemy Pillars 1');
        // A rescue sooner than its fall, its lying and its clip take.
        en.stuckSeconds = 5;
        await p.run(1.5);
        en.reactions.push([0, 0.4, 3.5]);
        const { trail, note } = reactionTrail(en);
        let movedRising = 0, brainWhileRising = new Set<string>();
        await p.run(14, undefined, () => {
            note();
            if (/getUp|recover/.test(en.reactions.state)) {
                movedRising = Math.max(movedRising, Math.hypot(en.velocity[0], en.velocity[2]));
                brainWhileRising.add(en.state);
            }
        });
        expect(trail.join('>')).toMatch(/getUp>recover>animated/);
        expect(movedRising, 'moving while it got up').toBeLessThan(0.2);
        expect([...brainWhileRising]).toEqual(['knocked']);
    });

    it('knocked down and shot again while it gets up, a civilian goes back down and gets up again', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: [32, 0.02, -34], yaw: 0 } });
        const civ = p.npc('Civilian 1');
        const r = reactionTrail(civ);
        civ.reactions.trip();
        let again = false;
        await p.run(30, (t) => {
            r.note();
            if (!again && civ.reactions.state === 'getUp' && civ.reactions.stateTime > 0.6) {
                // At its chest, wherever the body has got to.
                const body = civ.reactions.body;
                shoot(p, body.simPosition(body.chest));
                again = true;
            }
            if (again && civ.reactions.state === 'animated') return true;
        });
        expect(again).toBe(true);
        // Up partway, knocked back, and up again in the end.
        expect(r.trail.join('>')).toMatch(/getUp>(falling|stagger).*animated/);
        expect(civ.reactions.alive).toBe(true);
    });

    it('nearly hit twice, an enemy runs for cover and crouches where the shooter cannot see it', async () => {
        // South of the wall, its back to the player 12 m behind it: two rounds past it, a metre off. Cover is the
        // wall's other side.
        const p = await play({ npcs: { 'Enemy Crates 1': { at: [-12, 0, -9], yaw: 0 } }, player: { at: [-10, 0.02, -21], yaw: 0 } });
        const enemy = p.npc('Enemy Crates 1');
        p.watch(enemy);
        const r = reactionTrail(enemy);
        await p.run(1);
        let fired = 0, settled = 0, hidden: boolean | null = null;
        const physics: any = p.r.scene.physics;
        await p.run(10, (t) => {
            r.note();
            if (fired < 2 && t >= fired * 0.4) {
                // A metre to the side of its chest, square to the shot.
                const at = enemy.worldPosition, me = p.player.worldPosition;
                const d = [at[0] - me[0], at[2] - me[2]], n = Math.hypot(d[0], d[1]);
                shoot(p, [at[0] - d[1] / n, at[1] + 1.3, at[2] + d[0] / n]);
                fired++;
            }
            // Settled behind it: crouched, a moment in.
            if (enemy.state === 'in cover' && enemy.crouched && ++settled > 12) {
                const eye = [p.player.worldPosition[0], p.player.worldPosition[1] + 1.55, p.player.worldPosition[2]];
                const head = [enemy.worldPosition[0], enemy.worldPosition[1] + 1.0, enemy.worldPosition[2]];
                const hit = physics.raycast(eye, head, { reject: (o: any, b: any) => !!o?.character || o?.nodeType === 'character' || !!physics.ragdollPartOf(b) });
                hidden = !!hit && Math.hypot(hit.point[0] - head[0], hit.point[1] - head[1], hit.point[2] - head[2]) > 0.35;
                return true;
            }
        });
        expect(r.trail.join('>'), 'never hit').not.toMatch(/stagger|falling/);
        expect(p.states.get(enemy)!).toEqual(expect.arrayContaining(['cover', 'in cover']));
        expect(hidden).toBe(true);
    });
});

// The host runtime runs published games headless: the checked-in examples, packed as a Play-in-window or a
// published (scripts extracted) game.bin, on an engine with no renderer, stepped tick by tick.
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { Game } from 'cleo';
import { HostRuntime } from '../src/hostRuntime';
import { packExampleGame } from '../src/exampleGame';
import { buildScriptsSource, extractScripts } from '../../editor/src/features/publish/extractScripts';

const EXAMPLES = path.resolve(__dirname, '../../editor/public/examples');
const open: HostRuntime[] = [];
afterEach(() => { for (const r of open.splice(0)) r.dispose(); });

const run = async (bin: Uint8Array, scripts?: string) => {
    const r = await HostRuntime.open({ bin, scripts }, { tickRate: 30 });
    open.push(r);
    return r;
};
const nodesOfType = (r: HostRuntime, type: string) => [...r.scene.nodes].filter((n: any) => n.nodeType === type) as any[];
const distance = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('HostRuntime', () => {
    it('runs the Sandbox headless: models, their shared clips, the scripts, physics on the game clock', async () => {
        const r = await run(await packExampleGame(path.join(EXAMPLES, 'sandbox')));
        expect(r.engine.headless).toBe(true);
        expect(r.sceneName).toBe('Sandbox');
        // The mannequin is a real model, posed by an animator with the rig's clips retargeted onto it.
        const mannequin = [...r.scene.nodes].find((n: any) => n.name === 'Mannequin') as any;
        expect(mannequin.animator).toBeTruthy();
        expect(mannequin.model.animations.length).toBeGreaterThan(40);
        // The Player's class script is attached (its fields are the node's own).
        const player = [...r.scene.nodes].find((n: any) => n.name === 'Player') as any;
        expect(typeof player.walkScale).toBe('number');
        expect(player.hasMoveInput).toBe(false);
        const crate = [...r.scene.nodes].find((n: any) => n.name === 'Crate') as any;
        const startY = crate.worldPosition[1];
        r.step(300);
        expect(Game.time).toBeCloseTo(10_000, 3);
        expect(r.stats().ticks).toBe(300);
        // Whatever the crate started on, it is at rest now, not falling forever.
        const y = crate.worldPosition[1];
        r.step(30);
        expect(Math.abs(crate.worldPosition[1] - y)).toBeLessThan(1e-3);
        expect(Number.isFinite(startY)).toBe(true);
    });

    it('measures the simulation range from the players, not a camera', async () => {
        const bin = await packExampleGame(path.join(EXAMPLES, 'sandbox'), {
            edit: (data) => { data.config.physics = { ...(data.config.physics ?? {}), simulationRange: 10 }; },
        });
        const r = await run(bin);
        // No player yet: nothing freezes for range.
        r.step(30);
        const bodies = [...r.scene.nodes].filter((n: any) => n.nodeType === 'collider' && n.body?.isDynamic) as any[];
        expect(bodies.length).toBeGreaterThan(3);
        expect(bodies.filter((n) => n.body.rangeFrozen)).toEqual([]);
        // One player, by the first body: the far ones freeze, the near ones do not.
        let player = [...bodies[0].worldPosition];
        r.focusPoints = () => [player];
        r.step(30);
        const near = bodies.filter((n) => distance(n.worldPosition, player) < 9);
        const far = bodies.filter((n) => distance(n.worldPosition, player) > 12);
        expect(far.length).toBeGreaterThan(0);
        for (const n of near) expect(n.body.rangeFrozen).toBe(false);
        for (const n of far) expect(n.body.rangeFrozen).toBe(true);
        // A second player by a far body wakes it.
        const other = [...far[0].worldPosition];
        r.focusPoints = () => [player, other];
        r.step(5);
        expect(far[0].body.rangeFrozen).toBe(false);
        for (const n of near) expect(n.body.rangeFrozen).toBe(false);
    });

    it('plays a Firing Line match: the manager fills it with bots, who move and fight', async () => {
        const r = await run(await packExampleGame(path.join(EXAMPLES, 'firing-line')));
        r.step(30);
        const characters = nodesOfType(r, 'character');
        expect(characters.length).toBe(12); // GAME_TYPES' minFighters
        const before = characters.map((c) => [...c.worldPosition]);
        r.step(600);
        const moved = characters.filter((c, i) => distance(c.worldPosition, before[i]) > 2).length;
        expect(moved).toBeGreaterThanOrEqual(8);
        expect(r.stats().meanMs).toBeLessThan(25);
        console.log(`Firing Line, 12 fighters, 20 s: ${JSON.stringify(r.stats())}`);
    });

    it('runs a published game, its scripts and modules extracted into game.scripts.js', async () => {
        let scriptsJs = '';
        const bin = await packExampleGame(path.join(EXAMPLES, 'firing-line'), {
            edit: (data) => {
                const { scripts, paths, modules } = extractScripts(data);
                scriptsJs = buildScriptsSource(scripts, paths, modules);
            },
        });
        expect(scriptsJs).toContain('CLEO_GAME_MODULES');
        const r = await run(bin, scriptsJs);
        r.step(30);
        // Only the scripts (the manager, through its module) spawn the bots.
        expect(nodesOfType(r, 'character').length).toBe(12);
    });

    // The budget is 25 ms of one core per tick at 30 Hz (docs/design/netsync.md §7). 12 fighters take ~4 ms. 50
    // took ~26 ms mean before the host's AI detail and animation level of detail (phase 8), ~22 ms after (p95
    // ~37 ms), on the development machine. What is left is mostly one navmesh path search a tick (~4 ms each).
    // This measures and logs it, and fails on a regression past the old cost.
    it('measures a 50-fighter match against the tick budget', async () => {
        const bin = await packExampleGame(path.join(EXAMPLES, 'firing-line'), {
            edit: (data) => {
                const shared = Object.keys(data.modules ?? {}).find((id) => /FpsShared/.test(id))!;
                data.modules[shared] = data.modules[shared].replace(/minFighters: 12/g, 'minFighters: 50');
            },
        });
        const r = await run(bin);
        r.step(60);
        expect(nodesOfType(r, 'character').length).toBe(50);
        r.step(900);
        const stats = r.stats();
        console.log(`Firing Line, 50 fighters, last 10 s of 30: ${JSON.stringify(stats)}`);
        expect(stats.meanMs).toBeLessThan(35);
    });
});

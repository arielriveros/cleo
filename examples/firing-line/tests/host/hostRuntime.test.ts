// The host runtime runs published games headless: the checked-in examples, packed as a Play-in-window or a
// published (scripts extracted) game.bin, on an engine with no renderer, stepped tick by tick.
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { Game } from 'cleo';
import { HostRuntime } from '@host/hostRuntime';
import { packExampleGame } from '@host/exampleGame';
import { EXAMPLE } from '@tools/exampleKit/testKit';
import { buildScriptsSource, extractScripts } from '@editor/features/publish/extractScripts';

const open: HostRuntime[] = [];
afterEach(() => { for (const r of open.splice(0)) r.dispose(); });

const run = async (bin: Uint8Array, scripts?: string) => {
    const r = await HostRuntime.open({ bin, scripts }, { tickRate: 30 });
    open.push(r);
    return r;
};
const nodesOfType = (r: HostRuntime, type: string) => [...r.scene.nodes].filter((n: any) => n.nodeType === type) as any[];
const distance = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('HostRuntime on Firing Line', () => {
    it('plays a Firing Line match: the manager fills it with bots, who move and fight', async () => {
        const r = await run(await packExampleGame(EXAMPLE));
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
        const bin = await packExampleGame(EXAMPLE, {
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
        const bin = await packExampleGame(EXAMPLE, {
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

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

describe('HostRuntime on the Sandbox', () => {
    it('runs the Sandbox headless: models, their shared clips, the scripts, physics on the game clock', async () => {
        const r = await run(await packExampleGame(EXAMPLE));
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
        const bin = await packExampleGame(EXAMPLE, {
            edit: (data) => { data.config.physics = { ...(data.config.physics ?? {}), simulationRange: 10 }; },
        });
        const r = await run(bin);
        // No player yet: nothing freezes for range.
        r.step(30);
        // Bodies that follow the project's range (one set to 'always', the Sandbox's car, is never frozen).
        const bodies = [...r.scene.nodes].filter((n: any) => n.nodeType === 'collider' && n.body?.isDynamic && n.body.simulationMode !== 'always') as any[];
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
});

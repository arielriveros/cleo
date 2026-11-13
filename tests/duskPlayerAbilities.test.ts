import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
// The whole engine: it registers itself as the scripts' 'cleo' module, so the real script runs.
import { Scene, CleoEngine, TilemapNode, Tilemap, Tileset } from '../src/cleo';
import type { CharacterBody2DNode } from '../src/cleo';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { fakeInput } from './helpers/fakeInput';
import type { FakeInput } from './helpers/fakeInput';

// Duskwell's warrior's moves, which are the GAME's, written in examples/scripts/DuskPlayer.ts over the
// engine's generic 2D walking and jumping -- the platformer that used to be built into the engine:
// a double jump, a dash, a wall slide and wall jump (each off until found), and a jump cut. Played through
// the real script and a Player Controller, as the demo plays them.

const SOURCE = readFileSync(join(__dirname, '..', 'examples', 'scripts', 'DuskPlayer.ts'), 'utf8');

let authoring = false;
let input: FakeInput;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; input = fakeInput(); });
afterEach(() => { CleoEngine.authoringMode = authoring; input.restore(); });

/** A floor at y = 0 from x = -30 to 30, a wall at x = 6..7 from y = 0 to 12, and the warrior at (x, y). */
function world(vars: Record<string, unknown> = {}, at: [number, number] = [0, 0.5]) {
    const scene = new Scene();
    const ts = new Tileset({ id: 'ts', textureId: 'ts.png', imageWidth: 16, imageHeight: 16, tileWidth: 16, tileHeight: 16, columns: 1, rows: 1 });
    ts.setMeta(0, { solid: true });
    const map = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
    map.registerTileset(ts);
    map.addLayer({ tilesetId: 'ts' });
    // Row r spans y in [-r-1, -r] at the map's origin; the map sits at y = 0, so row 0 is the floor below 0.
    for (let x = -30; x < 30; x++) map.setTile(0, x, 0, 0);
    for (let r = -12; r < 0; r++) map.setTile(0, 6, r, 0);
    scene.addNode(new TilemapNode('Map', map));
    parseNodeJson(scene.root, {
        type: 'characterBody2D', name: 'Player', id: 'player', position: [at[0], at[1], 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        characterBody2D: { size: [1, 2.2] },
        script: SOURCE, scriptVars: vars,
        children: [{
            type: 'controller', name: 'Player Controller', id: 'pc', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            children: [], possessedId: 'player', controlSource: 'player', moveAction: 'Move', jumpAction: 'Jump',
            lookAction: '', sprintAction: '', crouchAction: '', aimSource: 'world', driveAimTarget: false,
        }],
    });
    scene.start();
    const player = scene.getNodeById('player') as CharacterBody2DNode & Record<string, any>;
    return { scene, player };
}
function run(scene: Scene, seconds: number, fps = 60, each?: () => void) {
    for (let t = 0; t < seconds - 1e-9; t += 1 / fps) { each?.(); scene.update(1 / fps, 0, false); input.endFrame(); }
}
/** The highest the feet reach over `seconds`. */
function apex(scene: Scene, player: CharacterBody2DNode, seconds: number, fps = 60): number {
    let top = -Infinity;
    run(scene, seconds, fps, () => { top = Math.max(top, player.position[1]); });
    return top;
}

describe("Duskwell's warrior", () => {
    it('jumps through its Player Controller to the full jump height while the button is held', () => {
        const { scene, player } = world();
        run(scene, 0.3);
        input.press('Jump');
        expect(apex(scene, player, 0.8)).toBeCloseTo(player.jumpHeight, 1);
        input.release('Jump');
    });

    it('cuts the jump short when the button is let go early', () => {
        const { scene, player } = world();
        run(scene, 0.3);
        input.press('Jump');
        run(scene, 1 / 60);
        input.release('Jump');
        expect(apex(scene, player, 0.8)).toBeLessThan(player.jumpHeight * 0.6);
    });

    it('double jumps only with the ability, once before landing', () => {
        for (const has of [false, true]) {
            const { scene, player } = world({ hasDoubleJump: has });
            run(scene, 0.3);
            input.press('Jump');
            run(scene, 0.3);
            input.release('Jump');
            run(scene, 1 / 60);
            const before = player.position[1];
            input.press('Jump');
            const top = apex(scene, player, 0.6);
            expect(top > before + 1, `ability ${has}`).toBe(has);
            input.release('Jump');
            run(scene, 1 / 60);
            // A third press in the same flight does nothing.
            input.press('Jump');
            run(scene, 1 / 60);
            expect(player.velocity2D[1] <= 0 || !has).toBe(true);
            input.release('Jump');
        }
    });

    it('dashes at dash speed holding its height, then waits for its cooldown', () => {
        const { scene, player } = world({ hasDash: true });
        run(scene, 0.3);
        input.setMove(-1, 0);
        input.tap('Dash');
        run(scene, 0.05);
        expect(player.velocity2D[0]).toBe(-player.dashSpeed);
        expect(player.isDashing).toBe(true);
        run(scene, player.dashTime);
        expect(player.isDashing).toBe(false);
        input.tap('Dash');
        run(scene, 1 / 60);
        expect(player.isDashing).toBe(false);
        // Without the ability, the button does nothing.
        const gated = world({ hasDash: false });
        run(gated.scene, 0.3);
        input.tap('Dash');
        run(gated.scene, 1 / 60);
        expect(gated.player.isDashing).toBe(false);
    });

    it('covers the same distance dashing at 30, 60 and 144 frames a second', () => {
        const distance = (fps: number) => {
            const { scene, player } = world({ hasDash: true });
            run(scene, 0.4, fps);
            const from = player.position[0];
            input.setMove(-1, 0);
            input.tap('Dash');
            run(scene, 1 / fps, fps);
            input.setMove(0, 0);
            run(scene, 0.5, fps);
            return from - player.position[0];
        };
        const d = [30, 60, 144].map(distance);
        expect(d[0]).toBeGreaterThan(4);
        expect(Math.max(...d) - Math.min(...d)).toBeLessThan(0.15);
    });

    it('slides down a wall it presses into, and jumps off it away from the wall', () => {
        const { scene, player } = world({ hasWallJump: true }, [4.5, 6]);
        input.setMove(1, 0);
        run(scene, 0.4);
        expect(player.onWall).toBe(1);
        expect(player.velocity2D[1]).toBeCloseTo(-player.wallSlideSpeed, 3);
        expect(player.isWallSliding).toBe(true);
        input.tap('Jump');
        run(scene, 1 / 60);
        expect(player.velocity2D[0]).toBeLessThan(0);
        expect(player.velocity2D[1]).toBeGreaterThan(0);
        // Without the ability it just falls against the wall.
        const gated = world({ hasWallJump: false }, [4.5, 6]);
        run(gated.scene, 0.4);
        expect(gated.player.isWallSliding).toBe(false);
    });
});

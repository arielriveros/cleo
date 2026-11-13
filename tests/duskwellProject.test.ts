import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { readExample } from '../tools/exampleKit/readExample.mjs';
import { COLS, ROWS, GRID, ROOMS, roomBounds } from '../tools/duskwell/level';
// The whole engine: it registers itself as the scripts' 'cleo' module, so the demo's scripts run headless.
import { Scene, CleoEngine, ControllerNode } from '../src/cleo';
import type { CharacterBody2DNode } from '../src/cleo';
import { fakeInput } from './helpers/fakeInput';
import type { FakeInput } from './helpers/fakeInput';

// The Duskwell example: the 2D metroidvania slice built by tools/duskwell/build.ts on the flat 2D frame,
// the 2D physics and the sprite clips. Most of what can go wrong with it does not fail loudly -- a scene
// not marked 2D draws through the 3D frame, a tilemap with its 3D colliders on builds a box per rock
// cell, a script id that resolves to nothing leaves the player standing, a pit a plain jump clears
// gates nothing -- so this suite reads the bundle the editor imports and plays it headless.

const PROJECT = join(__dirname, '..', 'applications', 'editor', 'public', 'examples', 'duskwell');
const present = existsSync(join(PROJECT, 'manifest.json'));

// Read through the editor's own bundle reader: the example is checked in as format 2.
const duskwell = present ? await readExample(PROJECT) : null;
const read = (...parts: string[]) => duskwell!.read(...parts);
const allNodes = (root: any): any[] => {
    const out: any[] = [];
    const walk = (n: any) => { out.push(n); for (const c of n.children ?? []) walk(c); };
    walk(root);
    return out;
};

let authoring = false;
let input: FakeInput;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; input = fakeInput(); });
afterEach(() => { CleoEngine.authoringMode = authoring; input.restore(); });

describe.skipIf(!present)('the Duskwell example project', { timeout: 60_000 }, () => {
    const manifest = () => read('manifest.json');
    const sceneFile = () => read('scenes', `${manifest().mainSceneId}.json`);
    const nodes = () => allNodes(sceneFile().scene);
    const library = (name: string) => read('libraries', `${name}.json`) ?? [];
    const named = (name: string) => nodes().find(n => n.name === name);

    /**
     * The scene, parsed and started the way the player starts it, scripts and all. The player plays it
     * through its Player Controller from scripted buttons (`input`), as a person would from the keyboard.
     */
    const play = () => {
        const scene = new Scene();
        scene.parse(sceneFile(), true);
        scene.start();
        const player = scene.findNode('Player') as CharacterBody2DNode & Record<string, any>;
        return { scene, player };
    };
    const FRAME = 1 / 60;
    const run = (scene: Scene, seconds: number, each?: (t: number) => void) => {
        for (let t = 0; t < seconds - 1e-9; t += FRAME) { each?.(t); scene.update(FRAME, 0, false); input.endFrame(); }
    };

    it('drives the player through a Player Controller, its moves in its script', () => {
        const player = named('Player');
        const controller = player.children.find((c: any) => c.type === 'controller');
        expect(controller.controlSource).toBe('player');
        expect(controller.possessedId).toBe(player.id);
        expect([controller.moveAction, controller.jumpAction]).toEqual(['Move', 'Jump']);
        // The body is generic: no built-in controller, no abilities.
        expect(player.characterBody2D.settings).toBeUndefined();
        expect(player.characterBody2D.abilities).toBeUndefined();
        const { scene, player: live } = play();
        // Possession resolves on the controller's first think, in the frame's control pass.
        run(scene, FRAME);
        expect(live.controller).toBeInstanceOf(ControllerNode);
        expect([live.hasDash, live.hasDoubleJump, live.hasWallJump]).toEqual([false, false, false]);
    });

    it('is one 2D scene, drawn by the flat 2D frame', () => {
        const metas = manifest().sceneMetas;
        expect(metas).toHaveLength(1);
        expect(metas[0].dimension).toBe('2D');
        expect(sceneFile().scene.dimension).toBe('2D');
        const render = sceneFile().config.render;
        expect(render.pipeline2D).toBe('flat');
        expect(render.toneMapper).toBe('none');
    });

    it('draws its map side-on, with no 3D colliders, at 16 pixels a unit', () => {
        const maps = nodes().filter(n => n.type === 'tilemap');
        expect(maps).toHaveLength(1);
        const map = maps[0].tilemap;
        expect(map.colliders3D).toBe(false);
        expect(map.entitySort).toBe('none');
        expect(map.layers.every((l: any) => l.collision === false)).toBe(true);
        const ruins = map.tilesets[0];
        expect([ruins.tileWidth, ruins.pixelsPerUnit]).toEqual([16, 16]);
        const metas = Object.values(ruins.tiles) as any[];
        expect(metas.some(m => m.solid)).toBe(true);
        expect(metas.some(m => m.oneWay)).toBe(true);
        // The camera shows 480 x 270 art pixels, pixel-perfect, at the tiles' scale.
        const cam = nodes().find(n => n.type === 'camera2D');
        expect(cam.camera2D.pixelsPerUnit).toBe(16);
        expect(cam.camera2D.referenceResolution).toEqual([480, 270]);
        expect(cam.camera2D.pixelPerfect).toBe(true);
        expect(cam.camera2D.followTarget).toBe('Player');
    });

    it('ships every tileset and texture it draws with', () => {
        const tilesets = new Map(library('tilesets').map((t: any) => [t.id, t]));
        const textures = new Set(read('textures/index.json').map((t: any) => t.id));
        for (const t of tilesets.values() as Iterable<any>) expect(textures.has(t.textureId), t.name).toBe(true);
        const used = new Set<string>();
        for (const n of nodes()) {
            if (n.sprite?.tilesetId) used.add(n.sprite.tilesetId);
            for (const t of n.tilemap?.tilesets ?? []) used.add(t.id);
        }
        for (const id of used) expect(tilesets.has(id), id).toBe(true);
        expect(new Set(manifest().sceneMetas[0].refs.tilesetIds)).toEqual(used);
    });

    it('attaches scripts the library has, to the node types they extend, with fields they declare', () => {
        const scripts = new Map(library('scripts').map((s: any) => [s.id, s]));
        const scripted = nodes().filter(n => n.variables?.__scriptId);
        expect(scripted.length).toBeGreaterThan(10);
        for (const n of scripted) {
            const s: any = scripts.get(n.variables.__scriptId.value);
            expect(s, n.name).toBeTruthy();
            expect(s.baseType, n.name).toBe(n.type);
            expect(n.script, n.name).toBe(s.source);
            const fields = new Set(s.variables.map((v: any) => v.name));
            for (const key of Object.keys(n.scriptVars ?? {})) expect(fields.has(key), `${n.name}.${key}`).toBe(true);
        }
        const by = (name: string) => scripted.filter(n => scripts.get(n.variables.__scriptId.value)?.name === name).map(n => n.name);
        expect(by('DuskPlayer')).toEqual(['Player']);
        expect(by('DuskBat')).toEqual(['Bat 1', 'Bat 2']);
        expect(by('DuskHud')).toEqual(['HUD']);
        expect(by('DuskPickup')).toContain('Dash Relic');
    });

    it('covers every open cell of the map with exactly one room', () => {
        const rooms = nodes().filter(n => n.type === 'room2D');
        expect(rooms.map(r => r.name)).toEqual(ROOMS.map(r => r.name));
        const rects = rooms.map(r => {
            const [w, h] = r.room2D.size, [x, y] = r.position;
            return [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
        });
        // The rooms in the scene are the level's, cell for cell.
        ROOMS.forEach((room, i) => expect(rects[i]).toEqual(roomBounds(room)));
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
            if (GRID[r][c] === '#') continue;
            const x = c + 0.5, y = ROWS - r - 0.5;
            const holding = rects.filter(b => x > b[0] && x < b[2] && y > b[1] && y < b[3]);
            expect(holding.length, `cell (${c}, ${r})`).toBe(1);
        }
    });

    it('lands the player on the floor, walks it, and hops it onto the step', () => {
        const { scene, player } = play();
        run(scene, 0.5);
        expect(player.isGrounded).toBe(true);
        expect(player.position[1]).toBeCloseTo(4, 4);
        // Walk right and jump onto the two-high step (columns 12-16, top at y = 6).
        input.setMove(1, 0);
        run(scene, 1.4, (t) => {
            if (Math.abs(t - 0.65) < FRAME / 2) input.press('Jump');
            if (t > 0.95) input.release('Jump');
        });
        expect(player.position[0]).toBeGreaterThan(12);
        expect(player.position[0]).toBeLessThan(17);
        expect(player.position[1]).toBeCloseTo(6, 4);
        // On the way it took the diamond over the step.
        expect((player as any).diamonds).toBe(1);
        scene.stop?.();
    });

    it("gates the Long Hall's pit: a running jump falls in, a jump and a dash clears it, as does a double jump", () => {
        const attempt = (move: 'none' | 'dash' | 'doubleJump') => {
            const { scene, player } = play();
            player.hasDash = move === 'dash';
            player.hasDoubleJump = move === 'doubleJump';
            player.teleport(56, 2);
            run(scene, 0.3);
            let jumpedAt = -1, lowest = Infinity;
            input.setMove(1, 0);
            run(scene, 1.6, (t) => {
                if (jumpedAt < 0 && player.position[0] >= 61.2) { input.press('Jump'); jumpedAt = t; }
                const since = t - jumpedAt;
                if (jumpedAt >= 0 && since > 0.32 && since < 0.34) input.release('Jump');
                if (move === 'dash' && jumpedAt >= 0 && Math.abs(since - 0.14) < FRAME / 2) input.tap('Dash');
                if (move === 'doubleJump' && jumpedAt >= 0 && Math.abs(since - 0.4) < FRAME / 2) input.press('Jump');
                if (move === 'doubleJump' && since > 0.7) input.release('Jump');
                lowest = Math.min(lowest, player.position[1]);
            });
            input.release('Jump');
            scene.stop?.();
            return { x: player.position[0], y: player.position[1], lowest, grounded: player.isGrounded };
        };
        const plain = attempt('none');
        expect(plain.lowest).toBeLessThan(0);
        for (const move of ['dash', 'doubleJump'] as const) {
            const cleared = attempt(move);
            expect(cleared.lowest, move).toBeGreaterThan(1.9);
            expect(cleared.grounded, move).toBe(true);
            expect(cleared.x, move).toBeGreaterThan(68.5);
        }
    });

    it('wakes a bat that swoops through the plank to bite, and that the sword combo kills', () => {
        const { scene, player } = play();
        run(scene, 0.3);
        // Under the plank Bat 1 hangs over: it has to fly through it to reach the player.
        player.teleport(43, 2);
        const p = player as any;
        let bitten = false, swing = 0;
        run(scene, 9, (t) => {
            bitten ||= p.health < p.maxHealth;
            const bat = scene.findNode('Bat 1');
            if (!bitten || !bat || t - swing < 0.25) return;
            const dx = bat.worldPosition[0] - player.worldPosition[0];
            if (Math.hypot(dx, bat.worldPosition[1] - player.worldPosition[1] - 1) > 2.6) return;
            player.facing = dx;
            p._attack();
            swing = t;
        });
        expect(bitten).toBe(true);
        expect(scene.findNode('Bat 1')).toBeFalsy();
        expect(p.diamonds).toBe(1);
        expect(p.isDead).toBe(false);
        scene.stop?.();
    });

    it('respawns a player who fell out of the world, whole, at the last checkpoint', () => {
        const { scene, player } = play();
        run(scene, 0.3);
        // Light the Long Hall's lamp, then step off the pit's edge.
        player.teleport(40.5, 2);
        run(scene, 0.3);
        player.teleport(64.5, 2);
        run(scene, 4);
        expect((player as any).isDead).toBe(false);
        expect((player as any).health).toBe((player as any).maxHealth);
        expect(player.position[0]).toBeCloseTo(40.5, 3);
        expect(player.position[1]).toBeCloseTo(2, 2);
        scene.stop?.();
    });
});

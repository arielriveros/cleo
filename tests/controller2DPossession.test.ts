import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { CharacterBody2DNode } from '../src/core/scene/nodes/characterBody2DNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { TilemapNode } from '../src/core/scene/nodes/tilemapNode';
import { Tilemap } from '../src/graphics/tilemap/tilemap';
import { Tileset } from '../src/graphics/tilemap/tileset';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { fakeInput } from './helpers/fakeInput';
import type { FakeInput } from './helpers/fakeInput';

// A Controller drives a 2D body the way it drives a 3D Character: it possesses it and writes its intent
// in the control pass, from the player's actions (here) or a brain. The 2D intent is in world axes -- the
// Move stick's x is +x, its y +y -- with no camera basis.

let authoring = false;
let input: FakeInput;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; input = fakeInput(); });
afterEach(() => { CleoEngine.authoringMode = authoring; input.restore(); });

/** A floor from x = -20 to 20 at y = 0, a body on it, and a player controller possessing it. */
function world() {
    const scene = new Scene();
    const ts = new Tileset({ id: 'ts', textureId: 'ts.png', imageWidth: 16, imageHeight: 16, tileWidth: 16, tileHeight: 16, columns: 1, rows: 1 });
    ts.setMeta(0, { solid: true });
    const map = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
    map.registerTileset(ts);
    map.addLayer({ tilesetId: 'ts' });
    for (let x = -20; x < 20; x++) map.setTile(0, x, 0, 0);
    scene.addNode(new TilemapNode('Map', map));
    const body = new CharacterBody2DNode('Hero');
    body.setPosition([0, 0.5, 0]);
    scene.addNode(body);
    const controller = new ControllerNode('Player Controller');
    controller.controlSource = 'player';
    body.addChild(controller);
    controller.possess(body);
    scene.start();
    return { scene, body, controller };
}
const run = (scene: Scene, seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { each?.(); scene.update(1 / 60, 0, false); input.endFrame(); }
};

describe('a Controller possessing a 2D body', () => {
    it('possesses a Character Body 2D and back-points it', () => {
        const { body, controller } = world();
        expect(controller.possessed).toBe(body);
        expect(body.controller).toBe(controller);
        expect(body.isControlled).toBe(true);
        controller.release();
        expect(body.controller).toBeNull();
    });

    it('reads Move as x right, y up, and Jump as a jump', () => {
        const { scene, body } = world();
        run(scene, 0.3);
        input.setMove(1, 0);
        run(scene, 0.5);
        expect(body.position[0]).toBeGreaterThan(2);
        expect(body.facing).toBe(1);
        input.setMove(0, 0);
        input.tap('Jump');
        let top = 0;
        run(scene, 0.6, () => { top = Math.max(top, body.position[1]); });
        expect(top).toBeGreaterThan(body.jumpHeight - 0.1);
    });

    it('ignores the aim basis: a turned aim node does not turn the stick', () => {
        const { scene, body, controller } = world();
        const pivot = new Node('Pivot');
        pivot.setRotation([0, 90, 0]);
        scene.addNode(pivot);
        controller.aimSource = 'node';
        controller.aimSourceId = pivot.id;
        run(scene, 0.3);
        input.setMove(-1, 0);
        run(scene, 0.4);
        expect(body.position[0]).toBeLessThan(-1);
        expect(Math.abs(body.position[2])).toBe(0);
    });

    it('stops driving when released: the body is inert again', () => {
        const { scene, body, controller } = world();
        run(scene, 0.3);
        controller.release();
        input.setMove(1, 0);
        run(scene, 0.5);
        expect(body.position[0]).toBe(0);
    });

    it('resolves a saved possession by id, and still refuses a node that is neither kind of pawn', () => {
        const scene = new Scene();
        parseNodeJson(scene.root, {
            type: 'characterBody2D', name: 'Hero', id: 'hero', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            children: [{ type: 'controller', name: 'PC', id: 'pc', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
                children: [], possessedId: 'hero', controlSource: 'player' }],
            characterBody2D: {},
        });
        const hero = scene.getNodeById('hero') as CharacterBody2DNode;
        const pc = scene.getNodeById('pc') as ControllerNode;
        expect(pc.possessed).toBe(hero);
        expect(hero.controller).toBe(pc);
        const plain = new Node('Lamp');
        scene.addNode(plain);
        pc.possessedId = plain.id;
        expect(pc.possessed).toBeNull();
    });
});

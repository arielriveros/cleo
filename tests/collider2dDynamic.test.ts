import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import './helpers/features';
import { CleoEngine } from '../src/core/engine';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { Body2DNode } from '../src/core/scene/nodes/body2DNode';
import { TriggerNode } from '../src/core/scene/nodes/triggerNode';
import { TilemapNode } from '../src/core/scene/nodes/tilemapNode';
import { Tilemap } from '../src/graphics/tilemap/tilemap';
import { Tileset } from '../src/graphics/tilemap/tileset';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';

// A 2D collider with mass: it falls under the 2D world's gravity and lands on a tilemap's collision and on
// other colliders, its layers and mask deciding what it collides with, and everything under it with it.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

/** A 2D scene with a solid floor (top at y = 0) from x = -20 to 20, and a one-way plank at y = 3 from x = 5 to 8. */
function level() {
    const scene = new Scene();
    scene.dimension = '2D';
    const ts = new Tileset({ id: 'ts', textureId: 'ts.png', imageWidth: 32, imageHeight: 16, tileWidth: 16, tileHeight: 16, columns: 2, rows: 1 });
    ts.setMeta(0, { solid: true });
    ts.setMeta(1, { oneWay: true });
    const map = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
    map.registerTileset(ts);
    map.addLayer({ tilesetId: 'ts' });
    for (let x = -20; x < 20; x++) map.setTile(0, x, 0, 0);
    // Row -3 spans y in [2, 3]: a plank whose top is at y = 3.
    for (let x = 5; x < 8; x++) map.setTile(0, x, -3, 1);
    scene.addNode(new TilemapNode('Map', map));
    scene.start();
    return scene;
}

const run = (scene: Scene, seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) scene.update(1 / 60, 0, false);
};

/** A 1 x 1 crate collider with `mass` at (x, y) (its centre), with a child node under it. */
function crate(scene: Scene, x: number, y: number, mass = 1, extra: Partial<Body2DNode> = {}): Body2DNode {
    parseNodeJson(scene.root, {
        type: 'body2D', name: 'Crate', id: `crate-${x}-${y}`, position: [x, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        body2D: { size: [1, 1], kind: 'solid', mass },
        children: [{ type: 'node', name: 'Sprite', id: `sprite-${x}-${y}`, position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [] }],
    });
    const node = scene.root.children[scene.root.children.length - 1] as Body2DNode;
    Object.assign(node, extra);
    return node;
}

describe('a 2D collider with mass', () => {
    it('falls onto the tilemap and rests on it, carrying what is under it', () => {
        const scene = level();
        const box = crate(scene, 0, 5);
        run(scene, 2);
        expect(box.position[1]).toBeCloseTo(0.5, 4);
        expect(box.grounded).toBe(true);
        expect(box.velocity2D[1]).toBe(0);
        scene.root.updateTransforms();
        expect(box.getChildByName('Sprite')[0].worldPosition[1]).toBeCloseTo(1, 4);
    });

    it('stays put without mass', () => {
        const scene = level();
        const box = crate(scene, 0, 5, 0);
        run(scene, 1);
        expect(box.position[1]).toBe(5);
    });

    it('lands on a one-way tile from above', () => {
        const scene = level();
        const box = crate(scene, 6.5, 6);
        run(scene, 2);
        expect(box.position[1]).toBeCloseTo(3.5, 4);
    });

    it('stacks on another collider whose layers it collides with, and passes one it does not', () => {
        const scene = level();
        const bottom = crate(scene, 0, 1);
        const top = crate(scene, 0, 4);
        run(scene, 2);
        expect(bottom.position[1]).toBeCloseTo(0.5, 4);
        expect(top.position[1]).toBeCloseTo(1.5, 4);

        // The lower crate collides with layer 1 only; the upper one is on layer 2. A pair collides only when
        // each one's mask holds the other's layer, so the upper crate passes the lower one and lands on the
        // tiles (layer 1, which its own mask holds).
        const other = level();
        crate(other, 0, 1, 1, { mask: 1 } as any);
        const upper = crate(other, 0, 4, 1, { layer: 2, mask: 3 } as any);
        run(other, 2);
        expect(upper.position[1]).toBeCloseTo(0.5, 4);
    });

    it('falls through the tilemap when its mask leaves layer 1 out', () => {
        const scene = level();
        const box = crate(scene, 0, 3, 1, { mask: 2 } as any);
        run(scene, 1);
        expect(box.position[1]).toBeLessThan(-1);
    });

    it('is seen by a 2D trigger looking for its layer', () => {
        const scene = level();
        const plate = new TriggerNode('Plate');
        plate.size = [2, 0.5];
        plate.mask = 1;
        plate.setPosition([0, 0.25, 0]);
        scene.addNode(plate);
        const box = crate(scene, 0, 4);
        const heard: string[] = [];
        plate.onTriggerEnter = (n: Node) => { heard.push(`plate: ${n.name}`); };
        box.onTriggerEnter = (n: Node) => { heard.push(`crate: ${n.name}`); };
        run(scene, 2);
        expect(heard).toEqual(['plate: Crate', 'crate: Plate']);
    });
});

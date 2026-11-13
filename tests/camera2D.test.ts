import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { CleoEngine } from '../src/core/engine';
import { Camera } from '../src/core/camera';
import { camera2DLayout, confineAxis, deadzoneAxis, parallaxSpan, smoothDamp } from '../src/core/math';
import type { Camera2DLayout, ParallaxSpan } from '../src/core/math';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { Camera2DNode } from '../src/core/scene/nodes/camera2DNode';
import { Room2DNode } from '../src/core/scene/nodes/room2DNode';
import { ParallaxLayerNode } from '../src/core/scene/nodes/parallaxLayerNode';
import { Sprite } from '../src/graphics/sprite';
import { Tileset } from '../src/graphics/tilemap/tileset';
import { usageFromSceneJson } from '../src/graphics/programUsage';

// The 2D game camera: its art-pixel layout, the follow (dead zone, damping, look-ahead), rooms (confinement,
// the slide between them, the enter/exit hooks) and shake; and the parallax backdrop's spans.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

const layout = (): Camera2DLayout => ({ scale: 0, virtualWidth: 0, virtualHeight: 0 });

describe('camera2DLayout', () => {
    it('picks the largest whole scale that fits the reference resolution, pixel-perfect', () => {
        const l = camera2DLayout(1920, 1080, 480, 270, 1, true, layout());
        expect(l.scale).toBe(4);
        expect(l.virtualWidth).toBe(480);
        // A window between whole scales shows MORE than the reference, never less.
        const m = camera2DLayout(1700, 1000, 480, 270, 1, true, layout());
        expect(m.scale).toBe(3);
        expect(m.virtualWidth).toBeCloseTo(1700 / 3, 6);
        expect(m.virtualHeight).toBeGreaterThanOrEqual(270);
    });

    it('never drops below scale 1, and zoom multiplies it', () => {
        expect(camera2DLayout(300, 200, 480, 270, 1, true, layout()).scale).toBe(1);
        expect(camera2DLayout(1920, 1080, 480, 270, 0.5, true, layout()).scale).toBe(2);
    });

    it('scales continuously when not pixel-perfect', () => {
        expect(camera2DLayout(1700, 1000, 480, 270, 1, false, layout()).scale).toBeCloseTo(Math.min(1700 / 480, 1000 / 270), 6);
    });
});

describe('follow and confine math', () => {
    it('moves the camera only as far as the dead zone needs', () => {
        expect(deadzoneAxis(0, 0.9, 1)).toBe(0);
        expect(deadzoneAxis(0, 3, 1)).toBe(2);
        expect(deadzoneAxis(0, -3, 1)).toBe(-2);
    });

    it('keeps the view inside a range, centring it in one narrower than the view', () => {
        expect(confineAxis(0, 5, -20, 20)).toBe(0);
        expect(confineAxis(-18, 5, -20, 20)).toBe(-15);
        expect(confineAxis(19, 5, -20, 20)).toBe(15);
        expect(confineAxis(3, 5, 0, 6)).toBe(3);
        expect(confineAxis(100, 5, 0, 6)).toBe(3);
    });

    it('damps to the target without overshoot, the same at any frame rate', () => {
        const settle = (fps: number) => {
            const s = { velocity: 0 };
            let x = 0;
            for (let t = 0; t < 0.5; t += 1 / fps) x = smoothDamp(x, 10, s, 0.12, 1 / fps);
            return x;
        };
        for (const fps of [30, 60, 144]) {
            expect(settle(fps)).toBeLessThanOrEqual(10);
            expect(settle(fps)).toBeGreaterThan(9.9);
        }
        expect(Math.abs(settle(30) - settle(144))).toBeLessThan(0.05);
        expect(smoothDamp(3, 10, { velocity: 0 }, 0, 0.016)).toBe(10);
    });
});

/** A scene with two rooms side by side and a player, followed by a 2D camera. */
function world() {
    const scene = new Scene();
    const left = new Room2DNode('Left', [30, 17]);
    left.setPosition([0, 0, 0]);
    const right = new Room2DNode('Right', [30, 17]);
    right.setPosition([30, 0, 0]);
    const player = new Node('Player');
    const camera = new Camera2DNode('Cam');
    camera.followTarget = 'Player';
    camera.followOffset = [0, 0];
    camera.deadzone = [0, 0];
    camera.damping = 0;
    camera.roomTransitionSeconds = 0.5;
    for (const n of [left, right, player, camera]) scene.addNode(n);
    scene.start();
    camera.fitView(1920, 1080);
    return { scene, left, right, player, camera };
}
const FRAME = 1 / 60;
const step = (scene: Scene, seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += FRAME) scene.update(FRAME, 0, false); };

describe('Camera2DNode', () => {
    it('is found as a camera and a 2D camera, and rooms by their type', () => {
        const { scene, camera, left, right } = world();
        expect(scene.activeCamera).toBe(camera);
        expect(scene.cameras2D.has(camera)).toBe(true);
        expect([...scene.rooms2D]).toEqual([left, right]);
    });

    it('fits an orthographic projection of its view in world units', () => {
        const { camera } = world();
        // 1920 x 1080 at scale 4 shows 480 x 270 art pixels, 30 x 16.875 units at 16 per unit.
        expect(camera.camera.type).toBe('orthographic');
        expect(camera.camera.top).toBeCloseTo(270 / 16 / 2, 6);
    });

    it('follows its target, confined to the room it stands in', () => {
        const { scene, camera, player } = world();
        player.setPosition([2, 0, 0]);
        step(scene, 0.1);
        // The view is 30 units wide, the room 30: the only centre that fits is the room's.
        expect(camera.position[0]).toBeCloseTo(0, 5);
        expect(camera.room?.name).toBe('Left');
    });

    it('slides into the next room over its transition, then follows there', () => {
        const { scene, camera, player } = world();
        player.setPosition([2, 0, 0]);
        step(scene, 0.1);
        player.setPosition([31, 0, 0]);
        step(scene, 0.25);
        const mid = camera.position[0];
        expect(camera.inRoomTransition).toBe(true);
        expect(mid).toBeGreaterThan(1);
        expect(mid).toBeLessThan(29);
        step(scene, 0.4);
        expect(camera.inRoomTransition).toBe(false);
        expect(camera.position[0]).toBeCloseTo(30, 4);
        expect(camera.room?.name).toBe('Right');
    });

    it('tells the target and the rooms when the target crosses over', () => {
        const { scene, player, left, right } = world();
        const heard: string[] = [];
        player.onRoomEnter = (r: Node) => { heard.push(`player enters ${r.name}`); };
        player.onRoomExit = (r: Node) => { heard.push(`player leaves ${r.name}`); };
        left.onRoomExit = (n: Node) => { heard.push(`Left loses ${n.name}`); };
        right.onRoomEnter = (n: Node) => { heard.push(`Right gains ${n.name}`); };
        player.setPosition([2, 0, 0]);
        step(scene, 0.05);
        player.setPosition([31, 0, 0]);
        step(scene, 0.05);
        expect(heard).toEqual(['player enters Left', 'player leaves Left', 'Left loses Player', 'player enters Right', 'Right gains Player']);
    });

    it('stays where it is placed while authoring', () => {
        const { scene, camera, player } = world();
        CleoEngine.authoringMode = true;
        camera.setPosition([7, 7, 10]);
        player.setPosition([30, 0, 0]);
        step(scene, 0.2);
        expect(camera.position[0]).toBe(7);
    });

    it('shakes without moving its follow', () => {
        const { scene, camera, player } = world();
        player.setPosition([2, 0, 0]);
        step(scene, 0.1);
        camera.shake(0.5, 0.3);
        step(scene, 0.05);
        expect(Math.abs(camera.position[0])).toBeGreaterThan(0);
        step(scene, 0.4);
        expect(camera.position[0]).toBeCloseTo(0, 5);
    });

    it('round-trips its settings', async () => {
        const scene = new Scene();
        const cam = new Camera2DNode('Cam');
        cam.pixelsPerUnit = 32; cam.referenceResolution = [320, 180]; cam.zoom = 2; cam.pixelPerfect = false;
        cam.followTarget = 'Hero'; cam.followOffset = [1, 2]; cam.deadzone = [3, 4]; cam.damping = 0.3;
        cam.lookAhead = 1.5; cam.confineToRooms = false; cam.roomTransitionSeconds = 0;
        scene.addNode(cam);
        const json = await scene.serialize(true);
        const back = new Scene();
        back.parse(json, true);
        const c = [...back.cameras2D][0];
        expect(c).toBeInstanceOf(Camera2DNode);
        expect([c.pixelsPerUnit, c.referenceResolution, c.zoom, c.pixelPerfect, c.followTarget, c.followOffset, c.deadzone,
                c.damping, c.lookAhead, c.confineToRooms, c.roomTransitionSeconds])
            .toEqual([32, [320, 180], 2, false, 'Hero', [1, 2], [3, 4], 0.3, 1.5, false, 0]);
    });
});

describe('Room2DNode', () => {
    it('contains points on its edges, and round-trips', async () => {
        const room = new Room2DNode('R', [10, 4]);
        room.zone = 'Crypt';
        room.setPosition([5, 2, 0]);
        room.updateTransforms(null);
        expect(room.contains(0, 0)).toBe(true);
        expect(room.contains(10, 4)).toBe(true);
        expect(room.contains(10.01, 0)).toBe(false);
        // Picked by its top-left corner, never its whole rectangle.
        const pick = room.pickBox();
        expect(pick.max[0] - pick.min[0]).toBeLessThan(2);
        const scene = new Scene();
        scene.addNode(room);
        const back = new Scene();
        back.parse(await scene.serialize(true), true);
        const r = [...back.rooms2D][0];
        expect(r).toBeInstanceOf(Room2DNode);
        expect([r.size, r.zone]).toEqual([[10, 4], 'Crypt']);
    });
});

describe('parallaxSpan', () => {
    const span = (): ParallaxSpan => ({ min: 0, max: 0, from: 0, to: 0 });

    it('moves the image by its share of the camera travel', () => {
        const s = parallaxSpan(10, 5, 0, 4, 0.5, false, span());
        // The anchor is the origin plus half the camera's 10: 5, so the image spans 3..7.
        expect([s.min, s.max, s.from, s.to]).toEqual([3, 7, 0, 1]);
    });

    it('covers the view exactly when repeating, with the image coordinates running past 1', () => {
        const s = parallaxSpan(10, 6, 0, 4, 0, true, span());
        expect([s.min, s.max]).toEqual([4, 16]);
        // Anchored at the origin (parallax 0 keeps the image put on screen... at the camera's own 0 offset).
        expect(s.to - s.from).toBeCloseTo(12 / 4, 6);
    });
});

describe('ParallaxLayerNode', () => {
    const backdrop = () => new Tileset({ id: 'bg', textureId: 'bg.png', imageWidth: 426, imageHeight: 384,
        tileWidth: 426, tileHeight: 384, columns: 1, rows: 1, pixelsPerUnit: 16 });

    it('covers the view sideways when repeating, its image tiling', () => {
        const node = new ParallaxLayerNode('Hills', new Sprite({ tileset: backdrop() }));
        node.parallax = [0.25, 1];
        node.updateTransforms(null);
        const cam = new Camera({ type: 'orthographic', left: -8, right: 8, bottom: -8, top: 8 });
        cam.resize(16, 9);
        cam.position = vec3.fromValues(100, 0, 10);
        const m = node.quadMatrixInto(mat4.create(), cam);
        expect(m[0]).toBeCloseTo(16 * 16 / 9 * 1, 4);
        expect(m[12]).toBeCloseTo(100, 4);
        const uv = node.uvRectInto(new Float32Array(4));
        expect(uv[2] - uv[0]).toBeCloseTo((16 * 16 / 9) / (426 / 16), 4);
    });

    it('is never picked, and round-trips its settings', async () => {
        const node = new ParallaxLayerNode('Hills', new Sprite({ tileset: backdrop() }));
        const box = node.pickBox();
        expect(box.min[0]).toBeGreaterThan(box.max[0]);
        node.parallax = [0.2, 0.8]; node.repeatX = false; node.repeatY = true; node.scroll = [1, 0];
        const scene = new Scene();
        scene.addNode(node);
        const back = new Scene();
        back.parse(await scene.serialize(true), true);
        const p = back.findNode('Hills') as ParallaxLayerNode;
        expect(p).toBeInstanceOf(ParallaxLayerNode);
        expect([p.parallax, p.repeatX, p.repeatY, p.scroll]).toEqual([[0.2, 0.8], false, true, [1, 0]]);
    });
});

describe('program usage', () => {
    it('ships the upscale for a pixel-perfect 2D camera, and the batched sprite for a parallax layer', () => {
        const use = { names: new Set<string>() } as any;
        usageFromSceneJson({ type: 'camera2D', camera2D: { pixelPerfect: true }, children: [] }, use);
        usageFromSceneJson({ type: 'parallaxLayer', children: [] }, use);
        expect(use.names.has('pixelUpscale')).toBe(true);
        expect(use.names.has('sprite')).toBe(true);
        const none = { names: new Set<string>() } as any;
        usageFromSceneJson({ type: 'camera2D', camera2D: { pixelPerfect: false }, children: [] }, none);
        expect(none.names.has('pixelUpscale')).toBe(false);
    });
});

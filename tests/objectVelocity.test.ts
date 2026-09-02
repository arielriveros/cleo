import { describe, it, expect } from 'vitest';
import { mat4, vec3, vec4 } from 'gl-matrix';
import { Node } from '../src/core/scene/nodes/node';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';

/**
 * Per-object motion vectors, at the level a GL-free suite can reach.
 *
 * The shader arithmetic is four lines and is replicated here rather than mocked, because what the
 * feature rests on is a table of behaviours that is easy to state backwards — and a mode that blurred
 * where it should not would look plausible in a screenshot. `objectVelocity.wgsl` and
 * `chunks/objectVelocity.wgsl` are the code under test; keep the two in step.
 *
 * The flag half is a plain serialization round trip: `motionBlur` rides on `Node`, not `ModelNode`, so
 * it is reachable without a GL context (`ModelNode` is not — see tests/nodeParse.test.ts).
 */

/**
 * `chunks/objectVelocity.wgsl`'s `encodeVelocity`, `.xy` only.
 *
 * The shader once scaled this by the shutter and clamped it to one tile; it no longer does, because
 * TAA reads the same buffer and needs the true delta. So this is the whole of `.xy` now rather than a
 * stripped-down version of it — see `chunks/motionBlurShutter.wgsl` for where the shutter went.
 */
function velocityUV(curClip: vec4, prevClip: vec4): [number, number] {
    return [
        (curClip[0] / curClip[3]) * 0.5 - (prevClip[0] / prevClip[3]) * 0.5,
        (curClip[1] / curClip[3]) * 0.5 - (prevClip[1] / prevClip[3]) * 0.5,
    ];
}

/**
 * The full four-component encoding, both flags included.
 *
 * `.z` = excluded from motion blur. `.w` = `.xy` is the true screen-space delta, which 'objectOnly'
 * deliberately is not. Two flags because the two consumers ask different questions of the same vector.
 */
function encodeVelocity(curClip: vec4, prevClip: vec4,
                        mode: 'full' | 'objectOnly' | 'none'): [number, number, number, number] {
    const [x, y] = velocityUV(curClip, prevClip);
    return [x, y, mode === 'none' ? 1 : 0, mode === 'objectOnly' ? 0 : 1];
}

/** The vertex stage: a local position through a model matrix and a view-projection, to clip space. */
function toClip(viewProj: mat4, model: mat4, local: vec3): vec4 {
    const world = vec4.transformMat4(vec4.create(), [local[0], local[1], local[2], 1], model);
    return vec4.transformMat4(vec4.create(), world, viewProj);
}

function viewProjAt(eye: vec3, target: vec3): mat4 {
    const view = mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, 0.1, 100);
    return mat4.multiply(mat4.create(), proj, view);
}

const translation = (x: number, y: number, z: number) => mat4.fromTranslation(mat4.create(), [x, y, z]);

// One surface point, off-centre so a wrong axis or a dropped translation shows up rather than
// cancelling against a symmetric zero.
const POINT: vec3 = [0.4, 0.7, -0.2];

/** What the pass uploads: 'full' reprojects with LAST frame's camera, 'objectOnly' with this frame's. */
function velocity(mode: 'full' | 'objectOnly',
                  prevViewProj: mat4, curViewProj: mat4, prevModel: mat4, curModel: mat4) {
    const uvPrevViewProj = mode === 'objectOnly' ? curViewProj : prevViewProj;
    return velocityUV(toClip(curViewProj, curModel, POINT), toClip(uvPrevViewProj, prevModel, POINT));
}

// Displacements are ~0.19 in UV, so "moved" and "did not move" are three orders of magnitude apart and
// these thresholds are not a judgement call.
const SHARP = 1e-6;
const BLURRED = 0.05;

describe('per-object velocity', () => {
    const still = translation(0, 0, 0);
    const movedX = translation(2, 0, 0);
    const parked = viewProjAt([0, 1, 5], [0, 0, 0]);
    const panned = viewProjAt([2, 1, 5], [2, 0, 0]);

    describe('camera and node move together (a follow cam keeping pace)', () => {
        it("emits nothing in 'full' — which is the third-person fix, and it needs no flag", () => {
            // The point of per-object motion vectors. Camera reprojection assumed every world point was
            // static, so it charged the camera's motion to the character and smeared it; the real
            // screen-space delta is zero, because the character did not move on screen.
            const [vx, vy] = velocity('full', parked, panned, still, movedX);
            expect(Math.abs(vx)).toBeLessThan(SHARP);
            expect(Math.abs(vy)).toBeLessThan(SHARP);
        });

        it("blurs in 'objectOnly', because the node did cross the world", () => {
            // The row that makes 'objectOnly' not simply "less blur". Removing the camera's
            // contribution leaves the node's own +2, which is exactly what cancelled it above.
            expect(Math.abs(velocity('objectOnly', parked, panned, still, movedX)[0])).toBeGreaterThan(BLURRED);
        });
    });

    describe('camera moves, node stands still', () => {
        it("blurs in 'full'", () => {
            expect(Math.abs(velocity('full', parked, panned, still, still)[0])).toBeGreaterThan(BLURRED);
        });

        it("cancels the camera EXACTLY in 'objectOnly'", () => {
            // Not "small": handing the shader this frame's view-projection as its previous one puts the
            // camera term on both sides of the subtraction, where it divides out. A tolerance loose
            // enough to hide a residual would defeat the test.
            const [vx, vy] = velocity('objectOnly', parked, panned, still, still);
            expect(Math.abs(vx)).toBeLessThan(SHARP);
            expect(Math.abs(vy)).toBeLessThan(SHARP);
        });
    });

    describe('camera parked, node moves', () => {
        it('blurs in both modes — with no camera term there is nothing to remove', () => {
            expect(Math.abs(velocity('full', parked, parked, still, movedX)[0])).toBeGreaterThan(BLURRED);
            expect(Math.abs(velocity('objectOnly', parked, parked, still, movedX)[0])).toBeGreaterThan(BLURRED);
        });
    });

    it("keeps true velocity for a node flagged 'none' instead of zeroing it", () => {
        // `.z` is a MOTION-BLUR opt-out and nothing else. It used to arrive with a zeroed `.xy`, which
        // kept the object out of TileMax for free — but TAA reads that same `.xy` to decide where the
        // pixel was last frame, and a zero there reads as "did not move", which GHOSTS a moving object
        // rather than leaving it merely aliased. `motionBlurTileMax.wgsl` now skips flagged texels
        // explicitly, so the two questions get two answers.
        const cur = toClip(parked, movedX, POINT);
        const prev = toClip(parked, still, POINT);

        const flagged = encodeVelocity(cur, prev, 'none');
        const plain = encodeVelocity(cur, prev, 'full');

        expect(flagged[2]).toBe(1);
        expect(plain[2]).toBe(0);
        // The motion survives the flag, and is the same motion either way.
        expect(Math.abs(flagged[0])).toBeGreaterThan(BLURRED);
        expect(flagged.slice(0, 2)).toEqual(plain.slice(0, 2));
        // And it is still reprojectable: 'none' opts out of BLUR, not out of being described.
        expect(flagged[3]).toBe(1);
    });

    it("marks 'objectOnly' velocity as unusable for reprojection", () => {
        // The mode divides the camera term out on purpose, so what it stores is world motion, not
        // screen motion. Good blur, wrong reprojection — and under a moving camera a TAA resolve that
        // trusted it would fetch history from the wrong pixel and ghost the object. `.w` is how the
        // resolve is told to leave it alone; see taaResolve.wgsl.
        const cur = toClip(parked, movedX, POINT);
        const prev = toClip(parked, still, POINT);
        expect(encodeVelocity(cur, prev, 'objectOnly')[3]).toBe(0);
        expect(encodeVelocity(cur, prev, 'full')[3]).toBe(1);
    });

    it('emits nothing when the previous transform is the current one', () => {
        // What the pass uploads for a node with no usable history — freshly spawned, unhidden,
        // LOD-swapped or teleported. A stale snapshot would draw a full-length streak on the frame the
        // node appears, so `_nodeMoved` reports false and `u_prevModel` gets the current matrix.
        expect(velocity('full', panned, panned, movedX, movedX)).toEqual([0, 0]);
    });
});

describe('the motionBlur node flag', () => {
    it("defaults to 'full'", () => {
        expect(new Node('plain').motionBlur).toBe('full');
    });

    it('fans out to descendants, as visible does', () => {
        // An imported model is a holder node with its ModelNodes underneath, so a value set on the
        // character root has to reach the meshes the renderer actually draws.
        const parent = new Node('parent');
        const child = new Node('child');
        const grandchild = new Node('grandchild');
        child.addChild(grandchild);
        parent.addChild(child);

        parent.motionBlur = 'none';
        expect(child.motionBlur).toBe('none');
        expect(grandchild.motionBlur).toBe('none');
    });

    it('round-trips through serialize and parse', async () => {
        const root = new Node('root');
        const node = new Node('hero');
        node.motionBlur = 'objectOnly';
        root.addChild(node);

        const json = await node.serialize();
        expect(json.motionBlur).toBe('objectOnly');

        const target = new Node('root');
        parseNodeJson(target, json);
        expect(target.children[0].motionBlur).toBe('objectOnly');
    });

    it("stays out of the JSON while it is 'full'", async () => {
        // Absent means the default, so a scene that never touches the setting serializes exactly as it
        // did before the field existed and older saves keep loading unchanged.
        const json = await new Node('plain').serialize();
        expect('motionBlur' in json).toBe(false);
    });

    it("loads as 'full' when the key is missing", async () => {
        const root = new Node('root');
        const source = new Node('legacy');
        root.addChild(source);
        const json = await source.serialize();
        delete json.motionBlur;

        const target = new Node('root');
        parseNodeJson(target, json);
        expect(target.children[0].motionBlur).toBe('full');
    });
});

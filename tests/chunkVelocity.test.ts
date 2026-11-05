import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { Node } from '../src/core/scene/nodes/node';
import { TemporalPasses } from '../src/graphics/render/temporal';

/**
 * The velocity bookkeeping visits a landscape's terrain chunks through the landscape: a chunk moved exactly
 * when its landscape did, and its previous world matrix is derived from the landscape's. What has to hold:
 * a parked landscape costs no per-chunk work at all, a moved one reports motion and draws its chunks with
 * the right previous matrix, and a chunk opted out of plain reprojection is still drawn.
 */
const STOP = new Error('pass opened');

function setup() {
    const view = { frameIndex: 10, hasPrevViewProj: true, viewProj: mat4.create(), prevViewProj: mat4.create() };
    const inGBufferCalls: object[] = [];
    const sys = {
        geometry: { inGBuffer: (n: object) => { inGBufferCalls.push(n); return true; } },
        visibility: { outsideFrustum: () => false },
    };
    const projection = { uvProducing: (m: mat4) => m };
    const passes = { beginFullscreenPass: () => { throw STOP; } };
    const temporal = new TemporalPasses({} as never, view as never, {} as never, passes as never, {} as never,
                                        {} as never, projection as never, {} as never, sys as never);
    (temporal as unknown as { _velocityObjectsTarget: () => null })._velocityObjectsTarget = () => null;

    const landscape = new Node('landscape');
    landscape.setPosition([5, 0, 5]);
    const chunks: Node[] = [];
    for (let i = 0; i < 4; i++) {
        const c = new Node(`chunk${i}`);
        c.setPosition([i * 10, 0, 0]);
        Object.assign(c, { isTerrainChunk: true, initialized: true, model: { material: { type: 'terrain', config: {} } } });
        landscape.addChild(c);
        chunks.push(c);
    }
    Object.defineProperty(landscape, 'chunkNodes', { get: () => chunks });
    landscape.updateTransforms();
    const scene = { models: new Set(chunks), modelsExceptTerrain: new Set(), landscapes: new Set([landscape]) };

    const t = temporal as unknown as {
        _objectVelocityPass(s: unknown): void; _velocityDrawList: Node[]; _prevWorldOf(n: Node): mat4 | null;
    };
    const select = () => {
        try { t._objectVelocityPass(scene); } catch (e) { if (e !== STOP) throw e; }
        return [...t._velocityDrawList];
    };
    const nextFrame = () => { temporal.capturePrevTransforms(scene as never); view.frameIndex++; };
    return { temporal, t, view, scene, landscape, chunks, select, nextFrame, inGBufferCalls };
}

describe('terrain chunk velocity', () => {
    it('does no per-chunk work for a landscape that stays put', () => {
        const { temporal, select, nextFrame, inGBufferCalls, scene } = setup();
        nextFrame();
        temporal.detectObjectMotion(scene as never);
        expect(temporal.anyObjectMoved).toBe(false);
        expect(select()).toEqual([]);
        expect(inGBufferCalls).toEqual([]);
    });

    it('reports a moved landscape and draws its chunks with their previous world matrices', () => {
        const { temporal, t, select, nextFrame, landscape, chunks, scene } = setup();
        const before = chunks.map(c => mat4.clone(c.worldTransform));
        nextFrame();
        landscape.setPosition([6, 0, 5]);
        landscape.updateTransforms();
        temporal.detectObjectMotion(scene as never);
        expect(temporal.anyObjectMoved).toBe(true);
        expect(select()).toEqual(chunks);
        chunks.forEach((c, i) => expect(Array.from(t._prevWorldOf(c)!)).toEqual(Array.from(before[i])));
    });

    it('still draws a chunk opted out of plain reprojection', () => {
        const { select, nextFrame, chunks } = setup();
        chunks[2].motionBlur = 'none';
        nextFrame();
        expect(select()).toEqual([chunks[2]]);
    });

    it('has no history for a chunk whose landscape skipped a frame', () => {
        const { t, view, nextFrame, chunks } = setup();
        nextFrame();
        view.frameIndex += 2;
        expect(t._prevWorldOf(chunks[0])).toBeNull();
    });
});

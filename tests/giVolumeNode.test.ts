import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { GIVolumeNode, MAX_GI_PROBES_PER_AXIS } from '../src/core/scene/nodes/giVolumeNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';

describe('GIVolumeNode', () => {
    it('round-trips every setting', async () => {
        const v = new GIVolumeNode('room', {
            size: [6, 3, 8], probeCounts: [7, 4, 9], rays: 256, maxRayDistance: 20, captureResolution: 16,
            includeGrass: true, blendDistance: 0.5, intensity: 1.5, normalBias: 0.2, viewBias: 0.3,
            multiBounce: false, additive: true, enabled: false, bakeId: 'bake-1',
        });
        const parent = new Node('parent');
        parseNodeJson(parent, await v.serialize());
        const r = parent.children[0] as GIVolumeNode;
        expect(r).toBeInstanceOf(GIVolumeNode);
        expect(r.size).toEqual([6, 3, 8]);
        expect(r.probeCounts).toEqual([7, 4, 9]);
        expect(r.rays).toBe(256);
        expect(r.raySide).toBe(16);
        expect(r.maxRayDistance).toBe(20);
        expect(r.captureResolution).toBe(16);
        expect(r.includeGrass).toBe(true);
        expect(r.blendDistance).toBe(0.5);
        expect(r.intensity).toBe(1.5);
        expect(r.normalBias).toBe(0.2);
        expect(r.viewBias).toBe(0.3);
        expect(r.multiBounce).toBe(false);
        expect(r.additive).toBe(true);
        expect(r.enabled).toBe(false);
        expect(r.bakeId).toBe('bake-1');
    });

    it('parses an empty payload to the defaults', () => {
        const parent = new Node('parent');
        parseNodeJson(parent, { type: 'giVolume', name: 'gi', id: 'x', children: [] });
        const r = parent.children[0] as GIVolumeNode;
        expect(r.size).toEqual([10, 10, 10]);
        expect(r.probeCounts).toEqual([5, 5, 5]);
        expect(r.rays).toBe(64);
        expect(r.bakeId).toBeNull();
        expect(r.enabled).toBe(true);
        expect(r.multiBounce).toBe(true);
        expect(r.additive).toBe(false);
    });

    it('holds its settings to their ranges', () => {
        const v = new GIVolumeNode('v', { probeCounts: [1, 1000, 3.6], rays: 100, captureResolution: 30, size: [-1, 0, 5] });
        expect(v.probeCounts).toEqual([2, MAX_GI_PROBES_PER_AXIS, 4]);
        expect(v.rays).toBe(64);
        expect(v.captureResolution).toBe(32);
        expect(v.size[0]).toBeGreaterThan(0);
        expect(v.size[1]).toBeGreaterThan(0);
        v.rays = 200;
        expect(v.rays).toBe(256);
        v.maxRayDistance = -5;
        expect(v.maxRayDistance).toBeGreaterThanOrEqual(1);
        v.intensity = NaN;
        expect(v.intensity).toBe(1);
    });

    it('asks for a capture when the grid changes, not when only its look does', () => {
        const v = new GIVolumeNode('v');
        v.markCaptured();
        v.intensity = 2;
        v.additive = true;
        v.blendDistance = 3;
        v.normalBias = 0.3;
        v.enabled = false;
        expect(v.captureRequested).toBe(false);
        v.probeCounts = [5, 5, 5];
        expect(v.captureRequested).toBe(false);   // the same counts
        v.probeCounts = [6, 5, 5];
        expect(v.captureRequested).toBe(true);
        v.markCaptured();
        v.size = [10, 10, 11];
        expect(v.captureRequested).toBe(true);
        v.markCaptured();
        v.rays = 256;
        expect(v.captureRequested).toBe(true);
        v.markCaptured();
        v.requestCapture();
        expect(v.captureRequested).toBe(true);
    });

    it('puts probe (0,0,0) at the min corner and the last at the max, under the transform', () => {
        const v = new GIVolumeNode('v', { size: [10, 4, 6], probeCounts: [6, 3, 4] });
        v.setPosition([100, 2, -50]);
        v.updateTransforms();
        const p = vec3.create();
        v.probeWorldPosition(p, 0, 0, 0);
        expect([...p].map(x => +x.toFixed(5))).toEqual([95, 0, -53]);
        v.probeWorldPosition(p, 5, 2, 3);
        expect([...p].map(x => +x.toFixed(5))).toEqual([105, 4, -47]);
        expect(v.localSpacing).toEqual([2, 2, 2]);
        expect(v.minSpacing).toBeCloseTo(2);
        expect(v.probeCount).toBe(72);
        // worldToGrid inverts gridToWorld.
        const w2g = v.worldToGrid(mat4.create());
        const g = vec3.transformMat4(vec3.create(), vec3.fromValues(100, 2, -50), w2g);
        expect(g[0]).toBeCloseTo(2.5);
        expect(g[1]).toBeCloseTo(1);
        expect(g[2]).toBeCloseTo(1.5);
    });

    it('scales its spacing with the world scale', () => {
        const v = new GIVolumeNode('v', { size: [4, 4, 4], probeCounts: [5, 5, 5] });
        v.setScale([2, 1, 0.5]);
        v.updateTransforms();
        expect(v.worldSpacing.map(x => +x.toFixed(5))).toEqual([2, 1, 0.5]);
        expect(v.minSpacing).toBeCloseTo(0.5);
        expect(v.volumeSize).toBeCloseTo(64);
    });

    it('weighs 1 inside, eases at the feather, 0 outside or disabled', () => {
        const v = new GIVolumeNode('v', { size: [10, 10, 10], blendDistance: 2 });
        expect(v.weightAt(vec3.fromValues(0, 0, 0))).toBe(1);
        const edge = v.weightAt(vec3.fromValues(4, 0, 0));
        expect(edge).toBeGreaterThan(0);
        expect(edge).toBeLessThan(1);
        expect(v.weightAt(vec3.fromValues(6, 0, 0))).toBe(0);
        expect(v.distanceToVolume(vec3.fromValues(8, 0, 0))).toBeCloseTo(3);
        expect(v.distanceToVolume(vec3.fromValues(1, 1, 1))).toBe(0);
        v.enabled = false;
        expect(v.weightAt(vec3.fromValues(0, 0, 0))).toBe(0);
    });

    it('is collected by the scene', () => {
        const scene = new Scene();
        const v = new GIVolumeNode('gi');
        scene.addNode(v);
        expect([...scene.giVolumes]).toEqual([v]);
    });
});

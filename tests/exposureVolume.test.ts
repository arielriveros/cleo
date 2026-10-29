import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { ExposureVolumeNode } from '../src/core/scene/nodes/exposureVolumeNode';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { blendExposure, effectiveCurveStops, type ExposureSettings } from '../src/graphics/exposureBlend';
import { exposureCurveStops } from '../src/graphics/lighting';

const SCENE: ExposureSettings = {
    autoExposureEnabled: true, ev100: 15, exposureCompensation: 1, exposureCompensationCurve: [],
    exposureMinEV: 2, exposureMaxEV: 17, exposureSpeedUp: 3, exposureSpeedDown: 1,
};

describe('ExposureVolumeNode', () => {
    it('round-trips its box and only the fields it overrides', async () => {
        const v = new ExposureVolumeNode('cave', { size: [4, 5, 6], blendDistance: 2, priority: 3 });
        v.setOverride('exposureMinEV', 3);
        v.setOverride('exposureCompensationCurve', [[0, -1], [8, 0]]);
        v.enabled = false;
        const parent = new Node('parent');
        parseNodeJson(parent, await v.serialize());
        const r = parent.children[0] as ExposureVolumeNode;
        expect(r).toBeInstanceOf(ExposureVolumeNode);
        expect(r.size).toEqual([4, 5, 6]);
        expect(r.blendDistance).toBe(2);
        expect(r.priority).toBe(3);
        expect(r.enabled).toBe(false);
        expect(r.overrides).toEqual({ exposureMinEV: 3, exposureCompensationCurve: [[0, -1], [8, 0]] });
        expect(r.hasOverride('exposureMaxEV')).toBe(false);
    });

    it('lets a field through again when its override is cleared', () => {
        const v = new ExposureVolumeNode('v', { overrides: { exposureMinEV: 3, exposureMaxEV: 9 } });
        v.setOverride('exposureMinEV', undefined);
        expect(v.overrides).toEqual({ exposureMaxEV: 9 });
    });

    it('applies a preset as overrides of every field it sets', () => {
        const v = new ExposureVolumeNode('v');
        expect(v.applyPreset('cave')).toBe(true);
        expect(v.overrides.exposureMinEV).toBe(3);
        expect(v.overrides.exposureCompensationCurve!.length).toBeGreaterThan(0);
        expect(v.applyPreset('nope')).toBe(false);
    });

    it('weighs 1 inside, eases at the feather, 0 outside or disabled', () => {
        const v = new ExposureVolumeNode('v', { size: [10, 10, 10], blendDistance: 2 });
        expect(v.weightAt(vec3.fromValues(0, 0, 0))).toBe(1);
        const edge = v.weightAt(vec3.fromValues(4, 0, 0));
        expect(edge).toBeGreaterThan(0);
        expect(edge).toBeLessThan(1);
        expect(v.weightAt(vec3.fromValues(6, 0, 0))).toBe(0);
        v.enabled = false;
        expect(v.weightAt(vec3.fromValues(0, 0, 0))).toBe(0);
    });

    it('follows the node transform', () => {
        const v = new ExposureVolumeNode('v', { size: [2, 2, 2], blendDistance: 0 });
        v.setPosition([20, 0, 0]);
        v.updateTransforms();
        expect(v.weightAt(vec3.fromValues(0, 0, 0))).toBe(0);
        expect(v.weightAt(vec3.fromValues(20.5, 0, 0))).toBe(1);
    });
});

describe('Scene.exposureVolumesAt', () => {
    it('orders by priority, then the smaller box last', () => {
        const scene = new Scene();
        const big = new ExposureVolumeNode('big', { size: [100, 100, 100] });
        const small = new ExposureVolumeNode('small', { size: [4, 4, 4] });
        const high = new ExposureVolumeNode('high', { size: [200, 200, 200], priority: 1 });
        const away = new ExposureVolumeNode('away', { size: [1, 1, 1] });
        away.setPosition([50, 50, 50]);
        for (const n of [high, small, big, away]) { scene.addNode(n); n.updateTransforms(); }
        expect(scene.exposureVolumesAt(vec3.fromValues(0, 0, 0)).map(f => f.volume.name)).toEqual(['big', 'small', 'high']);
    });
});

describe('blendExposure', () => {
    it('is the scene unchanged with no volume', () => {
        const e = blendExposure(SCENE, []);
        expect(e.exposureMinEV).toBe(2);
        expect(effectiveCurveStops(e, 5)).toBe(0);
    });

    it('blends only overridden fields, by weight', () => {
        const e = blendExposure(SCENE, [{ overrides: { exposureMinEV: 4, ev100: 5 }, weight: 0.5 }]);
        expect(e.exposureMinEV).toBe(3);
        expect(e.ev100).toBe(10);
        expect(e.exposureMaxEV).toBe(17);
        expect(e.exposureCompensation).toBe(1);
    });

    it('lets a later volume win over an earlier one', () => {
        const e = blendExposure(SCENE, [
            { overrides: { exposureMinEV: 4 }, weight: 1 },
            { overrides: { exposureMinEV: 8 }, weight: 1 },
        ]);
        expect(e.exposureMinEV).toBe(8);
    });

    it('switches metering at half weight', () => {
        expect(blendExposure(SCENE, [{ overrides: { autoExposureEnabled: false }, weight: 0.49 }]).autoExposureEnabled).toBe(true);
        expect(blendExposure(SCENE, [{ overrides: { autoExposureEnabled: false }, weight: 0.5 }]).autoExposureEnabled).toBe(false);
    });

    it('blends curve output, not keys', () => {
        const sceneCurve: [number, number][] = [[0, -2], [10, 0]];
        const volumeCurve: [number, number][] = [[0, 2], [4, 1]];
        const base = { ...SCENE, exposureCompensationCurve: sceneCurve };
        const e = blendExposure(base, [{ overrides: { exposureCompensationCurve: volumeCurve }, weight: 0.25 }]);
        for (const ev of [-1, 2, 5, 12]) {
            const expected = exposureCurveStops(sceneCurve, ev) * 0.75 + exposureCurveStops(volumeCurve, ev) * 0.25;
            expect(effectiveCurveStops(e, ev)).toBeCloseTo(expected, 10);
        }
        const full = blendExposure(base, [{ overrides: { exposureCompensationCurve: volumeCurve }, weight: 1 }]);
        expect(effectiveCurveStops(full, 2)).toBeCloseTo(exposureCurveStops(volumeCurve, 2), 10);
    });
});

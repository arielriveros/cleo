import { describe, it, expect } from 'vitest';
import { VolumetricCloudsNode } from '../src/core/scene/nodes/volumetricCloudsNode';
import { VOLUMETRIC_CLOUDS_PRESETS } from '../src/core/scene/nodes/volumetricCloudsPresets';

describe('volumetric cloud presets', () => {
    it('has unique ids', () => {
        const ids = VOLUMETRIC_CLOUDS_PRESETS.map(p => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('only sets real node properties, never quality / enabled / opacity / useSceneSun', () => {
        const node = new VolumetricCloudsNode('clouds');
        const reserved = ['steps', 'lightSteps', 'maxDistance', 'jitter', 'resolutionScale', 'temporalUpscale',
            'enabled', 'opacity', 'useSceneSun'];
        for (const p of VOLUMETRIC_CLOUDS_PRESETS) {
            for (const k of Object.keys(p.options)) {
                expect(k in node, `${p.id}.${k}`).toBe(true);
                expect(reserved, `${p.id}.${k}`).not.toContain(k);
            }
        }
    });

    it('applies a preset by id and leaves user settings alone', () => {
        const node = new VolumetricCloudsNode('clouds', { steps: 96, resolutionScale: 1, useSceneSun: false, opacity: 0.7 });
        expect(node.applyPreset('rainy')).toBe(true);
        expect(node.coverage).toBeCloseTo(0.95);
        expect(node.baseAltitude).toBe(400);
        expect(node.steps).toBe(96);
        expect(node.resolutionScale).toBe(1);
        expect(node.useSceneSun).toBe(false);
        expect(node.opacity).toBeCloseTo(0.7);
    });

    it('fully resets fields from a previous preset and does not alias preset arrays', () => {
        const node = new VolumetricCloudsNode('clouds');
        node.applyPreset('stormy');
        node.applyPreset('sunny');
        expect(node.anvilBias).toBe(0);
        node.ambientColor[0] = 99;
        expect(VOLUMETRIC_CLOUDS_PRESETS.find(p => p.id === 'sunny')!.options.ambientColor![0]).not.toBe(99);
    });

    it('returns false for an unknown id', () => {
        expect(new VolumetricCloudsNode('clouds').applyPreset('nope')).toBe(false);
    });
});

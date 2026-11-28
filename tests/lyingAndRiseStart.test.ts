import { describe, it, expect } from 'vitest';
import { quat } from 'gl-matrix';
import type { Animation } from '../src/animation/animatedModel';
import { classifyLying } from '../src/physics/reactive/bodySensors';
import { clipRiseStart } from '../src/animation/clipRiseStart';
import { boneIndex, humanoidSkin, poseClip } from './helpers/humanoidRig';

// How a body lies (classifyLying: on its back, its front, its side, with some give) and where a get-up clip starts to
// rise (clipRiseStart: a capture's get-up that lies still a while first is joined where it moves).

describe('lying classes', () => {
    it('reads the back, the front and the side from how far the front of the body faces up', () => {
        expect([classifyLying(0.9, null), classifyLying(-0.9, null), classifyLying(0.1, null), classifyLying(-0.3, null)]).toEqual([1, -1, 0, 0]);
    });

    it('stays what it is until it is well into the next: no flicker on the line', () => {
        // On its back, rocking toward its side: still on its back down to 0.25.
        expect(classifyLying(0.3, 1)).toBe(1);
        expect(classifyLying(0.2, 1)).toBe(0);
        // On its side: on its back only past 0.45, its front past -0.45.
        expect(classifyLying(0.4, 0)).toBe(0);
        expect(classifyLying(0.5, 0)).toBe(1);
        expect(classifyLying(-0.5, 0)).toBe(-1);
        // On its front, rolling: through the side to the back.
        expect(classifyLying(-0.3, -1)).toBe(-1);
        expect(classifyLying(0.0, -1)).toBe(0);
        expect(classifyLying(0.6, -1)).toBe(1);
    });
});

describe('where a get-up rises', () => {
    const skin = humanoidSkin();
    const clip = (keys: [number, number][]): Animation => ({
        name: 'Get Up',
        samplers: [{ input: keys.map(k => k[0]), output: keys.flatMap(k => [...quat.setAxisAngle(quat.create(), [1, 0, 0], k[1] * Math.PI / 180)]), interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: boneIndex('Spine'), targetPath: 'rotation' }],
    });

    it('lying still for 1.4 s then rising: joined a frame before it moves', () => {
        const t = clipRiseStart(clip([[0, 0], [1.4, 0], [3, -70]]), skin);
        expect(t).toBeGreaterThan(1.3);
        expect(t).toBeLessThan(1.45);
    });

    it('moving from the start, or never: from its first frame', () => {
        expect(clipRiseStart(clip([[0, 0], [1, -60]]), skin)).toBe(0);
        expect(clipRiseStart(poseClip('Still', { Spine: [[1, 0, 0], 20] }, 2), skin)).toBe(0);
    });

    it('is measured once per clip and skeleton', () => {
        const c = clip([[0, 0], [1, 0], [2, -60]]);
        const a = clipRiseStart(c, skin);
        c.samplers[0].input[1] = 0.2;
        expect(clipRiseStart(c, skin)).toBe(a);
    });
});

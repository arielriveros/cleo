import { describe, expect, it } from 'vitest';
import { FoliageInteraction, INTERACT_MAX_AGE, INTERACT_RANGE, MAX_INTERACT_STAMPS, gatherFoliageInteractors } from '../src/graphics/foliageInteraction';
import { Material, applyInteraction, interactionConfigOf } from '../src/graphics/material';

// Foliage interaction: what pushes grass and bushes aside arrives at the GPU as a few stamps (a sphere,
// the way it was going, a strength, a birth time). These pin the CPU half: which sources make stamps,
// the trail they leave, how stamps age out, and which ones win when there are more than fit.

const CAM = [0, 1.7, 0];
const stampOf = (fi: FoliageInteraction, i: number) => Array.from(fi.stamps.slice(i * 8, i * 8 + 8));

describe('FoliageInteraction stamps', () => {
    it('makes a live stamp per source, with its direction of travel and the time it was made', () => {
        const fi = new FoliageInteraction();
        const walker = {};
        fi.update([{ key: walker, interactor: { position: [2, 0, 0], radius: 0.5, velocity: [0, 0, 3] } }], 10, CAM);
        // The live stamp, and the first trail stamp it drops while moving.
        expect(fi.count).toBe(2);
        expect(stampOf(fi, 0)).toEqual([2, 0, 0, 0.5, 0, 1, 1, 10]);
    });

    it('leaves a trail every ~0.8 radii while moving, and none standing still', () => {
        const fi = new FoliageInteraction();
        const walker = {};
        let t = 0;
        for (let x = 0; x <= 2.0001; x += 0.1, t += 0.05)
            fi.update([{ key: walker, interactor: { position: [x, 0, 0], radius: 0.5, velocity: [2, 0, 0] } }], t, CAM);
        // 2 m at a drop every 0.4 m: about 6 trail stamps, plus the live one.
        expect(fi.count).toBeGreaterThanOrEqual(6);
        expect(fi.count).toBeLessThanOrEqual(8);
        const still = new FoliageInteraction();
        for (let i = 0; i < 20; i++) still.update([{ key: walker, interactor: { position: [0, 0, 0], radius: 0.5, velocity: [0, 0, 0] } }], i * 0.1, CAM);
        expect(still.count).toBe(1);
    });

    it('lets trail stamps age out, and forgets a source that left', () => {
        const fi = new FoliageInteraction();
        const walker = {};
        fi.update([{ key: walker, interactor: { position: [1, 0, 0], radius: 0.5, velocity: [3, 0, 0] } }], 0, CAM);
        fi.update([], 1, CAM);
        expect(fi.count).toBe(1);                       // the trail stamp lingers: the grass is still parted
        fi.update([], INTERACT_MAX_AGE + 0.5, CAM);
        expect(fi.count).toBe(0);
    });

    it('ignores sources out of range, and keeps the nearest when more than fit', () => {
        const fi = new FoliageInteraction();
        const far = { key: {}, interactor: { position: [INTERACT_RANGE + 5, 0, 0], radius: 0.5 } };
        const many = Array.from({ length: MAX_INTERACT_STAMPS + 6 }, (_, i) => ({ key: {}, interactor: { position: [i + 1, 0, 0], radius: 0.5 } }));
        fi.update([far, ...many], 0, CAM);
        expect(fi.count).toBe(MAX_INTERACT_STAMPS);
        const xs = Array.from({ length: fi.count }, (_, i) => fi.stamps[i * 8]);
        expect(Math.max(...xs)).toBe(MAX_INTERACT_STAMPS);  // the 16 nearest
    });
});

describe('gatherFoliageInteractors', () => {
    it('takes characters, moving dynamic bodies, radial force fields and registered interactors', () => {
        const character = { visible: true, worldPosition: [1, 0, 1], currentVelocity: [1, 0, 0] };
        const rolling = { mass: 5, position: { x: 3, y: 0.5, z: 0 }, velocity: { x: 4, y: 0, z: 0 }, boundingRadius: 0.4 };
        const resting = { mass: 5, position: { x: 4, y: 0.5, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, boundingRadius: 0.4 };
        const wall = { mass: 0, position: { x: 5, y: 0, z: 0 }, velocity: { x: 9, y: 0, z: 0 } };
        const blast = { enabled: true, visible: true, kind: 'radial', strength: 30, radius: 6, worldPosition: [0, 0, 5] };
        const breeze = { enabled: true, visible: true, kind: 'directional', strength: 5, radius: 6, worldPosition: [0, 0, 5] };
        const custom = { position: [7, 0, 0], radius: 1 };
        const scene: any = {
            characters: new Set([character]), physics: { bodies: [rolling, resting, wall] },
            forceFields: new Set([blast, breeze]), foliageInteractors: new Map([[custom, custom]]),
        };
        const got = gatherFoliageInteractors(scene);
        expect(got.map(g => g.key)).toEqual([character, rolling, blast, custom]);
        expect(got[1].interactor.radius).toBeCloseTo(0.4);
        expect(got[2].interactor.radius).toBe(6);
    });
});

describe('Material interaction', () => {
    it('defaults to rigid, round-trips, clamps and is omitted when default', () => {
        const m = Material.PBR({});
        expect(interactionConfigOf(m)).toEqual({ interactBend: 0, interactRecovery: 1 });
        expect('interactBend' in (m.serialize() as any)).toBe(false);
        applyInteraction(m, { interactBend: 0.8, interactRecovery: 1.5 });
        const back = Material.parse(m.serialize());
        expect(interactionConfigOf(back)).toEqual({ interactBend: 0.8, interactRecovery: 1.5 });
        applyInteraction(m, { interactBend: 4, interactRecovery: 0 });
        expect(interactionConfigOf(m)).toEqual({ interactBend: 1, interactRecovery: 0.1 });
    });

});

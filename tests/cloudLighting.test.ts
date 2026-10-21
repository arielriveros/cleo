import { describe, it, expect } from 'vitest';
import { atmosphereTransmittance, shHemisphereMeans } from '../src/graphics/cloudLighting';
import { VolumetricCloudsNode } from '../src/core/scene/nodes/volumetricCloudsNode';

const EARTH = {
    rayleigh: [5.8e-6, 13.5e-6, 33.1e-6] as [number, number, number],
    mie: 21e-6, rayleighHeight: 8000, mieHeight: 1200,
    planetRadius: 6371e3, atmosphereRadius: 6471e3,
};

describe('cloud sun transmittance', () => {
    it('is highest at the zenith and reddens toward the horizon', () => {
        const zenith = atmosphereTransmittance(EARTH, 1000, [0, 1, 0]);
        const low = atmosphereTransmittance(EARTH, 1000, [Math.cos(0.05), Math.sin(0.05), 0]);
        for (let i = 0; i < 3; i++) expect(low[i]).toBeLessThan(zenith[i]);
        // Rayleigh takes blue first: the low sun is redder relative to the zenith one.
        expect(low[0] / zenith[0]).toBeGreaterThan(low[2] / zenith[2]);
        expect(zenith[0]).toBeGreaterThan(0.8);
    });

    it('is zero once the planet blocks the sun', () => {
        const t = atmosphereTransmittance(EARTH, 1000, [Math.cos(-0.2), Math.sin(-0.2), 0]);
        expect(t).toEqual([0, 0, 0]);
    });

    it('still reaches a high cloud just after sunset on the ground', () => {
        // ~0.5 degrees below the horizon: occluded at the ground, not 3 km up.
        const dir = [Math.cos(-0.009), Math.sin(-0.009), 0];
        expect(atmosphereTransmittance(EARTH, 0, dir)[0]).toBe(0);
        expect(atmosphereTransmittance(EARTH, 3000, dir)[0]).toBeGreaterThan(0);
    });
});

describe('sky SH hemisphere means', () => {
    it('recovers a constant sky and a sky brighter above than below', () => {
        // A constant radiance L projects to c0 = L * sqrt(4 pi) only.
        const sh = new Float32Array(36);
        sh[0] = sh[1] = sh[2] = 2 * Math.sqrt(4 * Math.PI);
        const flat = shHemisphereMeans(sh);
        expect(flat.up[0]).toBeCloseTo(2, 3);
        expect(flat.down[0]).toBeCloseTo(2, 3);

        sh[4] = sh[5] = sh[6] = 1; // +y gradient
        const graded = shHemisphereMeans(sh);
        expect(graded.up[0]).toBeGreaterThan(graded.down[0]);
    });
});

describe('volumetric clouds lighting fields', () => {
    it('defaults the physically based fields when an old scene omits them', () => {
        const node = new VolumetricCloudsNode('clouds', { absorption: 1.4 });
        expect(node.absorption).toBe(1.4);
        expect(node.albedo).toBeCloseTo(0.98);
        expect(node.msOctaves).toBe(3);
        expect(node.useSkyAmbient).toBe(true);
    });

    it('round-trips the new fields through serialize', () => {
        const node = new VolumetricCloudsNode('clouds', { msOctaves: 2, hazeDistance: 12000, phaseBackG: -0.4 });
        const clouds = (node as any)._serializePayload().clouds;
        const back = new VolumetricCloudsNode('clouds', clouds);
        expect(back.msOctaves).toBe(2);
        expect(back.hazeDistance).toBe(12000);
        expect(back.phaseBackG).toBeCloseTo(-0.4);
    });

    it('clamps octaves and keeps the back lobe negative', () => {
        const node = new VolumetricCloudsNode('clouds');
        node.msOctaves = 9;
        node.phaseBackG = 0.5;
        expect(node.msOctaves).toBe(4);
        expect(node.phaseBackG).toBe(0);
    });
});

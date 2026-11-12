import { describe, it, expect } from 'vitest';
import { Scene } from '../src/core/scene/scene';
import { LightNode } from '../src/core/scene/nodes/lightNode';
import { PointLight } from '../src/graphics/lighting';
import ValleyTourDirectorNode from '../examples/scripts/ValleyTourDirector';
import type { SequenceScriptContext } from '../src/sequencer/types';

// The Valley tour's director (examples/scripts/ValleyTourDirector.ts): its storm lightning, called as the tour's
// Script track calls it. Where the timeline is decides the flash, so a seek shows what a playback would.

function setup() {
    const scene = new Scene();
    const director = new ValleyTourDirectorNode('Valley Tour');
    const light = new LightNode('Lightning', new PointLight({ unit: 'photometric', intensity: 0, range: 2500 } as any), false);
    scene.addNode(director);
    scene.addNode(light);
    const clouds = { ambientIntensity: 2 };
    Object.defineProperty(scene, 'volumetricClouds', { get: () => clouds });
    return { director, light, clouds };
}

const ctx = (phase: SequenceScriptContext['phase'], local: number, duration = 40): SequenceScriptContext => ({
    phase, time: 100 + local, local, duration, alpha: local / duration, weight: 1, dt: 0, seeking: false, stopped: false,
    args: [7, 8], sequence: null, resume: () => {},
});

describe('the Valley tour director', () => {
    it('flashes the lightning light and the clouds at each strike, dark between, and puts the clouds back', () => {
        const { director, light, clouds } = setup();
        director.lightning(ctx('enter', 0));
        const strikes = (director as any)._strikes as { t: number }[];
        expect(strikes).toHaveLength(8);
        for (let i = 1; i < strikes.length; i++) expect(strikes[i].t).toBeGreaterThan(strikes[i - 1].t);
        const t = strikes[2].t;
        director.lightning(ctx('update', t + 0.03));
        expect((light.light as any).intensity).toBeGreaterThan(1e9);
        expect(clouds.ambientIntensity).toBeGreaterThan(2 * 3);
        // High in the clouds, a few hundred metres off.
        expect(light.position[1]).toBeGreaterThan(350);
        director.lightning(ctx('update', t + 0.8));
        expect((light.light as any).intensity).toBeLessThan(1e3);
        // The same moment, the same flash: a seek back to it gives the same picture.
        director.lightning(ctx('update', t + 0.03));
        const again = (light.light as any).intensity;
        director.lightning(ctx('update', t + 0.03));
        expect((light.light as any).intensity).toBe(again);
        director.lightning(ctx('exit', 40));
        expect((light.light as any).intensity).toBe(0);
        expect(clouds.ambientIntensity).toBe(2);
    });

    it('reads its lumens as the editor will: no exponent in its field defaults', async () => {
        const { readFileSync } = await import('fs');
        const source = readFileSync(new URL('../examples/scripts/ValleyTourDirector.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/public \w+: number = [\d.]+e\d/);
    });
});

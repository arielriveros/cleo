import { describe, it, expect } from 'vitest';
import { SkyLightNode } from '../src/core/scene/nodes/skyLightNode';
import { Node } from '../src/core/scene/nodes/node';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';

/**
 * The sky light's own contract: its two authored values round-trip, and the projection-dirty flag is
 * driven by the thing that actually invalidates the coefficients.
 */
describe('SkyLightNode', () => {
    it('round-trips intensity and tint', async () => {
        const node = new SkyLightNode('sky light', { intensity: 2.5, tint: [0.9, 1.0, 1.2] });
        const json = await node.serialize();
        const root = new Node('root');
        parseNodeJson(root, json);
        const parsed = root.children[0] as SkyLightNode;
        expect(parsed).toBeInstanceOf(SkyLightNode);
        expect(parsed.intensity).toBeCloseTo(2.5);
        expect(parsed.tint).toEqual([0.9, 1.0, 1.2]);
    });

    it('round-trips cloud shadows, off by default so existing scenes keep their look', async () => {
        expect(new SkyLightNode('sky light').cloudShadows).toBe(false);
        const node = new SkyLightNode('sky light', { cloudShadows: true, cloudShadowStrength: 0.6 });
        const root = new Node('root');
        parseNodeJson(root, await node.serialize());
        const parsed = root.children[0] as SkyLightNode;
        expect(parsed.cloudShadows).toBe(true);
        expect(parsed.cloudShadowStrength).toBeCloseTo(0.6);
        parsed.cloudShadowStrength = 4;
        expect(parsed.cloudShadowStrength).toBe(1);
    });

    it('clamps a negative intensity rather than inverting the light', () => {
        const node = new SkyLightNode('sky light');
        node.intensity = -3;
        expect(node.intensity).toBe(0);
    });

    it('asks for a re-projection when the tint changes but not when the intensity does', () => {
        const node = new SkyLightNode('sky light');
        node.markProjected();
        // Intensity is a scalar the shader applies at evaluation time — re-deriving nine coefficients
        // for it would be pure waste.
        node.intensity = 2;
        expect(node.needsProjection).toBe(false);
        // The tint multiplies the coefficients themselves, so it genuinely invalidates them.
        node.tint = [1, 0.5, 0.5];
        expect(node.needsProjection).toBe(true);
    });

    it('leaves the scene ambient alone by default, day and night', () => {
        const node = new SkyLightNode('sky light');
        expect(node.ambientScale(0.8)).toBe(1);
        expect(node.ambientScale(-0.5)).toBe(1);
        expect(node.ambientScale(null)).toBe(1);
    });

    it('fades the ambient to the night share once the sun is down', () => {
        const node = new SkyLightNode('sky light', { ambient: 0.5, nightAmbient: 0.02 });
        expect(node.ambientScale(0.5)).toBeCloseTo(0.5);           // day: the plain scale
        expect(node.ambientScale(-0.5)).toBeCloseTo(0.5 * 0.02);   // deep night: the night share of it
        const dusk = node.ambientScale(-0.05);
        expect(dusk).toBeLessThan(0.5);
        expect(dusk).toBeGreaterThan(0.01);
        // No sun to tell day from night: the night share never applies.
        expect(node.ambientScale(null)).toBeCloseTo(0.5);
        node.nightAmbient = -1;
        expect(node.nightAmbient).toBe(0);
        node.ambient = -2;
        expect(node.ambient).toBe(0);
    });

    it('round-trips the ambient settings; an older save keeps the full ambient', async () => {
        const node = new SkyLightNode('sky light', { ambient: 1.5, nightAmbient: 0.1 });
        const root = new Node('root');
        parseNodeJson(root, await node.serialize());
        const parsed = root.children[0] as SkyLightNode;
        expect(parsed.ambient).toBeCloseTo(1.5);
        expect(parsed.nightAmbient).toBeCloseTo(0.1);

        const old = await new SkyLightNode('old').serialize();
        delete old.skyLight.ambient;
        delete old.skyLight.nightAmbient;
        const root2 = new Node('root');
        parseNodeJson(root2, old);
        const restored = root2.children[0] as SkyLightNode;
        expect(restored.ambient).toBe(1);
        expect(restored.nightAmbient).toBe(1);
    });

    it('starts dirty, so a freshly loaded scene projects without anything having to touch it', () => {
        expect(new SkyLightNode('sky light').needsProjection).toBe(true);
    });
});

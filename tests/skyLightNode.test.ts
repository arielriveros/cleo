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

    it('starts dirty, so a freshly loaded scene projects without anything having to touch it', () => {
        expect(new SkyLightNode('sky light').needsProjection).toBe(true);
    });
});

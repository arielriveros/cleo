import { describe, it, expect } from 'vitest';
import { Node } from '../src/cleo';
import { GeometryPass } from '../src/graphics/render/geometryPass';

/**
 * A shadow-only node (Node.shadowOnly) is drawn into the shadow maps and by no camera: a first-person player's own
 * body, gone from the view it would fill while its shadow stays on the ground. The flag is the node's (it fans out
 * like `viewmodel`); the camera passes leave such a node out through GeometryPass.inGBuffer (and the forward pass's
 * own test), while the shadow casters' gather keeps it, since it only asks `visible`.
 */

describe('shadowOnly flag', () => {
    it('is off, and absent from the JSON, by default', async () => {
        const root = new Node('root');
        const n = new Node('n');
        root.addChild(n);
        expect(n.shadowOnly).toBe(false);
        expect(await n.serialize()).not.toHaveProperty('shadowOnly');
    });

    it('fans out to children, leaves them visible, and survives a save', async () => {
        const root = new Node('root');
        const body = new Node('body');
        const weapon = new Node('weapon');
        root.addChild(body);
        body.addChild(weapon);
        body.shadowOnly = true;
        expect(weapon.shadowOnly).toBe(true);
        // Still visible: it keeps animating and casting.
        expect(weapon.visible).toBe(true);
        const json = await body.serialize();
        expect(json.shadowOnly).toBe(true);
        const back = new Node('root');
        Node.parse(back, json);
        expect(back.children[0].shadowOnly).toBe(true);
        expect(back.children[0].children[0].shadowOnly).toBe(true);
        body.shadowOnly = false;
        expect(weapon.shadowOnly).toBe(false);
    });

    it('keeps the node out of the G-buffer, which every camera pass and capture reads', () => {
        const model = (shadowOnly: boolean) => ({
            visible: true, shadowOnly, editorOnly: false,
            model: { material: { type: 'pbr', config: { transparent: false } } },
        });
        const inGBuffer = (n: object) => GeometryPass.prototype.inGBuffer.call({}, n as any);
        expect(inGBuffer(model(false))).toBe(true);
        expect(inGBuffer(model(true))).toBe(false);
    });
});

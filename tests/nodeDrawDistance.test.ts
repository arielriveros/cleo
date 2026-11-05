import { describe, it, expect } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Node } from '../src/core/scene/nodes/node';

// Node.drawDistance: the renderer calls updateDrawCull(eye) each frame (Visibility.updateModelLOD). Past
// the distance the whole subtree reads invisible; it returns only inside ×0.9; authored visibility and
// LOD visibility are untouched; nothing emits SCENE_CHANGED.

function placed(x: number): { root: Node; child: Node } {
    const root = new Node('enemy');
    const child = new Node('model');
    root.addChild(child);
    root.setPosition([x, 0, 0]);
    root.updateTransforms();
    root.drawDistance = 50;
    return { root, child };
}

describe('Node.drawDistance', () => {
    it('hides the subtree past the distance, with ×0.9 hysteresis on the way back', () => {
        const { root, child } = placed(0);
        root.updateDrawCull([49, 0, 0]);
        expect(child.visible).toBe(true);
        root.updateDrawCull([51, 0, 0]);
        expect(root.visible).toBe(false);
        expect(child.visible).toBe(false);
        expect(child.drawCulled).toBe(true);
        root.updateDrawCull([46, 0, 0]);   // inside 50 but not inside 45: still culled
        expect(child.visible).toBe(false);
        root.updateDrawCull([44, 0, 0]);
        expect(child.visible).toBe(true);
    });

    it('hides children attached while culled and releases them when detached', () => {
        const { root } = placed(0);
        root.updateDrawCull([100, 0, 0]);
        const weapon = new Node('weapon');
        root.addChild(weapon);
        expect(weapon.visible).toBe(false);
        root.removeChild(weapon);
        expect(weapon.visible).toBe(true);
    });

    it('keeps authored visibility and LOD visibility separate, and emits no scene event', () => {
        const { root, child } = placed(0);
        const events: any[] = [];
        const listener = (e: any) => events.push(e);
        CleoEngine.eventEmitter.on('SCENE_CHANGED', listener);
        try {
            root.updateDrawCull([100, 0, 0]);
            root.updateDrawCull([0, 0, 0]);
        } finally { CleoEngine.eventEmitter.off('SCENE_CHANGED', listener); }
        expect(events).toHaveLength(0);
        child.setLodVisible(false);
        expect(child.visible).toBe(false);
        child.setLodVisible(true);
        expect(child.visible).toBe(true);
    });

    it('nests: an inner draw distance stays culled while the outer returns', () => {
        const { root, child } = placed(0);
        child.drawDistance = 10;
        root.updateDrawCull([100, 0, 0]);
        child.updateDrawCull([100, 0, 0]);
        root.updateDrawCull([20, 0, 0]);
        child.updateDrawCull([20, 0, 0]);
        expect(root.visible).toBe(true);
        expect(child.visible).toBe(false);
    });

    it('round-trips through serialize/parse and turns off at 0', async () => {
        const { root } = placed(0);
        const json = await root.serialize();
        expect(json.drawDistance).toBe(50);
        root.updateDrawCull([100, 0, 0]);
        root.drawDistance = 0;
        expect(root.visible).toBe(true);
        expect((await root.serialize()).drawDistance).toBeUndefined();
    });
});

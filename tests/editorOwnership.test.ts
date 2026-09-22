import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { isEditorOnlyNode, isEditorOwnedNode, isEditorOwnedName, markEditorOwned } from '../src/core/scene/editorNodes';

/**
 * Editor OWNERSHIP: the nodes the editor puts into a scene for itself — the free-fly camera, gizmo handles,
 * helper icons, collider wireframes, brush cursors, preview lights — must never mark a document unsaved,
 * never become an undo step and never be saved.
 *
 * All three consumers used to guess, each in its own way. The dirty tracker tested the emitting node's own
 * name. The undo recorder did not test at all. Serialization kept everything and relied on every caller to
 * strip it afterwards. What is pinned here is the single engine-side answer they now share, and the two
 * places it has to be decided by the engine because no listener can decide it afterwards.
 */

function capture(run: () => void): any[] {
    const events: any[] = [];
    const listener = (e: any) => events.push(e);
    CleoEngine.eventEmitter.on('SCENE_CHANGED', listener);
    try { run(); } finally { CleoEngine.eventEmitter.off('SCENE_CHANGED', listener); }
    return events;
}

describe('the ownership predicate', () => {
    it('accepts either marker anywhere in the name', () => {
        expect(isEditorOwnedName('__editor__Camera')).toBe(true);
        expect(isEditorOwnedName('__debug__body_7')).toBe(true);
        expect(isEditorOwnedName('light__editor__icon')).toBe(true);
        expect(isEditorOwnedName('Camera')).toBe(false);
        expect(isEditorOwnedName('__terrain_chunk__0')).toBe(false);
        expect(isEditorOwnedName(undefined)).toBe(false);
    });

    it('is a superset of editorOnly, not the same question', () => {
        // Owned but deliberately NOT chrome: the preview ground is lit, shadow-catching scene content.
        const ground = new Node('__editor__ground');
        expect(isEditorOwnedNode(ground)).toBe(true);
        expect(isEditorOnlyNode(ground)).toBe(false);

        // Chrome is always owned, whatever it is called.
        const chrome = new Node('ring');
        chrome.editorOnly = true;
        expect(isEditorOwnedNode(chrome)).toBe(true);

        const handle = new Node('handle');
        (handle as any).isGizmo = true;
        expect(isEditorOwnedNode(handle)).toBe(true);
    });

    it('honours the explicit flag, for editor nodes whose name must stay as it is', () => {
        const holder = markEditorOwned(new Node('Mannequin'));
        expect(isEditorOwnedNode(holder)).toBe(true);
        markEditorOwned(holder, false);
        expect(isEditorOwnedNode(holder)).toBe(false);
    });

    it('inherits downward, including to children added later', () => {
        const group = new Node('__debug__body_1');
        const shape = new Node('shape');
        group.addChild(shape);
        const late = new Node('late');
        shape.addChild(late);
        expect(shape.isEditorOwned).toBe(true);
        expect(late.isEditorOwned).toBe(true);
    });

    it('never flows upward: a light carrying an icon is still content', () => {
        const light = new Node('Sun');
        light.addChild(new Node('__editor__LightSprite'));
        expect(light.isEditorOwned).toBe(false);
    });
});

describe('ownership on the SCENE_CHANGED payload', () => {
    it('is stamped on an add, after the attach', () => {
        const group = new Node('__debug__body_1');
        const shape = new Node('shape');
        const [add] = capture(() => group.addChild(shape)).filter(e => e.prop === 'add');
        // The shape's own name is plain; it is owned through the group it just joined.
        expect(add.editorOwned).toBe(true);
    });

    it('is computed BEFORE a removal detaches the node', () => {
        // After removeChild the shape has no parent, so asking the node would say "not owned". The payload
        // has to carry the answer from before, or the undo recorder records the removal of chrome.
        const group = new Node('__debug__body_1');
        const shape = new Node('shape');
        group.addChild(shape);
        const [remove] = capture(() => group.removeChild(shape)).filter(e => e.prop === 'remove');
        expect(remove.editorOwned).toBe(true);
        expect(shape.isEditorOwned).toBe(false);
    });

    it('is false for authored content', () => {
        const parent = new Node('parent');
        const events = capture(() => {
            const child = new Node('child');
            parent.addChild(child);
            child.name = 'renamed';
            child.visible = false;
            parent.removeChild(child);
        });
        expect(events.length).toBeGreaterThan(0);
        for (const e of events) expect(e.editorOwned).toBe(false);
    });

    it('rides on the recursive visibility fan-out, per node', () => {
        // Hiding a light also hides its icon. The icon's own event must be distinguishable from the light's.
        const light = new Node('Sun');
        const icon = new Node('__editor__LightSprite');
        light.addChild(icon);
        const events = capture(() => { light.visible = false; }).filter(e => e.kind === 'visibility');
        expect(events.find(e => e.node === icon)?.editorOwned).toBe(true);
        expect(events.find(e => e.node === light)?.editorOwned).toBe(false);
    });

    it('carries the scene, captured before a removal clears it', () => {
        const scene = new Scene();
        const node = new Node('crate');
        scene.addNode(node);
        const [remove] = capture(() => scene.removeNode(node)).filter(e => e.prop === 'remove');
        expect(remove.scene).toBe(scene);
        expect(node.scene).toBe(null);

        // A subtree still being built belongs to no scene yet.
        const detached = new Node('holder');
        const [add] = capture(() => detached.addChild(new Node('part'))).filter(e => e.prop === 'add');
        expect(add.scene).toBe(null);
        scene.dispose();
    });
});

describe('property events', () => {
    let wasAuthoring = false;
    beforeEach(() => { wasAuthoring = CleoEngine.authoringMode; CleoEngine.authoringMode = true; });
    afterEach(() => { CleoEngine.authoringMode = wasAuthoring; });

    it('are never emitted for an owned node', () => {
        // The editor camera, gizmo handles and helper wireframes are moved every frame; this is where that
        // flood stops.
        const camera = new Node('__editor__Camera');
        const shape = new Node('shape');
        new Node('__debug__body_1').addChild(shape);
        const events = capture(() => {
            camera.setPosition([1, 2, 3]);
            camera.setRotation([10, 20, 0]);
            shape.setScale([2, 2, 2]);
            camera.setVariable('x', 1, 'number');
        });
        expect(events).toEqual([]);
    });

    it('still fire, stamped not-owned, for authored content', () => {
        const crate = new Node('crate');
        const events = capture(() => crate.setPosition([1, 0, 0]));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ kind: 'transform', node: crate, editorOwned: false });
    });
});

describe('serialization', () => {
    it('leaves editor-owned children out', async () => {
        const light = new Node('Sun');
        light.addChild(new Node('__editor__LightSprite'));
        light.addChild(new Node('__debug__CameraModel'));
        const flagged = new Node('preview holder');
        flagged.editorOwned = true;
        light.addChild(flagged);
        const chrome = new Node('ring');
        chrome.editorOnly = true;
        light.addChild(chrome);
        light.addChild(new Node('real child'));

        const json = await light.serialize();
        expect(json.children.map((c: any) => c.name)).toEqual(['real child']);
    });

    it('still serializes an owned node that is asked for directly', async () => {
        // The test is on each CHILD alone. Serializing an owned root must keep its own plain children.
        const holder = markEditorOwned(new Node('holder'));
        holder.addChild(new Node('body'));
        const json = await holder.serialize();
        expect(json.children.map((c: any) => c.name)).toEqual(['body']);
    });
});

describe('Node.removeChild of a node that is not a child', () => {
    it('is a no-op instead of detaching the last child', () => {
        // A stale undo entry replaying against a tree that has moved on used to `splice(-1, 1)`. That
        // silently detached the parent's LAST child, which is usually an editor helper.
        const parent = new Node('root');
        const content = new Node('crate');
        const helper = new Node('__editor__gizmo__x');
        parent.addChild(content);
        parent.addChild(helper);
        const stranger = new Node('stranger');

        const events = capture(() => parent.removeChild(stranger));
        expect(events).toEqual([]);
        expect(parent.children).toEqual([content, helper]);
        expect(helper.parent).toBe(parent);
    });
});

describe('Node.removeChild around onDespawn', () => {
    it('reads the slot AFTER onDespawn, so a handler that drops a sibling cannot misdirect the splice', () => {
        // The index used to be read before onDespawn. A handler removing an EARLIER sibling then shifted the
        // doomed node down a slot, and the splice took out whichever node sat in its old one.
        const parent = new Node('root');
        const marker = new Node('marker');
        const enemy = new Node('enemy');
        const player = new Node('player');
        parent.addChild(marker); parent.addChild(enemy); parent.addChild(player);
        enemy.onDespawn = () => parent.removeChild(marker);

        const [remove] = capture(() => parent.removeChild(enemy)).filter(e => e.node === enemy && e.prop === 'remove');
        expect(parent.children).toEqual([player]);
        expect(enemy.parent).toBe(null);
        expect(player.parent).toBe(parent);
        expect(remove.prev).toEqual({ parentId: parent.id, index: 0 });
    });
});

describe('a name that is not a string', () => {
    it('is simply not owned, rather than a TypeError on every structural event', () => {
        // Scripts can assign anything, and a hand-edited scene can carry a numeric name.
        expect(isEditorOwnedName(7 as any)).toBe(false);
        const odd = new Node('x');
        expect(() => { (odd as any).name = 7; }).not.toThrow();
        expect(() => odd.addChild(new Node('child'))).not.toThrow();
        expect(odd.isEditorOwned).toBe(false);
    });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Scene } from '../src/core/scene/scene';
import { Camera } from '../src/core/camera';
import { Node } from '../src/core/scene/nodes/node';
import { CameraNode } from '../src/core/scene/nodes/cameraNode';
import { UINode } from '../src/core/scene/nodes/ui/uiNode';
import { UIRootNode } from '../src/core/scene/nodes/ui/uiRoot';
import { UIPanelNode, UIStackNode, UISpacerNode } from '../src/core/scene/nodes/ui/uiContainers';
import { UITextNode, UIImageNode } from '../src/core/scene/nodes/ui/uiContent';
import { UIButtonNode, UIProgressBarNode, UISliderNode, UIToggleNode, UITextInputNode } from '../src/core/scene/nodes/ui/uiWidgets';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { isUINodeType } from '../src/core/scene/nodes/nodeType';

// Every UI type, with a mutation that must survive a serialize/parse round trip.
const TYPES: { make: () => UINode, type: string, mutate?: (n: any) => void, check?: (n: any) => void }[] = [
    { make: () => new UIRootNode('root ui'), type: 'uiRoot',
      mutate: n => { n.space = 'world'; n.referenceDistance = 25; n.uiTargetId = 'abc'; n.scaleMode = 'constantPixel'; },
      check: n => { expect(n.space).toBe('world'); expect(n.referenceDistance).toBe(25); expect(n.uiTargetId).toBe('abc'); } },
    { make: () => new UIPanelNode('panel'), type: 'uiPanel' },
    { make: () => new UITextNode('label'), type: 'uiText',
      mutate: n => { n.text = 'Health'; n.fontSize = 22; n.align = 'center'; },
      check: n => { expect(n.text).toBe('Health'); expect(n.fontSize).toBe(22); expect(n.align).toBe('center'); } },
    { make: () => new UIImageNode('icon'), type: 'uiImage',
      mutate: n => { n.textureId = 'tex-1'; n.fit = 'cover'; },
      check: n => { expect(n.textureId).toBe('tex-1'); expect(n.fit).toBe('cover'); } },
    { make: () => new UIButtonNode('btn'), type: 'uiButton',
      mutate: n => { n.label = 'Start'; n.disabled = true; },
      check: n => { expect(n.label).toBe('Start'); expect(n.disabled).toBe(true); } },
    { make: () => new UIStackNode('stack'), type: 'uiStack',
      mutate: n => { n.direction = 'row'; n.gap = 12; n.justify = 'spaceBetween'; },
      check: n => { expect(n.direction).toBe('row'); expect(n.gap).toBe(12); expect(n.justify).toBe('spaceBetween'); } },
    { make: () => new UISpacerNode('gap'), type: 'uiSpacer',
      mutate: n => { n.flex = 3; }, check: n => expect(n.flex).toBe(3) },
    { make: () => new UIProgressBarNode('hp'), type: 'uiProgressBar',
      mutate: n => { n.max = 100; n.value = 42; n.direction = 'rtl'; },
      check: n => { expect(n.max).toBe(100); expect(n.value).toBe(42); expect(n.direction).toBe('rtl'); } },
    { make: () => new UISliderNode('vol'), type: 'uiSlider',
      mutate: n => { n.min = 0; n.max = 10; n.step = 1; n.value = 7; },
      check: n => { expect(n.value).toBe(7); expect(n.step).toBe(1); } },
    { make: () => new UIToggleNode('mute'), type: 'uiToggle',
      mutate: n => { n.checked = true; n.label = 'Mute'; },
      check: n => { expect(n.checked).toBe(true); expect(n.label).toBe('Mute'); } },
    { make: () => new UITextInputNode('name'), type: 'uiTextInput',
      mutate: n => { n.value = 'Ariel'; n.placeholder = 'name'; n.maxLength = 12; },
      check: n => { expect(n.value).toBe('Ariel'); expect(n.maxLength).toBe(12); } },
];

describe('isUINodeType', () => {
    it('claims exactly the UI family', () => {
        for (const t of TYPES) expect(isUINodeType(t.type)).toBe(true);
        for (const t of ['node', 'model', 'camera', 'sprite', 'tilemap', 'landscape', 'cameraRig'])
            expect(isUINodeType(t)).toBe(false);
    });

    // A startsWith('ui') test would claim these; the Set does not. The predicate gates publish stripping,
    // picking and inspector routing, so a false positive is not cosmetic.
    it('does not claim an unrelated type that merely starts with "ui"', () => {
        expect(isUINodeType('uiLikeButNotUI')).toBe(false);
        expect(isUINodeType('ui')).toBe(false);
    });
});

describe('UI node serialization', () => {
    for (const spec of TYPES) {
        it(`round-trips ${spec.type} through serialize -> parseNodeJson`, async () => {
            const original = spec.make();
            original.setAnchor(1, 0);
            original.setRect(12, 34, 210, 56);
            original.opacity = 0.75;
            original.zOrder = 5;
            original.clip = true;
            original.borderRadius = 7;
            spec.mutate?.(original);

            const json = await original.serialize();
            expect(json.type).toBe(spec.type);

            const parent = new Node('parent');
            parseNodeJson(parent, json);
            const restored = parent.children[0] as any;

            expect(restored).toBeInstanceOf(UINode);
            expect(restored.nodeType).toBe(spec.type);
            expect(restored.id).toBe(original.id);
            expect(restored.anchorMin).toEqual([1, 0]);
            expect(restored.offsetMin).toEqual([12, 34]);
            expect(restored.offsetMax).toEqual([222, 90]);
            expect(restored.opacity).toBe(0.75);
            expect(restored.zOrder).toBe(5);
            expect(restored.clip).toBe(true);
            expect(restored.borderRadius).toBe(7);
            spec.check?.(restored);

            // Second round trip must be byte-identical, which is what catches a field that serializes
            // but does not parse (or vice versa) — the failure mode a single trip cannot see.
            const again = await restored.serialize();
            expect(again.ui).toEqual(json.ui);
        });
    }

    it('preserves visible: false, which the legacy UI model silently dropped', async () => {
        const panel = new UIPanelNode('hidden');
        panel.visible = false;
        const parent = new Node('parent');
        parseNodeJson(parent, await panel.serialize());
        expect((parent.children[0] as UINode).visible).toBe(false);
    });

    it('restores a nested subtree with the right classes', async () => {
        const root = new UIRootNode('UI');
        const stack = new UIStackNode('rows', 'column');
        stack.addChild(new UITextNode('a'));
        stack.addChild(new UIProgressBarNode('b'));
        root.addChild(stack);

        const parent = new Node('parent');
        parseNodeJson(parent, await root.serialize());
        const restored = parent.children[0] as UIRootNode;
        expect(restored).toBeInstanceOf(UIRootNode);
        expect(restored.children[0]).toBeInstanceOf(UIStackNode);
        expect(restored.children[0].children[0]).toBeInstanceOf(UITextNode);
        expect(restored.children[0].children[1]).toBeInstanceOf(UIProgressBarNode);
    });
});

describe('UI node parse does not double-add', () => {
    // Node._commonParse already ends with parent.addChild(node). SpriteNode.parse and ~9 others call it a
    // SECOND time, which fires a spurious reparent-detach + reparent SCENE_CHANGED pair per node on every
    // scene load. The UI parses deliberately do not, and this is what keeps it that way.
    it('emits no reparent events when parsing a UI subtree', async () => {
        const root = new UIRootNode('UI');
        root.addChild(new UIPanelNode('p'));
        root.addChild(new UITextNode('t'));
        const json = await root.serialize();

        const events: any[] = [];
        const listener = (e: any) => events.push(e);
        CleoEngine.eventEmitter.on('SCENE_CHANGED', listener);
        const wasAuthoring = CleoEngine.authoringMode;
        CleoEngine.authoringMode = true;
        try {
            parseNodeJson(new Node('parent'), json);
        } finally {
            CleoEngine.authoringMode = wasAuthoring;
            CleoEngine.eventEmitter.off('SCENE_CHANGED', listener);
        }

        const reparents = events.filter(e => e?.prop === 'reparent' || e?.prop === 'reparent-detach');
        expect(reparents).toEqual([]);
    });
});

describe('the UI layout pass', () => {
    let scene: Scene;

    beforeEach(() => {
        scene = new Scene();
        scene.setUIViewport(1920, 1080, 1);
        scene.start();
    });

    // Started and UNPAUSED, which is what both the editor and a running game actually do. It matters for
    // world-space UI specifically: CameraNode.update() is what pushes the node's world transform into the
    // Camera, and the node loop (hence that sync) is skipped while paused — so a paused scene would
    // project against a camera that had never been positioned.
    const solve = () => scene.update(1 / 60, 0, false);

    it('does nothing, and costs nothing, when the scene has no UI', () => {
        scene.addNode(new Node('empty'));
        solve();
        expect(scene.stats.uiMs).toBe(0);
    });

    it('resolves a screen root to the viewport in reference units', () => {
        const root = new UIRootNode('UI');
        root.referenceResolution = [1920, 1080];
        scene.addNode(root);
        solve();

        expect(root.scaleFactor).toBeCloseTo(1, 10);
        expect(root.rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
        expect(scene.stats.uiNodes).toBe(1);
    });

    it('keeps children in reference units and scales only at the root', () => {
        // Half-size viewport: the root scales to 0.5, but a child anchored at 100px in reference space
        // still reports rect.x = 100 and screenRect.x = 50. That split is the whole point of the design.
        scene.setUIViewport(960, 540, 1);
        const root = new UIRootNode('UI');
        root.referenceResolution = [1920, 1080];
        const panel = new UIPanelNode('p');
        panel.setAnchor(0, 0);
        panel.setRect(100, 50, 200, 40);
        root.addChild(panel);
        scene.addNode(root);
        solve();

        expect(root.scaleFactor).toBeCloseTo(0.5, 10);
        expect(panel.rect).toEqual({ x: 100, y: 50, width: 200, height: 40 });
        expect(panel.screenRect).toEqual({ x: 50, y: 25, width: 100, height: 20 });
    });

    it('anchors a child to the bottom-right corner of the viewport', () => {
        const root = new UIRootNode('UI');
        const badge = new UIPanelNode('badge');
        badge.setAnchor(1, 1);
        badge.offsetMin = [-120, -60];
        badge.offsetMax = [-20, -20];
        root.addChild(badge);
        scene.addNode(root);
        solve();

        expect(badge.rect).toEqual({ x: 1800, y: 1020, width: 100, height: 40 });
    });

    it('multiplies opacity down the tree and ANDs visibility', () => {
        const root = new UIRootNode('UI');
        const outer = new UIPanelNode('outer');
        const inner = new UITextNode('inner');
        outer.opacity = 0.5;
        inner.opacity = 0.5;
        outer.addChild(inner);
        root.addChild(outer);
        scene.addNode(root);
        solve();
        expect(inner.resolvedOpacity).toBeCloseTo(0.25, 10);
        expect(inner.resolvedVisible).toBe(true);

        outer.visible = false;
        solve();
        expect(inner.resolvedVisible).toBe(false);
        // Still SOLVED though: the editor has to be able to show a rect for a hidden-but-selected node.
        expect(inner.rect.width).toBeGreaterThan(0);
    });

    it('bumps layoutVersion only when the resolved rect actually changes', () => {
        const root = new UIRootNode('UI');
        const panel = new UIPanelNode('p');
        root.addChild(panel);
        scene.addNode(root);
        solve();

        const settled = panel.layoutVersion;
        solve();
        solve();
        // The DOM layer skips a node whose layoutVersion is unchanged; if this ticked every frame the
        // skip would never fire and every element would be restyled sixty times a second.
        expect(panel.layoutVersion).toBe(settled);

        panel.setRect(5, 5, 50, 50);
        solve();
        expect(panel.layoutVersion).toBeGreaterThan(settled);
    });

    it('lays a column stack out with gaps and a flexible spacer', () => {
        const root = new UIRootNode('UI');
        root.referenceResolution = [1920, 1080];
        const stack = new UIStackNode('col', 'column');
        stack.setAnchor(0, 0);
        stack.setRect(0, 0, 300, 400);
        stack.gap = 10;

        const a = new UITextNode('a'); a.setRect(0, 0, 300, 50);
        const spacer = new UISpacerNode('sp'); spacer.flex = 1;
        const b = new UITextNode('b'); b.setRect(0, 0, 300, 30);
        stack.addChild(a); stack.addChild(spacer); stack.addChild(b);
        root.addChild(stack);
        scene.addNode(root);
        solve();

        expect(a.rect.y).toBe(0);
        expect(a.rect.height).toBe(50);
        // 400 total - 50 - 30 - two 10px gaps = 300 for the spacer.
        expect(spacer.rect.height).toBe(300);
        expect(b.rect.y).toBe(370);
        expect(b.rect.height).toBe(30);
        // align defaults to 'stretch', so the cross axis fills the stack.
        expect(a.rect.width).toBe(300);
    });

    it('intersects clip rects down the tree', () => {
        const root = new UIRootNode('UI');
        const clipper = new UIPanelNode('clipper');
        clipper.setRect(0, 0, 100, 100);
        clipper.clip = true;
        const child = new UIPanelNode('child');
        child.setRect(50, 50, 500, 500);
        clipper.addChild(child);
        root.addChild(clipper);
        scene.addNode(root);
        solve();

        expect(child.clipRect).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    });

    it('projects a world-space root onto the screen and hides it behind the camera', () => {
        const cameraNode = new CameraNode('cam', new Camera({ type: 'perspective', fov: 90, near: 0.1, far: 100 }));
        cameraNode.active = true;
        cameraNode.setPosition([0, 0, 0]);   // default forward is +Z
        scene.addNode(cameraNode);

        const root = new UIRootNode('nameplate', 'world');
        root.referenceResolution = [200, 60];
        root.pivot = [0.5, 0.5];
        root.minScale = 0.01;
        root.maxScale = 100;
        root.setPosition([0, 0, 10]);
        scene.addNode(root);
        solve();

        expect(root.onScreen).toBe(true);
        // Centred horizontally and vertically, offset back by the pivot.
        const w = 200 * root.scaleFactor, h = 60 * root.scaleFactor;
        expect(root.origin.x).toBeCloseTo(1920 / 2 - w / 2, 4);
        expect(root.origin.y).toBeCloseTo(1080 / 2 - h / 2, 4);

        // Behind the camera: hidden, not mirrored to a plausible-looking coordinate.
        root.setPosition([0, 0, -10]);
        solve();
        expect(root.onScreen).toBe(false);
    });

    it('shrinks a world-space root as it recedes', () => {
        const cameraNode = new CameraNode('cam', new Camera({ type: 'perspective', fov: 90, near: 0.1, far: 500 }));
        cameraNode.active = true;
        scene.addNode(cameraNode);

        const root = new UIRootNode('nameplate', 'world');
        root.referenceDistance = 10;
        root.minScale = 0.01;
        root.maxScale = 100;
        root.setPosition([0, 0, 10]);
        scene.addNode(root);
        solve();
        const near = root.scaleFactor;

        root.setPosition([0, 0, 40]);
        solve();
        expect(root.scaleFactor).toBeLessThan(near);
        expect(root.scaleFactor).toBeCloseTo(near / 4, 4);
    });

    it('leaves a world root un-resolved rather than frozen when there is no camera', () => {
        const root = new UIRootNode('nameplate', 'world');
        root.setPosition([0, 0, 10]);
        scene.addNode(root);
        solve();
        expect(root.onScreen).toBe(false);
        expect(root.scaleFactor).toBe(0);
    });

    it('skips despawned UI subtrees', () => {
        const root = new UIRootNode('UI');
        const panel = new UIPanelNode('p');
        root.addChild(panel);
        scene.addNode(root);
        solve();
        const before = panel.layoutVersion;

        panel.despawn();
        panel.setRect(999, 999, 10, 10);
        solve();
        // Dormant: not resolved, so the version cannot have moved.
        expect(panel.layoutVersion).toBe(before);
    });
});

describe('UI widget behaviour', () => {
    it('a disabled button does not fire onPress', () => {
        const button = new UIButtonNode('b');
        let fired = 0;
        button.onPress = () => { fired++; };
        button.press();
        expect(fired).toBe(1);

        button.disabled = true;
        button.press();
        expect(fired).toBe(1);
    });

    it('a slider quantizes to its step and clamps to its range', () => {
        const slider = new UISliderNode('s');
        slider.min = 0; slider.max = 10; slider.step = 2;
        slider.value = 4.9;
        expect(slider.value).toBe(4);
        slider.value = 999;
        expect(slider.value).toBe(10);
        slider.value = -5;
        expect(slider.value).toBe(0);
    });

    // A script assigning `value` must not re-enter its own handler, or a two-way binding loops forever.
    it('a slider fires onValueChanged only for user input, not script assignment', () => {
        const slider = new UISliderNode('s');
        let fired = 0;
        slider.onValueChanged = () => { fired++; };

        slider.value = 0.25;
        expect(fired).toBe(0);

        slider.setValueFromFraction(0.75);
        expect(fired).toBe(1);
        expect(slider.value).toBeCloseTo(0.75, 10);

        // No actual change -> no event.
        slider.setValueFromFraction(0.75);
        expect(fired).toBe(1);
    });

    it('a toggle fires onValueChanged only when the user flips it', () => {
        const toggle = new UIToggleNode('t');
        let fired = 0;
        toggle.onValueChanged = () => { fired++; };
        toggle.checked = true;
        expect(fired).toBe(0);
        toggle.toggle();
        expect(fired).toBe(1);
        expect(toggle.checked).toBe(false);
    });

    it('a read-only text input ignores user input but not script assignment', () => {
        const input = new UITextInputNode('i');
        let fired = 0;
        input.onValueChanged = () => { fired++; };
        input.readOnly = true;

        input.setValueFromInput('typed');
        expect(input.value).toBe('');
        expect(fired).toBe(0);

        input.value = 'from script';
        expect(input.value).toBe('from script');
    });

    it('a text input truncates to maxLength', () => {
        const input = new UITextInputNode('i');
        input.maxLength = 4;
        input.value = 'abcdefgh';
        expect(input.value).toBe('abcd');
    });

    it('a progress bar reports a clamped fraction', () => {
        const bar = new UIProgressBarNode('hp');
        bar.min = 0; bar.max = 200; bar.value = 50;
        expect(bar.fraction).toBeCloseTo(0.25, 10);
        bar.value = 999;
        expect(bar.fraction).toBe(1);
        bar.value = -1;
        expect(bar.fraction).toBe(0);
    });

    it('a zero-span progress bar reports 0 rather than NaN', () => {
        const bar = new UIProgressBarNode('hp');
        bar.min = 5; bar.max = 5; bar.value = 5;
        expect(bar.fraction).toBe(0);
    });

    it('orders siblings by zOrder, keeping tree order for ties', () => {
        const root = new UIRootNode('UI');
        const a = new UIPanelNode('a'); a.zOrder = 2;
        const b = new UIPanelNode('b'); b.zOrder = 0;
        const c = new UIPanelNode('c'); c.zOrder = 0;
        root.addChild(a); root.addChild(b); root.addChild(c);
        expect(root.uiChildren.map(n => n.name)).toEqual(['b', 'c', 'a']);
    });
});

describe('every authored setter marks the node dirty', () => {
    // Reflective on purpose. The DOM layer skips any node whose `revision` has not moved, so a setter that
    // forgets to bump it is invisible in the editor and impossible to spot by reading one class — which is
    // exactly how all 17 base-class setters once shipped broken (a colour edit did nothing; pivot and
    // rotation never appeared at all). A hand-written list of properties would have the same blind spot as
    // the code it checks, so this walks the prototypes instead and therefore covers properties not yet
    // written.

    /** A value guaranteed to differ from `current`, so setters that early-return on equality still fire. */
    const differentFrom = (current: any): any => {
        if (typeof current === 'number') return current + 1;
        if (typeof current === 'boolean') return !current;
        if (typeof current === 'string') return current + 'x';
        if (Array.isArray(current)) return current.map((v: any) => (typeof v === 'number' ? v + 0.25 : v));
        return 'x'; // null / undefined — covers uiTargetId and textureId
    };

    /** Accessors with a setter, declared anywhere between the concrete class and UINode (inclusive). */
    const settableProps = (node: UINode): string[] => {
        const out: string[] = [];
        for (let proto = Object.getPrototypeOf(node); proto && proto !== Node.prototype; proto = Object.getPrototypeOf(proto))
            for (const [name, desc] of Object.entries(Object.getOwnPropertyDescriptors(proto)))
                if (desc.set && !out.includes(name)) out.push(name);
        return out;
    };

    for (const spec of TYPES) {
        it(`${spec.type}: every setter bumps revision`, () => {
            const props = settableProps(spec.make());
            expect(props.length).toBeGreaterThan(0);

            const missed: string[] = [];
            for (const prop of props) {
                // A fresh node per property, so one setter's clamping cannot mask the next one.
                const node = spec.make() as any;
                const before = node.revision;
                node[prop] = differentFrom(node[prop]);
                if (node.revision === before) missed.push(prop);
            }
            expect(missed).toEqual([]);
        });
    }
});

describe('resolved geometry marks a node dirty', () => {
    // The companion to the test above, for the half of the contract the solve owns rather than the setters.
    it('bumps layoutVersion on a world root when only the camera moved', () => {
        const scene = new Scene();
        scene.setUIViewport(1920, 1080, 1);
        scene.start();

        const cameraNode = new CameraNode('cam', new Camera({ type: 'perspective', fov: 90, near: 0.1, far: 500 }));
        cameraNode.active = true;
        scene.addNode(cameraNode);

        const root = new UIRootNode('nameplate', 'world');
        root.setPosition([0, 0, 20]);
        scene.addNode(root);
        scene.update(1 / 60, 0, false);

        const settled = root.layoutVersion;
        scene.update(1 / 60, 0, false);
        expect(root.layoutVersion).toBe(settled); // nothing moved

        // A world root's RECT never changes — it is always the reference resolution — so only the origin
        // and scale carry the motion. Comparing the rect alone left a world HUD frozen on screen while the
        // solve happily produced correct numbers nobody read.
        cameraNode.setPosition([5, 0, 0]);
        scene.update(1 / 60, 0, false);
        expect(root.layoutVersion).toBeGreaterThan(settled);
    });
});

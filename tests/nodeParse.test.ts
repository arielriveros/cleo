import { describe, it, expect } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Camera } from '../src/core/camera';
import { Tilemap } from '../src/graphics/tilemap/tilemap';
import { Sprite } from '../src/graphics/sprite';
import { DirectionalLight, PointLight, Spotlight } from '../src/graphics/lighting';
import { Node } from '../src/core/scene/nodes/node';
import { LodGroupNode } from '../src/core/scene/nodes/lodGroupNode';
import { CameraRigNode } from '../src/core/scene/nodes/cameraRigNode';
import { TilemapNode } from '../src/core/scene/nodes/tilemapNode';
import { LightNode } from '../src/core/scene/nodes/lightNode';
import { LightProbeNode } from '../src/core/scene/nodes/lightProbeNode';
import { VolumetricCloudsNode } from '../src/core/scene/nodes/volumetricCloudsNode';
import { SkyAtmosphereNode } from '../src/core/scene/nodes/skyAtmosphereNode';
import { CameraNode } from '../src/core/scene/nodes/cameraNode';
import { SpriteNode } from '../src/core/scene/nodes/spriteNode';
import { AnimatedSpriteNode } from '../src/core/scene/nodes/animatedSpriteNode';
import { UIRootNode } from '../src/core/scene/nodes/ui/uiRoot';
import { UIPanelNode, UIStackNode, UISpacerNode } from '../src/core/scene/nodes/ui/uiContainers';
import { UITextNode, UIImageNode } from '../src/core/scene/nodes/ui/uiContent';
import { UIButtonNode, UIProgressBarNode, UISliderNode, UIToggleNode, UITextInputNode } from '../src/core/scene/nodes/ui/uiWidgets';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';

/**
 * The parse contract, pinned across the file split.
 *
 * `Node.finishParse` attaches the node to its parent. Eight subclasses used to call `parent.addChild`
 * again on top of that, so every scene load fired a spurious detach + reparent pair per node — which
 * `HistoryContext` and the editor's dirty tracking both listen to. A static method cannot enforce "do not
 * attach the node yourself", so this suite enforces it instead.
 *
 * `ModelNode` and `LandscapeNode` are absent because they cannot be constructed or parsed without a GL
 * context (mesh VAOs, terrain textures) and this suite is deliberately GL-free — see vitest.config.ts.
 * Neither was among the eight classes that double-added, so the property under test is unaffected.
 *
 * `SkyboxNode` is deliberately absent from the table: its parse attaches inside
 * `Skybox.fromBase64(...).then(...)`, so the node is not in the tree when `parse` returns. That asynchrony
 * is load-bearing and would fail a synchronous assertion for the right reason.
 */

const CASES: { label: string, make: () => Node, cls: Function }[] = [
    { label: 'node', make: () => new Node('plain'), cls: Node },
    { label: 'lodGroup', make: () => new LodGroupNode('lod'), cls: LodGroupNode },
    { label: 'cameraRig', make: () => new CameraRigNode('rig'), cls: CameraRigNode },
    { label: 'tilemap', make: () => {
        // A layerless map gains a default layer on deserialize (Tilemap's own behaviour), which would make
        // the round-trip assertion fail for a reason that has nothing to do with node parsing.
        const map = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
        map.addLayer({ name: 'Ground' });
        return new TilemapNode('map', map);
    }, cls: TilemapNode },
    { label: 'light-directional', make: () => new LightNode('sun', new DirectionalLight({}), true), cls: LightNode },
    { label: 'light-point', make: () => new LightNode('bulb', new PointLight({})), cls: LightNode },
    { label: 'light-spot', make: () => new LightNode('spot', new Spotlight({})), cls: LightNode },
    { label: 'lightProbe', make: () => new LightProbeNode('probe', { size: [4, 4, 4] }), cls: LightProbeNode },
    { label: 'volumetricClouds', make: () => new VolumetricCloudsNode('clouds'), cls: VolumetricCloudsNode },
    { label: 'skyAtmosphere', make: () => new SkyAtmosphereNode('sky'), cls: SkyAtmosphereNode },
    { label: 'camera', make: () => new CameraNode('cam', new Camera({ type: 'perspective' })), cls: CameraNode },
    { label: 'sprite', make: () => new SpriteNode('spr', new Sprite(), 'spherical'), cls: SpriteNode },
    { label: 'animatedSprite', make: () => new AnimatedSpriteNode('anim', new Sprite(), { frames: [1, 2], fps: 12, loop: true, constraints: 'cylindrical' }), cls: AnimatedSpriteNode },
    { label: 'uiRoot', make: () => new UIRootNode('UI'), cls: UIRootNode },
    { label: 'uiPanel', make: () => new UIPanelNode('panel'), cls: UIPanelNode },
    { label: 'uiText', make: () => new UITextNode('text'), cls: UITextNode },
    { label: 'uiImage', make: () => new UIImageNode('image'), cls: UIImageNode },
    { label: 'uiButton', make: () => new UIButtonNode('button'), cls: UIButtonNode },
    { label: 'uiStack', make: () => new UIStackNode('stack'), cls: UIStackNode },
    { label: 'uiSpacer', make: () => new UISpacerNode('spacer'), cls: UISpacerNode },
    { label: 'uiProgressBar', make: () => new UIProgressBarNode('bar'), cls: UIProgressBarNode },
    { label: 'uiSlider', make: () => new UISliderNode('slider'), cls: UISliderNode },
    { label: 'uiToggle', make: () => new UIToggleNode('toggle'), cls: UIToggleNode },
    { label: 'uiTextInput', make: () => new UITextInputNode('input'), cls: UITextInputNode },
];

/** Parse `json` under a fresh parent, capturing the structural events it emits. */
function parseCapturing(json: any): { parent: Node, events: any[] } {
    const events: any[] = [];
    const listener = (e: any) => events.push(e);
    const parent = new Node('parent');
    const wasAuthoring = CleoEngine.authoringMode;
    CleoEngine.eventEmitter.on('SCENE_CHANGED', listener);
    // _notifyChange is a no-op outside authoring mode, which would make the assertion below vacuous.
    CleoEngine.authoringMode = true;
    try {
        parseNodeJson(parent, json);
    } finally {
        CleoEngine.authoringMode = wasAuthoring;
        CleoEngine.eventEmitter.off('SCENE_CHANGED', listener);
    }
    return { parent, events };
}

const reparentsIn = (events: any[]) =>
    events.filter(e => e?.prop === 'reparent' || e?.prop === 'reparent-detach');

describe('parseNodeJson', () => {
    for (const { label, make, cls } of CASES) {
        it(`${label}: rebuilds the right class and round-trips`, async () => {
            const original = make();
            original.setPosition([1, 2, 3]);
            original.setVariable('hp', 7, 'number');

            const json = await original.serialize();
            const { parent } = parseCapturing(json);
            const restored = parent.children[0];

            expect(restored).toBeInstanceOf(cls);
            expect(restored.id).toBe(original.id);
            expect(restored.name).toBe(original.name);
            expect(restored.getVariable('hp')).toBe(7);

            // A second trip must be identical. This is what catches a field that serializes but does not
            // parse, and a payload override that replaced its parent's instead of extending it — which is
            // exactly how AnimatedSpriteNode lost its sprite on the first attempt at this refactor.
            expect(await restored.serialize()).toEqual(json);
        });

        it(`${label}: attaches exactly once`, async () => {
            const { events } = parseCapturing(await make().serialize());
            expect(reparentsIn(events)).toEqual([]);
        });
    }

    it('rebuilds a nested subtree, attaching every node exactly once', async () => {
        const root = new UIRootNode('UI');
        const stack = new UIStackNode('rows');
        stack.addChild(new UITextNode('a'));
        stack.addChild(new UIProgressBarNode('b'));
        root.addChild(stack);
        root.addChild(new CameraNode('cam', new Camera({ type: 'perspective' })));

        const { parent, events } = parseCapturing(await root.serialize());
        const restored = parent.children[0];
        expect(restored.children[0].children[1]).toBeInstanceOf(UIProgressBarNode);
        expect(restored.children[1]).toBeInstanceOf(CameraNode);
        expect(reparentsIn(events)).toEqual([]);
    });

    it('falls back to a plain Node for an unknown type rather than throwing', () => {
        const { parent } = parseCapturing({ name: 'mystery', type: 'somethingFromTheFuture', id: 'z' });
        expect(parent.children[0]).toBeInstanceOf(Node);
        expect(parent.children[0].name).toBe('mystery');
    });

    // The dispatcher wires the base class's child recursion on import. If that ever stopped happening,
    // children would silently come back as bare Nodes — a model as an empty transform, nothing logged.
    it('recurses into children through the wired dispatcher, not a bare Node.parse', async () => {
        const holder = new Node('holder');
        holder.addChild(new CameraNode('cam', new Camera({ type: 'perspective' })));
        const { parent } = parseCapturing(await holder.serialize());
        expect(parent.children[0].children[0]).toBeInstanceOf(CameraNode);
    });

    /**
     * `castShadows` used to be dropped on serialize and hardcoded from the light TYPE on parse, so a
     * directional light you had switched OFF came back on, and a spot light you had switched on came
     * back off. Now that spot lights actually cast, that silent override is a visible bug.
     */
    describe('LightNode.castShadows', () => {
        it('round-trips whatever was authored, for every light type', async () => {
            const cases: [LightNode, boolean][] = [
                [new LightNode('sun-off', new DirectionalLight({}), false), false],
                [new LightNode('sun-on', new DirectionalLight({}), true), true],
                [new LightNode('spot-on', new Spotlight({}), true), true],
                [new LightNode('point-on', new PointLight({}), true), true],
            ];
            for (const [node, expected] of cases) {
                const { parent } = parseCapturing(await node.serialize());
                expect((parent.children[0] as LightNode).castShadows).toBe(expected);
            }
        });

        it('falls back to the old type rule for payloads written before it was serialized', async () => {
            // Those payloads carry no key at all, and for them the old behaviour IS the saved intent.
            const json = await new LightNode('legacy', new DirectionalLight({}), false).serialize();
            delete json.castShadows;
            expect(parseCapturing(json).parent.children[0].castShadows).toBe(true);

            const spot = await new LightNode('legacy-spot', new Spotlight({}), true).serialize();
            delete spot.castShadows;
            expect(parseCapturing(spot).parent.children[0].castShadows).toBe(false);
        });
    });

    // The hook LandscapeNode uses to keep its generated terrain chunks out of the saved scene. Exercised
    // here through a local subclass rather than through LandscapeNode itself, which needs a GL context.
    it('honours _serializableChildren, so a node can withhold generated children', async () => {
        class Generated extends Node {
            protected _serializableChildren(): Node[] {
                return this.children.filter(c => !c.name.startsWith('__generated__'));
            }
        }
        const node = new Generated('holder');
        node.addChild(new Node('real'));
        node.addChild(new Node('__generated__chunk'));

        const json = await node.serialize();
        expect(node.children).toHaveLength(2);
        expect(json.children.map((c: any) => c.name)).toEqual(['real']);
    });
});

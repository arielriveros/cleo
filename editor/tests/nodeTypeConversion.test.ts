import { describe, it, expect } from 'vitest'
import { Node, Scene, LightNode, DirectionalLight, CharacterNode, ControllerNode, CameraRigNode, NavMeshNode, SoundNode, LightProbeNode, SpriteNode, Sprite, CameraNode, Camera, parseNodeJson, isUINodeType } from 'cleo'
import { payloadOf, rebaseNodeJson, rebuildNodeInPlace, prepareNodeTypeChange } from '../src/utils/nodeTypeConversion'
import { CONVERTIBLE_NODE_TYPES, findNodeTypeOption, nodeTypeLabel } from '../src/features/sceneInspector/nodeTypeCatalog'
import { findAddItem } from '../src/features/sceneInspector/addCatalog'

/**
 * The type-change contract behind the template root's Type selector.
 *
 * The engine's `_nodeType` is readonly, so a conversion is serialize -> rebase -> destroy -> parse. What
 * must hold across that: the node keeps its id (the editor's scripts/bodies/triggers maps are keyed by it),
 * its name, transform, children and user variables; it loses its old type's payload entirely; and it loses
 * the variables that link it to an asset it is no longer an instance of.
 *
 * `model` and `landscape` are absent for the same reason as in tests/nodeParse.test.ts — they need a GL
 * context and this suite is deliberately GL-free.
 */

const BASE_KEYS = ['id', 'name', 'position', 'rotation', 'scale', 'children', 'variables', 'spawnOnStart', 'motionBlur']

describe('payloadOf', () => {
    it('keeps only the type-specific half', async () => {
        const json = await new LightNode('sun', new DirectionalLight({}), true).serialize()
        const payload = payloadOf(json)
        for (const key of [...BASE_KEYS, 'type']) expect(payload).not.toHaveProperty(key)
        // Whatever LightNode._serializePayload contributes, it is non-empty and includes the discriminator
        // its own parse switches on.
        expect(payload).toHaveProperty('lightType')
    })

    it('is empty for a plain node, which has no payload at all', async () => {
        expect(payloadOf(await new Node('plain').serialize())).toEqual({})
    })
})

describe('rebaseNodeJson', () => {
    it('drops the old payload and keeps the common block verbatim', async () => {
        const light = new LightNode('sun', new DirectionalLight({}), true)
        light.setPosition([1, 2, 3])
        light.addChild(new Node('child'))
        const json = await light.serialize()

        const rebased = rebaseNodeJson(json, 'character')

        expect(rebased.type).toBe('character')
        expect(rebased).not.toHaveProperty('lightType')
        expect(rebased).not.toHaveProperty('light')
        expect(rebased.id).toBe(json.id)
        expect(rebased.name).toBe('sun')
        expect(rebased.position).toEqual(json.position)
        expect(rebased.spawnOnStart).toBe(json.spawnOnStart)
        // By reference, not a copy: the before/after pair an undo entry holds must share the subtree's
        // vertex buffers rather than duplicating them.
        expect(rebased.children).toBe(json.children)
    })

    it('installs the new type\'s payload without letting it clobber the common block', async () => {
        const json = await new Node('holder').serialize()
        const payload = payloadOf(await new SoundNode('emitter', { mode: 'spatial', sampleId: 's1' }).serialize())

        const rebased = rebaseNodeJson(json, 'sound', payload)

        expect(rebased.id).toBe(json.id)
        expect(rebased.name).toBe('holder')
        expect(rebased.sound.sampleId).toBe('s1')
    })

    it('scrubs asset-link variables but keeps the template link, the script link and user variables', async () => {
        const node = new Node('holder')
        node.setVariable('__modelId', 'model-1', 'string')
        node.setVariable('__materialIds', 'mat-1', 'string')
        node.setVariable('__modelBaseTRS', 'trs', 'string')
        node.setVariable('__templateId', 'tpl-1', 'string')
        node.setVariable('__scriptId', 'script-1', 'string')
        node.setVariable('hp', 7, 'number')

        const rebased = rebaseNodeJson(await node.serialize(), 'character')

        expect(rebased.variables).not.toHaveProperty('__modelId')
        expect(rebased.variables).not.toHaveProperty('__materialIds')
        expect(rebased.variables).not.toHaveProperty('__modelBaseTRS')
        expect(rebased.variables).toHaveProperty('__templateId')
        expect(rebased.variables).toHaveProperty('__scriptId')
        expect(rebased.variables).toHaveProperty('hp')
    })

    it('does not mutate the json it rebases', async () => {
        const json = await new LightNode('sun', new DirectionalLight({}), true).serialize()
        rebaseNodeJson(json, 'character')
        expect(json.type).toBe('light')
        expect(json).toHaveProperty('lightType')
    })
})

/**
 * Every convertible type this suite can build without a GL context, and how to seed its payload.
 * `from` builds the node being converted — a plain Node for every case except the conversion back TO a
 * plain node, which has to start as something else to be a conversion at all.
 */
const CASES: { type: string; cls: Function; makeDefault: (() => Promise<Node>) | null; from?: () => Node }[] = [
    { type: 'node', cls: Node, makeDefault: null, from: () => new CharacterNode('the root') },
    { type: 'character', cls: CharacterNode, makeDefault: null },
    { type: 'controller', cls: ControllerNode, makeDefault: null },
    { type: 'cameraRig', cls: CameraRigNode, makeDefault: null },
    { type: 'navMesh', cls: NavMeshNode, makeDefault: null },
    { type: 'lightProbe', cls: LightProbeNode, makeDefault: null },
    { type: 'sound', cls: SoundNode, makeDefault: async () => new SoundNode('s', { mode: 'spatial' }) },
    { type: 'sprite', cls: SpriteNode, makeDefault: async () => new SpriteNode('s', new Sprite(), 'spherical') },
    { type: 'light', cls: LightNode, makeDefault: async () => new LightNode('l', new DirectionalLight({}), true) },
    { type: 'camera', cls: CameraNode, makeDefault: async () => new CameraNode('c', new Camera({ type: 'perspective' })) },
]

describe('prepareNodeTypeChange + rebuildNodeInPlace', () => {
    for (const { type, cls, makeDefault, from } of CASES) {
        it(`converts into ${type}, keeping id, name, transform and children`, async () => {
            const scene = new Scene()
            const node = from ? from() : new Node('the root')
            scene.addNode(node)
            node.setPosition([1, 2, 3])
            node.setVariable('hp', 7, 'number')
            node.addChild(new Node('kept a'))
            node.addChild(new Node('kept b'))

            const prepared = await prepareNodeTypeChange(node, type as any, makeDefault)
            expect(prepared).not.toBeNull()
            rebuildNodeInPlace(scene, prepared!.after)

            const rebuilt = scene.getNodeById(node.id)!
            expect(rebuilt).toBeInstanceOf(cls)
            expect(rebuilt.nodeType).toBe(type)
            expect(rebuilt.name).toBe('the root')
            expect(rebuilt.position).toEqual(node.position)
            expect(rebuilt.getVariable('hp')).toBe(7)
            expect(rebuilt.children.map(c => c.name)).toEqual(['kept a', 'kept b'])
        })
    }

    it('returns null when the node is already the target type', async () => {
        expect(await prepareNodeTypeChange(new CharacterNode('c'), 'character', null)).toBeNull()
    })

    it('keeps the node in its original slot among its siblings', async () => {
        const scene = new Scene()
        const parent = new Node('parent')
        scene.addNode(parent)
        parent.addChild(new Node('before'))
        const subject = new Node('subject')
        parent.addChild(subject)
        parent.addChild(new Node('after'))

        const prepared = await prepareNodeTypeChange(subject, 'character', null)
        rebuildNodeInPlace(scene, prepared!.after)

        expect(parent.children.map(c => c.name)).toEqual(['before', 'subject', 'after'])
        expect(parent.children[1]).toBeInstanceOf(CharacterNode)
    })

    it('strips editor and debug helper children so they are not re-parsed as user content', async () => {
        const scene = new Scene()
        const node = new Node('the root')
        scene.addNode(node)
        node.addChild(new Node('__editor__LightSprite'))
        node.addChild(new Node('real child'))

        const prepared = await prepareNodeTypeChange(node, 'character', null)
        rebuildNodeInPlace(scene, prepared!.after)

        expect(scene.getNodeById(node.id)!.children.map(c => c.name)).toEqual(['real child'])
    })

    it('round-trips: the before blob restores the original type and payload', async () => {
        const scene = new Scene()
        const light = new LightNode('sun', new DirectionalLight({}), true)
        scene.addNode(light)

        const prepared = await prepareNodeTypeChange(light, 'character', null)
        rebuildNodeInPlace(scene, prepared!.after)
        expect(scene.getNodeById(light.id)).toBeInstanceOf(CharacterNode)

        rebuildNodeInPlace(scene, prepared!.before)
        const restored = scene.getNodeById(light.id)!
        expect(restored).toBeInstanceOf(LightNode)
        expect(await restored.serialize()).toEqual(prepared!.before)
    })

    it('despawns the old node so a converted-away sound stops playing', async () => {
        const scene = new Scene()
        const sound = new SoundNode('emitter', { mode: 'spatial' })
        scene.addNode(sound)
        let despawned = false
        sound.onDespawn = () => { despawned = true }

        const prepared = await prepareNodeTypeChange(sound, 'node', null)
        rebuildNodeInPlace(scene, prepared!.after)

        // reparent=false on the removeChild — with reparent=true (what HistoryContext.restore uses) the
        // sound would keep playing and its timers would stay armed.
        expect(despawned).toBe(true)
    })
})

/**
 * The selector's offer list, checked against what the engine will actually accept.
 *
 * This is the suite that fires when someone adds a node type whose `parse` throws on a payload-less blob
 * and wires it into the catalog with `defaultFrom: null` — which would ship a menu entry that breaks the
 * template root the moment it is picked.
 */
describe('CONVERTIBLE_NODE_TYPES', () => {
    it('offers no UI node and no scene singleton', () => {
        const singletons = ['skybox', 'skyAtmosphere', 'skyLight', 'volumetricClouds', 'landscape', 'tilemap']
        for (const option of CONVERTIBLE_NODE_TYPES) {
            expect(isUINodeType(option.nodeType), option.nodeType).toBe(false)
            expect(singletons, option.nodeType).not.toContain(option.nodeType)
        }
    })

    it('names an add-catalog item that exists, if it names one at all', () => {
        for (const option of CONVERTIBLE_NODE_TYPES)
            if (option.defaultFrom) expect(findAddItem(option.defaultFrom), option.defaultFrom).toBeTruthy()
    })

    it('lists each type once, and labels it', () => {
        const types = CONVERTIBLE_NODE_TYPES.map(o => o.nodeType)
        expect(new Set(types).size).toBe(types.length)
        for (const option of CONVERTIBLE_NODE_TYPES) expect(option.label.length).toBeGreaterThan(0)
    })

    for (const option of CONVERTIBLE_NODE_TYPES.filter(o => !o.defaultFrom)) {
        it(`${option.nodeType} parses from a bare blob, so it needs no default payload`, () => {
            const parent = new Node('parent')
            parseNodeJson(parent, { id: 'x', name: 'bare', type: option.nodeType })
            expect(parent.children[0].nodeType).toBe(option.nodeType)
        })
    }

    for (const type of ['model', 'light', 'camera']) {
        it(`${type} is declared as needing a default payload, because its parse throws without one`, () => {
            expect(findNodeTypeOption(type)?.defaultFrom, type).toBeTruthy()
            expect(() => parseNodeJson(new Node('parent'), { id: 'x', name: 'bare', type })).toThrow()
        })
    }
})

describe('nodeTypeLabel', () => {
    it('uses the catalog label where there is one', () => {
        expect(nodeTypeLabel('node')).toBe('Empty')
        expect(nodeTypeLabel('cameraRig')).toBe('Camera Rig')
    })

    it('falls back to capitalising anything not on the list, matching what the row showed before', () => {
        expect(nodeTypeLabel('skybox')).toBe('Skybox')
        expect(nodeTypeLabel('uiProgressBar')).toBe('UiProgressBar')
    })
})

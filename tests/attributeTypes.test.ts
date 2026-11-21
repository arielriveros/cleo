import { describe, it, expect, vi, afterEach } from 'vitest';
import '../src/cleo';   // registers 'cleo' for scripts, and the asset kinds (src/core/properties/assetKinds.ts)
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { LightNode } from '../src/core/scene/nodes/lightNode';
import { AreaLight } from '../src/graphics/lighting';
import { Material } from '../src/graphics/material';
import { Texture } from '../src/graphics/texture';
import { Sound } from '../src/audio/sound';
import { Tileset } from '../src/graphics/tilemap/tileset';
import { attachScriptFactory } from '../src/core/scene/nodes/nodeScripting';
import { compileScript } from '../src/core/scripting/scriptRuntime';
import { Logger } from '../src/core/logger';
import { TextureManager } from '../src/graphics/systems/textureManager';
import {
    Choice, ListOf, Integer, typeOfToken, typeFromAnnotation, propertyTypeLabel, defaultOf, upgradePropertyType,
} from '../src/core/properties/types';
import { Color, ColorAlpha, Vec2, Vec3, Vec4, ClipName, SceneName, LayerName, ParamName } from '../src/core/scripting/fieldTypes';
import {
    assetRefOf, clearAssetTable, registerAssetResolver, registerAssetTable, resolveAsset, storedValueFits,
} from '../src/core/properties/fieldRefs';
import { nodeAtRelativePath, relativeNodePath } from '../src/core/save/nodePaths';
import { decodeSaveValue, encodeSaveValue } from '../src/core/save/values';

// The native attribute types: one table says what a value is (src/core/properties/types.ts), and a field that
// holds an asset or a node stores a reference the engine turns into the object (fieldRefs.ts).

afterEach(() => { vi.restoreAllMocks(); clearAssetTable(); });

describe('the type table', () => {
    it('reads declaration tokens: built-ins, the named types, and the engine classes', () => {
        expect(typeOfToken(Number)).toEqual({ kind: 'number' });
        expect(typeOfToken(Integer)).toEqual({ kind: 'number', integer: true });
        expect(typeOfToken(Boolean)).toEqual({ kind: 'boolean' });
        expect(typeOfToken(String)).toEqual({ kind: 'string' });
        expect(typeOfToken(Color)).toEqual({ kind: 'color' });
        expect(typeOfToken(ColorAlpha)).toEqual({ kind: 'color', alpha: true });
        expect([Vec2, Vec3, Vec4].map(t => typeOfToken(t))).toEqual([2, 3, 4].map(size => ({ kind: 'vector', size })));
        expect(typeOfToken(ClipName)).toEqual({ kind: 'name', name: 'clip' });
        expect([SceneName, LayerName, ParamName].map(t => (typeOfToken(t) as any).name)).toEqual(['scene', 'layer', 'param']);
        expect(typeOfToken(Choice(['rect', 'disk']))).toEqual({ kind: 'choice', values: ['rect', 'disk'] });
        expect(typeOfToken(ListOf(Texture))).toEqual({ kind: 'list', of: { kind: 'asset', asset: 'texture' } });
        expect(typeOfToken(Material)).toEqual({ kind: 'asset', asset: 'material' });
        expect(typeOfToken(Sound)).toEqual({ kind: 'asset', asset: 'sound' });
        expect(typeOfToken(Tileset)).toEqual({ kind: 'asset', asset: 'tileset' });
        expect(typeOfToken(Node)).toEqual({ kind: 'node', className: 'Node' });
        expect(typeOfToken(LightNode)).toEqual({ kind: 'node', className: 'LightNode' });
        expect(typeOfToken(Date)).toBeNull();
    });

    it('reads the same types from a script annotation', () => {
        expect(typeFromAnnotation('Color')).toEqual({ kind: 'color' });
        expect(typeFromAnnotation('Material | null')).toEqual({ kind: 'asset', asset: 'material' });
        expect(typeFromAnnotation('LightNode')).toEqual({ kind: 'node', className: 'LightNode' });
        expect(typeFromAnnotation('Texture[]')).toEqual({ kind: 'list', of: { kind: 'asset', asset: 'texture' } });
        expect(typeFromAnnotation('Door', null, { scriptClass: n => n === 'Door' })).toEqual({ kind: 'node', className: 'Door', script: true });
        expect(typeFromAnnotation('', [1, 2])).toEqual({ kind: 'vector', size: 2 });
    });

    it('writes each type the way a script spells it, and starts each from a sensible value', () => {
        expect(['Color', 'ColorAlpha', 'Vec3', 'Material', 'LightNode', 'ClipName[]', 'SceneName']
            .map(a => propertyTypeLabel(typeFromAnnotation(a)))).toEqual(['Color', 'ColorAlpha', 'Vec3', 'Material', 'LightNode', 'ClipName[]', 'SceneName']);
        expect(propertyTypeLabel({ kind: 'choice', values: ['a', 'b'] })).toBe(`'a' | 'b'`);
        expect(defaultOf({ kind: 'color' })).toEqual([1, 1, 1]);
        expect(defaultOf({ kind: 'asset', asset: 'material' })).toBeNull();
        expect(defaultOf({ kind: 'vector', size: 2 })).toEqual([0, 0]);
    });

    it('reads a schema stored before the property types as what it meant', () => {
        expect(upgradePropertyType('vec3', { color: true })).toEqual({ kind: 'color' });
        expect(upgradePropertyType('stringList', { pick: 'clip' })).toEqual({ kind: 'list', of: { kind: 'name', name: 'clip' } });
        expect(upgradePropertyType({ kind: 'boolean' })).toEqual({ kind: 'boolean' });
    });

    it('knows which stored values a type can hold', () => {
        expect(storedValueFits({ kind: 'asset', asset: 'material' }, { $asset: 'material', id: 'm' })).toBe(true);
        expect(storedValueFits({ kind: 'asset', asset: 'material' }, { $asset: 'texture', id: 'm' })).toBe(false);
        expect(storedValueFits({ kind: 'asset', asset: 'material' }, 'Brick')).toBe(false);
        expect(storedValueFits({ kind: 'color' }, [1, 0, 0])).toBe(true);
        expect(storedValueFits({ kind: 'color', alpha: true }, [1, 0, 0])).toBe(false);
        expect(storedValueFits({ kind: 'node', className: 'Node' }, { $nodePath: '..' })).toBe(true);
    });
});

describe('relative node paths', () => {
    const tree = () => {
        const root = new Node('root');
        const a = new Node('A'); const b = new Node('B'); const torch1 = new Node('Torch'); const torch2 = new Node('Torch');
        root.addChild(a); root.addChild(b); b.addChild(torch1); b.addChild(torch2);
        return { root, a, b, torch1, torch2 };
    };

    it('goes up to the common ancestor and down, telling namesakes apart', () => {
        const { root, a, b, torch2 } = tree();
        expect(relativeNodePath(a, torch2)).toBe('../B/Torch#1');
        expect(relativeNodePath(torch2, a)).toBe('../../A');
        expect(relativeNodePath(b, torch2)).toBe('Torch#1');
        expect(relativeNodePath(a, a)).toBe('.');
        expect(relativeNodePath(a, root)).toBe('..');
        expect(relativeNodePath(a, new Node('elsewhere'))).toBeNull();
    });

    it('leads back to the same node, in a copy of the tree too', () => {
        const one = tree();
        const two = tree();
        const path = relativeNodePath(one.a, one.torch2)!;
        expect(nodeAtRelativePath(one.a, path)).toBe(one.torch2);
        expect(nodeAtRelativePath(two.a, path)).toBe(two.torch2);
        expect(nodeAtRelativePath(two.a, '../Gone')).toBeNull();
    });
});

/** A scripted node under `parent`, its stored field values set as a scene parse sets them. */
function scripted(source: string, vars: Record<string, unknown>, parent: Node, name = 'subject'): any {
    const node = new Node(name);
    parent.addChild(node);
    (Node as any)._parseScriptVars(node, vars);
    attachScriptFactory(node, compileScript(source));
    return node;
}

const HEAD = `import { Node, Material, LightNode } from 'cleo'\nimport { attribute } from 'cleo/decorators'\n`;

describe('asset fields', () => {
    const red = () => ({ ...Material.parse({}).serialize(), name: 'Red' });

    it('hold the engine object, from the one asset table, shared by every field naming it', () => {
        registerAssetTable({ materials: { m1: red() } });
        const scene = new Scene();
        const src = `${HEAD}export default class A extends Node {
            @attribute skin: Material = null
            @attribute spare: Material[] = []
            seen: any = null
            onStart() { this.seen = this.skin }
        }`;
        const a = scripted(src, { skin: { $asset: 'material', id: 'm1' }, spare: [{ $asset: 'material', id: 'm1' }] }, scene.root, 'a');
        const b = scripted(src, { skin: { $asset: 'material', id: 'm1' } }, scene.root, 'b');
        scene.start();
        expect(a.skin).toBeInstanceOf(Material);
        expect(a.seen).toBe(a.skin);
        expect(b.skin).toBe(a.skin);
        expect(a.spare[0]).toBe(a.skin);
        expect(assetRefOf(a.skin)).toEqual({ $asset: 'material', id: 'm1' });
    });

    it('parse each table entry once, and again only when the game hands over a different one', () => {
        const first = red();
        const second = red();
        const parse = vi.spyOn(Material, 'parse');
        registerAssetTable({ materials: { m1: first } });
        const one = resolveAsset('material', 'm1');
        expect(resolveAsset('material', 'm1')).toBe(one);
        registerAssetTable({ materials: { m1: first } });
        expect(resolveAsset('material', 'm1')).toBe(one);
        registerAssetTable({ materials: { m1: second } });
        expect(resolveAsset('material', 'm1')).not.toBe(one);
        expect(parse).toHaveBeenCalledTimes(2);
    });

    it('stay empty, said once, when the game has no such asset', () => {
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        const scene = new Scene();
        const src = `${HEAD}export default class A extends Node { @attribute skin: Material = null }`;
        const a = scripted(src, { skin: { $asset: 'material', id: 'gone' } }, scene.root);
        scene.start();
        expect(a.skin).toBeNull();
        expect(warn.mock.calls.filter(c => String(c[0]).includes("'gone'"))).toHaveLength(1);
    });

    it('find textures and sounds by id, through their managers', () => {
        const fake = {} as object;
        registerAssetResolver('texture', id => (id === 't1' ? fake : undefined));
        try {
            expect(resolveAsset('texture', 't1')).toBe(fake);
            expect(resolveAsset('texture', 't2')).toBeNull();
        } finally {
            registerAssetResolver('texture', id => TextureManager.Instance.getTexture(id));
        }
    });

    it('are kept by saves as the reference they came from', () => {
        registerAssetTable({ materials: { m1: red() } });
        const mat = resolveAsset('material', 'm1')!;
        const enc = encodeSaveValue({ skin: mat }, 'f', { warn: () => {}, pathOf: () => null });
        expect(enc).toEqual({ skin: { $asset: 'material', id: 'm1' } });
        expect((decodeSaveValue(enc) as any).skin).toBe(mat);
    });
});

describe('node fields', () => {
    it('hold the node their path leads to, before onConstruct and onStart run', () => {
        const scene = new Scene();
        const lamp = new LightNode('Lamp', new AreaLight());
        scene.root.addChild(lamp);
        const holder = new Node('Holder');
        scene.root.addChild(holder);
        const a = scripted(`${HEAD}export default class A extends Node {
            @attribute lamp: LightNode = null
            atConstruct: any = 'unset'
            onConstruct() { this.atConstruct = this.lamp }
        }`, { lamp: { $nodePath: '../../Lamp' } }, holder);
        scene.start();
        expect(a.lamp).toBe(lamp);
        expect(a.atConstruct).toBe(lamp);
    });

    it('find what was spawned before onStart, and report what is still missing once, unless declared optional', () => {
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        const scene = new Scene();
        const src = `${HEAD}export default class A extends Node {
            @attribute target: Node = null
            @attribute maybe?: Node = null
            onConstruct() { if (!this.target) { const n = new Node('Late'); this.parent.addChild(n) } }
        }`;
        const a = scripted(src, { target: { $nodePath: '../Late' }, maybe: { $nodePath: '../Never' } }, scene.root);
        scene.start();
        expect(a.target?.name).toBe('Late');
        expect(a.maybe).toBeNull();
        expect(warn.mock.calls.filter(c => String(c[0]).includes('Never'))).toHaveLength(0);

        const other = new Scene();
        const b = scripted(`${HEAD}export default class B extends Node { @attribute target: Node = null }`, { target: { $nodePath: '../Nowhere' } }, other.root, 'b');
        other.start();
        expect(b.target).toBeNull();
        expect(warn.mock.calls.filter(c => String(c[0]).includes('Nowhere'))).toHaveLength(1);
    });

    it('leave a field the script set itself alone', () => {
        const scene = new Scene();
        const mine = new Node('Mine');
        scene.root.addChild(mine);
        const a = scripted(`${HEAD}export default class A extends Node {
            @attribute target: Node = null
            onConstruct() { this.target = this.parent.getChildByName('Mine')[0] }
        }`, { target: { $nodePath: '../Missing' } }, scene.root);
        scene.start();
        expect(a.target).toBe(mine);
    });

    it("stay the stored path on a node whose script never attached (the editor's), its scene started or not", () => {
        // The editor's scene starts, but its nodes never run their scripts. Resolved there, the Sandbox's Game
        // Manager held null for its sun (the Environment template's children come in later) and Play got that.
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        const scene = new Scene();
        const lamp = new LightNode('Lamp', new AreaLight());
        scene.root.addChild(lamp);
        const node = new Node('Game Manager');
        scene.root.addChild(node);
        (Node as any)._parseScriptVars(node, { sun: { $nodePath: '../Lamp' }, gone: { $nodePath: '../Later' } });
        scene.start();
        expect((node as any).sun).toEqual({ $nodePath: '../Lamp' });
        expect((node as any).gone).toEqual({ $nodePath: '../Later' });
        expect(warn.mock.calls.filter(c => String(c[0]).includes('Later'))).toHaveLength(0);
    });
});

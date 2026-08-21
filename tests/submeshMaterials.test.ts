import { describe, it, expect, vi } from 'vitest';

// A model merged at import carries one material per SUBMESH — an index range of one shared mesh — linked
// to a material asset each. The link list is `__materialIds` (a JSON string, because node variables have
// no array type) with `__materialId` mirroring entry [0] so unconverted readers keep working.
//
// Both bugs this file pins came from that mirror being read INSTEAD of the list:
//   - clearing one slot called the whole-node unlink and reset every submesh;
//   - the post-save propagation matched on the scalar, so an edit to a second submesh's material matched
//     no node at all and silently did nothing.
//
// `cleo` is mocked because these helpers only need Material.parse/Basic and a node-shaped object — pulling
// in the real barrel would want a GL context.

vi.mock('cleo', () => ({
  Material: {
    parse: (m: any) => ({ ...m, __parsed: true }),
    Basic: (opts: any) => ({ type: 'basic', ...opts, __fallback: true }),
  },
  TextureManager: { Instance: { getTexture: () => null, addTextureFromBase64: () => {} } },
  Node: class {},
}));

const {
  MATERIAL_ID_VAR, MATERIAL_IDS_VAR, getMaterialIdsOf, applyMaterialAsset,
  unlinkToFallback, unlinkMaterialAt, materialSlotsReferencing, resolveMaterialRefs,
} = await import('../editor/src/utils/materials');

/**
 * A stand-in for a ModelNode: the variable bag plus a live `model` whose `material` is an alias for
 * `materials[0]` — which is exactly how `Model` defines it, and what makes writing slot 0 and writing
 * `material` the same operation.
 */
function fakeNode(materialCount: number) {
  const vars = new Map<string, any>();
  const materials = Array.from({ length: materialCount }, (_, i) => ({ type: 'pbr', slot: i })) as any[];
  return {
    nodeType: 'model',
    model: {
      materials,
      get material() { return materials[0] },
      set material(m: any) { materials[0] = m },
    },
    getVariable: (name: string) => vars.get(name),
    setVariable: (name: string, value: any) => { vars.set(name, value) },
    removeVariable: (name: string) => { vars.delete(name) },
  } as any;
}

const asset = (id: string) => ({ id, name: id, material: { type: 'pbr', tag: id }, thumbnail: '' }) as any;

function linkTwo(node: any) {
  applyMaterialAsset(node, asset('mat-a'), 0);
  applyMaterialAsset(node, asset('mat-b'), 1);
}

describe('per-submesh material links', () => {
  it('stores one id per submesh and keeps the scalar mirroring entry [0]', () => {
    const node = fakeNode(2);
    linkTwo(node);
    expect(getMaterialIdsOf(node)).toEqual(['mat-a', 'mat-b']);
    // Everything not yet converted to the list reads the scalar, so the mirror is load-bearing.
    expect(node.getVariable(MATERIAL_ID_VAR)).toBe('mat-a');
    expect(JSON.parse(node.getVariable(MATERIAL_IDS_VAR))).toEqual(['mat-a', 'mat-b']);
  });

  it('writes the material into the slot it was given, not slot 0', () => {
    const node = fakeNode(2);
    linkTwo(node);
    expect(node.model.materials[0].tag).toBe('mat-a');
    expect(node.model.materials[1].tag).toBe('mat-b');
  });

  it('leaves an unmerged model with no list variable at all', () => {
    const node = fakeNode(1);
    applyMaterialAsset(node, asset('only'), 0);
    expect(node.getVariable(MATERIAL_ID_VAR)).toBe('only');
    expect(node.getVariable(MATERIAL_IDS_VAR)).toBeUndefined();
    expect(getMaterialIdsOf(node)).toEqual(['only']);
  });
});

describe('materialSlotsReferencing — which submeshes use an asset', () => {
  it('finds a link at a slot ABOVE zero', () => {
    // The scalar `__materialId` is 'mat-a' here, so the old `getMaterialIdOf(n) === id` test matched
    // nothing for 'mat-b' — which is exactly why editing the second submesh's material did nothing.
    const node = fakeNode(2);
    linkTwo(node);
    expect(materialSlotsReferencing(node, 'mat-b')).toEqual([1]);
    expect(node.getVariable(MATERIAL_ID_VAR)).not.toBe('mat-b');
  });

  it('finds every slot when one asset is used twice', () => {
    const node = fakeNode(3);
    applyMaterialAsset(node, asset('shared'), 0);
    applyMaterialAsset(node, asset('other'), 1);
    applyMaterialAsset(node, asset('shared'), 2);
    expect(materialSlotsReferencing(node, 'shared')).toEqual([0, 2]);
  });

  it('returns nothing for an unrelated asset, and for a node with no links', () => {
    const node = fakeNode(2);
    linkTwo(node);
    expect(materialSlotsReferencing(node, 'nope')).toEqual([]);
    expect(materialSlotsReferencing(fakeNode(2), 'mat-a')).toEqual([]);
  });
});

describe('unlinkMaterialAt — clearing ONE slot', () => {
  it('clears the given slot and leaves the others linked', () => {
    const node = fakeNode(2);
    linkTwo(node);
    unlinkMaterialAt(node, 1);

    expect(getMaterialIdsOf(node)).toEqual(['mat-a', undefined]);
    expect(node.model.materials[1].__fallback).toBe(true);
    // The whole point: slot 0 is untouched, both its material and its link.
    expect(node.model.materials[0].tag).toBe('mat-a');
    expect(node.getVariable(MATERIAL_ID_VAR)).toBe('mat-a');
  });

  it('clearing slot 0 drops the scalar mirror but keeps the rest of the list', () => {
    const node = fakeNode(2);
    linkTwo(node);
    unlinkMaterialAt(node, 0);

    expect(node.getVariable(MATERIAL_ID_VAR)).toBeUndefined();
    expect(getMaterialIdsOf(node)).toEqual([undefined, 'mat-b']);
    expect(node.model.materials[0].__fallback).toBe(true);
    expect(node.model.materials[1].tag).toBe('mat-b');
  });

  it('drops both variables once nothing is left linked', () => {
    const node = fakeNode(2);
    linkTwo(node);
    unlinkMaterialAt(node, 0);
    unlinkMaterialAt(node, 1);
    expect(node.getVariable(MATERIAL_ID_VAR)).toBeUndefined();
    expect(node.getVariable(MATERIAL_IDS_VAR)).toBeUndefined();
    expect(getMaterialIdsOf(node)).toEqual([]);
  });

  it('behaves exactly like the whole-node unlink for a single-material model', () => {
    const node = fakeNode(1);
    applyMaterialAsset(node, asset('only'), 0);
    unlinkMaterialAt(node, 0);
    expect(node.getVariable(MATERIAL_ID_VAR)).toBeUndefined();
    expect(node.model.materials[0].__fallback).toBe(true);
  });

  it('unlinkToFallback still clears EVERY slot — that is its job', () => {
    const node = fakeNode(2);
    linkTwo(node);
    unlinkToFallback(node);
    expect(node.model.materials.every((m: any) => m.__fallback)).toBe(true);
    expect(getMaterialIdsOf(node)).toEqual([]);
  });
});

describe('resolveMaterialRefs — instantiating a merged model', () => {
  const libs = [asset('mat-a'), asset('mat-b')];

  const jsonNode = (over: any = {}) => ({
    variables: {
      [MATERIAL_ID_VAR]: { type: 'string', value: 'mat-a' },
      [MATERIAL_IDS_VAR]: { type: 'string', value: JSON.stringify(['mat-a', 'mat-b']) },
    },
    model: { materials: [{ type: 'stale' }, { type: 'stale' }], material: { type: 'stale' } },
    children: [],
    ...over,
  });

  it('resolves every slot from the list, and keeps material == materials[0]', () => {
    const json = jsonNode();
    resolveMaterialRefs(json, libs as any);
    expect(json.model.materials[0].tag).toBe('mat-a');
    expect(json.model.materials[1].tag).toBe('mat-b');
    expect(json.model.material).toBe(json.model.materials[0]);
  });

  it('resolves through children', () => {
    const parent = { variables: {}, children: [jsonNode()] } as any;
    resolveMaterialRefs(parent, libs as any);
    expect(parent.children[0].model.materials[1].tag).toBe('mat-b');
  });

  it('falls back to the single link when the serialized model has no materials array', () => {
    // Model.serialize omits `materials` unless there is more than one submesh, so this shape is normal.
    const json = jsonNode({ model: { material: { type: 'stale' } } });
    expect(() => resolveMaterialRefs(json, libs as any)).not.toThrow();
    expect((json.model as any).material.tag).toBe('mat-a');
  });

  it('leaves the embedded copies alone when the list is corrupt', () => {
    const json = jsonNode();
    json.variables[MATERIAL_IDS_VAR] = { type: 'string', value: '{not json' };
    resolveMaterialRefs(json, libs as any);
    expect(json.model.materials[0].tag).toBe('mat-a');   // the single link still resolves
    expect(json.model.materials[1].type).toBe('stale');  // the rest stand rather than being dropped
  });

  it('skips an id whose asset was deleted, without disturbing the others', () => {
    const json = jsonNode();
    json.variables[MATERIAL_IDS_VAR] = { type: 'string', value: JSON.stringify(['mat-a', 'gone']) };
    resolveMaterialRefs(json, libs as any);
    expect(json.model.materials[0].tag).toBe('mat-a');
    expect(json.model.materials[1].type).toBe('stale');
  });
});

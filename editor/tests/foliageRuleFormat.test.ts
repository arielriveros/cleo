import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { TerrainMaterial, setGLContext, setDevice, WebGL2Device } from 'cleo';

// A foliage rule's baked prototype meshes are a DERIVED CACHE of the model asset it references, and are
// no longer persisted. Storing them put a full copy of every tree in every terrain material that
// scattered it, plus a second copy in every scene blob that used one — which is what exhausted the editor
// on save. These pin the contract: nothing geometric is written when a rule can be rebuilt, a rule that
// cannot be rebuilt keeps carrying its own geometry, and anything saved before this still loads.

const { registerFoliageSourceResolver, resolveFoliageRuleGeometry, buildFoliageRuleFromModelAsset } = await import('../src/utils/foliageRules');

const meshRule = (over: any = {}) => ({
  kind: 'mesh',
  id: 'rule-1',
  name: 'Oak',
  modelId: 'oak-model',
  density: 0.05,
  densityUnit: 'm2',
  minScale: 0.8,
  maxScale: 1.4,
  collision: null,
  billboard: null,
  ...over,
});

const bakedGeometry = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  tangents: new Float32Array(9),
  bitangents: new Float32Array(9),
  texCoords: new Float32Array([0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
});

const serializedRules = (rules: any[]) => {
  const tm = TerrainMaterial.Create('pbr', {});
  tm.foliageInclude = rules as any;
  return tm.serialize().foliageInclude;
};

/**
 * Resolving a rule re-parses the model subtree, and `Mesh` allocates a VAO and buffers in its
 * constructor — so even a test that never draws needs a device. Same stub as tests/submeshRoundTrip in
 * the engine suite: unknown members resolve to a no-op rather than being enumerated.
 */
beforeAll(() => {
  let n = 0;
  const constants: Record<string, number> = {
    UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
  };
  const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
  const gl = new Proxy({}, {
    get: (_t, key: string) => (key in constants ? constants[key]
      : objects.has(key) ? () => ({ id: ++n })
      : () => undefined),
  });
  setGLContext(gl as any);
  setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

beforeEach(() => registerFoliageSourceResolver(null));

describe('what a rule persists', () => {
  it('drops the baked geometry of a rule that names a model', () => {
    const [out] = serializedRules([meshRule({ models: [{ geometry: bakedGeometry() }], lods: [{ models: [], distance: 30 }] })]);
    expect(out.models).toBeUndefined();
    expect(out.model).toBeUndefined();
    expect(out.lods).toBeUndefined();
  });

  it('keeps everything that was AUTHORED rather than derived', () => {
    const [out] = serializedRules([meshRule({ models: [{ geometry: bakedGeometry() }], cullDistance: 90, castShadows: true })]);
    expect(out.modelId).toBe('oak-model');
    expect(out.name).toBe('Oak');
    expect(out.density).toBe(0.05);
    expect(out.minScale).toBe(0.8);
    expect(out.cullDistance).toBe(90);
    expect(out.castShadows).toBe(true);
    expect(out.densityUnit).toBe('m2');
  });

  it('KEEPS the geometry of a rule with no model to rebuild from', () => {
    // Nothing could restore this one, so dropping it would destroy the prototype outright.
    const orphan = meshRule({ modelId: undefined, models: [{ geometry: bakedGeometry() }] });
    const [out] = serializedRules([orphan]);
    expect(out.models).toHaveLength(1);
  });

  it('leaves a billboard rule alone', () => {
    const [out] = serializedRules([{ kind: 'billboard', id: 'g', name: 'Grass', textureId: 'tex', density: 2 }]);
    expect(out.kind).toBe('billboard');
    expect(out.textureId).toBe('tex');
  });

  it('does not mutate the live material it serialized', () => {
    // The live rule still needs its prototypes; only the PERSISTED copy goes without.
    const rule = meshRule({ models: [{ geometry: bakedGeometry() }] });
    serializedRules([rule]);
    expect(rule.models).toHaveLength(1);
  });
});

describe('resolveFoliageRuleGeometry', () => {
  const modelAsset = {
    id: 'oak-model',
    name: 'Oak',
    // `type` is the discriminator parseByType dispatches on — without it the subtree parses as a plain
    // Node, the walk finds no ModelNode, and nothing is baked.
    nodeJson: { id: 'oak-root', type: 'model', name: 'oak', model: { geometry: bakedGeometry(), material: { type: 'pbr' } }, children: [] },
    materialIds: [],
    thumbnail: '',
  } as any;

  it('rebuilds a stripped rule from the library', () => {
    registerFoliageSourceResolver(() => ({ model: modelAsset, library: [modelAsset], materials: [] }));
    const rule = meshRule();
    resolveFoliageRuleGeometry(rule);
    expect((rule as any).models).toHaveLength(1);
    expect((rule as any).models[0].geometry.positions).toBeInstanceOf(Float32Array);
  });

  it('produces FLAT typed arrays, not one array object per vertex', () => {
    // The whole point: the old shape was 5 JS arrays per vertex, ~4x the memory and a million objects.
    registerFoliageSourceResolver(() => ({ model: modelAsset, library: [modelAsset], materials: [] }));
    const rule = meshRule();
    resolveFoliageRuleGeometry(rule);
    const g = (rule as any).models[0].geometry;
    expect(g.positions).toBeInstanceOf(Float32Array);
    expect(g.normals).toBeInstanceOf(Float32Array);
    expect(g.texCoords).toBeInstanceOf(Float32Array);
    expect(g.indices).toBeInstanceOf(Uint32Array);
    expect(g.positions.length).toBe(9);
  });

  it('leaves a legacy rule that still embeds its geometry untouched', () => {
    // Everything saved before this, and the shipped example projects.
    registerFoliageSourceResolver(() => ({ model: modelAsset, library: [modelAsset], materials: [] }));
    const legacy = meshRule({ models: [{ geometry: { positions: [[0, 0, 0]] } }] });
    resolveFoliageRuleGeometry(legacy);
    expect((legacy as any).models[0].geometry.positions).toEqual([[0, 0, 0]]);
  });

  it('leaves the rule alone when the model was deleted', () => {
    registerFoliageSourceResolver(() => null);
    const rule = meshRule();
    resolveFoliageRuleGeometry(rule);
    expect((rule as any).models).toBeUndefined();
  });

  it('leaves the rule alone when no resolver is registered', () => {
    const rule = meshRule();
    resolveFoliageRuleGeometry(rule);
    expect((rule as any).models).toBeUndefined();
  });

  it('ignores a billboard rule', () => {
    registerFoliageSourceResolver(() => ({ model: modelAsset, library: [modelAsset], materials: [] }));
    const billboard = { kind: 'billboard', name: 'Grass', textureId: 'tex' } as any;
    resolveFoliageRuleGeometry(billboard);
    expect(billboard.models).toBeUndefined();
  });

  it('reads the pre-rename meshId spelling', () => {
    registerFoliageSourceResolver((id) => (id === 'oak-model' ? { model: modelAsset, library: [modelAsset], materials: [] } : null));
    const rule = meshRule({ modelId: undefined, meshId: 'oak-model' });
    resolveFoliageRuleGeometry(rule);
    expect((rule as any).models).toHaveLength(1);
  });
});

/**
 * Building a rule FROM a model asset, which is what the terrain-material inspector does when you add a
 * foliage prop or press re-sync.
 *
 * A LOD level is a REFERENCE to another model asset, so `resolvedLods` needs the library to find one.
 * Called without it, every level resolved to null and the rule came out with no `lods` at all: the
 * foliage layer then had a single detail level, the renderer skipped its per-cell LOD band entirely,
 * and every visible cell drew LOD0 at every distance. No error, and the inspector reported "1 LOD
 * level" — so generating LOD levels appeared to do nothing.
 *
 * `castShadows` is the other half: it is authored on the RULE, not derived from the asset, so a rebuild
 * that forgets to carry it silently clears the inspector's own checkbox.
 */
describe('buildFoliageRuleFromModelAsset', () => {
  const subtree = (name: string) => ({
    id: `${name}-root`, type: 'model', name,
    model: { geometry: bakedGeometry(), material: { type: 'pbr' } },
    children: [],
  });
  const asset = (id: string, over: any = {}) =>
    ({ id, name: id, nodeJson: subtree(id), materialIds: [], thumbnail: '', ...over }) as any;

  const lod1 = asset('oak-lod1');
  const lod2 = asset('oak-lod2');
  const oak = asset('oak-model', {
    lods: [{ modelId: lod1.id, distance: 25 }, { modelId: lod2.id, distance: 70 }],
    cullDistance: 120,
  });
  const library = [oak, lod1, lod2];

  it('resolves every LOD level when handed the library', () => {
    const rule = buildFoliageRuleFromModelAsset(oak, undefined, library, []);
    expect(rule.lods).toHaveLength(2);
    expect(rule.lods!.map(l => l.distance)).toEqual([25, 70]);
    expect(rule.lods!.every(l => l.models.length > 0)).toBe(true);
  });

  it('resolves NOTHING without it — the bug this exists to pin', () => {
    // The two arguments are optional in the signature, so omitting them typechecked and ran; the only
    // symptom was foliage that never coarsened with distance.
    expect(buildFoliageRuleFromModelAsset(oak).lods).toBeUndefined();
  });

  it('carries the asset cull distance onto the rule', () => {
    expect(buildFoliageRuleFromModelAsset(oak, undefined, library, []).cullDistance).toBe(120);
  });

  it('drops a level whose model asset is gone, keeping the rest aligned', () => {
    const partial = buildFoliageRuleFromModelAsset(oak, undefined, [oak, lod2], []);
    expect(partial.lods).toHaveLength(1);
    expect(partial.lods![0].distance).toBe(70);
  });

  it('preserves the fields authored on the rule rather than on the asset', () => {
    const existing = {
      id: 'RULE', name: 'Oak (painted)', density: 0.02, minScale: 0.5, maxScale: 2,
      castShadows: true, billboard: { textureId: 'imp', distance: 80 }, collision: { shape: 'capsule' },
    } as any;
    const rule = buildFoliageRuleFromModelAsset(oak, existing, library, []);
    expect(rule.id).toBe('RULE');
    expect(rule.name).toBe('Oak (painted)');
    expect(rule.density).toBe(0.02);
    expect(rule.minScale).toBe(0.5);
    expect(rule.maxScale).toBe(2);
    // Re-sync used to clear this one: it was simply absent from the returned object.
    expect(rule.castShadows).toBe(true);
    expect(rule.billboard).toEqual({ textureId: 'imp', distance: 80 });
    expect(rule.collision).toEqual({ shape: 'capsule' });
  });

  it('links the rule to the source asset so a model save can refresh it', () => {
    expect(buildFoliageRuleFromModelAsset(oak, undefined, library, []).modelId).toBe('oak-model');
  });
});

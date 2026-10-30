import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'cleo/graphics/utils/gltfLoader';
import { fnv1a } from '../src/core/generator';
import { inflateIdat } from '../src/core/png';
import { bakeImpostor, buildFoliage, encodeFoliage, levelStats, summarize, type FoliageModel } from '../src/foliage/buildFoliage';
import { exportFoliage } from '../src/foliage/exportFoliage';
import { DEFAULT_DOC, FOLIAGE_SCHEMAS, normaliseFoliage, type FoliageDoc, type FoliageKind } from '../src/foliage/foliageParams';
import { FOLIAGE_PRESETS } from '../src/foliage/foliagePresets';
import { barkTextures } from '../src/foliage/textures/bark';
import { buildSkeleton } from '../src/foliage/tree/skeleton';

// Small textures and a modest rock, so the suite stays fast; every code path still runs.
function doc(kind: FoliageKind, patch: Partial<FoliageDoc> = {}): FoliageDoc {
  const d = normaliseFoliage({ ...DEFAULT_DOC, kind, name: kind, ...patch });
  d.grass.textureSize = 128;
  d.rock = { ...d.rock, textureSize: 128, detail: 4, triangles: 800 };
  d.tree = { ...d.tree, barkTextureSize: 128, leafTextureSize: 128 };
  return d;
}

const hashModel = (m: FoliageModel) => fnv1a(new Uint8Array(m.levels.flatMap(l => l.parts.flatMap(p => [
  ...new Uint8Array(p.buffers.positions.buffer), ...new Uint8Array(p.buffers.indices.buffer)]))));

function expectValidLevels(m: FoliageModel) {
  for (const [li, level] of m.levels.entries()) {
    for (const part of level.parts) {
      const { positions, normals, uvs, indices } = part.buffers;
      const n = positions.length / 3;
      expect(normals.length, `${m.kind} LOD${li} ${part.name} normals`).toBe(n * 3);
      expect(uvs.length, `${m.kind} LOD${li} ${part.name} uvs`).toBe(n * 2);
      expect(indices.length % 3).toBe(0);
      expect(positions.every(Number.isFinite), `${m.kind} LOD${li} ${part.name} positions finite`).toBe(true);
      expect(normals.every(Number.isFinite)).toBe(true);
      expect(uvs.every(Number.isFinite)).toBe(true);
      for (const i of indices) expect(i).toBeLessThan(n);
    }
  }
}

describe('Foliage Creator generation', () => {
  for (const kind of ['grass', 'rock', 'tree'] as const) {
    it(`builds a ${kind}: valid buffers, LODs that get cheaper`, () => {
      const m = buildFoliage(doc(kind));
      expect(m.levels).toHaveLength(3);
      expectValidLevels(m);
      const stats = levelStats(m);
      expect(stats[0].triangles).toBeGreaterThan(0);
      expect(stats[1].triangles, `${kind} LOD1 < LOD0`).toBeLessThan(stats[0].triangles);
      expect(stats[2].triangles, `${kind} LOD2 < LOD1`).toBeLessThan(stats[1].triangles);
      // Distances ascend.
      expect(m.levels[1].distance).toBeGreaterThan(m.levels[0].distance);
      expect(m.levels[2].distance).toBeGreaterThan(m.levels[1].distance);
      expect(m.cullDistance).toBeGreaterThan(m.levels[2].distance);
    });

    it(`is a deterministic function of the ${kind} document and its seed`, () => {
      const a = buildFoliage(doc(kind)), b = buildFoliage(doc(kind));
      expect(hashModel(a)).toBe(hashModel(b));
      expect(hashModel(buildFoliage(doc(kind, { seed: 7 })))).not.toBe(hashModel(a));
    });
  }

  it('keeps a tree\'s trunk and branches when only its leaves change', () => {
    const base = doc('tree');
    const a = buildSkeleton(base.seed, base.tree);
    const b = buildSkeleton(base.seed, { ...base.tree, leafSize: base.tree.leafSize * 1.5, leavesPerBranch: 4 });
    expect(b.stems.map(s => s.points)).toEqual(a.stems.map(s => s.points));
  });

  it('keeps the first branches when a later level changes (keyed random streams)', () => {
    const base = doc('tree');
    const a = buildSkeleton(base.seed, base.tree);
    const b = buildSkeleton(base.seed, { ...base.tree, branches2: base.tree.branches2 + 3 });
    const level1 = (s: ReturnType<typeof buildSkeleton>) => s.stems.filter(x => x.level <= 1).map(x => x.points);
    expect(level1(b)).toEqual(level1(a));
  });

  it('builds every preset within a sane triangle budget', () => {
    for (const preset of FOLIAGE_PRESETS) {
      const d = doc(preset.kind, {});
      (d as any)[preset.kind] = { ...(d as any)[preset.kind], ...preset.params, textureSize: 128, barkTextureSize: 128, leafTextureSize: 128 };
      if (preset.kind === 'rock') d.rock.detail = Math.min(d.rock.detail, 4);
      const m = buildFoliage(d);
      expectValidLevels(m);
      const lod0 = levelStats(m)[0].triangles;
      expect(lod0, preset.id).toBeGreaterThan(0);
      expect(lod0, `${preset.id} LOD0 budget`).toBeLessThan(40000);
    }
  });

  it('draws schemas whose keys exist on the records', () => {
    const d = normaliseFoliage(DEFAULT_DOC);
    for (const kind of ['grass', 'rock', 'tree'] as const)
      for (const group of FOLIAGE_SCHEMAS[kind])
        for (const spec of group.specs) expect(spec.key in d[kind], `${kind}.${spec.key}`).toBe(true);
  });

  it('clamps a hostile document', () => {
    const d = normaliseFoliage({ kind: 'tree', tree: { branches1: 1e9, levels: 99, leafTextureSize: 3 } as any });
    expect(d.tree.branches1).toBe(120);
    expect(d.tree.levels).toBe(3);
    expect(d.tree.leafTextureSize).toBe(512);
  });
});

describe('Foliage textures', () => {
  it('bark tiles: the first and last columns and rows continue each other', () => {
    const { albedo } = barkTextures(3, 64, 'furrowed', [0.3, 0.2, 0.1, 1]);
    const at = (x: number, y: number) => albedo.data[(y * 64 + x) * 4 + 1];
    let edgeDiff = 0, innerDiff = 0;
    for (let y = 0; y < 64; y++) { edgeDiff += Math.abs(at(63, y) - at(0, y)); innerDiff += Math.abs(at(31, y) - at(32, y)); }
    // Across the wrap seam the texture changes no more than between any two neighbouring columns.
    expect(edgeDiff).toBeLessThan(innerDiff * 3 + 64 * 4);
  });

  it('leaf cards have a cutout and colour under it', () => {
    const m = buildFoliage(doc('tree'));
    const leaves = m.textures.leaves!;
    let opaque = 0, clear = 0, blackClear = 0;
    for (let i = 0; i < leaves.width * leaves.height; i++) {
      const a = leaves.data[i * 4 + 3];
      if (a >= 128) opaque++;
      else { clear++; if (leaves.data[i * 4] + leaves.data[i * 4 + 1] + leaves.data[i * 4 + 2] === 0) blackClear++; }
    }
    expect(opaque).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(0);
    // Dilated: the transparent texels carry leaf colour, not black.
    expect(blackClear / clear).toBeLessThan(0.01);
  });
});

describe('Foliage export', () => {
  for (const kind of ['grass', 'rock', 'tree'] as const) {
    it(`writes ${kind} .glb files the engine's importer reads back`, async () => {
      const m = buildFoliage(doc(kind));
      const files = await encodeFoliage(m);
      expect(files.glbs).toHaveLength(3);
      for (const [i, glb] of files.glbs.entries()) {
        const parsed = await new GLTFLoader().parseDescriptorsFromFiles([new File([glb as BlobPart], `${kind}_LOD${i}.glb`)], false);
        const level = m.levels[i];
        expect(parsed.meshes).toHaveLength(level.parts.length);
        const tris = parsed.meshes.reduce((n, mesh) => n + mesh.geometry.indices!.length / 3, 0);
        expect(tris).toBe(levelStats(m)[i].triangles);
        for (const mesh of parsed.meshes) expect(mesh.geometry.uvs?.length).toBe(mesh.geometry.positions.length / 3 * 2);
        expect(parsed.images.every(img => img.kind === 'bytes')).toBe(true);
        if (kind === 'tree') {
          const leaves = parsed.materials.find(mt => mt.name === 'Leaves');
          if (i < 3 && leaves) {
            expect(leaves.alphaCutoff).toBe(0.5);
            expect(leaves.doubleSided).toBe(true);
            expect(leaves.translucency).toBeCloseTo(m.materials.leaves!.translucency!);
            expect(leaves.wind?.windRole).toBe('leaves');
          }
          const bark = parsed.materials.find(mt => mt.name === 'Bark')!;
          expect(bark.translucency).toBe(0);
          expect(bark.wind?.windRole).toBe('plant');
          expect(bark.textures.normalMap).toBeDefined();
        }
        if (kind === 'grass' && i < 2) expect(parsed.materials[0].translucency).toBeGreaterThan(0);
      }
      for (const png of Object.values(files.pngs)) expect((await inflateIdat(png!)).colorType).toBe(6);
    });
  }

  it('bakes a tree impostor and names every file in the sidecar', async () => {
    const d = doc('tree');
    d.tree.impostorFrames = 4;
    d.tree.impostorFrameSize = 128;
    const m = buildFoliage(d);
    const impostor = await bakeImpostor(m);
    expect(impostor).not.toBeNull();
    expect(impostor!.info.frames).toBe(4);
    const out = exportFoliage(d, summarize(m), await encodeFoliage(m), impostor);
    const names = out.map(f => f.name);
    expect(names).toEqual(['tree_LOD0.glb', 'tree_LOD1.glb', 'tree_LOD2.glb', 'tree_impostor_albedo.png', 'tree_impostor_normal.png', 'tree.foliage.json']);
    const side = JSON.parse(new TextDecoder().decode(out[out.length - 1].bytes));
    expect(side.generator).toBe('foliage');
    expect(side.output.lods.map((l: any) => l.file)).toEqual(names.slice(0, 3));
    expect(side.output.impostor.distance).toBe(d.tree.impostorDistance);
  });
});

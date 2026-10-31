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
import { buildBushSkeleton } from '../src/foliage/bush';
import { applyMaterialPatch, materialValues, resetMaterial } from '../src/foliage/materials';
import { planPbrSet } from '../src/foliage/pbrSet';
import { readZip } from '../src/core/zip';
import { deflateRawSync } from 'node:zlib';

// Small textures and a modest rock, so the suite stays fast; every code path still runs.
function doc(kind: FoliageKind, patch: Partial<FoliageDoc> = {}): FoliageDoc {
  const d = normaliseFoliage({ ...DEFAULT_DOC, kind, name: kind, ...patch });
  d.grass.textureSize = 128;
  d.rock = { ...d.rock, textureSize: 128, detail: 4, triangles: 800 };
  d.tree = { ...d.tree, barkTextureSize: 128, leafTextureSize: 128 };
  d.bush = { ...d.bush, barkTextureSize: 128, leafTextureSize: 128 };
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
  for (const kind of ['grass', 'rock', 'tree', 'bush'] as const) {
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
    for (const kind of ['grass', 'rock', 'tree', 'bush'] as const)
      for (const group of FOLIAGE_SCHEMAS[kind])
        for (const spec of group.specs) expect(spec.key in d[kind], `${kind}.${spec.key}`).toBe(true);
  });

  it('grows a bush from several leaning stems rooted near the origin', () => {
    const d = doc('bush');
    const m = buildFoliage(d);
    expect(m.collider).toBeNull();
    expect(m.impostor).toBeNull();
    const roots = buildBushSkeleton(d.seed, d.bush).stems.filter(s => s.level === 0);
    expect(roots).toHaveLength(d.bush.stems);
    for (const s of roots) expect(Math.hypot(s.points[0][0], s.points[0][2])).toBeLessThanOrEqual(d.bush.spread + 1e-6);
    // Stems lean out: their tips spread wider than their roots.
    const tipSpread = Math.max(...roots.map(s => Math.hypot(s.points.at(-1)![0], s.points.at(-1)![2])));
    expect(tipSpread).toBeGreaterThan(d.bush.spread);
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
  for (const kind of ['grass', 'rock', 'tree', 'bush'] as const) {
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
        if (kind === 'tree' || kind === 'bush') {
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
          // Every bark channel: AO, roughness and metallic in one packed map, read as both slots.
          expect(bark.textures.occlusionMap).toBeDefined();
          expect(bark.textures.metallicRoughnessTexture).toBe(bark.textures.occlusionMap);
          expect(bark.roughness).toBe(1);
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

describe('Foliage materials', () => {
  it('links roughness, translucency and wind to the kind parameters; keeps the rest as overrides', () => {
    let d = doc('tree');
    d = applyMaterialPatch(d, 'leaves', { roughness: 0.33, translucency: 0.7, windFlutter: 0.9, metallic: 0.2, baseColor: [0.5, 1, 0.5] });
    expect(d.tree.leafRoughness).toBe(0.33);
    expect(d.tree.leafTranslucency).toBe(0.7);
    expect(d.tree.windFlutter).toBe(0.9);
    expect(d.tree.materials?.leaves).toEqual({ metallic: 0.2, baseColor: [0.5, 1, 0.5] });
    const v = materialValues(d, 'leaves');
    expect(v.roughness).toBe(0.33);
    expect(v.alphaCutoff).toBe(0.5);
    // Bark has no translucency or cutout to edit.
    const bark = materialValues(d, 'bark');
    expect(bark.translucency).toBeUndefined();
    expect(bark.alphaCutoff).toBeUndefined();
    expect(resetMaterial(d, 'leaves').tree.materials?.leaves).toBeUndefined();
  });

  it('writes the overrides into every level of the .glb export', async () => {
    let d = doc('bush');
    d = applyMaterialPatch(d, 'leaves', { baseColor: [0.8, 0.6, 0.4], alphaCutoff: 0.3, emissive: [1, 0, 0], emissiveIntensity: 3 });
    d = applyMaterialPatch(d, 'bark', { metallic: 0.25, windRole: 'leaves' });
    const m = buildFoliage(d);
    const files = await encodeFoliage(m);
    expect(m.textures.barkOrm!.data[2]).toBe(Math.round(0.25 * 255));
    for (const [i, glb] of files.glbs.entries()) {
      const parsed = await new GLTFLoader().parseDescriptorsFromFiles([new File([glb as BlobPart], `bush_LOD${i}.glb`)], false);
      const leaves = parsed.materials.find(mt => mt.name === 'Leaves')!;
      expect(leaves.baseColor.slice(0, 3)).toEqual([0.8, 0.6, 0.4]);
      expect(leaves.alphaCutoff).toBeCloseTo(0.3);
      expect(leaves.emissiveFactor).toEqual([1, 0, 0]);
      expect(leaves.emissiveIntensity).toBe(3);
      const bark = parsed.materials.find(mt => mt.name === 'Bark')!;
      // Metallic lives in the ORM map's blue channel (the engine reads the map, not the factor).
      expect(bark.metallic).toBe(1);
      expect(bark.textures.metallicRoughnessTexture).toBeDefined();
      expect(bark.wind?.windRole).toBe('leaves');
      expect(bark.wind?.windFlutter).toBeCloseTo(d.bush.windFlutter);
    }
  });

  it('survives a stored document with junk overrides', () => {
    const d = normaliseFoliage({ kind: 'grass', grass: { materials: { grass: { metallic: 9, baseColor: 'red', bogus: 1 }, rock: { metallic: 0.5 } } } as any });
    expect(d.grass.materials).toEqual({ grass: { metallic: 1 } });
  });
});

describe('Bark ORM map', () => {
  const channel = (img: { data: Uint8Array }, c: number) => { let lo = 255, hi = 0; for (let i = c; i < img.data.length; i += 4) { lo = Math.min(lo, img.data[i]); hi = Math.max(hi, img.data[i]); } return [lo, hi]; };
  const flat = (size: number, r: number, g: number, b: number) => {
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
    return { width: size, height: size, data };
  };

  it('generates AO and roughness from the bark relief, metallic from the material', () => {
    const m = buildFoliage(doc('tree'));
    const orm = m.textures.barkOrm!;
    const [aoLo, aoHi] = channel(orm, 0);
    expect(aoHi).toBe(255);                      // plate tops are unoccluded
    expect(aoLo).toBeLessThan(160);              // cracks are dark
    const [rLo, rHi] = channel(orm, 1);
    const r = m.materials.bark!.roughness * 255;
    expect(rLo).toBeGreaterThan(r * 0.85); expect(rHi).toBeLessThanOrEqual(Math.min(255, Math.ceil(r * 1.09)));
    expect(channel(orm, 2)).toEqual([0, 0]);
  });

  it('takes a packed ARM map, then single channels over it, at the bark size', () => {
    const d = doc('tree');
    d.tree.barkRoughness = 1;
    const m = buildFoliage(d, { barkOrm: flat(64, 200, 100, 0), barkMetallic: flat(32, 128, 128, 128) });
    const orm = m.textures.barkOrm!;
    expect(orm.width).toBe(d.tree.barkTextureSize);
    expect(channel(orm, 0)).toEqual([200, 200]);
    expect(channel(orm, 1)).toEqual([100, 100]);
    expect(channel(orm, 2)).toEqual([128, 128]);
    // The roughness slider scales a roughness map.
    d.tree.barkRoughness = 0.5;
    const half = buildFoliage(d, { barkRoughness: flat(16, 200, 200, 200) }).textures.barkOrm!;
    expect(channel(half, 1)).toEqual([100, 100]);
  });

  it('sorts a downloaded texture set onto the bark slots by file name', () => {
    const plan = planPbrSet('bark', [
      'textures/pine_bark_ao_1k.png', 'textures/pine_bark_arm_1k.png', 'textures/pine_bark_diff_1k.jpg', 'textures/pine_bark_disp_1k.png',
      'textures/pine_bark_nor_dx_1k.png', 'textures/pine_bark_nor_gl_1k.png', 'textures/pine_bark_rough_1k.png', 'Metalness.jpg', 'readme.txt',
    ]);
    const bySlot = Object.fromEntries(plan.files.map(f => [f.slot, f.name]));
    expect(bySlot).toEqual({
      barkAo: 'textures/pine_bark_ao_1k.png', barkOrm: 'textures/pine_bark_arm_1k.png', bark: 'textures/pine_bark_diff_1k.jpg',
      barkNormal: 'textures/pine_bark_nor_gl_1k.png', barkRoughness: 'textures/pine_bark_rough_1k.png', barkMetallic: 'Metalness.jpg',
    });
    expect(plan.skipped.sort()).toEqual(['readme.txt', 'textures/pine_bark_disp_1k.png', 'textures/pine_bark_nor_dx_1k.png']);
    // Only a DirectX normal: used, green flipped.
    expect(planPbrSet('bark', ['Bark_NormalDX.png']).files).toEqual([{ role: 'normal', slot: 'barkNormal', name: 'Bark_NormalDX.png', flipGreen: true }]);
    // A rock has colour and normal slots only.
    expect(planPbrSet('rock', ['a_diff.png', 'a_arm.png']).files.map(f => f.slot)).toEqual(['rockAlbedo']);
  });

  it('reads stored and deflated zip entries', async () => {
    const entries: [string, Uint8Array, boolean][] = [['textures/', new Uint8Array(), false], ['textures/a.txt', new TextEncoder().encode('stored'), false],
      ['textures/b.txt', new TextEncoder().encode('deflated '.repeat(50)), true]];
    const locals: Buffer[] = [], central: Buffer[] = [];
    let offset = 0;
    for (const [name, raw, deflate] of entries) {
      const body = deflate ? deflateRawSync(raw) : Buffer.from(raw);
      const n = Buffer.from(name);
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8);
      local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
      const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(deflate ? 8 : 0, 10);
      dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42);
      locals.push(local, n, body); central.push(dir, n);
      offset += 30 + n.length + body.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    const out = await readZip(new Uint8Array(Buffer.concat([...locals, cd, end])));
    expect(out.map(e => [e.name, new TextDecoder().decode(e.bytes)])).toEqual([['textures/a.txt', 'stored'], ['textures/b.txt', 'deflated '.repeat(50)]]);
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { packGameBin, ATTRS } from '../src/features/publish/pack';
import {
  unpackGameBin, inflateSceneGeometry, inflateTerrainData, inflateTilemapData, readGameHeader, readChunkSet,
  collectSceneRefs, collectUiTextureIds, type ChunkLookup,
} from '../src/player/unpack';
import { bufferSource, blobSource, rangeSource, openGameUrl, parseContentRange, PROBE_BYTES, type GameSource } from '../src/player/gameSource';
import { planSpans, scatter, pool } from '../src/player/byteSpans';
import { compressTilemapData } from '../src/features/publish/terrainImages';
import { Tilemap } from '../../../src/graphics/tilemap/tilemap';
import { Tileset } from '../../../src/graphics/tilemap/tileset';
import { CHUNK_SIZE } from '../../../src/graphics/tilemap/chunk';

/**
 * Reading game.bin a range at a time (player/gameSource.ts, byteSpans.ts, unpack.ts readChunkSet).
 *
 * A running game no longer holds the file: it reads the header and manifest, then each scene's chunks as the
 * scene loads. Two things would fail SILENTLY: a chunk the collector does not name (the inflate then throws
 * only for the scene that has it — or, worse, a field skipped renders as missing geometry), and a chunk set
 * whose arrays alias each other or a previous visit's (one instance deforming another, or a revisit seeing
 * what the last one wrote). Both are pinned here against the whole-file reader the packer's own tests cover.
 */

const cube = () => ({
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  texCoords: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
});
const tri = () => ({ positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2] });
/** The packed file as bytes. */
const packed = (data: any) => new Uint8Array(packGameBin(data).buffer);
const model = (geometry: any) => ({ model: { geometry, material: { type: 'blinn' } }, children: [] });

const deflate = async (bytes: Uint8Array) => new Uint8Array(await new Response(
  new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());

async function tilemapNode(): Promise<any> {
  const tm = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
  tm.registerTileset(new Tileset({ id: 'ts', textureId: 'atlas.png', imageWidth: 64, imageHeight: 64, tileWidth: 16, tileHeight: 16, columns: 4, rows: 4 }));
  tm.addLayer({ name: 'Ground', tilesetId: 'ts' });
  tm.fillRect(0, 0, 0, CHUNK_SIZE - 1, CHUNK_SIZE - 1, 3);
  const scene = { name: 'root', children: [{ name: 'Tilemap', id: 'map', type: 'tilemap', children: [], tilemap: JSON.parse(JSON.stringify(tm.serialize())) }] };
  await compressTilemapData(scene);
  return scene.children[0];
}

/** Every kind of chunk a scene can carry: shared and distinct meshes, bone data, a landscape with foliage and
 *  deflated payloads, a tilemap, a GI volume and a UI image. Plus a second scene and a template. */
async function richGame(): Promise<any> {
  const heights = new Uint16Array([0, 1234, 65535, 42, 7, 900, 12, 3]);
  const splat = new Uint8Array(64).map((_, i) => (i * 13) & 0xff);
  const skinned = {
    model: {
      geometry: tri(), material: { type: 'pbr' },
      jointIndices: new Float32Array([0, 1, 0, 0, 1, 2, 0, 0, 2, 3, 0, 0]),
      jointWeights: new Float32Array([1, 0, 0, 0, 0.5, 0.5, 0, 0, 0.25, 0.75, 0, 0]),
    },
    children: [],
  };
  const terrain = {
    terrain: {
      resolution: 3, splatRes: 4, heightFormat: 'u16', heightMin: 0, heightMax: 10,
      heightBytes: await deflate(new Uint8Array(heights.buffer)),
      splatBytes: await deflate(splat),
      foliage: [{ kind: 'mesh', name: 'oak', models: [{ geometry: cube(), material: {} }] }],
    },
    children: [],
  };
  const gi = { name: 'GI', type: 'giVolume', giVolume: { bakeId: 'gi-a' }, children: [] };
  const ui = { name: 'Logo', type: 'uiImage', ui: { textureId: 'logo.png' }, children: [] };
  return {
    version: 2,
    entry: 'main',
    scenes: {
      main: { name: 'Main', scene: { name: 'root', children: [model(cube()), model(cube()), model(tri()), skinned, terrain, await tilemapNode(), gi, ui] } },
      other: { name: 'Other', scene: { name: 'root', children: [model(tri())] } },
    },
    templates: [{ id: 't1', name: 'Crate', node: { name: 'Crate', children: [model(cube())] } }],
    config: { graphics: { clearColor: [0, 0, 0, 1] } },
    textureBytes: [],
    giBakes: [{ id: 'gi-a', bytes: new Uint8Array(1001).map((_, i) => (i * 7) & 0xff) }, { id: 'gi-unused', bytes: new Uint8Array(8) }],
  };
}

/** Typed arrays as plain arrays, so two inflated trees compare by value. */
function plain(x: any): any {
  if (ArrayBuffer.isView(x)) return Array.from(x as any);
  if (Array.isArray(x)) return x.map(plain);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, plain(v)]));
  return x;
}

/** game.bin served from memory the way a static host or game:// does, with switches for the ways one can differ. */
function fakeHost(file: Uint8Array, options: { ignoreRange?: boolean; encoding?: string; etag?: () => string; status?: number } = {}) {
  const requests: { range: string | null }[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range');
    requests.push({ range });
    if (options.status) return new Response('nope', { status: options.status });
    const headers: Record<string, string> = {};
    if (options.encoding) headers['Content-Encoding'] = options.encoding;
    if (options.etag) headers.ETag = options.etag();
    const m = range && !options.ignoreRange ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (m) {
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), file.length - 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${file.length}`;
      headers['Content-Length'] = String(end - start + 1);
      return new Response(file.slice(start, end + 1), { status: 206, headers });
    }
    headers['Content-Length'] = String(file.length);
    return new Response(file.slice(), { status: 200, headers });
  });
  return { fetchFn, requests };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('planSpans / scatter / pool', () => {
  it('merges neighbours within the gap, splits past it, and caps a span', () => {
    const ranges = [{ o: 0, l: 10 }, { o: 12, l: 4 }, { o: 1000, l: 5 }, { o: 1006, l: 1 }];
    expect(planSpans(ranges, { maxGap: 8, maxSpan: 1 << 20 }).map(s => [s.start, s.end, s.members])).toEqual([
      [0, 16, [0, 1]], [1000, 1007, [2, 3]],
    ]);
    expect(planSpans(ranges, { maxGap: 1 << 20, maxSpan: 16 }).map(s => [s.start, s.end])).toEqual([[0, 16], [1000, 1007]]);
    // A range bigger than maxSpan is a span of its own, never split.
    expect(planSpans([{ o: 0, l: 100 }, { o: 100, l: 1 }], { maxGap: 0, maxSpan: 10 }).map(s => [s.start, s.end])).toEqual([[0, 100], [100, 101]]);
  });

  it('scatters a stream cut at odd places into exact-size buffers, and throws on a short one', async () => {
    const file = new Uint8Array(500).map((_, i) => i & 0xff);
    const ranges = [{ o: 3, l: 40 }, { o: 50, l: 1 }, { o: 51, l: 120 }, { o: 10, l: 5 } /* overlaps the first */];
    const [span] = planSpans(ranges, { maxGap: 64, maxSpan: 1 << 20 });
    const cuts = [7, 1, 33, 64, 2, 1000];
    const stream = () => {
      let pos = span.start, k = 0;
      return new ReadableStream<Uint8Array>({ pull(c) {
        if (pos >= span.end) { c.close(); return; }
        const n = Math.min(cuts[k++ % cuts.length], span.end - pos);
        c.enqueue(file.slice(pos, pos + n)); pos += n;
      } });
    };
    const targets = ranges.map(r => new Uint8Array(r.l));
    await scatter(stream(), span, ranges, targets);
    ranges.forEach((r, i) => expect(Array.from(targets[i])).toEqual(Array.from(file.subarray(r.o, r.o + r.l))));

    const short = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(file.slice(span.start, span.start + 10)); c.close(); } });
    await expect(scatter(short, span, ranges, ranges.map(r => new Uint8Array(r.l)))).rejects.toThrow(/ended early/);
  });

  it('runs at most `limit` at once and keeps the input order', async () => {
    let live = 0, most = 0;
    const out = await pool([5, 1, 4, 2, 3], 2, async (n) => {
      live++; most = Math.max(most, live);
      await new Promise(r => setTimeout(r, n));
      live--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(most).toBe(2);
  });
});

describe('opening game.bin over fetch', () => {
  it('reads by range when the host honours it: one probe, then only what is asked', async () => {
    const file = packed(await richGame());
    // Padding past the probe, so the file is not read whole by the first request.
    const big = new Uint8Array(PROBE_BYTES + 4096); big.set(file, 0);
    const host = fakeHost(big);
    vi.stubGlobal('fetch', host.fetchFn);
    const { source, prefix } = await openGameUrl('./game.bin');
    expect(source.kind).toBe('range');
    expect(source.size).toBe(big.length);
    expect(prefix!.length).toBe(PROBE_BYTES);
    expect(host.requests).toEqual([{ range: `bytes=0-${PROBE_BYTES - 1}` }]);
    const header = await readGameHeader(source, prefix);
    expect(header.manifest.entry).toBe('main');
    expect(host.requests).toHaveLength(1); // the manifest was inside the probe
    const tail = await source.read(big.length - 10, 10);
    expect(Array.from(tail)).toEqual(Array.from(big.subarray(big.length - 10)));
    expect(host.requests[1]).toEqual({ range: `bytes=${big.length - 10}-${big.length - 1}` });
  });

  it('counts every byte of reads that run in parallel', async () => {
    const file = new Uint8Array(4 * PROBE_BYTES);
    vi.stubGlobal('fetch', fakeHost(file).fetchFn);
    const source = rangeSource('./game.bin', file.length, null);
    // Far apart, so each is a span (a request) of its own, all in flight at once.
    const ranges = [0, 1, 2, 3].map(i => ({ o: i * PROBE_BYTES, l: 1000 + i }));
    await source.readMany(ranges);
    expect(source.stats.requests).toBe(4);
    expect(source.stats.bytesRead).toBe(ranges.reduce((a, r) => a + r.l, 0));
  });

  it('reads the rest of a manifest longer than the probe with one more request', async () => {
    const data: any = await richGame();
    data.config.pad = 'x'.repeat(PROBE_BYTES + 1000);
    const file = packed(data);
    const host = fakeHost(file);
    vi.stubGlobal('fetch', host.fetchFn);
    const { source, prefix } = await openGameUrl('./game.bin');
    const header = await readGameHeader(source, prefix);
    expect(header.manifest.config.pad.length).toBe(PROBE_BYTES + 1000);
    expect(host.requests).toHaveLength(2);
  });

  it('takes a file smaller than the probe whole from the probe', async () => {
    const file = packed(await richGame());
    const host = fakeHost(file);
    vi.stubGlobal('fetch', host.fetchFn);
    const { source } = await openGameUrl('./game.bin');
    expect(source.kind).toBe('buffer');
    expect(host.requests).toHaveLength(1);
  });

  it('streams the whole file into one buffer when the host ignores Range, with progress and no second request', async () => {
    const file = new Uint8Array(3 * PROBE_BYTES).map((_, i) => i & 0xff);
    file.set(packed(await richGame()), 0);
    const host = fakeHost(file, { ignoreRange: true });
    vi.stubGlobal('fetch', host.fetchFn);
    const progress: number[] = [];
    const { source, prefix } = await openGameUrl('./game.bin', done => progress.push(done));
    expect(source.kind).toBe('buffer');
    expect(prefix).toBeNull();
    expect(source.size).toBe(file.length);
    expect(progress.at(-1)).toBe(file.length);
    expect(host.requests).toHaveLength(1);
    expect(Array.from(await source.read(file.length - 4, 4))).toEqual(Array.from(file.subarray(file.length - 4)));
  });

  it('reads an encoded whole answer with arrayBuffer, and re-asks without Range for an encoded range', async () => {
    const file = new Uint8Array(2 * PROBE_BYTES); file.set(packed(await richGame()), 0);
    const whole = fakeHost(file, { ignoreRange: true, encoding: 'gzip' });
    vi.stubGlobal('fetch', whole.fetchFn);
    expect((await openGameUrl('./game.bin')).source.size).toBe(file.length);

    const ranged = fakeHost(file, { encoding: 'br' });
    vi.stubGlobal('fetch', ranged.fetchFn);
    const { source } = await openGameUrl('./game.bin');
    expect(source.kind).toBe('buffer');
    expect(ranged.requests.map(r => r.range)).toEqual([`bytes=0-${PROBE_BYTES - 1}`, null]);
  });

  it('refuses a file that changed under the game, and says what a failed load was', async () => {
    const file = new Uint8Array(2 * PROBE_BYTES);
    let tag = 0;
    const host = fakeHost(file, { etag: () => `"v${tag}"` });
    vi.stubGlobal('fetch', host.fetchFn);
    const { source } = await openGameUrl('./game.bin');
    tag = 1;
    await expect(source.read(PROBE_BYTES + 5, 10)).rejects.toThrow(/changed/);

    // A host answering with the wrong range (or size) is caught the same way.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(10), { status: 206, headers: { 'Content-Range': 'bytes 0-9/99' } })));
    await expect(rangeSource('./game.bin', file.length, null).read(100, 10)).rejects.toThrow(/changed/);

    vi.stubGlobal('fetch', fakeHost(file, { status: 404 }).fetchFn);
    await expect(openGameUrl('./game.bin')).rejects.toThrow(/HTTP 404/);
  });

  it('parses Content-Range', () => {
    expect(parseContentRange('bytes 0-9/100')).toEqual({ start: 0, end: 9, size: 100 });
    expect(parseContentRange('bytes 0-9/*')).toBeNull();
    expect(parseContentRange(null)).toBeNull();
  });
});

/** Each source over the same file. */
async function sources(file: Uint8Array): Promise<[string, () => Promise<GameSource>][]> {
  return [
    ['buffer', async () => bufferSource(file.slice().buffer)],
    ['blob', async () => blobSource(new Blob([file as BlobPart]))],
    ['range', async () => {
      vi.stubGlobal('fetch', fakeHost(file).fetchFn);
      return rangeSource('./game.bin', file.length, null);
    }],
  ];
}

async function inflateAll(scene: any, lookup: ChunkLookup) {
  inflateSceneGeometry(scene, lookup);
  await inflateTerrainData(scene, lookup);
  await inflateTilemapData(scene, lookup);
}

describe('readChunkSet', () => {
  it('names every chunk the inflate functions read (scenes, and templates for their geometry)', async () => {
    const file = packed(await richGame());
    const whole = unpackGameBin(file.slice().buffer);
    const key = (r: { o: number; l: number }) => `${r.o}:${r.l}`;
    // A lookup that records each chunk it is asked for, answered from the whole file.
    const recording = (asked: Set<string>): ChunkLookup => ({
      geometryFor: ref => {
        const packed: any = whole.manifest.geometries[ref];
        for (const name of ATTRS) if (packed?.[name]) asked.add(key(packed[name]));
        if (packed?.indices) asked.add(key(packed.indices));
        return whole.geometryFor(ref);
      },
      chunkBytes: c => { if (c) asked.add(key(c)); return whole.chunkBytes(c); },
      chunkFloats: c => { if (c) asked.add(key(c)); return whole.chunkFloats(c); },
    });
    for (const entry of Object.values(whole.manifest.scenes)) {
      const asked = new Set<string>();
      const scene = structuredClone(entry.scene);
      const named = new Set(collectSceneRefs(scene, whole.manifest).chunks.map(key));
      await inflateAll(scene, recording(asked));
      expect(asked.size).toBeGreaterThan(0);
      for (const k of asked) expect(named, `chunk ${k} of scene ${entry.name}`).toContain(k);
    }
    for (const t of whole.manifest.templates ?? []) {
      const asked = new Set<string>();
      const node = structuredClone(t.node);
      const named = new Set(collectSceneRefs(node, whole.manifest, { data: false }).chunks.map(key));
      inflateSceneGeometry(node, recording(asked));
      for (const k of asked) expect(named).toContain(k);
    }
    expect(collectSceneRefs(whole.manifest.scenes.main.scene, whole.manifest).giBakeIds).toEqual(['gi-a']);
    expect([...collectUiTextureIds(whole.manifest.scenes.main.scene)]).toEqual(['logo.png']);
  });

  it('inflates a scene exactly as the whole-file reader does, from every source', async () => {
    const file = packed(await richGame());
    const whole = unpackGameBin(file.slice().buffer);
    const expected = structuredClone(whole.manifest.scenes.main.scene);
    await inflateAll(expected, whole);

    for (const [kind, open] of await sources(file)) {
      const source = await open();
      const header = await readGameHeader(source);
      const scene = structuredClone(header.manifest.scenes.main.scene);
      const set = await readChunkSet(source, header, collectSceneRefs(scene, header.manifest));
      await inflateAll(scene, set);
      expect(plain(scene), kind).toEqual(plain(expected));
      expect(set.giBakes.map(b => b.id), kind).toEqual(['gi-a']);
      expect(Array.from(set.giBakes[0].bytes), kind).toEqual(Array.from(whole.giBakes[0].bytes));
    }
  });

  it('gives the first user of a shared mesh the arrays and every other one a copy, and every visit its own', async () => {
    const file = packed(await richGame());
    for (const [kind, open] of await sources(file)) {
      const source = await open();
      const header = await readGameHeader(source);
      const claimed = new Set<string>();
      const visit = async () => {
        const scene = structuredClone(header.manifest.scenes.main.scene);
        await inflateAll(scene, await readChunkSet(source, header, collectSceneRefs(scene, header.manifest), claimed));
        return scene.children.map((c: any) => c.model?.geometry?.positions as Float32Array | undefined);
      };
      const first = await visit();
      // Children 0 and 1 share one mesh: never one buffer.
      expect(first[0]!.buffer, kind).not.toBe(first[1]!.buffer);
      expect(Array.from(first[0]!), kind).toEqual(Array.from(first[1]!));
      const again = await visit();
      // A second visit never reuses the first one's arrays, which that scene may have rewritten.
      for (let i = 0; i < 3; i++) expect(again[i]!.buffer, `${kind} child ${i}`).not.toBe(first[i]!.buffer);
      if (source.ownsReads) {
        // A read's arrays are its own: no view onto anything bigger than the chunk.
        expect(first[0]!.byteOffset).toBe(0);
        expect(first[0]!.buffer.byteLength).toBe(first[0]!.byteLength);
      }
    }
  });

  it('refuses to answer for a chunk it was not asked to read', async () => {
    const file = packed(await richGame());
    const source = bufferSource(file.slice().buffer);
    const header = await readGameHeader(source);
    const set = await readChunkSet(source, header, { chunks: [], giBakeIds: [] });
    const scene = structuredClone(header.manifest.scenes.main.scene);
    expect(() => inflateSceneGeometry(scene, set)).toThrow(/was not read/);
  });
});

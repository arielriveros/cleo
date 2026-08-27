// Turns the raw source art in examples/assets/terrain into something an engine can actually load.
//
// The pine is the reason this file exists: `pine_tree_01.bin` is 948 MB and its three variants are
// 6.9M / 4.2M / 6.0M triangles, because the needles are modelled geometry rather than alpha cards.
// Nothing downstream — not the importer, not a scene blob, not a GPU — survives that. The searsia is
// merely heavy (361k / 210k / 44k), and the grass and rocks are already fine.
//
// Two reduction operators, picked per primitive by what the geometry IS:
//
//   cluster  Grid vertex clustering. Snap vertices to a lattice, elect one representative per cell,
//            remap, drop degenerates. Correct for a CONNECTED surface — a trunk, a rock — where
//            merging nearby vertices just makes the surface coarser.
//
//   thin     Connected-component subsampling. Label the disjoint islands (one needle, one leaf, one
//            twig card), then keep a spatially EVEN subset of whole islands, budgeted in triangles.
//            Correct for a soup of separate blades: clustering would weld neighbouring needles into
//            blobs, and uniform random thinning leaves bald patches, so the survivors are strided
//            through Morton order.
//
// Output is a staging tree of small .gltf + .bin pairs plus the textures they reference, which
// tools/terrain/buildLandscape.js then loads through the engine's own Loader.
//
//   node tools/terrain/decimateTrees.mjs [--out <dir>]
//
// Nothing here is committed; only the bundle built from it is.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SRC = path.join(REPO, 'examples', 'assets', 'terrain');

const argOut = process.argv.indexOf('--out');
const OUT = argOut > 0 && process.argv[argOut + 1]
    ? path.resolve(process.argv[argOut + 1])
    : path.join(os.tmpdir(), 'cleo-terrain-build');

// glTF component types we care about. The source files are all Blender exports: tightly packed,
// non-interleaved (no byteStride), float attributes, uint32 indices.
const F32 = 5126, U32 = 5125, U16 = 5123, U8 = 5121;
const COMP_BYTES = { [F32]: 4, [U32]: 4, [U16]: 2, [U8]: 1 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

// ---------------------------------------------------------------------------------------------
// Reading

/**
 * A glTF opened for RANGED reads. The pine's buffer is 948 MB; slurping it would cost a gigabyte of
 * resident memory to reach ~180 MB of primitive data, so every accessor is read straight out of the
 * file at its own offset.
 */
class GltfSource {
    constructor(gltfPath) {
        this.dir = path.dirname(gltfPath);
        this.json = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
        const uri = this.json.buffers[0].uri;
        this.binPath = path.join(this.dir, decodeURIComponent(uri));
        this.fd = fs.openSync(this.binPath, 'r');
    }

    close() { fs.closeSync(this.fd); }

    /** The raw values of one accessor, as the typed array its componentType calls for. */
    read(accessorIndex) {
        const acc = this.json.accessors[accessorIndex];
        if (acc.sparse) throw new Error('sparse accessors are not supported');
        const bv = this.json.bufferViews[acc.bufferView];
        if (bv.byteStride && bv.byteStride !== COMP_BYTES[acc.componentType] * TYPE_COUNT[acc.type])
            throw new Error('interleaved bufferViews are not supported');
        const n = acc.count * TYPE_COUNT[acc.type];
        const bytes = n * COMP_BYTES[acc.componentType];
        const buf = Buffer.allocUnsafe(bytes);
        const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
        let got = 0;
        while (got < bytes) {
            const r = fs.readSync(this.fd, buf, got, bytes - got, offset + got);
            if (r <= 0) throw new Error(`short read on ${this.binPath}`);
            got += r;
        }
        // The Buffer's own byteOffset is not guaranteed to be 8-aligned, and a typed-array view
        // demands alignment, so hand the copy its own ArrayBuffer.
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytes);
        switch (acc.componentType) {
            case F32: return new Float32Array(ab);
            case U32: return new Uint32Array(ab);
            case U16: return new Uint16Array(ab);
            case U8: return new Uint8Array(ab);
            default: throw new Error('unsupported componentType ' + acc.componentType);
        }
    }

    nodeByName(name) {
        const i = this.json.nodes.findIndex(n => n.name === name);
        if (i < 0) throw new Error(`no node named ${name} in ${this.binPath}`);
        return this.json.nodes[i];
    }

    materialName(i) { return this.json.materials[i]?.name ?? `material_${i}`; }

    /**
     * One primitive lifted into plain arrays, with `KHR_texture_transform` already baked into the
     * UVs. The engine's GLTFLoader does not implement that extension, and `pine_tree_01_bark`
     * carries offset [0, 0.9] scale [1.2, 0.1] — left alone the bark tiles wrong by an order of
     * magnitude, which reads as a smeared trunk rather than as a missing feature.
     */
    primitive(prim) {
        const a = prim.attributes;
        const positions = this.read(a.POSITION);
        const normals = a.NORMAL !== undefined ? this.read(a.NORMAL) : new Float32Array(positions.length);
        let uvs = a.TEXCOORD_0 !== undefined ? this.read(a.TEXCOORD_0) : new Float32Array((positions.length / 3) * 2);
        const indices = Uint32Array.from(this.read(prim.indices));

        const xf = this._texTransform(prim.material);
        if (xf) {
            uvs = Float32Array.from(uvs);
            for (let i = 0; i < uvs.length; i += 2) {
                uvs[i] = uvs[i] * xf.scale[0] + xf.offset[0];
                uvs[i + 1] = uvs[i + 1] * xf.scale[1] + xf.offset[1];
            }
        }
        return { positions, normals, uvs, indices, material: this.materialName(prim.material) };
    }

    /**
     * The one UV transform a material uses. glTF allows a different transform per texture slot;
     * these files never do, and a per-slot transform has nowhere to go in a single UV set anyway,
     * so a disagreement is an error rather than a silent pick.
     */
    _texTransform(materialIndex) {
        const m = this.json.materials?.[materialIndex];
        if (!m) return null;
        const slots = [
            m.normalTexture, m.occlusionTexture, m.emissiveTexture,
            m.pbrMetallicRoughness?.baseColorTexture, m.pbrMetallicRoughness?.metallicRoughnessTexture,
        ].filter(Boolean);
        let found = null;
        for (const s of slots) {
            const t = s.extensions?.KHR_texture_transform;
            if (!t) continue;
            const xf = { offset: t.offset || [0, 0], scale: t.scale || [1, 1] };
            if (t.rotation) throw new Error('KHR_texture_transform rotation is not supported');
            if (found && (found.offset[0] !== xf.offset[0] || found.offset[1] !== xf.offset[1]
                || found.scale[0] !== xf.scale[0] || found.scale[1] !== xf.scale[1]))
                throw new Error(`material ${this.materialName(materialIndex)} has per-slot UV transforms`);
            found = xf;
        }
        return found;
    }
}

// ---------------------------------------------------------------------------------------------
// Reduction

/** Drop the vertices no surviving triangle references, and rewrite the indices to match. */
function compact(mesh) {
    const { positions, normals, uvs, indices } = mesh;
    const remap = new Int32Array(positions.length / 3).fill(-1);
    let next = 0;
    for (let i = 0; i < indices.length; i++) {
        const v = indices[i];
        if (remap[v] < 0) remap[v] = next++;
    }
    const p = new Float32Array(next * 3), n = new Float32Array(next * 3), t = new Float32Array(next * 2);
    for (let v = 0; v < remap.length; v++) {
        const d = remap[v];
        if (d < 0) continue;
        p[d * 3] = positions[v * 3]; p[d * 3 + 1] = positions[v * 3 + 1]; p[d * 3 + 2] = positions[v * 3 + 2];
        n[d * 3] = normals[v * 3]; n[d * 3 + 1] = normals[v * 3 + 1]; n[d * 3 + 2] = normals[v * 3 + 2];
        t[d * 2] = uvs[v * 2]; t[d * 2 + 1] = uvs[v * 2 + 1];
    }
    const out = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) out[i] = remap[indices[i]];
    return { positions: p, normals: n, uvs: t, indices: out, material: mesh.material };
}

function bounds(positions) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
            const v = positions[i + k];
            if (v < min[k]) min[k] = v;
            if (v > max[k]) max[k] = v;
        }
    if (!isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
    return { min, max };
}

/**
 * Grid vertex clustering at a given cell size. Every vertex in a cell collapses onto the cell's
 * first-seen vertex; triangles whose corners land in fewer than three distinct cells vanish.
 *
 * Averaging the survivors' positions was tried and rejected: it rounds a trunk's silhouette inward
 * and pulls bark UVs off their texture band. First-seen keeps a real vertex, with its real UV.
 */
/**
 * Median UV distance per metre of surface, measured over the mesh's own edges.
 *
 * This is what makes the seam test below scale correctly. Two vertices a cell apart legitimately
 * differ in UV by about `cell * uvDensity`; anything much larger than that is a real discontinuity.
 * A fixed threshold cannot work, because the cell size is exactly what the bisection is varying.
 */
function uvDensityOf(mesh) {
    const { positions: p, uvs, indices: idx } = mesh;
    const samples = [];
    const stride = Math.max(3, Math.floor(idx.length / 3 / 4000) * 3);
    for (let i = 0; i < idx.length; i += stride) {
        const a = idx[i], b = idx[i + 1];
        const dp = Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
        if (dp < 1e-6) continue;
        const du = Math.hypot(uvs[a * 2] - uvs[b * 2], uvs[a * 2 + 1] - uvs[b * 2 + 1]);
        samples.push(du / dp);
    }
    if (!samples.length) return 0;
    samples.sort((x, y) => x - y);
    return Math.max(1e-4, samples[samples.length >> 1]);
}

/**
 * How far apart two UVs may be, as a MULTIPLE of what the cell size would normally account for, and
 * still be treated as the same point on the atlas.
 *
 * A UV SEAM is two vertices at the same place carrying different texture coordinates. Merged, one
 * side has its UVs dragged across the atlas and the texture smears over the island boundary — which
 * is what the rocks' "lost texture definition" was.
 *
 * Two earlier attempts are worth recording, because both were worse than no seam handling at all:
 * bucketing UVs to a 1/64 grid, and then a fixed 0.05 neighbourhood. Both make ordinary interior
 * vertices distinct, so nothing merges, the cell-size bisection runs away chasing a reduction it can
 * never reach, and what ships is a handful of metre-long triangles across the model. The pine
 * rendered as black sails and the triangle COUNT was correct the whole time.
 */
const UV_SEAM_SCALE = 3.0;
/** Cap on distinct UV groups per spatial cell, so a coarse cell cannot make this quadratic. */
const MAX_CELL_REPS = 16;

function clusterOnce(mesh, cell, uvDensity) {
    const { positions, uvs, indices } = mesh;
    const b = bounds(positions);
    const nx = Math.max(1, Math.ceil((b.max[0] - b.min[0]) / cell));
    const ny = Math.max(1, Math.ceil((b.max[1] - b.min[1]) / cell));
    const rep = new Map();
    const to = new Int32Array(positions.length / 3);
    for (let v = 0; v < to.length; v++) {
        const cx = Math.floor((positions[v * 3] - b.min[0]) / cell);
        const cy = Math.floor((positions[v * 3 + 1] - b.min[1]) / cell);
        const cz = Math.floor((positions[v * 3 + 2] - b.min[2]) / cell);
        const key = (cz * ny + cy) * nx + cx;
        let group = rep.get(key);
        if (group === undefined) { rep.set(key, group = []); }

        const u = uvs[v * 2], w = uvs[v * 2 + 1];
        let best = -1, bestD = Infinity;
        for (const r of group) {
            const d = Math.abs(u - uvs[r * 2]) + Math.abs(w - uvs[r * 2 + 1]);
            if (d < bestD) { bestD = d; best = r; }
        }
        const seam = UV_SEAM_SCALE * cell * uvDensity;
        if (best >= 0 && (bestD <= seam || group.length >= MAX_CELL_REPS)) to[v] = best;
        else { group.push(v); to[v] = v; }
    }
    const kept = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = to[indices[i]], c = to[indices[i + 1]], d = to[indices[i + 2]];
        if (a === c || c === d || a === d) continue;
        kept.push(a, c, d);
    }
    return compact({ ...mesh, indices: Uint32Array.from(kept) });
}

/**
 * Cluster down to `targetTris`, bisecting on the cell size.
 *
 * The upper bound on the cell is deliberately modest. It used to be a quarter of the model's diagonal,
 * and when a mesh could not reach its target the fallback ran at THAT cell — which does not produce a
 * coarse mesh, it produces a handful of metre-long triangles spanning the model. Not reaching a target
 * is now a reported miss that keeps the closest real result instead.
 */
function cluster(mesh, targetTris, label = '') {
    const tris = mesh.indices.length / 3;
    if (tris <= targetTris) return mesh;
    const b = bounds(mesh.positions);
    const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const uvDensity = uvDensityOf(mesh);
    let lo = diag / 4096, hi = diag / 24, best = null, bestGot = Infinity, coarsest = null;
    for (let iter = 0; iter < 14; iter++) {
        const mid = Math.sqrt(lo * hi);
        const r = clusterOnce(mesh, mid, uvDensity);
        const got = r.indices.length / 3;
        if (!coarsest || got < coarsest.indices.length / 3) coarsest = r;
        if (got > targetTris) lo = mid; else { hi = mid; best = r; bestGot = got; }
        if (best && bestGot >= targetTris * 0.85 && bestGot <= targetTris) break;
    }
    if (best) return best;
    const got = coarsest.indices.length / 3;
    console.warn(`  ! ${label || 'mesh'}: could not reach ${targetTris} tris, kept ${got}`);
    return coarsest;
}

/**
 * Label the disjoint islands of a triangle soup — one needle, one leaf card — with union-find over
 * shared vertex indices. The source index buffers are spatially local (the median index span across
 * an 8-triangle block of pine needles is 24), so the passes stay cache-friendly even at 12M indices.
 */
function components(mesh) {
    const nv = mesh.positions.length / 3;
    const parent = new Uint32Array(nv);
    for (let i = 0; i < nv; i++) parent[i] = i;
    const find = (x) => {
        let r = x;
        while (parent[r] !== r) r = parent[r];
        while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; }
        return r;
    };
    const idx = mesh.indices;
    for (let i = 0; i < idx.length; i += 3) {
        const a = find(idx[i]), b = find(idx[i + 1]), c = find(idx[i + 2]);
        if (a !== b) parent[b] = a;
        if (a !== c) parent[find(c)] = a;
    }
    // Root -> dense island id, plus each island's triangle list and centroid.
    const ids = new Map();
    const triOf = [];
    const sum = [];
    for (let i = 0; i < idx.length; i += 3) {
        const r = find(idx[i]);
        let id = ids.get(r);
        if (id === undefined) { id = triOf.length; ids.set(r, id); triOf.push([]); sum.push([0, 0, 0, 0]); }
        triOf[id].push(i);
        const s = sum[id];
        for (let k = 0; k < 3; k++) {
            const v = idx[i + k];
            s[0] += mesh.positions[v * 3]; s[1] += mesh.positions[v * 3 + 1]; s[2] += mesh.positions[v * 3 + 2];
        }
        s[3] += 3;
    }
    const centroid = sum.map(s => [s[0] / s[3], s[1] / s[3], s[2] / s[3]]);
    return { triOf, centroid };
}

/**
 * Interleave the low 10 bits of three coordinates into a 30-bit Morton (Z-order) code. Sorting by it
 * puts spatially near islands near each other in the list, which is what lets a plain stride through
 * that list be a spatially even sample.
 */
function morton3(x, y, z) {
    const part = (v) => {
        v = (v | (v << 16)) & 0x030000ff;
        v = (v | (v << 8)) & 0x0300f00f;
        v = (v | (v << 4)) & 0x030c30c3;
        v = (v | (v << 2)) & 0x09249249;
        return v;
    };
    return part(x) | (part(y) << 1) | (part(z) << 2);
}

/**
 * Keep a spatially even subset of whole islands, down to roughly `targetTris`.
 *
 * Walk the islands in Morton order and carry a triangle debt: each island adds `size * fraction` to
 * the debt and, once the debt covers its own size, is kept and pays for itself. Kept triangles come
 * out at `fraction` of the original by construction, whatever the size distribution.
 *
 * The budget has to be in TRIANGLES, not islands. The first version quota'd islands per spatial cell
 * and overshot 2,500 triangles by 22x: pine needle islands run from 7 to 986 triangles around a
 * median of 11, so any per-cell island count that rounds up to 1 can drag in a whole 986-triangle
 * sprig. Morton order is what keeps the survivors spread out, and because dense regions simply own
 * more of the list, the original density variation survives too — a uniform draw would flatten the
 * canopy into an even fuzz.
 */
function thin(mesh, targetTris, fatten = 1) {
    const tris = mesh.indices.length / 3;
    if (tris <= targetTris) return mesh;
    const { triOf, centroid } = components(mesh);
    const b = bounds(mesh.positions);
    const span = [0, 1, 2].map(k => Math.max(1e-6, b.max[k] - b.min[k]));

    const order = new Uint32Array(centroid.length);
    const code = new Uint32Array(centroid.length);
    for (let id = 0; id < centroid.length; id++) {
        order[id] = id;
        const q = (k) => Math.min(1023, Math.floor(((centroid[id][k] - b.min[k]) / span[k]) * 1023));
        code[id] = morton3(q(0), q(1), q(2));
    }
    order.sort((a, c) => code[a] - code[c]);

    const fraction = targetTris / tris;
    // `fatten` scales each SURVIVING island about its own centroid.
    //
    // Two percent of a pine's needles is a bare tree, and the budget cannot go much higher — the source
    // has 4.1 million needle triangles. Making the survivors bigger is what buys the canopy back: at
    // 2.4x, a fiftieth of the needles covers roughly a third of the original area, and the silhouette
    // reads as a conifer again instead of as a dead trunk. Up close the needles are visibly coarse,
    // which is the honest trade and the reason it is per-level rather than global.
    const positions = fatten !== 1 ? Float32Array.from(mesh.positions) : mesh.positions;
    const seen = fatten !== 1 ? new Uint8Array(positions.length / 3) : null;

    const kept = [];
    let debt = 0;
    for (const id of order) {
        const size = triOf[id].length;
        debt += size * fraction;
        if (debt < size) continue;
        debt -= size;
        for (const t of triOf[id]) kept.push(mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]);
        if (fatten === 1) continue;
        // Islands are disjoint by construction, so a vertex belongs to exactly one of them and can be
        // scaled in place. `seen` guards against a vertex shared by two triangles of the SAME island
        // being scaled twice.
        const c = centroid[id];
        for (const t of triOf[id])
            for (let k = 0; k < 3; k++) {
                const v = mesh.indices[t + k];
                if (seen[v]) continue;
                seen[v] = 1;
                for (let a = 0; a < 3; a++)
                    positions[v * 3 + a] = c[a] + (positions[v * 3 + a] - c[a]) * fatten;
            }
    }
    return compact({ ...mesh, positions, indices: Uint32Array.from(kept) });
}

// ---------------------------------------------------------------------------------------------
// Writing

/** Write one node's primitives as a self-contained .gltf + .bin, tightly packed and non-interleaved. */
function writeGltf(outPath, meshes, images, materialTemplates) {
    const accessors = [], bufferViews = [], chunks = [];
    let offset = 0;
    const push = (typed, componentType, type, extra = {}) => {
        const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
        // Every accessor's offset must be a multiple of its component size; float and uint32 are
        // both 4, and every chunk here is a whole number of them, so alignment holds by induction.
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(extra.target ? { target: extra.target } : {}) });
        chunks.push(bytes);
        offset += bytes.length;
        accessors.push({
            bufferView: bufferViews.length - 1, componentType, type,
            count: typed.length / TYPE_COUNT[type], ...(extra.minMax ? { min: extra.minMax.min, max: extra.minMax.max } : {}),
        });
        return accessors.length - 1;
    };

    const materials = [], materialIndex = new Map();
    const primitives = [];
    for (const m of meshes) {
        if (!materialIndex.has(m.material)) {
            materialIndex.set(m.material, materials.length);
            const tpl = materialTemplates.get(m.material);
            if (!tpl) throw new Error('no material template for ' + m.material);
            materials.push(tpl);
        }
        const b = bounds(m.positions);
        primitives.push({
            attributes: {
                POSITION: push(m.positions, F32, 'VEC3', { target: 34962, minMax: b }),
                NORMAL: push(m.normals, F32, 'VEC3', { target: 34962 }),
                TEXCOORD_0: push(m.uvs, F32, 'VEC2', { target: 34962 }),
            },
            indices: push(m.indices, U32, 'SCALAR', { target: 34963 }),
            material: materialIndex.get(m.material),
        });
    }

    const bin = Buffer.concat(chunks);
    const base = path.basename(outPath, '.gltf');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(outPath), base + '.bin'), bin);
    fs.writeFileSync(outPath, JSON.stringify({
        asset: { version: '2.0', generator: 'cleo decimateTrees' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: base, mesh: 0 }],
        meshes: [{ name: base, primitives }],
        materials,
        images,
        samplers: [{ magFilter: 9729, minFilter: 9987 }],
        textures: images.map((_, i) => ({ sampler: 0, source: i })),
        accessors,
        bufferViews,
        buffers: [{ uri: base + '.bin', byteLength: bin.length }],
    }));
    return bin.length;
}

/**
 * Rebuild the material/image/texture tables for a subset of a source glTF's materials, renumbering
 * as it goes and stripping the extensions the engine does not read (`KHR_texture_transform` is
 * already baked into the UVs; `KHR_materials_specular`/`_ior` have no engine equivalent).
 *
 * `alphaMode` is dropped on purpose. Every one of these files declares BLEND, which the engine's
 * glTF loader turns into `transparent: true` — that routes each leaf into the forward transparent
 * pass, out of the G-buffer, out of deferred lighting and out of the shadow maps. The diffuse maps
 * are JPEG and have no alpha channel at all, and the foliage is real modelled geometry, so the
 * blend mode buys nothing and costs the deferred path.
 */
function materialTable(src, names) {
    const images = [];
    const imageIndex = new Map();
    const claimImage = (texIndex) => {
        if (texIndex === undefined) return undefined;
        const source = src.json.textures[texIndex].source;
        const uri = src.json.images[source].uri;
        if (!imageIndex.has(uri)) { imageIndex.set(uri, images.length); images.push({ uri }); }
        return imageIndex.get(uri);
    };
    const table = new Map();
    for (const name of names) {
        const i = src.json.materials.findIndex(m => m.name === name);
        if (i < 0) throw new Error(`no material named ${name}`);
        const m = src.json.materials[i];
        const pbr = m.pbrMetallicRoughness || {};
        const out = { name, doubleSided: !!m.doubleSided, pbrMetallicRoughness: {} };
        if (pbr.baseColorFactor) out.pbrMetallicRoughness.baseColorFactor = pbr.baseColorFactor;
        out.pbrMetallicRoughness.metallicFactor = pbr.metallicFactor ?? 0;
        if (pbr.roughnessFactor !== undefined) out.pbrMetallicRoughness.roughnessFactor = pbr.roughnessFactor;
        const bc = claimImage(pbr.baseColorTexture?.index);
        if (bc !== undefined) out.pbrMetallicRoughness.baseColorTexture = { index: bc };
        const mr = claimImage(pbr.metallicRoughnessTexture?.index);
        if (mr !== undefined) out.pbrMetallicRoughness.metallicRoughnessTexture = { index: mr };
        const nm = claimImage(m.normalTexture?.index);
        if (nm !== undefined) out.normalTexture = { index: nm };
        const oc = claimImage(m.occlusionTexture?.index);
        if (oc !== undefined) out.occlusionTexture = { index: oc };
        table.set(name, out);
    }
    // Images are indices into the table we just built, so the texture list is 1:1 with it.
    return { table, images };
}

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
        else fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
    }
}

// ---------------------------------------------------------------------------------------------
// The build list
//
// Triangle budgets here are about FILE SIZE, not the GPU — the GPU cost is set by the LOD distances
// and densities in the builder page, not by how detailed a prototype is. A vertex costs 56 bytes in
// `assets.bin` (five float attributes plus indices), so the whole set below is ~33 MB of the bundle.
//
// `Model.serialize()` writes those attributes as plain JSON decimals — roughly 250 bytes per triangle
// — which is why the bundle has to be written as format 2. See tools/terrain/buildLandscape.js.

const OPS = {
    pine: {
        gltf: path.join(SRC, 'pine_tree_model', 'pine_tree_01_1k.gltf'),
        textures: path.join(SRC, 'pine_tree_model', 'textures'),
        // Variant `b` only: the smallest of the three at 4.2M triangles, and three near-identical
        // conifers would triple the scene text for variety the eye reads as noise anyway.
        node: 'pine_tree_01_b_LOD0',
        // The needle budget dominates, and the FATTEN FACTOR COMES DOWN AS IT RISES.
        //
        // Fattening also stopped being free once the alpha cutout landed: a fattened card shows a
        // BIGGER needle rather than more of them, so past a point it trades sparseness for
        // coarseness instead of fixing it. Budget is the lever; fatten is the top-up.
        //
        // At 82k (2% of the needles) the survivors had to be inflated 2.4x to close the canopy, which
        // is what made the tree read as coarse up close. At 570k (~14%) they do not: 1.5x is enough to
        // fill, and the needles stay the width they were modelled at.
        levels: [
            { name: 'pine_lod0', budget: { pine_tree_01_bark: ['cluster', 9000], pine_tree_01_trunk_b: ['cluster', 18000], pine_tree_01_dead_branches: ['cluster', 3500], pine_tree_01_twig: ['thin', 235000, 1.9] } },
            { name: 'pine_lod1', budget: { pine_tree_01_bark: ['cluster', 4000], pine_tree_01_trunk_b: ['cluster', 8000], pine_tree_01_dead_branches: ['cluster', 1500], pine_tree_01_twig: ['thin', 115000, 2.4] } },
            // LOD2 covers everything past 50 m, which on a 256 m terrain is most of the trees — and it
            // is also the level every shadow cascade draws. Its budget is a frame-cost decision, not a
            // fidelity one.
            { name: 'pine_lod2', budget: { pine_tree_01_bark: ['cluster', 900], pine_tree_01_trunk_b: ['cluster', 1800], pine_tree_01_dead_branches: ['cluster', 400], pine_tree_01_twig: ['thin', 9500, 5.0] } },
        ],
    },

    // The searsia variants are DIFFERENT-SIZED PLANTS, not levels of one — measured bounding boxes are
    // 3.83 / 3.17 / 1.58 m wide, so swapping between them by distance would pop. Each is its own
    // prototype, shipping the authored mesh at LOD0 and decimating only the levels below it: nothing is
    // reduced at the distance you actually look at it.
    //
    // The 3.83 m `large` variant is left out. Its 361k raw triangles plus 136k of levels is the single
    // biggest claim on a budget the scene's JSON serialization caps at roughly a million triangles, and
    // it is the same plant as the medium — the variety it buys does not pay for a third of the budget.
    searsiaMedium: {
        gltf: path.join(SRC, 'searsia_tree_model', 'searsia_burchellii_1k.gltf'),
        textures: path.join(SRC, 'searsia_tree_model', 'textures'),
        node: 'searsia_burchellii_medium_LOD0',
        levels: [
            { name: 'searsia_medium_lod0', budget: {} },  // 210,262 as authored
            { name: 'searsia_medium_lod1', budget: { searsia_burchellii_leaves: ['thin', 34000, 1.15], searsia_burchellii: ['cluster', 30000], searsia_burchellii_twigs: ['thin', 12000] } },
            { name: 'searsia_medium_lod2', budget: { searsia_burchellii_leaves: ['thin', 9000, 1.5], searsia_burchellii: ['cluster', 3000], searsia_burchellii_twigs: ['thin', 1800] } },
        ],
    },
    searsiaSmall: {
        gltf: path.join(SRC, 'searsia_tree_model', 'searsia_burchellii_1k.gltf'),
        textures: path.join(SRC, 'searsia_tree_model', 'textures'),
        node: 'searsia_burchellii_small_LOD0',
        levels: [
            { name: 'searsia_small_lod0', budget: {} },   // 44,516 as authored
            { name: 'searsia_small_lod1', budget: { searsia_burchellii_leaves: ['thin', 7000, 1.2], searsia_burchellii: ['cluster', 6000], searsia_burchellii_twigs: ['thin', 2500] } },
            { name: 'searsia_small_lod2', budget: { searsia_burchellii_leaves: ['thin', 2500, 1.6], searsia_burchellii: ['cluster', 2000], searsia_burchellii_twigs: ['thin', 1000] } },
        ],
    },
};

// Grass gets three levels, rocks two.
//
// Not for file size — these meshes are small — but for DRAW cost, which is what actually bounds the
// scene. A grass clump is 714-2,489 triangles of modelled blades, not a 2-triangle card, so ground
// cover at any believable density is millions of triangles before the camera has moved: 2 clumps/m²
// inside a 25 m radius is ~4,000 clumps. The near band can afford the authored mesh; everything
// past ~12 m gets a thinned copy, and past the LOD chain the foliage system swaps in a billboard
// impostor rendered in stage 2.
//
// The THIRD grass level exists because the mid band is where the instance count lives. Area grows with
// the square of the radius, so a 14-30 m ring holds four times the clumps of the 6-14 m one — running
// it on LOD1 costs more than LOD0 and LOD1 together. At ~120 triangles a clump reads as a tuft rather
// than as blades, which is all it has to do at 14 m, and the ring lands near 720k instead of 1.15M.
const GRASS_NODES = ['grass_medium_02_a', 'grass_medium_02_b', 'grass_medium_02_c', 'grass_medium_02_d', 'grass_medium_02_e'];
const ROCK_NODES = ['rock_moss_set_02_rock07', 'rock_moss_set_02_rock08', 'rock_moss_set_02_rock09', 'rock_moss_set_02_rock10',
    'rock_moss_set_02_rock11', 'rock_moss_set_02_rock12', 'rock_moss_set_02_rock13'];

const report = [];

/** The longest edge in a mesh — the cheap tell for a clustering pass that has gone wrong. */
function maxEdge(mesh) {
    const { positions: p, indices: idx } = mesh;
    let m = 0;
    for (let i = 0; i < idx.length; i += 3)
        for (let k = 0; k < 3; k++) {
            const a = idx[i + k], b = idx[i + (k + 1) % 3];
            const e = Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
            if (e > m) m = e;
        }
    return m;
}

function reduce(mesh, op, label) {
    if (!op) return mesh;
    const [kind, target, fatten] = op;
    const before = kind === 'cluster' ? maxEdge(mesh) : 0;
    const out = kind === 'cluster' ? cluster(mesh, target, label) : thin(mesh, target, fatten ?? 1);
    // A clustering pass that welds distant vertices together shows up here and nowhere else: the
    // triangle COUNT is whatever was asked for, the bounding box barely moves, and the only symptom is
    // a few enormous triangles across the model. That shipped once as a tree made of black sails.
    if (kind === 'cluster') {
        const after = maxEdge(out);
        if (after > before * 4 + 1e-6) {
            console.error(`FAIL: ${label} clustering stretched the longest edge `
                + `${before.toFixed(3)} m -> ${after.toFixed(3)} m`);
            process.exitCode = 1;
        }
    }
    return out;
}

function buildGroup(groupDir, src, nodeName, levels, textureDir) {
    const node = src.nodeByName(nodeName);
    const prims = src.json.meshes[node.mesh].primitives;
    const names = prims.map(p => src.materialName(p.material));
    const { table, images } = materialTable(src, [...new Set(names)]);

    // Read once, reduce many: the pine's twig accessor alone is 180 MB off disk.
    const source = prims.map(p => src.primitive(p));
    for (const level of levels) {
        const meshes = source.map(m => reduce(m, level.budget[m.material], `${level.name}/${m.material}`));
        const tris = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
        const bytes = writeGltf(path.join(groupDir, level.name + '.gltf'), meshes, images, table);
        report.push({ name: level.name, tris, bin: bytes });
        console.log(`  ${level.name.padEnd(22)} ${String(tris).padStart(8)} tris   ${(bytes / 1e6).toFixed(1)} MB bin`);
    }
    if (textureDir) copyDir(textureDir, path.join(groupDir, 'textures'));
}

console.log(`staging -> ${OUT}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const [group, cfg] of Object.entries(OPS)) {
    console.log(`${group}:`);
    const src = new GltfSource(cfg.gltf);
    try {
        buildGroup(path.join(OUT, group), src, cfg.node, cfg.levels, cfg.textures);
    } finally { src.close(); }
}

console.log('grass:');
{
    const src = new GltfSource(path.join(SRC, 'grass_foliage', 'grass_medium_02_1k.gltf'));
    try {
        for (const n of GRASS_NODES)
            buildGroup(path.join(OUT, 'grass'), src, n, [
                { name: n + '_lod0', budget: {} },
                { name: n + '_lod1', budget: { grass_medium_02: ['thin', 400, 1.5] } },
                // 280, not 120. The first attempt at 120 produced a level SPARSER than the 4-triangle
                // card impostor that takes over past it — so the chain ran dense mesh, bald mesh, full
                // card, and the bald ring between them read as bare ground with a wall of grass behind
                // it. An impostor is the cheapest representation and every level above it has to be at
                // least as full. Fatten is lower for the same reason: at 280 there are enough blades
                // left that widening them makes blades rather than paddles.
                { name: n + '_lod2', budget: { grass_medium_02: ['thin', 280, 1.9] } },
            ], n === GRASS_NODES[0] ? path.join(SRC, 'grass_foliage', 'textures') : null);
    } finally { src.close(); }
}

console.log('rocks:');
{
    const src = new GltfSource(path.join(SRC, 'rocks_foliage', 'rock_moss_set_02_1k.gltf'));
    try {
        for (const n of ROCK_NODES)
            // LOD0 is the authored mesh. A boulder is the one prop the camera gets close to, its
            // silhouette is its whole read, and 8k triangles on a handful of instances is cheap next
            // to the grass — decimating it was saving in the wrong place.
            buildGroup(path.join(OUT, 'rocks'), src, n, [
                { name: n + '_lod0', budget: {} },
                { name: n + '_lod1', budget: { rock_moss_set_02: ['cluster', 1600] } },
            ], n === ROCK_NODES[0] ? path.join(SRC, 'rocks_foliage', 'textures') : null);
    } finally { src.close(); }
}

// Both ground materials. Ground103 is brown soil, Ground110 is gravel/scree — the two surfaces the
// terrain layers are built from. Roughness and AmbientOcclusion are deliberately NOT staged: a terrain
// layer samples albedo, normal and displacement only — `Terrain._deriveLayerSurface` turns metallic
// and roughness into scalars — so shipping them would be megabytes no shader ever reads.
const GROUND_SETS = [
    ['ground_material_textures', ['Ground103_1K-PNG_Color.png', 'Ground103_1K-PNG_NormalGL.png', 'Ground103_1K-PNG_Displacement.png']],
    ['ground_material_2_textures', ['Ground110_1K-JPG_Color.jpg', 'Ground110_1K-JPG_NormalGL.jpg', 'Ground110_1K-JPG_Displacement.jpg']],
];
console.log('ground:');
{
    const gdir = path.join(OUT, 'ground');
    fs.mkdirSync(gdir, { recursive: true });
    for (const [dir, files] of GROUND_SETS)
        for (const f of files) {
            fs.copyFileSync(path.join(SRC, dir, f), path.join(gdir, f));
            console.log(`  ${f.padEnd(38)} ${(fs.statSync(path.join(gdir, f)).size / 1e6).toFixed(1)} MB`);
        }
}

const total = report.reduce((n, r) => n + r.tris, 0);
console.log(`\ntotal unique geometry: ${total} triangles across ${report.length} meshes`);
fs.writeFileSync(path.join(OUT, 'decimate-report.json'), JSON.stringify({ total, meshes: report }, null, 2));
// The budget is bundle size, not the GPU — draw cost is set by the LOD distances and densities in the
// builder page, not by how detailed a prototype is. A vertex costs ~56 bytes in `assets.bin`, so 2M
// triangles is roughly 130 MB of it.
if (total > 2000000) {
    console.error(`FAIL: ${total} triangles is past the 2M budget — assets.bin would be over ~130 MB`);
    process.exit(1);
}
console.log('OK');

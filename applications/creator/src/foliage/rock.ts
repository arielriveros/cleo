// Rocks: a displaced icosphere, cut, layered and flattened, decimated to a triangle budget, with its own
// baked albedo and normal map.
//
// Shape (the standard procedural-rock recipe): a dense icosphere scaled to the rock's proportions,
// displaced along each vertex's direction by fBm blended toward ridged noise, then planar FRACTURE CUTS
// (every vertex beyond a random plane is pushed back onto it -- the flat broken faces real rocks have),
// optional strata, and a flattened base so it sits on the ground. The dense mesh is then decimated with
// the editor's QEM simplifier to LOD 0's budget, and again for each lower level: displacing a dense mesh
// and decimating keeps the silhouette far better than displacing a coarse sphere.
//
// Texture: every vertex keeps the icosphere direction it started from, and that direction picks a CUBE
// FACE and a gnomonic coordinate on it -- six charts that never overlap, however the surface folds,
// because the direction (unlike the position) is unique per vertex. The albedo is baked into that layout
// from the dense surface: solid 3D noise for the stone, convex crests lighter (edge wear), cavities and
// the base darker (dirt), upward faces mossy. The decimated levels keep those uvs, so one texture serves
// every level.

import { simplify } from '@cleo/app-kit/geometry/simplify';
import type { RockParams } from './foliageParams';
import { normalize, type FoliageLevel, type FoliagePart, type PartBuffers, type V3 } from './mesh';
import { fbm3, noiseSeed, ridged3, valueNoise3 } from './noise';
import { stream } from './rng';
import { createImage, dilateColor, mixRgb, normalFromHeight, putLinear, rasterTriangle, rgb, scaleRgb, type Image } from './textures/image';

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** A unit icosphere: directions and triangles. */
function icosphere(subdivisions: number): { dirs: number[]; tris: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const dirs: number[] = [];
  const add = (x: number, y: number, z: number) => { const l = Math.hypot(x, y, z); dirs.push(x / l, y / l, z / l); return dirs.length / 3 - 1; };
  [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
   [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].forEach(v => add(v[0], v[1], v[2]));
  let tris = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map<number, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? a * 1e6 + b : b * 1e6 + a;
      let m = cache.get(key);
      if (m === undefined) {
        m = add(dirs[a * 3] + dirs[b * 3], dirs[a * 3 + 1] + dirs[b * 3 + 1], dirs[a * 3 + 2] + dirs[b * 3 + 2]);
        cache.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i], b = tris[i + 1], c = tris[i + 2];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    tris = next;
  }
  return { dirs, tris };
}

/** The cube face a direction projects onto: 0..5 = +X -X +Y -Y +Z -Z. */
function faceOf(x: number, y: number, z: number): number {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) return x >= 0 ? 0 : 1;
  if (ay >= az) return y >= 0 ? 2 : 3;
  return z >= 0 ? 4 : 5;
}

/** Gnomonic (a, b) of a direction on face `f`, roughly -1..1 over the face. */
function gnomonic(f: number, x: number, y: number, z: number): [number, number] {
  const k = (v: number) => 1 / Math.max(0.25, v);
  switch (f) {
    case 0: return [-z * k(x), -y * k(x)];
    case 1: return [z * k(-x), -y * k(-x)];
    case 2: return [x * k(y), z * k(y)];
    case 3: return [x * k(-y), -z * k(-y)];
    case 4: return [x * k(z), -y * k(z)];
    default: return [-x * k(-z), -y * k(-z)];
  }
}

/** Atlas layout: 3 x 2 cells; the content fills the inner part of each so seams get padding. */
function chartUv(f: number, a: number, b: number): [number, number] {
  const cx = f % 3, cy = Math.floor(f / 3);
  const reach = 1.18;                       // straddling triangles reach a little past the face
  const inner = 0.94;
  const u = (cx + 0.5 + (a / reach) * 0.5 * inner) / 3;
  const v = (cy + 0.5 + (b / reach) * 0.5 * inner) / 2;
  return [u, v];
}

interface Dense {
  positions: Float32Array;
  normals: Float32Array;
  dirs: Float32Array;
  /** Per vertex: positive in cavities, negative on crests; about -1..1. */
  curvature: Float32Array;
  tris: Uint32Array;
  height: number;
}

function denseRock(seed: number, p: RockParams): Dense {
  const { dirs, tris } = icosphere(p.detail);
  const n = dirs.length / 3;
  const pos = new Float32Array(n * 3);
  const sN = noiseSeed(seed, 'rockShape'), sR = noiseSeed(seed, 'rockRidge'), sS = noiseSeed(seed, 'rockStrata');
  const half = p.size * 0.5;
  const prop = p.proportions;
  const strataAxis = normalize([stream(seed, 'strata').signed() * 0.25, 1, stream(seed, 'strata', 1).signed() * 0.25] as V3);
  for (let i = 0; i < n; i++) {
    const x = dirs[i * 3], y = dirs[i * 3 + 1], z = dirs[i * 3 + 2];
    const f = p.noiseScale;
    const smoothN = fbm3(sN, x * f + 11, y * f + 7, z * f + 3, 5);
    const sharpN = ridged3(sR, x * f * 0.8 + 5, y * f * 0.8 + 1, z * f * 0.8 + 9, 5) * 2 - 1;
    let r = 1 + p.noiseAmount * (smoothN * (1 - p.sharpness) + sharpN * p.sharpness);
    if (p.strata > 0) {
      const along = x * strataAxis[0] + y * strataAxis[1] + z * strataAxis[2];
      const wobble = fbm3(sS, x * 2, y * 2, z * 2, 3) * 0.6;
      const band = Math.sin((along + wobble * 0.15) * p.strataFrequency * Math.PI);
      // Terraced: the band's sign steps the radius in and out, softened.
      r += p.strata * 0.05 * Math.tanh(band * 3);
    }
    pos[i * 3] = x * r * half * prop[0];
    pos[i * 3 + 1] = y * r * half * prop[1];
    pos[i * 3 + 2] = z * r * half * prop[2];
  }

  // Fracture cuts: push everything beyond each plane back onto it.
  for (let c = 0; c < p.cuts; c++) {
    const r = stream(seed, 'cut', c);
    // Mostly sideways and upward planes: a cut through the base would only be flattened away.
    const nrm = normalize([r.signed(), r.range(-0.2, 1), r.signed()] as V3);
    let extent = -Infinity;
    for (let i = 0; i < n; i++) extent = Math.max(extent, pos[i * 3] * nrm[0] + pos[i * 3 + 1] * nrm[1] + pos[i * 3 + 2] * nrm[2]);
    const d = extent - p.size * p.cutDepth * r.range(0.5, 1.2);
    for (let i = 0; i < n; i++) {
      const k = pos[i * 3] * nrm[0] + pos[i * 3 + 1] * nrm[1] + pos[i * 3 + 2] * nrm[2] - d;
      if (k > 0) { pos[i * 3] -= nrm[0] * k; pos[i * 3 + 1] -= nrm[1] * k; pos[i * 3 + 2] -= nrm[2] * k; }
    }
  }

  // Flatten the base, then stand it on y = 0, sunk a little so no light shows under it.
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { minY = Math.min(minY, pos[i * 3 + 1]); maxY = Math.max(maxY, pos[i * 3 + 1]); }
  const floor = minY + (maxY - minY) * p.flattenBottom * 0.5;
  for (let i = 0; i < n; i++) if (pos[i * 3 + 1] < floor) pos[i * 3 + 1] = floor;
  const sink = (maxY - floor) * 0.03;
  for (let i = 0; i < n; i++) pos[i * 3 + 1] -= floor + sink;

  // Area-weighted normals.
  const nrm = new Float32Array(n * 3);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) { nrm[v] += fx; nrm[v + 1] += fy; nrm[v + 2] += fz; }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]) || 1;
    nrm[i * 3] /= l; nrm[i * 3 + 1] /= l; nrm[i * 3 + 2] /= l;
  }

  // Curvature: how far the neighbours sit above (cavity) or below (crest) the tangent plane.
  const curv = new Float32Array(n), count = new Float32Array(n);
  const edge = (i: number, j: number) => {
    const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
    const l = Math.hypot(dx, dy, dz) || 1;
    curv[i] += (dx * nrm[i * 3] + dy * nrm[i * 3 + 1] + dz * nrm[i * 3 + 2]) / l;
    count[i]++;
  };
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    edge(a, b); edge(a, c); edge(b, a); edge(b, c); edge(c, a); edge(c, b);
  }
  for (let i = 0; i < n; i++) curv[i] /= Math.max(1, count[i]);
  // Normalised by its own spread (90th percentile of |curvature|), so the wear and dirt thresholds mean
  // the same thing at every detail level -- finer meshes have smaller angles between neighbours.
  // The median is the overall roundness every vertex of a boulder shares; only departures from it are
  // crests and cavities.
  const median = Float32Array.from(curv).sort()[Math.floor(n * 0.5)];
  for (let i = 0; i < n; i++) curv[i] -= median;
  const spread = Float32Array.from(curv, Math.abs).sort()[Math.floor(n * 0.9)] || 1;
  for (let i = 0; i < n; i++) curv[i] = Math.max(-1.5, Math.min(1.5, curv[i] / spread));

  return { positions: pos, normals: nrm, dirs: new Float32Array(dirs), curvature: curv, tris: new Uint32Array(tris), height: maxY - floor - sink };
}

/** Split the dense mesh per chart and give every vertex its chart uv. */
function charted(d: Dense): { buffers: PartBuffers; corners: Uint32Array } {
  const map = new Map<number, number>();
  const pos: number[] = [], nrm: number[] = [], uvs: number[] = [], src: number[] = [];
  const idx = new Uint32Array(d.tris.length);
  for (let t = 0; t < d.tris.length; t += 3) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) { const v = d.tris[t + k]; cx += d.dirs[v * 3]; cy += d.dirs[v * 3 + 1]; cz += d.dirs[v * 3 + 2]; }
    const f = faceOf(cx, cy, cz);
    for (let k = 0; k < 3; k++) {
      const v = d.tris[t + k];
      const key = v * 6 + f;
      let out = map.get(key);
      if (out === undefined) {
        out = pos.length / 3;
        map.set(key, out);
        pos.push(d.positions[v * 3], d.positions[v * 3 + 1], d.positions[v * 3 + 2]);
        nrm.push(d.normals[v * 3], d.normals[v * 3 + 1], d.normals[v * 3 + 2]);
        const [a, b] = gnomonic(f, d.dirs[v * 3], d.dirs[v * 3 + 1], d.dirs[v * 3 + 2]);
        const [u, vv] = chartUv(f, a, b);
        uvs.push(u, vv);
        src.push(v);
      }
      idx[t + k] = out;
    }
  }
  return {
    buffers: { positions: new Float32Array(pos), normals: new Float32Array(nrm), uvs: new Float32Array(uvs), indices: idx },
    corners: new Uint32Array(src),
  };
}

/** Bake albedo and normal map into the chart layout from the dense, charted surface. */
function bakeRockTextures(seed: number, p: RockParams, d: Dense, mesh: PartBuffers, source: Uint32Array): { albedo: Image; normal: Image } {
  const size = p.textureSize;
  const albedo = createImage(size, size);
  const heights = new Float32Array(size * size);
  const covered = new Uint8Array(size * size);
  const sC = noiseSeed(seed, 'rockColor'), sF = noiseSeed(seed, 'rockFine'), sM = noiseSeed(seed, 'rockMoss');
  const base = rgb(p.color), moss = rgb(p.mossColor);
  const light = mixRgb(base, [0.72, 0.7, 0.66], 0.45);
  const dark = scaleRgb(base, 0.4);
  const inv = 1 / Math.max(0.05, p.size);
  const { positions: P, normals: N, uvs: U, indices: I } = mesh;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ca = d.curvature[source[a]], cb = d.curvature[source[b]], cc = d.curvature[source[c]];
    rasterTriangle(size, size, U[a * 2] * size, U[a * 2 + 1] * size, U[b * 2] * size, U[b * 2 + 1] * size, U[c * 2] * size, U[c * 2 + 1] * size,
      (x, y, w0, w1, w2) => {
        const px = (P[a * 3] * w0 + P[b * 3] * w1 + P[c * 3] * w2) * inv;
        const py = (P[a * 3 + 1] * w0 + P[b * 3 + 1] * w1 + P[c * 3 + 1] * w2) * inv;
        const pz = (P[a * 3 + 2] * w0 + P[b * 3 + 2] * w1 + P[c * 3 + 2] * w2) * inv;
        const ny = N[a * 3 + 1] * w0 + N[b * 3 + 1] * w1 + N[c * 3 + 1] * w2;
        const curv = ca * w0 + cb * w1 + cc * w2;
        const i = y * size + x;
        // Stone: broad tonal patches, a finer grain and dark speckle.
        const broad = fbm3(sC, px * 2.2, py * 2.2, pz * 2.2, 4);
        const grain = fbm3(sF, px * 14, py * 14, pz * 14, 3);
        const speck = valueNoise3(sF + 1, px * 60, py * 60, pz * 60);
        let col = mixRgb(base, broad > 0 ? light : dark, Math.abs(broad) * p.colorVariation * 1.6);
        col = scaleRgb(col, 0.9 + grain * 0.25 * (0.5 + p.colorVariation) - (speck > 0.92 ? 0.25 : 0));
        if (p.strata > 0) col = scaleRgb(col, 1 + 0.18 * p.strata * Math.sin(py * p.size * p.strataFrequency * 2.4 + broad * 2));
        // Edge wear on crests, dirt in cavities and toward the base.
        const crest = smoothstep(-0.15, -0.9, curv);
        const cavity = smoothstep(0.1, 0.8, curv);
        const base01 = d.height > 0 ? Math.max(0, py * p.size / d.height) : 1;
        const ground = smoothstep(0.25, 0, base01);
        col = mixRgb(col, light, crest * p.edgeWear * 0.7);
        col = scaleRgb(col, 1 - p.cavityDirt * (cavity * 0.55 + ground * 0.35));
        // Moss on faces that look up, broken up by noise.
        if (p.moss > 0) {
          const m = smoothstep(0.35, 0.85, ny + (fbm3(sM, px * 4, py * 4, pz * 4, 4)) * 0.6) * p.moss;
          col = mixRgb(col, scaleRgb(moss, 0.8 + grain * 0.4), Math.min(1, m * 1.4));
        }
        putLinear(albedo, i, col[0], col[1], col[2], 1);
        heights[i] = 0.5 + grain * 0.35 + (speck - 0.5) * 0.08 - cavity * 0.1;
        covered[i] = 1;
      });
  }
  dilateColor(albedo, i => covered[i] === 1);
  // Heights spread the same way, via a grey image.
  const grey = createImage(size, size);
  for (let i = 0; i < size * size; i++) { const g = Math.round(Math.min(1, Math.max(0, heights[i])) * 255); grey.data[i * 4] = grey.data[i * 4 + 1] = grey.data[i * 4 + 2] = g; grey.data[i * 4 + 3] = 255; }
  dilateColor(grey, i => covered[i] === 1);
  for (let i = 0; i < size * size; i++) heights[i] = grey.data[i * 4] / 255;
  return { albedo, normal: normalFromHeight(heights, size, size, p.bumpiness * 1.5, false) };
}

const asSimplify = (b: PartBuffers) => ({ ...b, tangents: new Float32Array(0), bitangents: new Float32Array(0) });
const fromSimplify = (s: ReturnType<typeof simplify>): PartBuffers => ({ positions: s.positions, normals: s.normals, uvs: s.uvs, indices: s.indices });

export interface RockBuild {
  levels: FoliageLevel[];
  albedo: Image;
  normal: Image;
  /** A sphere that encloses most of the rock, for the sidecar's collider suggestion. */
  collider: { center: V3; radius: number };
}

export function buildRock(seed: number, p: RockParams, overrides: { albedo?: Image; normal?: Image } = {}): RockBuild {
  const dense = denseRock(seed, p);
  const { buffers, corners } = charted(dense);
  const textures = overrides.albedo && overrides.normal
    ? { albedo: overrides.albedo, normal: overrides.normal }
    : (() => { const t = bakeRockTextures(seed, p, dense, buffers, corners); return { albedo: overrides.albedo ?? t.albedo, normal: overrides.normal ?? t.normal }; })();

  const denseTris = buffers.indices.length / 3;
  const lod0 = fromSimplify(simplify(asSimplify(buffers), Math.min(1, p.triangles / denseTris)));
  const lod0Tris = lod0.indices.length / 3;
  const lod1 = fromSimplify(simplify(asSimplify(lod0), p.lod1Ratio));
  const lod2 = fromSimplify(simplify(asSimplify(lod1), Math.min(1, (p.lod2Ratio * lod0Tris) / Math.max(1, lod1.indices.length / 3))));
  const part = (b: PartBuffers): FoliagePart => ({ name: 'Rock', material: 'rock', buffers: b });

  // Collider: the sphere around the box centre covering ~the rock (QEM-free, from the dense mesh).
  let min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < dense.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], dense.positions[i + k]); max[k] = Math.max(max[k], dense.positions[i + k]);
  }
  const center: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.min(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 0.5 * 1.1;

  return {
    levels: [
      { parts: [part(lod0)], distance: 0 },
      { parts: [part(lod1)], distance: p.lod1Distance },
      { parts: [part(lod2)], distance: p.lod2Distance },
    ],
    albedo: textures.albedo,
    normal: textures.normal,
    collider: { center, radius },
  };
}

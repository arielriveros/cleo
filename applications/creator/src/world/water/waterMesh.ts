// The preview water's geometry: flat quads over every wet cell at its water level (the sea's, or its
// lake's), grown one cell so the edge tucks under the bank, merged along rows so a sea is a few hundred
// quads rather than a quad per cell. When there is sea, a ring of large quads carries it out to the
// horizon around the map. Positions are world space for a map centred on the origin.

import { WATER_DRY, type WaterMap } from '../lakes';

export interface WaterGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  tangents: Float32Array;
  bitangents: Float32Array;
  indices: Uint32Array;
}

export function buildWaterMesh(water: Pick<WaterMap, 'resolution' | 'level' | 'kind' | 'seaLevel'>, size: number, horizon = 8): WaterGeometry | null {
  const R = water.resolution;
  const cell = size / (R - 1);
  const half = size / 2;
  // Quad (c, r) spans samples c..c+1, r..r+1. Its level: the highest wet corner's (NaN when all dry),
  // then grown into dry neighbours so the surface reaches under the bank.
  const Q = R - 1;
  const level = new Float32Array(Q * Q).fill(NaN);
  for (let r = 0; r < Q; r++) for (let c = 0; c < Q; c++) {
    let best = NaN;
    for (const i of [r * R + c, r * R + c + 1, (r + 1) * R + c, (r + 1) * R + c + 1]) {
      if (water.kind[i] === WATER_DRY) continue;
      const l = water.level[i];
      if (!(best >= l)) best = l;
    }
    level[r * Q + c] = best;
  }
  const grown = Float32Array.from(level);
  for (let r = 0; r < Q; r++) for (let c = 0; c < Q; c++) {
    if (!Number.isNaN(level[r * Q + c])) continue;
    let best = NaN;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= Q || cc >= Q) continue;
      const l = level[rr * Q + cc];
      if (!Number.isNaN(l) && !(best >= l)) best = l;
    }
    grown[r * Q + c] = best;
  }

  const pos: number[] = [];
  const idx: number[] = [];
  const quad = (x0: number, z0: number, x1: number, z1: number, y: number) => {
    const b = pos.length / 3;
    pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
    // Counter-clockwise seen from above (+Y), the engine's front face.
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  };
  for (let r = 0; r < Q; r++) {
    let c = 0;
    while (c < Q) {
      const l = grown[r * Q + c];
      if (Number.isNaN(l)) { c++; continue; }
      let e = c + 1;
      while (e < Q && grown[r * Q + e] === l) e++;
      quad(-half + c * cell, -half + r * cell, -half + e * cell, -half + (r + 1) * cell, l);
      c = e;
    }
  }

  // The open sea goes on past the map's edge.
  let sea = false;
  for (let i = 0; i < R && !sea; i++) sea = water.kind[i] !== WATER_DRY || water.kind[(R - 1) * R + i] !== WATER_DRY || water.kind[i * R] !== WATER_DRY || water.kind[i * R + R - 1] !== WATER_DRY;
  if (sea) {
    const y = water.seaLevel, far = half * horizon;
    quad(-far, -far, far, -half, y);
    quad(-far, half, far, far, y);
    quad(-far, -half, -half, half, y);
    quad(half, -half, far, half, y);
  }
  if (!idx.length) return null;

  const n = pos.length / 3;
  const normals = new Float32Array(n * 3);
  const tangents = new Float32Array(n * 3);
  const bitangents = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    normals[i * 3 + 1] = 1;
    tangents[i * 3] = 1;
    bitangents[i * 3 + 2] = 1;
    uvs[i * 2] = pos[i * 3] / size;
    uvs[i * 2 + 1] = pos[i * 3 + 2] / size;
  }
  return { positions: Float32Array.from(pos), normals, uvs, tangents, bitangents, indices: Uint32Array.from(idx) };
}

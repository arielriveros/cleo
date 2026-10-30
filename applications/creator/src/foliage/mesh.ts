// Geometry plumbing shared by the grass, rock and tree generators: a growable builder, the part/level
// shapes the rest of the pipeline passes around, and the vector helpers the generators lean on.
//
// Plain arrays and typed arrays only -- no `cleo`, no DOM -- so it runs in the generation worker and in
// tests. The engine's `Geometry` is built from these on the main thread, through the glTF importer.

export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: V3): V3 => { const l = length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const mix = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Rotate `v` about the unit axis `k` by `angle` radians (Rodrigues). */
export function rotateAxis(v: V3, k: V3, angle: number): V3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const kv = cross(k, v), kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/** Any unit vector perpendicular to the unit vector `n`. */
export function perpendicular(n: V3): V3 {
  return normalize(Math.abs(n[1]) < 0.9 ? cross(n, [0, 1, 0]) : cross(n, [1, 0, 0]));
}

/** Which material a part is drawn with. One part per material: instanced foliage needs it that way. */
export type MaterialKey = 'grass' | 'grassCard' | 'rock' | 'bark' | 'leaves';

/** One part's buffers: the shape `simplify` (app-kit) takes and returns, minus tangents. */
export interface PartBuffers {
  positions: Float32Array;
  normals: Float32Array;
  /** v = 0 at the TOP row of the image (glTF's convention, which the engine's importer follows). */
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface FoliagePart {
  name: string;
  material: MaterialKey;
  buffers: PartBuffers;
}

/** One level of detail: its parts and its switch distance (metres from the bounding sphere's surface). */
export interface FoliageLevel {
  parts: FoliagePart[];
  distance: number;
}

export const triangles = (level: { parts: FoliagePart[] }) =>
  level.parts.reduce((n, p) => n + p.buffers.indices.length / 3, 0);
export const vertices = (level: { parts: FoliagePart[] }) =>
  level.parts.reduce((n, p) => n + p.buffers.positions.length / 3, 0);

/** Growable vertex/index lists, frozen into typed arrays by {@link build}. */
export class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number { return this.positions.length / 3; }

  vertex(p: V3, n: V3, u: number, v: number): number {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.uvs.push(u, v);
    return this.positions.length / 3 - 1;
  }

  /** Counter-clockwise seen from the front, glTF's winding. */
  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** `a b c d` counter-clockwise from the front. */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  build(): PartBuffers {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
    };
  }
}

/** The axis-aligned bounds of a set of levels' parts. */
export function boundsOf(parts: readonly FoliagePart[]): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const a = p.buffers.positions;
    for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) {
      if (a[i + k] < min[k]) min[k] = a[i + k];
      if (a[i + k] > max[k]) max[k] = a[i + k];
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

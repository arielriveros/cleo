import {
  Node, ModelNode, Model, Geometry, Material, Texture, TextureManager, WindNode, ForceFieldNode, LandscapeNode,
  WindFieldSnapshot, windFieldClock, createWindSample, WIND_SOURCE_FLOATS, markEditorOnly,
} from 'cleo';
import type { Scene, WindSample } from 'cleo';

// The scene's wind FIELD, drawn in the viewport (eye menu ▸ Wind field, or whenever the Wind node or a
// Force Field that moves the air is selected). The field is a function of position and time
// (core/wind/windField.ts, the CPU twin of what the foliage bends to on the GPU), so the overlay samples it
// itself, every frame, on the frame's own wind clock — what you see is exactly the air the grass is in:
//
//  - ARROWS on a grid round the camera, a power-of-two spacing from the camera's height, snapped so they
//    stay put in the world as the view moves. Each one is the air at the grass there: it points the way
//    the air goes, and its length and colour (blue calm → red gale) pulse with the gusts rolling through.
//  - TRACERS: streaks carried by the air, so the flow itself shows — a whirlwind's ring, a blast's burst,
//    eddies tumbling downwind, the lull behind a shelter.
//  - SOURCES: every Force Field that moves the air, as a glyph of what it does (arrows, spokes in or out,
//    a spinning ring, eddies, a shelter's cross) inside its outline.
//
// Lines are one pixel and have no per-vertex colour, so each vertex picks its colour AND its opacity from a
// small lookup texture through its uv (u = speed, v = alpha): one draw per layer, any number of colours.
// Every buffer is allocated once at its largest and rewritten in place; unused lines collapse to nothing.

/** The overlay's root; one per scene. */
export const WIND_FIELD_OVERLAY = '__debug__windfield';
const ARROWS = '__debug__windfield_arrows';
const TRACERS = '__debug__windfield_tracers';
const SOURCES = '__debug__windfield_sources';

/** The colour/opacity lookup every layer samples (registerWindFieldLut). */
export const WIND_LUT = '__editor__wind_lut';
export const WIND_LUT_WIDTH = 64;
export const WIND_LUT_HEIGHT = 8;
/** The speed (m/s) at the red end of the ramp: a storm's full gust (strength 2). */
export const WIND_LUT_MAX_SPEED = 14;

/** Arrows per side of the grid (odd: one sits under the grid centre). */
export const ARROW_GRID = 21;
const ARROW_VERTS = 4;
export const TRACER_COUNT = 128;
export const TRACER_POINTS = 16;
/** Seconds between the points a tracer leaves behind. */
const TRACER_STEP = 0.08;
export const SOURCE_SEGMENTS = 160;
const MAX_SOURCES = 8;

// ---- Colour -----------------------------------------------------------------------------------------

/** The ramp, sRGB: calm blue, cyan, green, yellow, orange, gale red. */
const RAMP: [number, [number, number, number]][] = [
  [0, [58, 109, 240]], [0.2, [40, 200, 235]], [0.4, [70, 215, 110]], [0.6, [245, 220, 60]], [0.8, [245, 140, 45]], [1, [232, 68, 58]],
];

/** The lookup texture's bytes: x = speed (0..WIND_LUT_MAX_SPEED), y = alpha (row j = j / (height - 1)). */
export function buildWindLut(): Uint8Array {
  const out = new Uint8Array(WIND_LUT_WIDTH * WIND_LUT_HEIGHT * 4);
  for (let x = 0; x < WIND_LUT_WIDTH; x++) {
    const t = x / (WIND_LUT_WIDTH - 1);
    let k = 1;
    while (k < RAMP.length - 1 && RAMP[k][0] < t) k++;
    const [t0, c0] = RAMP[k - 1], [t1, c1] = RAMP[k];
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    for (let y = 0; y < WIND_LUT_HEIGHT; y++) {
      const o = (y * WIND_LUT_WIDTH + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(c0[c] + (c1[c] - c0[c]) * f);
      out[o + 3] = Math.round(255 * y / (WIND_LUT_HEIGHT - 1));
    }
  }
  return out;
}

/** Register the lookup texture once. Needs the GPU device, so it runs on the overlay's first use. */
export function registerWindFieldLut(): void {
  const textures = TextureManager.Instance;
  if (textures.getTexture(WIND_LUT)) return;
  const texture = new Texture({ mipMap: false });
  texture.createFromData(buildWindLut(), WIND_LUT_WIDTH, WIND_LUT_HEIGHT, 'clamp');
  textures.addTexture(texture, WIND_LUT);
}

const sat = (x: number) => Math.min(1, Math.max(0, x));

/** The uv that reads `speed` (m/s) at opacity `alpha` from the lookup, at texel centres. */
export function windLutUv(speed: number, alpha: number, out: number[] = [0, 0]): number[] {
  out[0] = (0.5 + (WIND_LUT_WIDTH - 1) * sat(speed / WIND_LUT_MAX_SPEED)) / WIND_LUT_WIDTH;
  out[1] = (0.5 + (WIND_LUT_HEIGHT - 1) * sat(alpha)) / WIND_LUT_HEIGHT;
  return out;
}

// ---- Vertex writing ---------------------------------------------------------------------------------

/** Where position and uv sit in a model's interleaved vertex (Geometry.getData order), in floats. */
export interface VertexLayout { stride: number; position: number; uv: number }

const ATTRIBUTE_FLOATS: [string, number][] = [['position', 3], ['normal', 3], ['uv', 2], ['tangent', 3], ['bitangent', 3]];

/** The layout a mesh was packed with, from `ModelNode.vertexAttributes`. Null when it has no position or uv. */
export function vertexLayout(attributes: readonly string[]): VertexLayout | null {
  let stride = 0, position = -1, uv = -1;
  for (const [name, floats] of ATTRIBUTE_FLOATS) {
    if (!attributes.includes(name)) continue;
    if (name === 'position') position = stride;
    if (name === 'uv') uv = stride;
    stride += floats;
  }
  return position < 0 || uv < 0 ? null : { stride, position, uv };
}

/** A layer's CPU copy of its vertices, rewritten every frame and uploaded whole. */
export class LineBuffer {
  public data: Float32Array = new Float32Array(0);
  public layout: VertexLayout | null = null;
  private readonly _uv = [0, 0];

  constructor(public readonly vertexCount: number) {}

  /** Match `attributes` (a mesh's packed layout). False when there is nothing to write into. */
  public bind(attributes: readonly string[]): boolean {
    const layout = vertexLayout(attributes);
    if (!layout) return false;
    if (!this.layout || this.layout.stride !== layout.stride || this.layout.uv !== layout.uv) {
      this.layout = layout;
      this.data = new Float32Array(this.vertexCount * layout.stride);
      // Normals, where the layout has them, point up once and for all.
      const n = layout.position + 3 === layout.uv ? -1 : layout.position + 3;
      if (n >= 0) for (let i = 0; i < this.vertexCount; i++) this.data[i * layout.stride + n + 1] = 1;
    }
    return true;
  }

  /** Vertex `i` at (x, y, z), coloured for `speed` at opacity `alpha`. */
  public set(i: number, x: number, y: number, z: number, speed: number, alpha: number): void {
    const l = this.layout!;
    const o = i * l.stride;
    const d = this.data;
    d[o + l.position] = x; d[o + l.position + 1] = y; d[o + l.position + 2] = z;
    const uv = windLutUv(speed, alpha, this._uv);
    d[o + l.uv] = uv[0]; d[o + l.uv + 1] = uv[1];
  }

  /** Vertex `i` gone: collapsed onto the origin, fully transparent. */
  public clear(i: number): void { this.set(i, 0, 0, 0, 0, 0); }
}

// ---- Grid -------------------------------------------------------------------------------------------

/**
 * The arrow spacing (m) for a camera `height` above the ground: a power of two near 0.3 of it, 1 to 16 m.
 * `previous` adds hysteresis, so a camera hovering at a boundary does not flicker between two grids.
 */
export function windGridSpacing(height: number, previous: number | null = null): number {
  const raw = Math.min(16, Math.max(1, 0.3 * Math.max(0, height)));
  if (previous && raw > previous / (Math.SQRT2 * 1.15) && raw < previous * Math.SQRT2 * 1.15) return previous;
  return 2 ** Math.round(Math.log2(raw));
}

/** The grid's centre: a little ahead of the camera on the ground, snapped to the spacing. */
export function windGridCentre(camX: number, camZ: number, forwardX: number, forwardZ: number, spacing: number): [number, number] {
  const half = (ARROW_GRID - 1) / 2 * spacing;
  const fl = Math.hypot(forwardX, forwardZ);
  const ahead = fl > 1e-4 ? 0.5 * half / fl : 0;
  return [Math.round((camX + forwardX * ahead) / spacing) * spacing, Math.round((camZ + forwardZ * ahead) / spacing) * spacing];
}

/** 1 inside the grid, fading to 0 over its outer 30% (the square's own measure). */
export function edgeFade(dx: number, dz: number, half: number): number {
  const t = Math.max(Math.abs(dx), Math.abs(dz)) / Math.max(half, 1e-6);
  const s = sat((t - 0.7) / 0.3);
  return 1 - s * s * (3 - 2 * s);
}

/** The ground under world (x, z): the landscape there, else `fallback`. */
export function groundHeightAt(scene: Scene, x: number, z: number, fallback: number): number {
  for (const landscape of scene.landscapes as Iterable<LandscapeNode>) {
    const terrain = landscape.terrain;
    if (!terrain) continue;
    const o = terrain.origin, half = terrain.size / 2;
    const lx = x - o[0], lz = z - o[2];
    if (Math.abs(lx) > half || Math.abs(lz) > half) continue;
    return o[1] + terrain.heightAt(lx, lz);
  }
  return fallback;
}

/**
 * One arrow into `buf` at vertex `first` (4 vertices: tail, tip, two barbs): from (x, y, z) along `v`
 * (m/s), `spacing` long at full speed. Its length grows with the square root of the speed, so a breeze
 * still shows and a gale does not overrun its neighbours.
 */
export function writeArrow(buf: LineBuffer, first: number, x: number, y: number, z: number, v: readonly number[],
                           spacing: number, alpha: number): void {
  const speed = Math.hypot(v[0], v[1], v[2]);
  if (!(speed > 1e-3) || !(alpha > 0.004)) { for (let k = 0; k < ARROW_VERTS; k++) buf.clear(first + k); return; }
  const len = 0.85 * spacing * Math.sqrt(sat(speed / 14));
  const dx = v[0] / speed, dy = v[1] / speed, dz = v[2] / speed;
  // The tail sits half behind the sample point, so the arrow is centred on where it was measured.
  const tx = x - dx * len * 0.5, ty = y - dy * len * 0.5, tz = z - dz * len * 0.5;
  const hx = tx + dx * len, hy = ty + dy * len, hz = tz + dz * len;
  // Barbs in the plane of the arrow and the horizontal across it (straight up: across X).
  let px = -dz, pz = dx;
  const pl = Math.hypot(px, pz);
  if (pl < 1e-3) { px = 1; pz = 0; } else { px /= pl; pz /= pl; }
  const back = 0.28 * len * Math.cos(28 * Math.PI / 180), side = 0.28 * len * Math.sin(28 * Math.PI / 180);
  buf.set(first, tx, ty, tz, speed, alpha * 0.6);
  buf.set(first + 1, hx, hy, hz, speed, alpha);
  buf.set(first + 2, hx - dx * back + px * side, hy - dy * back, hz - dz * back + pz * side, speed, alpha);
  buf.set(first + 3, hx - dx * back - px * side, hy - dy * back, hz - dz * back - pz * side, speed, alpha);
}

/** Line pairs for `count` arrows of 4 vertices. */
export function arrowIndices(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) { const b = i * ARROW_VERTS; out.push(b, b + 1, b + 1, b + 2, b + 1, b + 3); }
  return out;
}

// ---- Tracers ----------------------------------------------------------------------------------------

/** A seeded uniform random in [0, 1) (mulberry32): the same field always seeds the same tracers. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The air at a point, written into `out` (m/s). */
export type WindSampler = (x: number, y: number, z: number, out: number[]) => number[];

/** Where tracers live: a square round (cx, cz), `half` across, and the ground under it. */
export interface TracerRegion { cx: number; cz: number; half: number; ground: (x: number, z: number) => number }

/**
 * Streaks carried by the air: `count` tracers, each the last TRACER_POINTS places it has been. Advected
 * with the midpoint rule; reborn when old, when they leave the region or when the air stalls them.
 */
export class WindTracers {
  /** Per tracer: the trail, newest first, as x, y, z, speed. */
  public readonly trail: Float32Array;
  public readonly age: Float32Array;
  public readonly life: Float32Array;
  private readonly _since: Float32Array;
  private readonly _stalled: Float32Array;
  private readonly _rand: () => number;
  private readonly _a = [0, 0, 0];
  private readonly _b = [0, 0, 0];

  constructor(public readonly count = TRACER_COUNT, seed = 1) {
    this.trail = new Float32Array(count * TRACER_POINTS * 4);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this._since = new Float32Array(count);
    this._stalled = new Float32Array(count);
    this._rand = seededRandom(seed);
    // Born dead, so the first step seeds them all (each part way through a life, so they do not pulse).
    this.age.fill(Infinity);
  }

  /** Begin tracer `i` again somewhere in `region`, a random way into a fresh life. */
  public spawn(i: number, region: TracerRegion, staggered: boolean): void {
    const r = this._rand;
    const x = region.cx + (r() * 2 - 1) * region.half, z = region.cz + (r() * 2 - 1) * region.half;
    const y = region.ground(x, z) + 0.6 + r() * 1.9;
    this.life[i] = 2.5 + r() * 2.5;
    this.age[i] = staggered ? r() * this.life[i] * 0.8 : 0;
    this._since[i] = 0;
    this._stalled[i] = 0;
    const t = this.trail;
    for (let k = 0; k < TRACER_POINTS; k++) {
      const o = (i * TRACER_POINTS + k) * 4;
      t[o] = x; t[o + 1] = y; t[o + 2] = z; t[o + 3] = 0;
    }
  }

  /** Advance every tracer by `dt` seconds through `sample`. */
  public step(dt: number, sample: WindSampler, region: TracerRegion): void {
    const t = this.trail;
    const reach = region.half * 1.1;
    for (let i = 0; i < this.count; i++) {
      const head = i * TRACER_POINTS * 4;
      if (!(this.age[i] < this.life[i])) { this.spawn(i, region, !Number.isFinite(this.age[i])); continue; }
      if (dt <= 0) continue;
      const x = t[head], y = t[head + 1], z = t[head + 2];
      const a = sample(x, y, z, this._a);
      const b = sample(x + a[0] * dt * 0.5, y + a[1] * dt * 0.5, z + a[2] * dt * 0.5, this._b);
      const nx = x + b[0] * dt, nz = z + b[2] * dt;
      const g = region.ground(nx, nz);
      const ny = Math.min(g + 8, Math.max(g + 0.3, y + b[1] * dt));
      const speed = Math.hypot(b[0], b[1], b[2]);
      this.age[i] += dt;
      this._stalled[i] = speed < 0.05 ? this._stalled[i] + dt : 0;
      if (Math.abs(nx - region.cx) > reach || Math.abs(nz - region.cz) > reach || this._stalled[i] > 1) {
        this.spawn(i, region, false);
        continue;
      }
      // A new trail point every TRACER_STEP; between them the head just moves.
      this._since[i] += dt;
      if (this._since[i] >= TRACER_STEP) {
        this._since[i] = 0;
        t.copyWithin(head + 4, head, head + (TRACER_POINTS - 1) * 4);
      }
      t[head] = nx; t[head + 1] = ny; t[head + 2] = nz; t[head + 3] = speed;
    }
  }

  /** The trails into `buf`: tracer i's point k is vertex i * TRACER_POINTS + k. */
  public write(buf: LineBuffer, region: TracerRegion): void {
    const t = this.trail;
    for (let i = 0; i < this.count; i++) {
      const life = this.life[i] > 0 ? sat(this.age[i] / this.life[i]) : 1;
      // Fades in over its first fifth and out over its last.
      const lifeFade = Math.min(sat(life / 0.2), sat((1 - life) / 0.2));
      for (let k = 0; k < TRACER_POINTS; k++) {
        const o = (i * TRACER_POINTS + k) * 4;
        const alpha = lifeFade * (1 - k / (TRACER_POINTS - 1)) * edgeFade(t[o] - region.cx, t[o + 2] - region.cz, region.half);
        buf.set(i * TRACER_POINTS + k, t[o], t[o + 1], t[o + 2], t[o + 3], alpha * 0.9);
      }
    }
  }
}

/** Line pairs for `count` trails of TRACER_POINTS vertices. */
export function tracerIndices(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) for (let k = 0; k < TRACER_POINTS - 1; k++) out.push(i * TRACER_POINTS + k, i * TRACER_POINTS + k + 1);
  return out;
}

// ---- Source glyphs ----------------------------------------------------------------------------------

/** One segment, for the glyph planner. */
export type Segment = [number, number, number, number, number, number];

const KIND_NAMES = ['directional', 'radial', 'vortex', 'turbulence', 'drag'] as const;

/**
 * What one packed wind source (ForceFieldNode.packInto, world space) looks like, as world segments: its
 * outline (a sphere's three rings or a box's edges) and a glyph of what it does — arrows along a
 * directional field, spokes out of a blast (heads outward) or into an inflow (heads inward), a ring with
 * heads turning the vortex's way round its axis, little eddy rings, and a cross for a shelter.
 */
export function sourceGlyph(sources: ArrayLike<number>, index: number): { kind: typeof KIND_NAMES[number]; strength: number; segments: Segment[] } {
  const o = index * WIND_SOURCE_FLOATS;
  const px = sources[o], py = sources[o + 1], pz = sources[o + 2];
  const kind = KIND_NAMES[Math.round(sources[o + 3])] ?? 'directional';
  let ux = sources[o + 4], uy = sources[o + 5], uz = sources[o + 6];
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  const strength = sources[o + 7];
  const shape = Math.round(sources[o + 8]);
  const ex = sources[o + 12], ey = sources[o + 13], ez = sources[o + 14];
  const R = shape === 1 ? sources[o + 9] : shape === 2 ? Math.max(Math.min(ex, ez), 0.5) : 3;
  const segs: Segment[] = [];
  const ring = (cx: number, cy: number, cz: number, ax: [number, number, number], bx: [number, number, number], r: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
      const c0 = Math.cos(a0) * r, s0 = Math.sin(a0) * r, c1 = Math.cos(a1) * r, s1 = Math.sin(a1) * r;
      segs.push([cx + ax[0] * c0 + bx[0] * s0, cy + ax[1] * c0 + bx[1] * s0, cz + ax[2] * c0 + bx[2] * s0,
                 cx + ax[0] * c1 + bx[0] * s1, cy + ax[1] * c1 + bx[1] * s1, cz + ax[2] * c1 + bx[2] * s1]);
    }
  };
  const arrow = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    segs.push([x0, y0, z0, x1, y1, z1]);
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) return;
    let sx = -dz, sz = dx;
    const sl = Math.hypot(sx, sz);
    if (sl < 1e-4) { sx = 1; sz = 0; } else { sx /= sl; sz /= sl; }
    const h = Math.min(0.3 * l, R * 0.25), bk = h * 0.88 / l, sd = h * 0.47;
    for (const sign of [1, -1]) segs.push([x1, y1, z1, x1 - dx * bk + sx * sd * sign, y1 - dy * bk, z1 - dz * bk + sz * sd * sign]);
  };

  // Outline.
  if (shape === 1) {
    ring(px, py, pz, [1, 0, 0], [0, 0, 1], R, 32);
    ring(px, py, pz, [1, 0, 0], [0, 1, 0], R, 32);
    ring(px, py, pz, [0, 1, 0], [0, 0, 1], R, 32);
  } else if (shape === 2) {
    for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) {
      if (i & bit) continue;
      const j = i | bit;
      const c = (k: number): [number, number, number] =>
        [px + ((k & 1) ? ex : -ex), py + ((k & 2) ? ey : -ey), pz + ((k & 4) ? ez : -ez)];
      segs.push([...c(i), ...c(j)] as Segment);
    }
  }

  // An orthonormal frame round the field's axis.
  let ax: [number, number, number] = Math.abs(uy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const bx: [number, number, number] = [uy * ax[2] - uz * ax[1], uz * ax[0] - ux * ax[2], ux * ax[1] - uy * ax[0]];
  const bl = Math.hypot(...bx) || 1; bx[0] /= bl; bx[1] /= bl; bx[2] /= bl;
  ax = [bx[1] * uz - bx[2] * uy, bx[2] * ux - bx[0] * uz, bx[0] * uy - bx[1] * ux];

  if (kind === 'directional') {
    const l = 0.8 * R * Math.sign(strength || 1);
    for (const off of [0, 0.45, -0.45]) {
      const cx = px + bx[0] * off * R, cy = py + bx[1] * off * R, cz = pz + bx[2] * off * R;
      arrow(cx - ux * l * 0.5, cy - uy * l * 0.5, cz - uz * l * 0.5, cx + ux * l * 0.5, cy + uy * l * 0.5, cz + uz * l * 0.5);
    }
  } else if (kind === 'radial') {
    // Negative strength blasts outward: heads at the rim. Positive draws in: heads at the core.
    const out = strength < 0;
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
      const inner = [px + cx * R * 0.3, py, pz + cz * R * 0.3], outer = [px + cx * R * 0.85, py, pz + cz * R * 0.85];
      if (out) arrow(inner[0], inner[1], inner[2], outer[0], outer[1], outer[2]);
      else arrow(outer[0], outer[1], outer[2], inner[0], inner[1], inner[2]);
    }
  } else if (kind === 'vortex') {
    const r = 0.7 * R;
    ring(px, py, pz, ax, bx, r, 32);
    // Heads along cross(axis, radial): counter-clockwise round +axis for positive strength.
    const turn = Math.sign(strength || 1);
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2 + Math.PI / 4;
      const rx = ax[0] * Math.cos(a) + bx[0] * Math.sin(a), ry = ax[1] * Math.cos(a) + bx[1] * Math.sin(a), rz = ax[2] * Math.cos(a) + bx[2] * Math.sin(a);
      const tx = (uy * rz - uz * ry) * turn, ty = (uz * rx - ux * rz) * turn, tz = (ux * ry - uy * rx) * turn;
      const hx = px + rx * r, hy = py + ry * r, hz = pz + rz * r, h = 0.15 * R;
      for (const side of [1, -1])
        segs.push([hx, hy, hz, hx - tx * h + rx * h * 0.5 * side, hy - ty * h + ry * h * 0.5 * side, hz - tz * h + rz * h * 0.5 * side]);
    }
  } else if (kind === 'turbulence') {
    for (const [ox, oz, s] of [[-0.35, -0.2, 0.22], [0.3, -0.1, 0.18], [0, 0.35, 0.2]] as const)
      ring(px + ox * R, py, pz + oz * R, [1, 0, 0], [0, 0, 1], s * R, 16);
  } else {
    const r = 0.6 * R;
    segs.push([px - r, py, pz - r, px + r, py, pz + r], [px - r, py, pz + r, px + r, py, pz - r]);
  }
  return { kind, strength, segments: segs.slice(0, SOURCE_SEGMENTS) };
}

// ---- The overlay ------------------------------------------------------------------------------------

/**
 * Whether the overlay should be up: the eye menu's switch, or a selection that is about the wind — the
 * Wind node, or a Force Field that moves the air — in a scene that has any wind to draw.
 */
export function windOverlayWanted(show: boolean, selected: Node | null, scene: Scene): boolean {
  const aboutWind = selected instanceof WindNode || (selected instanceof ForceFieldNode && selected.affectsWind);
  if (!show && !aboutWind) return false;
  if (scene.wind) return true;
  for (const f of scene.forceFields) if (f.affectsWind) return true;
  return false;
}

/** Builds a layer's line node (injectable for tests). */
export type WindWireBuilder = (name: string, vertexCount: number, indices: number[]) => ModelNode;

/** The editor's: a Basic wireframe sampling the lookup, every vertex starting invisible. */
export const buildWindWire: WindWireBuilder = (name, vertexCount, indices) => {
  const positions: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  const uvs: [number, number][] = [];
  const hidden = windLutUv(0, 0);
  for (let i = 0; i < vertexCount; i++) { positions.push([0, 0, 0]); normals.push([0, 1, 0]); uvs.push([hidden[0], hidden[1]]); }
  const node = new ModelNode(name, new Model(new Geometry(positions, normals, uvs, undefined, undefined, indices, false),
    Material.Basic({ color: [1, 1, 1], texture: WIND_LUT }, { wireframe: true, castShadow: false })));
  markEditorOnly(node);
  return node;
};

interface Layer { node: ModelNode; buf: LineBuffer }
interface OverlayState {
  arrows: Layer; tracers: Layer; sources: Layer;
  field: WindFieldSnapshot;
  tracerField: WindTracers;
  spacing: number | null;
  lastTime: number;
}
const states = new WeakMap<Node, OverlayState>();

/**
 * Keep the overlay up in `scene`: a `__debug__windfield` root with its three layers, ticking every frame.
 * Idempotent; the reconciler calls it on every pass while the overlay is wanted.
 */
export function ensureWindFieldOverlay(scene: Scene, options: { buildWire?: WindWireBuilder; registerLut?: () => void } = {}): Node {
  let root = scene.getNodesByName(WIND_FIELD_OVERLAY)[0];
  if (!root) {
    (options.registerLut ?? registerWindFieldLut)();
    root = new Node(WIND_FIELD_OVERLAY);
    markEditorOnly(root);
    scene.addNode(root);
  }
  let state = states.get(root);
  if (!state) {
    const build = options.buildWire ?? buildWindWire;
    const layer = (name: string, vertexCount: number, indices: number[]): Layer => {
      const node = build(name, vertexCount, indices);
      root!.addChild(node);
      return { node, buf: new LineBuffer(vertexCount) };
    };
    const arrowCount = ARROW_GRID * ARROW_GRID;
    const sourcePairs: number[] = [];
    for (let i = 0; i < MAX_SOURCES * SOURCE_SEGMENTS * 2; i++) sourcePairs.push(i);
    state = {
      arrows: layer(ARROWS, arrowCount * ARROW_VERTS, arrowIndices(arrowCount)),
      tracers: layer(TRACERS, TRACER_COUNT * TRACER_POINTS, tracerIndices(TRACER_COUNT)),
      sources: layer(SOURCES, MAX_SOURCES * SOURCE_SEGMENTS * 2, sourcePairs),
      field: new WindFieldSnapshot(),
      tracerField: new WindTracers(TRACER_COUNT, 7),
      spacing: null,
      lastTime: windFieldClock.time,
    };
    states.set(root, state);
  }
  const owner = root, s = state;
  // Re-bound on every pass: the scene it ticks against is the one being reconciled.
  root.onUpdate = () => tickWindFieldOverlay(owner, s, scene);
  return root;
}

/** Take the overlay out of `scene`, buffers and all. */
export function dropWindFieldOverlay(scene: Scene): void {
  for (const root of scene.getNodesByName(WIND_FIELD_OVERLAY)) {
    const state = states.get(root);
    if (state) for (const layer of [state.arrows, state.tracers, state.sources]) layer.node.dispose();
    states.delete(root);
    root.onUpdate = () => {};
    scene.removeNode(root);
  }
}

const _sample: WindSample = createWindSample();
const _v = [0, 0, 0];

/** One frame of the overlay. Exported for tests. */
export function tickWindFieldOverlay(root: Node, state: OverlayState, scene: Scene): void {
  const camera = scene.activeCamera?.camera;
  if (!camera) return;
  const time = windFieldClock.time;
  const dt = Math.min(0.1, Math.max(0, time - state.lastTime));
  state.lastTime = time;
  const field = state.field.capture(scene, time);
  const cam = camera.position;
  const view = camera.viewMatrix;
  const fallback = scene.wind ? scene.wind.worldPosition[1] : 0;
  const ground = (x: number, z: number) => groundHeightAt(scene, x, z, fallback);

  // The grid, from the camera's height over the ground under it.
  const spacing = state.spacing = windGridSpacing(cam[1] - ground(cam[0], cam[2]), state.spacing);
  const [cx, cz] = windGridCentre(cam[0], cam[2], -view[2], -view[10], spacing);
  const half = (ARROW_GRID - 1) / 2 * spacing;
  const lift = Math.min(3, Math.max(0.6, 0.35 * spacing));
  const sampler: WindSampler = (x, y, z, out) => {
    field.sample(x, y, z, _sample);
    out[0] = _sample.velocity[0]; out[1] = _sample.velocity[1]; out[2] = _sample.velocity[2];
    return out;
  };

  const arrows = state.arrows;
  if (arrows.buf.bind(arrows.node.vertexAttributes)) {
    let i = 0;
    for (let gz = 0; gz < ARROW_GRID; gz++) for (let gx = 0; gx < ARROW_GRID; gx++, i++) {
      const x = cx + (gx - (ARROW_GRID - 1) / 2) * spacing, z = cz + (gz - (ARROW_GRID - 1) / 2) * spacing;
      const g = ground(x, z);
      // The air the grass is in, drawn just above it.
      const v = sampler(x, g + 0.1, z, _v);
      const speed = Math.hypot(v[0], v[1], v[2]);
      const alpha = edgeFade(x - cx, z - cz, half) * (0.35 + 0.65 * sat(speed / 7));
      writeArrow(arrows.buf, i * ARROW_VERTS, x, g + lift, z, v, spacing, alpha);
    }
    upload(arrows);
  }

  const region: TracerRegion = { cx, cz, half, ground };
  state.tracerField.step(dt, sampler, region);
  const tracers = state.tracers;
  if (tracers.buf.bind(tracers.node.vertexAttributes)) {
    state.tracerField.write(tracers.buf, region);
    upload(tracers);
  }

  const sources = state.sources;
  if (sources.buf.bind(sources.node.vertexAttributes)) {
    let v = 0;
    for (let s = 0; s < MAX_SOURCES; s++) {
      if (s < field.count) {
        const glyph = sourceGlyph(field.sources, s);
        const speed = glyph.kind === 'drag' ? 0 : Math.abs(glyph.strength);
        for (const seg of glyph.segments) {
          sources.buf.set(v++, seg[0], seg[1], seg[2], speed, 0.95);
          sources.buf.set(v++, seg[3], seg[4], seg[5], speed, 0.95);
        }
      }
      const end = (s + 1) * SOURCE_SEGMENTS * 2;
      while (v < end) sources.buf.clear(v++);
    }
    upload(sources);
  }
}

function upload(layer: Layer): void {
  if (!layer.node.initialized) return;
  layer.node.model.mesh.updateVertexData(layer.buf.data);
}

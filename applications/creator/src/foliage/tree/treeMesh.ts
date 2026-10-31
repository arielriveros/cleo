// A tree skeleton as meshes: bark tubes and leaf cards, at three levels of detail.
//
// Branches are generalized cylinders: a ring of vertices at every spine point, oriented by
// parallel-transported frames (rotation-minimizing, so the rings never twist and the bark never spirals),
// with a duplicated seam column so the bark's u wraps cleanly. u counts whole bark repeats around the
// stem and v is arc length in the same unit, so bark texels stay square on thick and thin stems alike.
// Children start inside their parent and emerge through its surface: no welding, and at a tree's scale
// nothing shows.
//
// LODs, all from the one skeleton (so they line up exactly):
//   LOD 0  every stem, 10/6/4/3 sides by level, every spine point, every leaf card (folded and curled).
//   LOD 1  twigs dropped when there are three levels, 6/4/3 sides, every other spine point; a share of
//          the leaf cards (folded), each grown so the crown keeps its coverage.
//   LOD 2  trunk and first-level branches only, 5/3 sides, every third spine point, a smaller share of
//          larger flat cards.
//
// Bark is bumped (burls, knots, trunk flutes) by noise at each ring vertex's world position, so every
// level shows the same relief; its normals are the bumped surface's own.
// Beyond LOD 2 the octahedral impostor takes over (lod/impostor.ts).

import type { TreeParams } from '../foliageParams';
import { add, cross, dot, length, MeshBuilder, normalize, perpendicular, scale, sub, type FoliageLevel, type FoliagePart, type V3 } from '../mesh';
import { fbm3, noiseSeed, ridged3 } from '../noise';
import { atlasCell } from '../textures/leaves';
import { levelImperfections, type LeafCard, type Skeleton, type Stem } from './skeleton';

export interface LodSpec {
  maxLevel: number;
  sides: number[];
  stride: number;
  /** Spine-point stride per stem level, replacing `stride` (and the trunk's finer one). */
  strides?: number[];
  leafShare: number;
  /**
   * Leaf cards: 'full' bends them over all of the Leaves section's Segments, 'half' over half of them, a
   * number over at most that many; 0 or absent keeps flat quads.
   */
  leafRows?: 'full' | 'half' | number;
}

function lodSpecs(p: LevelParams): LodSpec[] {
  return [
    { maxLevel: 3, sides: [10, 6, 4, 3], stride: 1, leafShare: 1, leafRows: 'full' },
    { maxLevel: p.levels >= 3 ? 2 : 3, sides: [6, 4, 3, 3], stride: 2, leafShare: p.lod1Leaves, leafRows: 'half' },
    { maxLevel: 1, sides: [5, 3, 3, 3], stride: 3, leafShare: p.lod2Leaves },
  ];
}

/** Keep every `stride`-th point, always including both ends. */
function thin<T>(items: T[], stride: number): T[] {
  if (stride <= 1 || items.length <= 2) return items;
  const out: T[] = [];
  for (let i = 0; i < items.length - 1; i += stride) out.push(items[i]);
  out.push(items[items.length - 1]);
  return out;
}

/** Bark relief: burls and knots everywhere, flutes on the trunk. One per stem. */
interface Bumps { amount: number; scale: number; seed: number }

/**
 * A stem's radius at a ring vertex, with its bumps: noise sampled at the UNBUMPED world position, so the
 * seam column matches and every LOD (other sides, other spine points) carries the same relief. In
 * proportion to the radius, so twigs never balloon; the trunk adds vertical fluting.
 */
function bumpedRadius(b: Bumps, at: V3, dir: V3, r: number, angle: number, arc: number, trunk: boolean): number {
  if (b.amount <= 0) return r;
  const q = add(at, scale(dir, r));
  const f = 1 / b.scale;
  let k = fbm3(b.seed, q[0] * f, q[1] * f, q[2] * f, 4) * 0.35;
  // Knots: sparse, sharper swellings.
  k += Math.max(0, fbm3(b.seed + 17, q[0] * f * 0.5, q[1] * f * 0.5, q[2] * f * 0.5, 2) - 0.25) * 0.6;
  if (trunk) k += (ridged3(b.seed + 31, Math.cos(angle) * 1.6, Math.sin(angle) * 1.6, arc * f * 0.15, 3) - 0.5) * 0.3;
  return r * Math.max(0.4, 1 + b.amount * k);
}

/**
 * A stem's radius profile along its length, before the ring bumps: a collar where a branch leaves its
 * parent (the bark ridge swells over its first radius and a half) and slow lumps, so a branch thickens
 * and thins irregularly rather than tapering like a cone. Sampled by arc length, so every LOD agrees.
 */
function profile(b: Bumps, stem: Stem, key: number, arc: number): number {
  let k = 1;
  const r0 = stem.radii[0];
  if (stem.level > 0) {
    const c = Math.max(0, 1 - arc / (r0 * 1.5));
    k += 0.35 * c * c * (3 - 2 * c);
  }
  if (b.amount > 0) k += b.amount * 0.2 * fbm3(b.seed + 53, arc / Math.max(0.02, r0 * 8), key * 7.31, 0.5, 3);
  return Math.max(0.5, k);
}

function stemMesh(mb: MeshBuilder, stem: Stem, key: number, sides: number, stride: number, barkScale: number, bumps: Bumps): void {
  const pts = thin(stem.points, stride);
  const radii = thin(stem.radii, stride);
  const n = pts.length;
  if (n < 2) return;
  // u: whole bark repeats around the stem's base circumference; v: arc length in the same unit.
  const circumference = 2 * Math.PI * radii[0];
  const repeats = Math.max(1, Math.round(circumference / Math.max(0.05, barkScale)));
  const vScale = repeats > 0 ? circumference / repeats : barkScale;
  const tangents: V3[] = pts.map((_, i) => normalize(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)])));
  let frame = perpendicular(tangents[0]);
  let arc = 0;
  // Every ring's positions and directions first: the bumped normals read the neighbours.
  const pos: V3[][] = [], dirs: V3[][] = [], arcs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) arc += length(sub(pts[i], pts[i - 1]));
    arcs.push(arc);
    const t = tangents[i];
    // Parallel transport: remove the new tangent's component from the previous frame.
    frame = normalize(sub(frame, scale(t, dot(frame, t))));
    const bi = cross(t, frame);
    const ringPos: V3[] = [], ringDir: V3[] = [];
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const dir = normalize(add(scale(frame, Math.cos(a)), scale(bi, Math.sin(a))));
      const r = radii[i] * profile(bumps, stem, key, arc);
      ringPos.push(add(pts[i], scale(dir, bumpedRadius(bumps, pts[i], dir, r, a, arc, stem.level === 0))));
      ringDir.push(dir);
    }
    pos.push(ringPos); dirs.push(ringDir);
  }
  const rings: number[] = [];
  for (let i = 0; i < n; i++) {
    rings.push(mb.vertexCount);
    for (let k = 0; k <= sides; k++) {
      let normal = dirs[i][k];
      if (bumps.amount > 0 || stem.level > 0) {
        // The bumped surface's own normal, from its neighbours around (seam-wrapped) and along.
        const around = sub(pos[i][k === sides ? 1 : k + 1], pos[i][k === 0 ? sides - 1 : k - 1]);
        const along = sub(pos[Math.min(n - 1, i + 1)][k], pos[Math.max(0, i - 1)][k]);
        const g = normalize(cross(around, along));
        if (Number.isFinite(g[0]) && length(g) > 0.5) normal = dot(g, normal) < 0 ? scale(g, -1) : g;
      }
      mb.vertex(pos[i][k], normal, (k / sides) * repeats, arcs[i] / vScale);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    for (let k = 0; k < sides; k++) mb.quad(r0 + k, r0 + k + 1, r1 + k + 1, r1 + k);
  }
  // Close the tip with a fan to one point just past the last ring.
  const last = rings[n - 1];
  const tip = mb.vertex(add(pts[n - 1], scale(tangents[n - 1], radii[n - 1])), tangents[n - 1], 0.5 * repeats, (arcs[n - 1] + radii[n - 1]) / vScale);
  for (let k = 0; k < sides; k++) mb.triangle(last + k, last + k + 1, tip);
}

/** How a card bends: the Leaves section's shape fields. */
export interface LeafShapeParams { fold: number; curl: number; twist: number; wave: number; jitter: number; cupped: boolean }

/**
 * One leaf card. Flat (one quad) when `rows` is 0. Otherwise a grid, `rows` along the card and 2 (V) or 4
 * (cupped) across, every vertex placed by the card's shape: folded across its midline, curled back along
 * its length, its cross-section twisted turn by turn, rippled, and each card a little different (jitter
 * from its stable key). Normals come from the bent grid, half-blended with the crown-bent card normal so
 * the canopy still shades as one volume.
 */
function leafMesh(mb: MeshBuilder, card: LeafCard, grow: number, rows: number, shape: LeafShapeParams): void {
  const s = card.size * grow;
  const w = s * 0.5;
  const [u0, v0, u1, v1] = atlasCell(card.cell);
  // Card winding follows its geometric face (side x up); the shading normal is the bent one.
  const face = cross(card.side, card.up);
  const n = dot(face, card.normal) < 0 ? scale(card.normal, -1) : card.normal;
  const bends = shape.fold > 0 || shape.curl > 0 || shape.twist > 0 || shape.wave > 0;
  if (rows <= 0 || !bends) {
    const bl = add(card.anchor, scale(card.side, -w));
    const br = add(card.anchor, scale(card.side, w));
    const tr = add(br, scale(card.up, s));
    const tl = add(bl, scale(card.up, s));
    const a = mb.vertex(bl, n, u0, v1), b = mb.vertex(br, n, u1, v1);
    const c = mb.vertex(tr, n, u1, v0), d = mb.vertex(tl, n, u0, v0);
    mb.quad(a, b, c, d);
    return;
  }
  // Per-card variation, from the card's stable key: the same card bends the same way at every LOD.
  const k = card.key * 997.13;
  const jit = (o: number) => 1 + shape.jitter * 0.6 * Math.sin(k * (1.7 + o) + o * 2.1);
  const fold = shape.fold * jit(0), twist = shape.twist * jit(1) * (Math.sin(k * 3.1) < 0 ? -1 : 1);
  const wave = shape.wave * jit(2), phase = k * 5.3;
  const front = dot(face, n) < 0 ? scale(face, -1) : face;
  const cols = shape.cupped ? 4 : 2;
  const power = shape.cupped ? 2 : 1;
  const P: V3[][] = [];
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    // The spine: up the card, the tip curling back behind it, rippling along its length.
    const ripple = Math.sin(t * Math.PI * 2 + phase) * wave * w * 0.15 * t;
    const spine = add(add(card.anchor, scale(card.up, s * t)), scale(front, -shape.curl * s * 0.3 * t * t + ripple));
    // The cross-section turns about the card's length as it goes.
    const angle = twist * 0.7 * t;
    const side = add(scale(card.side, Math.cos(angle)), scale(front, Math.sin(angle)));
    const out = add(scale(front, Math.cos(angle)), scale(card.side, -Math.sin(angle)));
    const row: V3[] = [];
    for (let c = 0; c <= cols; c++) {
      const a = (c / cols) * 2 - 1;                        // -1 .. 1 across
      const crease = -fold * w * 0.6 * Math.pow(1 - Math.abs(a), power);
      row.push(add(add(spine, scale(side, a * w)), scale(out, crease)));
    }
    P.push(row);
  }
  const ids: number[][] = [];
  for (let r = 0; r <= rows; r++) {
    const row: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const across = sub(P[r][Math.min(cols, c + 1)], P[r][Math.max(0, c - 1)]);
      const along = sub(P[Math.min(rows, r + 1)][c], P[Math.max(0, r - 1)][c]);
      let g = normalize(cross(across, along));
      if (!Number.isFinite(g[0]) || length(g) < 0.5) g = n;
      if (dot(g, n) < 0) g = scale(g, -1);
      row.push(mb.vertex(P[r][c], normalize(add(g, n)), u0 + (u1 - u0) * (c / cols), v1 + (v0 - v1) * (r / rows)));
    }
    ids.push(row);
  }
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) mb.quad(ids[r][c], ids[r][c + 1], ids[r + 1][c + 1], ids[r + 1][c]);
}

type LevelParams = Pick<TreeParams, 'levels' | 'lod1Distance' | 'lod1Leaves' | 'lod2Distance' | 'lod2Leaves' | 'barkScale'>
  & Partial<Omit<TreeParams, 'levels' | 'lod1Distance' | 'lod1Leaves' | 'lod2Distance' | 'lod2Leaves' | 'barkScale'>>;

/** The three levels; `specs` replaces the tree's ladder (a bush's thin stems need fewer sides). */
export function treeLevels(skeleton: Skeleton, p: LevelParams, specs: LodSpec[] = lodSpecs(p)): FoliageLevel[] {
  const distances = [0, p.lod1Distance, p.lod2Distance];
  const bumpSeed = noiseSeed(skeleton.seed ?? 0, 'bark-bumps');
  // A branch's bumps are at its own scale: knots a few radii across, never trunk-sized blobs on a twig.
  const bumpsOf = skeleton.stems.map((stem): Bumps => ({
    amount: levelImperfections(p as TreeParams, stem.level).bumps,
    scale: Math.max(0.02, Math.min(p.barkBumpScale ?? 0.35, stem.radii[0] * 6)),
    seed: bumpSeed,
  }));
  const shape: LeafShapeParams = {
    fold: p.leafFold ?? 0, curl: p.leafCurl ?? 0, twist: p.leafTwist ?? 0, wave: p.leafWave ?? 0,
    jitter: p.leafJitter ?? 0, cupped: p.leafFoldShape === 'cupped',
  };
  const segments = Math.max(1, Math.round(p.leafSegments ?? 2));
  return specs.map((spec, li) => {
    const bark = new MeshBuilder();
    skeleton.stems.forEach((stem, si) => {
      if (stem.level > spec.maxLevel) return;
      const stride = spec.strides?.[Math.min(3, stem.level)] ?? (stem.level === 0 ? Math.max(1, spec.stride - 1) : spec.stride);
      stemMesh(bark, stem, si, spec.sides[Math.min(3, stem.level)], stride, p.barkScale, bumpsOf[si]);
    });
    const rows = spec.leafRows === 'full' ? segments : spec.leafRows === 'half' ? Math.ceil(segments / 2)
      : Math.min(segments, spec.leafRows ?? 0);
    const parts: FoliagePart[] = [{ name: 'Bark', material: 'bark', buffers: bark.build() }];
    if (skeleton.leaves.length) {
      const leaves = new MeshBuilder();
      // Grow survivors so the crown's leaf area holds: area scales with the square of size.
      const grow = 1 / Math.sqrt(spec.leafShare);
      for (const card of skeleton.leaves)
        if (card.key < spec.leafShare) leafMesh(leaves, card, Math.min(2.6, grow), rows, shape);
      if (leaves.vertexCount) parts.push({ name: 'Leaves', material: 'leaves', buffers: leaves.build() });
    }
    return { parts, distance: distances[li] };
  });
}

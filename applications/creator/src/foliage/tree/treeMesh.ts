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
//   LOD 0  every stem, 10/6/4/3 sides by level, every spine point, every leaf card.
//   LOD 1  twigs dropped when there are three levels, 6/4/3 sides, every other spine point; a share of
//          the leaf cards, each grown so the crown keeps its coverage.
//   LOD 2  trunk and first-level branches only, 5/3 sides, every third spine point, a smaller share of
//          larger cards.
// Beyond LOD 2 the octahedral impostor takes over (lod/impostor.ts).

import type { TreeParams } from '../foliageParams';
import { add, cross, dot, length, MeshBuilder, normalize, perpendicular, scale, sub, type FoliageLevel, type FoliagePart, type V3 } from '../mesh';
import { atlasCell } from '../textures/leaves';
import type { LeafCard, Skeleton, Stem } from './skeleton';

export interface LodSpec {
  maxLevel: number;
  sides: number[];
  stride: number;
  /** Spine-point stride per stem level, replacing `stride` (and the trunk's finer one). */
  strides?: number[];
  leafShare: number;
}

function lodSpecs(p: LevelParams): LodSpec[] {
  return [
    { maxLevel: 3, sides: [10, 6, 4, 3], stride: 1, leafShare: 1 },
    { maxLevel: p.levels >= 3 ? 2 : 3, sides: [6, 4, 3, 3], stride: 2, leafShare: p.lod1Leaves },
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

function stemMesh(mb: MeshBuilder, stem: Stem, sides: number, stride: number, barkScale: number): void {
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
  const rings: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) arc += length(sub(pts[i], pts[i - 1]));
    const t = tangents[i];
    // Parallel transport: remove the new tangent's component from the previous frame.
    frame = normalize(sub(frame, scale(t, dot(frame, t))));
    const bi = cross(t, frame);
    rings.push(mb.vertexCount);
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const dir = normalize(add(scale(frame, Math.cos(a)), scale(bi, Math.sin(a))));
      mb.vertex(add(pts[i], scale(dir, radii[i])), dir, (k / sides) * repeats, arc / vScale);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    for (let k = 0; k < sides; k++) mb.quad(r0 + k, r0 + k + 1, r1 + k + 1, r1 + k);
  }
  // Close the tip with a fan to one point just past the last ring.
  const last = rings[n - 1];
  const tip = mb.vertex(add(pts[n - 1], scale(tangents[n - 1], radii[n - 1])), tangents[n - 1], 0.5 * repeats, (arc + radii[n - 1]) / vScale);
  for (let k = 0; k < sides; k++) mb.triangle(last + k, last + k + 1, tip);
}

function leafMesh(mb: MeshBuilder, card: LeafCard, grow: number): void {
  const s = card.size * grow;
  const w = s * 0.5;
  const [u0, v0, u1, v1] = atlasCell(card.cell);
  const bl = add(card.anchor, scale(card.side, -w));
  const br = add(card.anchor, scale(card.side, w));
  const tr = add(br, scale(card.up, s));
  const tl = add(bl, scale(card.up, s));
  // Card winding follows its geometric face (side x up); the shading normal is the bent one.
  const face = cross(card.side, card.up);
  const n = dot(face, card.normal) < 0 ? scale(card.normal, -1) : card.normal;
  const a = mb.vertex(bl, n, u0, v1), b = mb.vertex(br, n, u1, v1);
  const c = mb.vertex(tr, n, u1, v0), d = mb.vertex(tl, n, u0, v0);
  mb.quad(a, b, c, d);
}

type LevelParams = Pick<TreeParams, 'levels' | 'lod1Distance' | 'lod1Leaves' | 'lod2Distance' | 'lod2Leaves' | 'barkScale'>;

/** The three levels; `specs` replaces the tree's ladder (a bush's thin stems need fewer sides). */
export function treeLevels(skeleton: Skeleton, p: LevelParams, specs: LodSpec[] = lodSpecs(p)): FoliageLevel[] {
  const distances = [0, p.lod1Distance, p.lod2Distance];
  return specs.map((spec, li) => {
    const bark = new MeshBuilder();
    for (const stem of skeleton.stems) {
      if (stem.level > spec.maxLevel) continue;
      const stride = spec.strides?.[Math.min(3, stem.level)] ?? (stem.level === 0 ? Math.max(1, spec.stride - 1) : spec.stride);
      stemMesh(bark, stem, spec.sides[Math.min(3, stem.level)], stride, p.barkScale);
    }
    const parts: FoliagePart[] = [{ name: 'Bark', material: 'bark', buffers: bark.build() }];
    if (skeleton.leaves.length) {
      const leaves = new MeshBuilder();
      // Grow survivors so the crown's leaf area holds: area scales with the square of size.
      const grow = 1 / Math.sqrt(spec.leafShare);
      for (const card of skeleton.leaves) if (card.key < spec.leafShare) leafMesh(leaves, card, Math.min(2.6, grow));
      if (leaves.vertexCount) parts.push({ name: 'Leaves', material: 'leaves', buffers: leaves.build() });
    }
    return { parts, distance: distances[li] };
  });
}

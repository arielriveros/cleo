// A bush: several stems from one root crown, each grown by the tree generator as a small tree and then
// leaned out from the centre. One skeleton for the whole bush, so the tree mesher, its LOD ladder, the
// leaf atlas and the bark all carry over unchanged.
//
// Stems are placed on a sunflower spiral inside the root crown (the golden angle again), the outer ones
// leaning further out, which gives the vase-like habit most shrubs have. The leaf-normal bend runs once
// over the merged cards so the bush shades as one rounded volume, not as one ball per stem.

import { DEFAULT_TREE, type BushParams, type TreeParams } from './foliageParams';
import { add, cross, normalize, rotateAxis, type FoliageLevel, type V3 } from './mesh';
import { stream } from './rng';
import { bendLeafNormals, buildSkeleton, type LeafCard, type Skeleton, type Stem } from './tree/skeleton';
import { treeLevels, type LodSpec } from './tree/treeMesh';

const DEG = Math.PI / 180;
const UP: V3 = [0, 1, 0];

/**
 * Thin stems: fewer sides and spine points than a tree's ladder at every level. A bush is scattered by
 * the thousand and seen from a few metres, where a twig's curve between every other point does not show.
 */
function bushLods(p: BushParams): LodSpec[] {
  return [
    { maxLevel: 3, sides: [5, 4, 3, 3], stride: 2, strides: [2, 2, 3, 3], leafShare: 1, leafRows: 2 },
    { maxLevel: p.levels >= 3 ? 2 : 3, sides: [4, 3, 3, 3], stride: 3, strides: [3, 3, 4, 4], leafShare: p.lod1Leaves },
    { maxLevel: 1, sides: [3, 3, 3, 3], stride: 4, strides: [4, 4, 4, 4], leafShare: p.lod2Leaves },
  ];
}

/** One stem's tree parameters: the bush's shared fields over the tree's defaults, no flare or fork. */
function stemParams(p: BushParams, height: number, radius: number): TreeParams {
  return {
    ...DEFAULT_TREE, ...p,
    height, trunkRadius: radius, flare: 0, trunkSplit: 0,
    // Bent once over the whole bush, below.
    leafNormalBend: 0,
    impostor: false,
  };
}

export function buildBushSkeleton(seed: number, p: BushParams): Skeleton {
  const stems: Stem[] = [];
  const leaves: LeafCard[] = [];
  const r = stream(seed, 'bush');
  for (let i = 0; i < p.stems; i++) {
    // Sunflower spiral: radial fraction sqrt((i + 0.5) / n), turned by the golden angle.
    const radial = p.stems === 1 ? 0 : Math.sqrt((i + 0.5) / p.stems);
    const az = i * 137.5 * DEG + r.signed() * 0.4;
    const out: V3 = [Math.cos(az), 0, Math.sin(az)];
    const base: V3 = [out[0] * p.spread * radial, 0, out[2] * p.spread * radial];
    const lean = p.lean * DEG * (0.3 + 0.7 * radial) * r.vary(1, 0.25);
    const height = p.height * r.vary(1, p.heightVariance) * (1 - 0.15 * radial);
    const stemSeed = (seed * 31 + i * 7919 + 1) & 0x7fffffff;
    const sk = buildSkeleton(stemSeed, stemParams(p, height, p.stemRadius * r.vary(1, 0.25)));

    // Lean: rotate about the horizontal axis that tips UP toward `out`, then move to the stem's base.
    const axis = normalize(cross(UP, out));
    const place = (v: V3): V3 => add(rotateAxis(v, axis, lean), base);
    const turn = (v: V3): V3 => rotateAxis(v, axis, lean);
    const offset = stems.length;
    for (const s of sk.stems)
      stems.push({ ...s, points: s.points.map(place), parent: s.parent < 0 ? -1 : s.parent + offset });
    for (const c of sk.leaves)
      leaves.push({ ...c, anchor: place(c.anchor), up: turn(c.up), side: turn(c.side), normal: turn(c.normal) });
  }
  bendLeafNormals(leaves, p.leafNormalBend);
  return { stems, leaves, seed };
}

export function bushLevels(skeleton: Skeleton, p: BushParams): FoliageLevel[] {
  return treeLevels(skeleton, p, bushLods(p));
}

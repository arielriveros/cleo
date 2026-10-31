// A tree's skeleton: stems (trunk, branches, sub-branches, twigs) as spines with radii, and where its
// leaf cards go. Weber & Penn's "Creation and Rendering of Realistic Trees" (1995), reduced to the
// parameters that matter in a slider panel (EZ-Tree takes the same cut):
//
//   - a trunk, optionally forking once into two leaders;
//   - per level, a branch count, a length relative to the parent, a down angle and a curve;
//   - successive branches turned about their parent by a phyllotaxis angle (137.5 deg, the golden angle,
//     packs them without ever lining two up);
//   - the crown's outline from Weber-Penn's shape-ratio functions, which scale level-1 lengths by height;
//   - tropism (`attractionUp`) bending every stem toward the sky or the ground as it grows;
//   - radii by a pipe-model rule: a child is `ratio` of its parent at the fork, scaled by its length.
//
// Leaf cards sit on the terminal stems, at the golden angle along them.

import type { CrownShape, TreeParams } from '../foliageParams';
import { add, cross, dot, length, normalize, perpendicular, rotateAxis, scale, sub, type V3 } from '../mesh';
import { stream, type Rng } from '../rng';

export interface Stem {
  level: number;
  points: V3[];
  radii: number[];
  /** Arc length of the spine. */
  length: number;
  parent: number;
  children: number;
}

export interface LeafCard {
  /** Where the card's bottom edge meets the twig (the card's pivot). */
  anchor: V3;
  /** Up the card (from the twig outward). */
  up: V3;
  /** Across the card. */
  side: V3;
  /** Shading normal, already bent toward the crown's outside. */
  normal: V3;
  size: number;
  /** Leaf atlas cell, 0..3. */
  cell: number;
  /** 0..1, stable per card: LODs keep the cards whose key is below their share. */
  key: number;
}

export interface Skeleton { stems: Stem[]; leaves: LeafCard[] }

const DEG = Math.PI / 180;
const UP: V3 = [0, 1, 0];

/** Weber-Penn's crown outline: level-1 length by position, `r` = 1 at the crown's base, 0 at its top. */
export function shapeRatio(shape: CrownShape, r: number): number {
  r = Math.min(1, Math.max(0, r));
  switch (shape) {
    case 'conical': return 0.2 + 0.8 * r;
    case 'spherical': return 0.2 + 0.8 * Math.sin(Math.PI * r);
    case 'hemispherical': return 0.2 + 0.8 * Math.sin(0.5 * Math.PI * r);
    case 'cylindrical': return 1;
    case 'tapered': return 0.5 + 0.5 * r;
    case 'flame': return r <= 0.7 ? r / 0.7 : (1 - r) / 0.3;
    case 'inverse': return 1 - 0.8 * r;
    default: return r <= 0.7 ? 0.5 + 0.5 * r / 0.7 : 0.5 + 0.5 * (1 - r) / 0.3;
  }
}

/** Point, direction and radius at fraction `t` of a stem's arc length. */
export function sampleStem(stem: Stem, t: number): { p: V3; d: V3; r: number } {
  const pts = stem.points;
  const target = Math.min(1, Math.max(0, t)) * stem.length;
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = length(sub(pts[i], pts[i - 1]));
    if (walked + seg >= target || i === pts.length - 1) {
      const k = seg > 0 ? Math.min(1, (target - walked) / seg) : 0;
      return {
        p: add(pts[i - 1], scale(sub(pts[i], pts[i - 1]), k)),
        d: normalize(sub(pts[i], pts[i - 1])),
        r: stem.radii[i - 1] + (stem.radii[i] - stem.radii[i - 1]) * k,
      };
    }
    walked += seg;
  }
  return { p: pts[0], d: UP, r: stem.radii[0] };
}

/**
 * Grow one spine from `start` along `dir`: `segments` steps, each turned by the stem's share of its curve
 * (toward the sky for a positive curve), pulled by tropism, and jittered by gnarliness.
 */
function grow(r: Rng, start: V3, dir: V3, len: number, segments: number, curveDeg: number, attraction: number, gnarl: number): V3[] {
  const pts: V3[] = [start];
  let d = normalize(dir);
  let p = start;
  const step = len / segments;
  for (let i = 0; i < segments; i++) {
    // Curve: rotate within the vertical plane that holds the stem (toward up for positive values).
    const horizontal = cross(d, UP);
    const axis = length(horizontal) > 1e-4 ? normalize(horizontal) : perpendicular(d);
    d = normalize(rotateAxis(d, axis, (curveDeg / segments) * DEG));
    // Tropism: lean toward the sky, or droop, a little every step.
    d = normalize(add(d, scale(UP, attraction * 0.12)));
    if (gnarl > 0) {
      const wobble = normalize([r.signed(), r.signed() * 0.3, r.signed()]);
      d = normalize(add(d, scale(wobble, gnarl * 0.18)));
    }
    p = add(p, scale(d, step));
    pts.push(p);
  }
  return pts;
}

function arcLength(points: V3[]): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += length(sub(points[i], points[i - 1]));
  return l;
}

/** Radii along a spine: `r0` at the base tapering to `tip` of it, with an optional root flare. */
function taper(points: V3[], r0: number, tip: number, flare = 0): number[] {
  const total = arcLength(points) || 1;
  let walked = 0;
  return points.map((pt, i) => {
    if (i > 0) walked += length(sub(pt, points[i - 1]));
    const t = walked / total;
    let r = r0 * (1 - (1 - tip) * t);
    if (flare > 0) r *= 1 + flare * Math.pow(Math.max(0, 1 - t / 0.12), 3);
    return r;
  });
}

const LEVEL_SEGMENTS = [14, 7, 5, 3];

export function buildSkeleton(seed: number, p: TreeParams): Skeleton {
  const stems: Stem[] = [];
  const push = (s: Omit<Stem, 'length' | 'children'>) => { stems.push({ ...s, length: arcLength(s.points), children: 0 }); return stems.length - 1; };

  // --- Trunk, and the leaders it may fork into -----------------------------------------------------
  const rt = stream(seed, 'trunk');
  const split = p.trunkSplit > 0.05 ? p.trunkSplit : 1;
  const trunkLen = p.height * split;
  const segs0 = Math.max(4, Math.round(LEVEL_SEGMENTS[0] * split));
  const trunkPts = grow(rt, [0, 0, 0], UP, trunkLen, segs0, 0, 0, p.gnarliness * 0.6);
  const trunk = push({ level: 0, points: trunkPts, radii: taper(trunkPts, p.trunkRadius, split < 1 ? 1 - 0.35 * split : 0.08, p.flare), parent: -1 });
  /** Level-0 stems and the global height fraction each one spans. */
  const leaders: { stem: number; h0: number; h1: number }[] = [{ stem: trunk, h0: 0, h1: split }];
  if (split < 1) {
    const top = trunkPts[trunkPts.length - 1];
    const rTop = stems[trunk].radii[stems[trunk].radii.length - 1];
    const az = rt.next() * Math.PI * 2;
    for (let k = 0; k < 2; k++) {
      const side: V3 = [Math.cos(az + k * Math.PI), 0, Math.sin(az + k * Math.PI)];
      const dir = normalize(add(UP, scale(side, Math.tan((22 + rt.signed() * 6) * DEG))));
      const pts = grow(stream(seed, 'leader', k), top, dir, p.height * (1 - split) * 1.04, Math.max(3, Math.round(LEVEL_SEGMENTS[0] * (1 - split))), 0, p.attractionUp * 0.5, p.gnarliness * 0.6);
      leaders.push({ stem: push({ level: 0, points: pts, radii: taper(pts, rTop * 0.78, 0.08), parent: trunk }), h0: split, h1: 1 });
    }
    stems[trunk].children += 2;
  }

  // --- Branch levels -------------------------------------------------------------------------------
  const levelParams = [
    { branches: p.branches1, length: p.length1, angle: p.angle1, curve: p.curve1 },
    { branches: p.branches2, length: p.length2, angle: p.angle2, curve: p.curve2 },
    { branches: p.branches3, length: p.length3, angle: p.angle3, curve: p.curve3 },
  ];
  let parents = leaders.map(l => l.stem);
  const spanOf = new Map(leaders.map(l => [l.stem, l]));
  for (let level = 1; level <= p.levels; level++) {
    const lp = levelParams[level - 1];
    const next: number[] = [];
    const longest = Math.max(1e-6, ...parents.map(i => stems[i].length));
    for (const parentIndex of parents) {
      const parent = stems[parentIndex];
      let count: number, t0: number, t1: number;
      if (level === 1) {
        // Spread over the crown: the part of this leader's height range above the bare trunk.
        const span = spanOf.get(parentIndex)!;
        const lo = Math.max(span.h0, p.baseSize), hi = span.h1;
        if (hi <= lo) continue;
        // The leaders above a fork share that stretch of the crown between them.
        const isLeader = span.h0 > 0;
        const share = (hi - lo) / Math.max(1e-6, 1 - p.baseSize) / (isLeader ? leaders.length - 1 : 1);
        count = Math.round(lp.branches * share);
        t0 = (lo - span.h0) / (span.h1 - span.h0);
        t1 = 1;
      } else {
        count = Math.round(lp.branches * (0.45 + 0.55 * parent.length / longest));
        t0 = 0.12; t1 = 1;
      }
      for (let i = 0; i < count; i++) {
        const r = stream(seed, 'branch', level, parentIndex, i);
        const t = Math.min(0.985, t0 + (t1 - t0) * ((i + 0.5 + r.signed() * 0.35) / count));
        const at = sampleStem(parent, t);
        // Child length: level 1 follows the crown outline; deeper levels shorten toward the parent's tip.
        let len: number;
        if (level === 1) {
          const span = spanOf.get(parentIndex)!;
          const h = span.h0 + (span.h1 - span.h0) * t;
          const crownR = (1 - h) / Math.max(1e-6, 1 - p.baseSize);
          len = p.height * lp.length * shapeRatio(p.crownShape, crownR) * r.vary(1, 0.2);
        } else {
          len = parent.length * lp.length * (1 - 0.55 * t) * r.vary(1, 0.25);
        }
        if (len < 0.02) continue;
        // Direction: turned about the parent by the phyllotaxis angle, then down from it by the angle.
        const azimuth = (i * p.rotate + r.signed() * 12) * DEG;
        const side0 = perpendicular(at.d);
        const side = normalize(rotateAxis(side0, at.d, azimuth + parentIndex * 1.7));
        const down = (lp.angle + r.signed() * 10) * DEG;
        const dir = normalize(add(scale(at.d, Math.cos(down)), scale(side, Math.sin(down))));
        // Pipe model: thinner than the parent at the fork, more so for short children.
        const r0 = Math.max(0.003, Math.min(at.r * 0.85, at.r * p.ratio * Math.sqrt(Math.min(1, len / Math.max(1e-6, parent.length)) * 1.4)));
        const pts = grow(r, at.p, dir, len, LEVEL_SEGMENTS[level], lp.curve * r.vary(1, 0.3), p.attractionUp * (0.6 + 0.4 * level), p.gnarliness);
        const index = push({ level, points: pts, radii: taper(pts, r0, 0.12), parent: parentIndex });
        parent.children++;
        next.push(index);
      }
    }
    if (next.length === 0) break;
    parents = next;
  }

  return { stems, leaves: placeLeaves(seed, p, stems) };
}

function placeLeaves(seed: number, p: TreeParams, stems: Stem[]): LeafCard[] {
  if (p.leafKind === 'none' || p.leavesPerBranch <= 0) return [];
  const terminal = stems.map((s, i) => ({ s, i })).filter(({ s }) => s.children === 0 && s.level >= 1);
  // A tree with no branches still gets its leaves -- on the trunk's top.
  const bearers = terminal.length ? terminal : [{ s: stems[0], i: 0 }];
  const meanLen = bearers.reduce((n, b) => n + b.s.length, 0) / bearers.length || 1;
  const cards: LeafCard[] = [];
  const needles = p.leafKind === 'needles';
  for (const { s, i } of bearers) {
    const r = stream(seed, 'leaves', i);
    const n = Math.max(1, Math.round(p.leavesPerBranch * Math.min(1.8, Math.max(0.35, s.length / meanLen))));
    for (let k = 0; k < n; k++) {
      const t = p.leafStart + (1 - p.leafStart) * ((k + 0.5) / n) + r.signed() * 0.02;
      const at = sampleStem(s, Math.min(1, t));
      const az = (k * 137.5 + r.signed() * 20) * DEG + i;
      const ring = normalize(rotateAxis(perpendicular(at.d), at.d, az));
      // Broad leaves stand out from the twig toward the light; needle brushes lie along it.
      const out = needles ? 0.35 : 0.75;
      let up = normalize(add(scale(at.d, 1 - out), scale(ring, out)));
      up = normalize(add(up, scale(UP, p.attractionUp * 0.3 + 0.15)));
      let side = normalize(cross(up, needles ? UP : ring));
      if (!Number.isFinite(side[0]) || length(side) < 1e-3) side = perpendicular(up);
      side = normalize(rotateAxis(side, up, r.signed() * 0.6));
      let normal = normalize(cross(side, up));
      if (normal[1] < 0) normal = scale(normal, -1);
      cards.push({
        anchor: at.p, up, side, normal,
        size: p.leafSize * r.vary(1, p.leafSizeVariance),
        cell: r.int(0, 3), key: r.next(),
      });
    }
    // One card at the very tip, pointing on along the twig.
    const tip = sampleStem(s, 1);
    const up = normalize(add(tip.d, scale(UP, 0.2)));
    const side = perpendicular(up);
    let normal = normalize(cross(side, up));
    if (normal[1] < 0) normal = scale(normal, -1);
    cards.push({ anchor: tip.p, up, side, normal, size: p.leafSize * r.vary(0.9, p.leafSizeVariance), cell: r.int(0, 3), key: r.next() });
  }

  bendLeafNormals(cards, p.leafNormalBend);
  return cards;
}

/**
 * Bend card normals outward from the crown's centre, so the canopy shades as one volume rather than a
 * scatter of flat cards (and a back-lit side keeps some light). In place.
 */
export function bendLeafNormals(cards: LeafCard[], amount: number): void {
  if (amount <= 0 || !cards.length) return;
  const c: V3 = [0, 0, 0];
  for (const card of cards) { c[0] += card.anchor[0]; c[1] += card.anchor[1]; c[2] += card.anchor[2]; }
  c[0] /= cards.length; c[1] /= cards.length; c[2] /= cards.length;
  for (const card of cards) {
    const outward = normalize(sub(card.anchor, c));
    const facing = dot(outward, card.normal) < 0 ? scale(card.normal, -1) : card.normal;
    card.normal = normalize(add(scale(facing, 1 - amount), scale(outward, amount)));
  }
}

// Grass: one clump of curved, tapered blades -- the unit a foliage rule scatters.
//
// Each blade is a strip along a bent spine (after Ghost of Tsushima's procedural grass, GDC 2021): a
// height, a width that tapers to the tip, a bend whose exponent sets how the curve droops, a random tilt
// and a facing that leans away from the clump centre. Its normals are turned across the width so a flat
// strip shades like a rounded blade. Colour comes from a small texture of four blade variants (three
// greens and one dry), with the root darkening baked in -- the geometry has no vertex colour to carry it.
//
// LODs: LOD 1 keeps a share of the blades with half the segments, each widened to cover the gap; LOD 2
// is three crossed cards carrying a side-on picture of the full clump.

import type { GrassParams } from './foliageParams';
import { MeshBuilder, normalize, cross, rotateAxis, type FoliageLevel, type FoliagePart, type V3 } from './mesh';
import { fbm2, noiseSeed } from './noise';
import { stream } from './rng';
import { createImage, dilateColor, mixRgb, putLinear, rasterTriangle, rgb, scaleRgb, type Image } from './textures/image';

const VARIANTS = 4;
const DRY_VARIANT = 3;
const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Blade texture: four vertical columns (variants), tip at the top row, root at the bottom. */
export function grassBladeTexture(seed: number, p: GrassParams): Image {
  const size = p.textureSize;
  const img = createImage(size, size);
  const s = noiseSeed(seed, 'grass');
  const base = rgb(p.baseColor), tip = rgb(p.tipColor), dry = rgb(p.dryColor);
  const colW = size / VARIANTS;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const col = Math.min(VARIANTS - 1, Math.floor(x / colW));
    const u = (x - col * colW + 0.5) / colW;      // across the blade, 0..1
    const v = (y + 0.5) / size;                   // 0 tip, 1 root
    const r = stream(seed, 'variant', col);
    let lo = base, hi = tip;
    if (col === DRY_VARIANT) { lo = scaleRgb(dry, 0.75); hi = mixRgb(dry, [0.75, 0.68, 0.45], 0.3); }
    else { const k = 0.85 + 0.3 * r.next(); lo = scaleRgb(lo, k); hi = scaleRgb(mixRgb(hi, lo, r.next() * 0.3), k); }
    let c = mixRgb(hi, lo, Math.pow(v, 0.8));
    // Root shade: ambient occlusion low in the clump.
    c = scaleRgb(c, 1 - p.rootShade * smoothstep(0.45, 1, v) * 0.85);
    // Midrib and streaks along the blade.
    const midrib = smoothstep(0.12, 0.0, Math.abs(u - 0.5)) * 0.18;
    const streak = (fbm2(s + col, u, v, 6, 2, 3) - 0.5) * 0.3;
    c = scaleRgb(c, 1 + midrib + streak);
    putLinear(img, y * size + x, c[0], c[1], c[2], 1);
  }
  return img;
}

interface Blade { base: V3; facing: number; tilt: V3; height: number; width: number; bend: number; variant: number }

function blades(seed: number, p: GrassParams): Blade[] {
  const out: Blade[] = [];
  for (let i = 0; i < p.blades; i++) {
    const r = stream(seed, 'blade', i);
    // Denser toward the centre: sqrt for uniform area, then pulled in.
    const a = r.next() * Math.PI * 2, d = Math.pow(r.next(), 0.7) * p.clumpRadius;
    const base: V3 = [Math.cos(a) * d, 0, Math.sin(a) * d];
    const outward = Math.atan2(base[0], base[2]);
    const random = r.next() * Math.PI * 2;
    // Blend a random facing toward "away from the centre" by clumpFacing (shortest way round).
    let delta = outward - random;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    const facing = random + delta * p.clumpFacing * (d / Math.max(1e-3, p.clumpRadius));
    const tiltAngle = (r.signed() * p.tilt) * Math.PI / 180;
    const tiltDir = r.next() * Math.PI * 2;
    const tilt = normalize(rotateAxis([0, 1, 0], [Math.cos(tiltDir), 0, Math.sin(tiltDir)], tiltAngle));
    const height = Math.max(0.01, p.height * (1 + p.heightVariance * r.signed()) * (1 - 0.35 * d / Math.max(1e-3, p.clumpRadius)));
    const dry = r.next() < p.dryness;
    out.push({
      base, facing, tilt, height, width: p.width * (0.75 + 0.5 * r.next()),
      bend: p.bend * (0.6 + 0.8 * r.next()), variant: dry ? DRY_VARIANT : r.int(0, 2),
    });
  }
  return out;
}

/** The blades as one part. `keep` thins (stable: a kept blade is kept at every lower share too). */
function bladeMesh(seed: number, p: GrassParams, all: Blade[], segments: number, keep: number): FoliagePart {
  const mb = new MeshBuilder();
  const grow = 1 / Math.sqrt(keep);
  const colW = 1 / VARIANTS;
  all.forEach((b, i) => {
    if (keep < 1 && stream(seed, 'keep', i).next() >= keep) return;
    const forward: V3 = [Math.sin(b.facing), 0, Math.cos(b.facing)];
    const up = b.tilt;
    const side = normalize(cross(up, forward));
    const fwd = normalize(cross(side, up));
    const width = b.width * Math.min(2.2, grow);
    const u0 = b.variant * colW + colW * 0.08, u1 = (b.variant + 1) * colW - colW * 0.08;
    const rows: number[] = [];
    for (let k = 0; k <= segments; k++) {
      const t = k / segments;
      // The spine: rises along `up`, droops along `fwd` by bend * t^curvature.
      const lean = b.bend * Math.pow(t, p.curvature);
      const rise = t * (1 - 0.4 * b.bend * b.bend * t);
      const pos: V3 = [
        b.base[0] + (up[0] * rise + fwd[0] * lean) * b.height,
        b.base[1] + (up[1] * rise + fwd[1] * lean) * b.height,
        b.base[2] + (up[2] * rise + fwd[2] * lean) * b.height,
      ];
      // Tangent of the spine, for the face normal.
      const dt = 1e-3, t2 = Math.min(1, t + dt), t1 = Math.max(0, t - dt);
      const spine = (tt: number): V3 => {
        const l = b.bend * Math.pow(tt, p.curvature), r = tt * (1 - 0.4 * b.bend * b.bend * tt);
        return [up[0] * r + fwd[0] * l, up[1] * r + fwd[1] * l, up[2] * r + fwd[2] * l];
      };
      const a2 = spine(t2), a1 = spine(t1);
      const tangent = normalize([a2[0] - a1[0], a2[1] - a1[1], a2[2] - a1[2]]);
      const face = normalize(cross(side, tangent));
      const half = width * 0.5 * (1 - p.taper * t);
      const v = 1 - t;
      if (k === segments && half < width * 0.02) {
        rows.push(mb.vertex(pos, face, (u0 + u1) * 0.5, v));
      } else {
        const nl = normalize(rotateAxis(face, tangent, p.normalRounding));
        const nr = normalize(rotateAxis(face, tangent, -p.normalRounding));
        rows.push(mb.vertex([pos[0] - side[0] * half, pos[1] - side[1] * half, pos[2] - side[2] * half], nl, u0, v));
        rows.push(mb.vertex([pos[0] + side[0] * half, pos[1] + side[1] * half, pos[2] + side[2] * half], nr, u1, v));
      }
    }
    // Rows are [l0 r0 l1 r1 ... (tip)].
    for (let k = 0; k < segments; k++) {
      const l0 = rows[k * 2], r0 = rows[k * 2 + 1];
      const tipSingle = k === segments - 1 && rows.length === segments * 2 + 1;
      if (tipSingle) { mb.triangle(l0, r0, rows[rows.length - 1]); continue; }
      const l1 = rows[k * 2 + 2], r1 = rows[k * 2 + 3];
      mb.quad(l0, r0, r1, l1);
    }
  });
  return { name: 'Blades', material: 'grass', buffers: mb.build() };
}

/**
 * The clump seen side-on, for LOD 2's cards: the LOD 0 blades rasterized straight down -Z into an
 * RGBA image with the blade texture's colours, alpha = coverage.
 */
function clumpPicture(blade: FoliagePart, texture: Image, size: number, halfWidth: number, height: number): Image {
  const img = createImage(size, size);
  const { positions, uvs, indices } = blade.buffers;
  const depth = new Float32Array(size * size).fill(Infinity);
  const toPx = (i: number): [number, number] => [
    (positions[i * 3] / halfWidth * 0.5 + 0.5) * size,
    (1 - positions[i * 3 + 1] / height) * size,
  ];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const [ax, ay] = toPx(a), [bx, by] = toPx(b), [cx, cy] = toPx(c);
    rasterTriangle(size, size, ax, ay, bx, by, cx, cy, (x, y, w0, w1, w2) => {
      const z = positions[a * 3 + 2] * w0 + positions[b * 3 + 2] * w1 + positions[c * 3 + 2] * w2;
      const i = y * size + x;
      if (z >= depth[i]) return;
      depth[i] = z;
      const u = uvs[a * 2] * w0 + uvs[b * 2] * w1 + uvs[c * 2] * w2;
      const v = uvs[a * 2 + 1] * w0 + uvs[b * 2 + 1] * w1 + uvs[c * 2 + 1] * w2;
      const sx = Math.min(texture.width - 1, Math.max(0, Math.floor(u * texture.width)));
      const sy = Math.min(texture.height - 1, Math.max(0, Math.floor(v * texture.height)));
      const so = (sy * texture.width + sx) * 4;
      img.data[i * 4] = texture.data[so]; img.data[i * 4 + 1] = texture.data[so + 1]; img.data[i * 4 + 2] = texture.data[so + 2];
      img.data[i * 4 + 3] = 255;
    });
  }
  dilateColor(img);
  return img;
}

/** Three crossed cards at 0, 60 and 120 degrees, each showing `picture`. */
function cardMesh(halfWidth: number, height: number): FoliagePart {
  const mb = new MeshBuilder();
  for (let k = 0; k < 3; k++) {
    const a = k * Math.PI / 3;
    const dx = Math.cos(a) * halfWidth, dz = -Math.sin(a) * halfWidth;
    // The card faces the camera along its normal; up-tilted normals light it like the top of a clump.
    const n = normalize([Math.sin(a) * 0.6, 0.8, Math.cos(a) * 0.6] as V3);
    const i0 = mb.vertex([-dx, 0, -dz], n, 0, 1);
    const i1 = mb.vertex([dx, 0, dz], n, 1, 1);
    const i2 = mb.vertex([dx, height, dz], n, 1, 0);
    const i3 = mb.vertex([-dx, height, -dz], n, 0, 0);
    mb.quad(i0, i1, i2, i3);
  }
  return { name: 'Card', material: 'grassCard', buffers: mb.build() };
}

export interface GrassBuild {
  levels: FoliageLevel[];
  bladeTexture: Image;
  cardTexture: Image;
}

export function buildGrass(seed: number, p: GrassParams, bladeTexture?: Image): GrassBuild {
  const texture = bladeTexture ?? grassBladeTexture(seed, p);
  const all = blades(seed, p);
  const lod0 = bladeMesh(seed, p, all, p.segments, 1);
  const lod1 = bladeMesh(seed, p, all, Math.max(1, Math.ceil(p.segments / 2)), p.lod1Blades);

  // The card spans the clump's widest extent and its tallest blade.
  let halfWidth = 0.05, height = 0.05;
  const pos = lod0.buffers.positions;
  for (let i = 0; i < pos.length; i += 3) {
    halfWidth = Math.max(halfWidth, Math.abs(pos[i]), Math.abs(pos[i + 2]));
    height = Math.max(height, pos[i + 1]);
  }
  halfWidth *= 1.05; height *= 1.03;
  const cardTexture = clumpPicture(lod0, texture, Math.min(512, p.textureSize * 2), halfWidth, height);
  return {
    levels: [
      { parts: [lod0], distance: 0 },
      { parts: [lod1], distance: p.lod1Distance },
      { parts: [cardMesh(halfWidth, height)], distance: p.lod2Distance },
    ],
    bladeTexture: texture,
    cardTexture,
  };
}

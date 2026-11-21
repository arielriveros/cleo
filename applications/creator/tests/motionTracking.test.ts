import { describe, expect, it } from 'vitest';
import {
  blendSeeded, contacts, extremities, pyramid, rdp, speeds, traceContour, trackChecked, trackPoint, turns, connectedComponents,
  type Gray, type Mask,
} from '../src/motion/reference/cv';

const W = 96, H = 72;
/** A smooth random-ish texture, shifted by (dx, dy) pixels (sub-pixel too). */
function texture(dx: number, dy: number, occlude?: { x: number; y: number; r: number }): Gray {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x - dx, v = y - dy;
    const val = 128 + 50 * Math.sin(u * 0.31) * Math.cos(v * 0.27) + 40 * Math.sin((u + v) * 0.13) + 25 * Math.cos(u * 0.07 - v * 0.19);
    data[y * W + x] = Math.max(0, Math.min(255, Math.round(val)));
    if (occlude && Math.hypot(x - occlude.x, y - occlude.y) < occlude.r) data[y * W + x] = 0;
  }
  return { w: W, h: H, data };
}

describe('reference tracking: Lucas–Kanade', () => {
  it('follows a sub-pixel shift, and a large one through the pyramid', () => {
    const a = pyramid(texture(0, 0)), b = pyramid(texture(1.4, -0.7));
    const q = trackPoint(a, b, [48, 36])!;
    expect(q[0]).toBeCloseTo(49.4, 1);
    expect(q[1]).toBeCloseTo(35.3, 1);
    const far = trackPoint(a, pyramid(texture(9, 6)), [44, 32])!;
    expect(far[0]).toBeCloseTo(53, 0);
    expect(far[1]).toBeCloseTo(38, 0);
  });

  it('comes back home forward–backward, and does not when the point is covered', () => {
    const a = pyramid(texture(0, 0)), b = pyramid(texture(2, 1));
    const good = trackChecked(a, b, [48, 36])!;
    expect(good.error).toBeLessThan(0.1);
    const hidden = trackChecked(a, pyramid(texture(2, 1, { x: 50, y: 37, r: 9 })), [48, 36]);
    expect(hidden === null || hidden.error > 1).toBe(true);
  });

  it('refuses a flat window', () => {
    const flat = { w: W, h: H, data: new Uint8Array(W * H).fill(100) };
    expect(trackPoint(pyramid(flat), pyramid(flat), [48, 36])).toBeNull();
  });
});

describe('reference tracking: silhouettes', () => {
  /** A star figure: a body with a head, two arms and two legs. */
  function figure(): Mask {
    const w = 60, h = 80, data = new Uint8Array(w * h);
    const disk = (cx: number, cy: number, r: number) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot(x - cx, y - cy) <= r) data[y * w + x] = 1; };
    const line = (x0: number, y0: number, x1: number, y1: number, r: number) => { for (let t = 0; t <= 1; t += 0.01) disk(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r); };
    disk(30, 12, 6);                                         // head
    line(30, 18, 30, 48, 5);                                 // body
    line(30, 24, 8, 36, 2.5); line(30, 24, 52, 36, 2.5);     // arms
    line(30, 48, 18, 76, 3); line(30, 48, 42, 76, 3);        // legs
    return { w, h, data };
  }

  it('traces a region’s outline all the way round', () => {
    const m = figure();
    const { labels, blobs } = connectedComponents(m);
    const c = traceContour(labels, m.w, m.h, blobs[0].label);
    expect(c.length).toBeGreaterThan(100);
    // Every outline point is in the region and touches the outside.
    for (const [x, y] of c) expect(labels[y * m.w + x]).toBe(blobs[0].label);
  });

  it('finds the head, hands and feet as the outline’s furthest points', () => {
    const e = extremities(figure(), { max: 5 });
    expect(e.length).toBe(5);
    const near = (x: number, y: number) => e.some(p => Math.hypot(p.x * 60 - x, p.y * 80 - y) < 6);
    expect(near(30, 6)).toBe(true);     // head
    expect(near(6, 37)).toBe(true);     // a hand
    expect(near(54, 37)).toBe(true);    // the other
    expect(near(17, 79)).toBe(true);    // a foot
    expect(near(43, 79)).toBe(true);    // the other
  });
});

describe('reference tracking: paths', () => {
  // A foot: planted, a step, planted again; a hand: a swing that turns.
  const foot = Float32Array.from(Array.from({ length: 40 }, (_, i) => {
    const x = i < 12 ? 0 : i < 24 ? (i - 12) * 0.05 : 0.6;
    return [x, 1 - (i >= 12 && i < 24 ? Math.sin(((i - 12) / 12) * Math.PI) * 0.1 : 0)];
  }).flat());

  it('finds a foot’s contacts', () => {
    expect(contacts(foot, 0.01, 5)).toEqual([[0, 12], [24, 39]]);
    expect(speeds(foot)[20]).toBeGreaterThan(0.04);
  });

  it('finds where a path turns, and the frames that keep its shape', () => {
    const swing = Float32Array.from(Array.from({ length: 30 }, (_, i) => [Math.sin((i / 29) * Math.PI * 1.5), 0]).flat());
    const t = turns(swing, 0.001);
    expect(t.length).toBe(1);
    expect(Math.abs(t[0] - 10)).toBeLessThanOrEqual(1);
    // Time counts as a dimension (a twentieth per frame), so the pauses are corners too.
    const keep = rdp(foot, 0.02, 0.05);
    expect(keep[0]).toBe(0);
    expect(keep.at(-1)).toBe(39);
    expect(keep.some(k => Math.abs(k - 12) <= 1) && keep.some(k => Math.abs(k - 24) <= 1)).toBe(true);
  });

  it('blends the tracks of two seeds by distance', () => {
    const n = 5, nan = () => new Float32Array(n * 2).fill(NaN);
    const f0 = nan(), b1 = nan();
    for (let i = 0; i <= 4; i++) { f0.set([i, 0], i * 2); b1.set([i + 1, 0], i * 2); }
    const f1 = nan(); f1.set([5, 0], 4 * 2);                   // a seed's own frame is its own position
    const out = blendSeeded(n, [0, 4], [f0, f1], [nan(), b1]);
    // Frame 0 is all the first seed's, frame 4 the second's, halfway half and half.
    expect(out[0]).toBe(0);
    expect(out[2 * 2]).toBeCloseTo(2.5, 6);
    expect(out[4 * 2]).toBe(5);
  });
});

describe('reference tracking: planting the feet', async () => {
  const { plantFeet, footContacts, normaliseTracks } = await import('../src/motion/reference/tracks');
  const { cameraBasis, projectPoint } = await import('../src/motion/reference/referenceCamera');
  const { DEFAULT_MOTION, normaliseMotion, presetBlend } = await import('../src/motion/motionDoc');
  const camera = { target: [0, 0.8, 0] as [number, number, number], distance: 4, pitch: 10, yaw: 180, roll: 0, vfov: 45 };
  const video = { width: 1280, height: 720, fps: 30 };

  it('puts a planted foot’s goal where its tracked point meets the ground', () => {
    // The left foot's sole touches the floor at (0.2, 0, 0.3) for frames 0–14, then lifts.
    const world: [number, number, number] = [0.2, 0, 0.3];
    const px = projectPoint(cameraBasis(camera), camera.vfov, video.width, video.height, world)!.px;
    const n = 30, points: number[] = [];
    for (let i = 0; i < n; i++) points.push(px[0] / video.width + (i < 15 ? 0 : (i - 14) * 0.01), px[1] / video.height);
    expect(footContacts(points, 30)).toEqual([[0, 14]]);
    const base = normaliseMotion(DEFAULT_MOTION);
    const doc = normaliseMotion({ ...base, keys: [{ ...base.keys[0], time: 0.2 }, { id: 'k2', poseId: base.poses[0].id, time: 0.8, ...presetBlend() }] });
    const ref = { videoId: 'v', offset: 0, speed: 1, in: 0, out: 1 };
    const state = normaliseTracks({ tracks: [{ id: 't', role: 'footL', seeds: [{ frame: 0, x: 0, y: 0 }] }],
                                    result: { times: Array.from({ length: n }, (_, i) => i / 30), points: { t: points }, error: {} } });
    const { doc: out, planted } = plantFeet(doc, ref, camera, video, state, 0.08, w => [w[0] * 100, w[1] * 100, w[2] * 100]);
    expect(planted).toBe(1);                                  // the key at 0.2 s is in the contact, the one at 0.8 s is not
    // Over the floor point, at the foot joint's height (0.08 here), in model units (×100).
    const k = out.keys.find(x => Math.abs(x.time - 0.2) < 1e-6)!;
    const goal = out.poses.find(p => p.id === k.poseId)!.ik!.footL!.pos;
    [20, 8, 30].forEach((v, i) => expect(goal[i]).toBeCloseTo(v, 3));
    // The pose both keys shared was copied: the other key's is untouched.
    const other = out.keys.find(x => Math.abs(x.time - 0.8) < 1e-6)!;
    expect(other.poseId).not.toBe(k.poseId);
    expect(out.poses.find(p => p.id === other.poseId)!.ik).toBeUndefined();
  });
});

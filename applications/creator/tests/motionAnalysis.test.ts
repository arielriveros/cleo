import { describe, expect, it } from 'vitest';
import {
  chiSquare, close, connectedComponents, toChroma, dilate, erode, followCrop, frameDifference, gaussianSmooth, heldFrames, histogram, keyCandidates,
  minimaByProminence, open, otsu, shotCuts, smoothBoxes, subjectOf, temporalMedian, toGray, unionBox, type Gray, type Mask,
} from '../src/motion/reference/cv';
import { analysisFrameAt, readAnalysis } from '../src/motion/reference/cv/analysisView';
import type { AnalysisResult } from '../src/motion/reference/cv/analysisJob';
import { packAnalysis, unpackAnalysis } from '../src/motion/reference/referenceCache';

const W = 64, H = 48;
/** A textured still background with a dark 8×16 "subject" at x (its feet at y 40). */
function frame(subjectX: number | null, light = 0): Gray {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = 140 + ((x * 7 + y * 13) % 40) + light;
  if (subjectX !== null) for (let y = 24; y < 40; y++) for (let x = subjectX; x < subjectX + 8; x++) if (x >= 0 && x < W) data[y * W + x] = 20;
  return { w: W, h: H, data };
}
const mask = (rows: string[]): Mask => ({ w: rows[0].length, h: rows.length, data: Uint8Array.from(rows.join('').split('').map(c => (c === '#' ? 1 : 0))) });

describe('reference analysis: pictures', () => {
  it('turns colour into luma and measures frame difference, whole or in a region', () => {
    const g = toGray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255], 3, 1);
    expect(Array.from(g.data)).toEqual([255, 0, 76]);
    const a = frame(10), b = frame(14);
    expect(frameDifference(a, a)).toBe(0);
    const whole = frameDifference(a, b), inside = frameDifference(a, b, { x: 8 / W, y: 20 / H, w: 16 / W, h: 24 / H });
    expect(inside).toBeGreaterThan(whole * 5);              // the change is all inside the subject's region
  });

  it('finds the background as the per-pixel median, and the subject against it', () => {
    // The subject walks across: no pixel is covered in more than a third of the frames.
    const frames = [0, 10, 20, 30, 40, 50].map(x => frame(x));
    const bg = temporalMedian(frames);
    expect(frameDifference(bg, frame(null))).toBe(0);
    const s = subjectOf(frame(30), bg)!;
    expect(s.box.x).toBeCloseTo(30 / W, 5);
    expect(s.box.w).toBeCloseTo(8 / W, 5);
    expect(s.box.y).toBeCloseTo(24 / H, 5);
    expect(s.box.h).toBeCloseTo(16 / H, 5);
    // A light change of the whole frame is not a subject (it is under Otsu's floor here).
    expect(subjectOf(frame(null, 6), bg)).toBeNull();
  });

  it('finds a subject the same brightness as what is behind it, by its colour', () => {
    // A red box (luma 76) on a grey floor of the same luma.
    const rgba = (red: boolean) => {
      const d = new Uint8Array(W * H * 4);
      for (let i = 0; i < W * H; i++) {
        const x = i % W, y = (i / W) | 0, inBox = red && x >= 20 && x < 30 && y >= 10 && y < 40;
        d.set(inBox ? [255, 0, 0, 255] : [76, 76, 76, 255], i * 4);
      }
      return d;
    };
    const planes = (red: boolean) => { const d = rgba(red); return [toGray(d, W, H), ...toChroma(d, W, H)]; };
    expect(subjectOf(planes(true)[0], planes(false)[0])).toBeNull();     // luma alone sees nothing
    const s = subjectOf(planes(true), planes(false))!;
    expect(s.box.x).toBeCloseTo(20 / W, 5);
    expect(s.box.h).toBeCloseTo(30 / H, 5);
  });

  it('thresholds by Otsu between two populations', () => {
    const hist = new Array(256).fill(0);
    hist[40] = 500; hist[45] = 300; hist[200] = 400; hist[210] = 200;
    const t = otsu(hist);
    expect(t).toBeGreaterThanOrEqual(45);
    expect(t).toBeLessThan(200);
  });

  it('opens away specks, closes cracks, and labels 8-connected regions largest first', () => {
    const m = mask([
      '#.........',
      '...####...',
      '...####...',
      '...##.#...',
      '...####...',
      '........##',
      '.........#',
    ]);
    const opened = open(m);
    expect(opened.data[0]).toBe(0);                          // the lone speck is gone
    const closed = close(m);
    expect(closed.data[3 * 10 + 5]).toBe(1);                 // the crack in the square is filled
    expect(erode(dilate(m)).data.length).toBe(m.data.length);
    const { blobs, labels } = connectedComponents(m);
    expect(blobs.map(b => b.area)).toEqual([15, 3, 1]);
    expect(blobs[0]).toMatchObject({ x0: 3, y0: 1, x1: 6, y1: 4 });
    expect(labels[0]).not.toBe(labels[1 * 10 + 3]);
    // Diagonal neighbours join (8-connectivity).
    expect(connectedComponents(mask(['#.', '.#'])).blobs.length).toBe(1);
  });

  it('measures histogram distance', () => {
    const a = histogram(frame(null)), b = histogram(frame(20));
    expect(chiSquare(a, a)).toBe(0);
    expect(chiSquare(a, b)).toBeGreaterThan(0);
    const black = histogram({ w: 2, h: 2, data: new Uint8Array(4) }), white = histogram({ w: 2, h: 2, data: new Uint8Array(4).fill(255) });
    expect(chiSquare(black, white)).toBeCloseTo(2, 6);
  });
});

describe('reference analysis: curves', () => {
  it('smooths without moving the minima', () => {
    const x = Array.from({ length: 41 }, (_, i) => Math.abs(i - 20));
    const s = gaussianSmooth(x, 2);
    expect(s.indexOf(Math.min(...s))).toBe(20);
  });

  it('finds the holds and turns of a motion as prominent minima, a minimum gap apart', () => {
    // Fast, a hold at 30, fast, a turn at 70 (a brief dip), a wobble too small to count at 50.
    const e = Array.from({ length: 100 }, (_, i) => {
      if (i >= 25 && i <= 35) return 0.002;
      if (i >= 68 && i <= 72) return 0.01;
      return 0.08 + (i === 50 ? -0.004 : 0);
    });
    const c = keyCandidates(e, 30, 0.5);
    expect(c.map(x => x.frame)).toEqual([30, 70]);
    // A hold at the very start (the curve only rises after it) counts, at its middle, codec noise or not.
    const start = Array.from({ length: 60 }, (_, i) => (i <= 20 ? 0.002 + (i % 3) * 0.0004 : 0.08));
    expect(keyCandidates(start, 30, 0.5).map(x => x.frame)).toEqual([10]);
    // Crowded minima: only the most prominent of each crowd.
    const crowded = minimaByProminence([5, 1, 5, 2, 5, 9, 0, 9], 0.1, 3);
    expect(crowded.map(x => x.frame)).toEqual([1, 6]);
  });

  it('sees animation on twos, and ordinary footage as every frame its own', () => {
    const twos = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0 : 0.05));
    expect(heldFrames(twos).onEvery).toBe(2);
    const threes = Array.from({ length: 60 }, (_, i) => (i % 3 ? 0 : 0.05));
    expect(heldFrames(threes).onEvery).toBe(3);
    const live = Array.from({ length: 60 }, () => 0.03);
    expect(heldFrames(live)).toMatchObject({ onEvery: 1 });
    expect(Array.from(heldFrames(twos).held.slice(0, 4))).toEqual([0, 1, 0, 1]);
  });

  it('finds a cut as a jump far above the clip’s usual change', () => {
    const d = Array.from({ length: 50 }, (_, i) => (i === 31 ? 0.9 : 0.01 + (i % 5) * 0.002));
    expect(shotCuts(d)).toEqual([31]);
    expect(shotCuts(Array.from({ length: 50 }, () => 0.02))).toEqual([]);
  });

  it('smooths boxes both ways, bridges short gaps, and unites them', () => {
    const boxes = [0, 1, 2, 3, 4, 5, 6, 7].map(i => (i === 3 || i === 4 ? null : { x: i * 0.05, y: 0.2, w: 0.1, h: 0.5 }));
    const s = smoothBoxes(boxes, 0.5, 4);
    expect(s.every(Boolean)).toBe(true);
    // Forward and back cancel the lag: a steady drift stays centred on the data.
    expect(s[5]!.x).toBeCloseTo(0.25, 1);
    const u = unionBox(boxes, 0)!;
    expect(u.x).toBeCloseTo(0, 6);
    expect(u.x + u.w).toBeCloseTo(0.45, 6);
    const f = followCrop({ x: 0.9, y: 0.4, w: 0.1, h: 0.2 }, { w: 0.3, h: 0.5 });
    expect(f.x + f.w).toBeLessThanOrEqual(1);
    expect(f.w).toBeCloseTo(0.3, 9);
  });
});

describe('reference analysis: the result', () => {
  const result = (): AnalysisResult => {
    const n = 90, fps = 30;
    const times = Float64Array.from({ length: n }, (_, i) => i / fps);
    const energy = Float32Array.from({ length: n }, (_, i) => (i >= 40 && i <= 50 ? 0.001 : 0.06));
    const boxes = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) boxes.set([0.2 + i * 0.002, 0.3, 0.1, 0.5], i * 4);
    return { times, energy, subjectEnergy: energy.slice(), histDist: new Float32Array(n).fill(0.01), boxes, foreground: new Float32Array(n).fill(0.05), width: 64, height: 36 };
  };

  it('reads candidates, boxes and the camera from the arrays', () => {
    const v = readAnalysis(result(), 30, 0.5);
    expect(v.candidates.map(c => c.frame)).toEqual([45]);
    expect(v.cameraMoves).toBe(false);
    expect(v.union!.x).toBeLessThan(0.2);
    expect(v.onEvery).toBe(1);
    expect(analysisFrameAt(result().times, 1.01)).toBe(30);
  });

  it('round-trips through its cache', async () => {
    const r = result();
    const back = (await unpackAnalysis(packAnalysis(r)))!;
    expect(back.times.length).toBe(90);
    expect(Array.from(back.boxes.slice(0, 4))).toEqual(Array.from(r.boxes.slice(0, 4)));
    expect(back.width).toBe(64);
  });
});

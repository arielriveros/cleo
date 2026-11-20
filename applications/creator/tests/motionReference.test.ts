import { describe, expect, it } from 'vitest';
import { MotionTransport, motionClipTime } from '../src/motion/reference/transport';
import {
  frameIndexAt, newReference, normaliseReference, referenceSpan, showsVideoAt, snapToGrid, stepOnGrid, timelineFrames,
  timelineTimeOf, videoFrameAt, videoTimeOf,
} from '../src/motion/reference/referenceDoc';
import { isVariableRate, normaliseVideoDoc, rateLabel, snapFrameRate } from '../src/motion/reference/videoDoc';
import { gateRect, videoToView, viewToVideo } from '../src/motion/reference/gate';
import { packPeaks, packThumbs, unpackCache, unpackPeaks, unpackThumbs } from '../src/motion/reference/referenceCache';
import { DEFAULT_MOTION, normaliseMotion } from '../src/motion/motionDoc';
import { exportMotion } from '../src/motion/exportMotion';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('video reference: frame rates', () => {
  it('snaps a measured rate onto the standard one it is within half a percent of', () => {
    close(snapFrameRate(29.97), 30000 / 1001);
    close(snapFrameRate(29.95), 30000 / 1001);
    expect(snapFrameRate(30.04)).toBe(30);
    close(snapFrameRate(23.98), 24000 / 1001);
    expect(snapFrameRate(239.6)).toBe(240);
    expect(snapFrameRate(37.123456)).toBe(37.123);       // nothing near: itself, 3 decimals
    expect(snapFrameRate(NaN)).toBe(30);
    expect(rateLabel(30000 / 1001)).toBe('29.97');
    expect(rateLabel(24000 / 1001)).toBe('23.976');
  });

  it('tells a variable frame rate from an even one with a dropped frame', () => {
    const even = Array.from({ length: 300 }, (_, i) => i / 30);
    expect(isVariableRate(even)).toBe(false);
    const dropped = even.filter((_, i) => i !== 150);
    expect(isVariableRate(dropped)).toBe(false);
    // A phone's: steps wandering between 1/24 and 1/36 of a second.
    let t = 0;
    const vfr = Array.from({ length: 300 }, (_, i) => (t += i % 3 === 0 ? 1 / 24 : 1 / 36));
    expect(isVariableRate(vfr)).toBe(true);
  });

  it('normalises a stored video document', () => {
    expect(normaliseVideoDoc(null)).toBeNull();
    expect(normaliseVideoDoc({ width: 10 })).toBeNull();
    const d = normaliseVideoDoc({ fileName: 'source.mp4', width: 1080.4, height: 1920, rotation: 45, fps: -3, duration: 'x' })!;
    expect(d).toMatchObject({ fileName: 'source.mp4', width: 1080, height: 1920, rotation: 0, fps: 1, duration: 0, vfr: false });
  });
});

describe('video reference: time', () => {
  it('maps the motion’s real time to the video’s media time and back, slow motion included', () => {
    const ref = { ...newReference('video_a', 0.5, 10), offset: 2 };
    close(videoTimeOf(ref, 0), 2);
    close(videoTimeOf(ref, 1.5), 3.5);
    close(timelineTimeOf(ref, 3.5), 1.5);
    // 240 fps stored at 30: eight video seconds pass in one real one.
    const slow = { ...ref, speed: 8 };
    close(videoTimeOf(slow, 1), 10);
    close(timelineTimeOf(slow, 10), 1);
    expect(referenceSpan(ref)).toEqual({ start: -1.5, end: 8.5 });
    expect(showsVideoAt(ref, -2)).toBe(false);
    expect(showsVideoAt(ref, 0)).toBe(true);
    expect(showsVideoAt(ref, 9)).toBe(false);
  });

  it('normalises a stored reference', () => {
    expect(normaliseReference(undefined)).toBeUndefined();
    expect(normaliseReference({ videoId: '' })).toBeUndefined();
    expect(normaliseReference({ videoId: 'v', speed: -2, in: 3, out: 1 })).toEqual({ videoId: 'v', offset: 3, speed: 1, in: 3, out: 4 });
    expect(normaliseReference({ videoId: 'v', offset: 1, speed: 1000, in: 0, out: 5 })!.speed).toBe(64);
  });

  it('finds the frame on screen, snaps and steps on the video’s own frames', () => {
    const ts = [0, 0.04, 0.08, 0.13, 0.16];                        // uneven, as a phone writes them
    expect(frameIndexAt(ts, -0.01)).toBe(-1);
    expect(frameIndexAt(ts, 0.1)).toBe(2);
    expect(frameIndexAt(ts, 0.13)).toBe(3);
    expect(frameIndexAt(ts, 9)).toBe(4);
    const grid = { frames: ts };
    expect(snapToGrid(0.11, grid)).toBe(0.13);
    expect(snapToGrid(0.09, grid)).toBe(0.08);
    expect(stepOnGrid(0.08, 1, grid)).toBe(0.13);
    expect(stepOnGrid(0.1, -1, grid)).toBe(0.04);                 // from the frame on screen (0.08)
    expect(stepOnGrid(0.1, 1, grid)).toBe(0.13);
    expect(stepOnGrid(0, -1, grid)).toBe(0);                       // clamped
    expect(stepOnGrid(0.16, 5, grid)).toBe(0.16);
    // An even rate: frames by rounding.
    close(stepOnGrid(0.5, 1, { fps: 30 }), 16 / 30);
    close(snapToGrid(0.51, { fps: 30 }), 15 / 30);
  });

  it('places the video’s frames on the timeline through the offset and speed, inside in/out', () => {
    const ref = { videoId: 'v', offset: 1, speed: 2, in: 1, out: 1.3 };
    const ts = [0.9, 1, 1.1, 1.2, 1.3, 1.4];
    const frames = Array.from(timelineFrames(ref, ts));
    expect(frames.length).toBe(4);
    frames.forEach((f, i) => close(f, [0, 0.05, 0.1, 0.15][i], 1e-9));
    expect(videoFrameAt(ref, ts, 0.06)).toBe(2);
    expect(videoFrameAt(ref, ts, 1)).toBeNull();
  });
});

describe('video reference: the transport', () => {
  it('plays, wraps when looping, and stops at the end when not', () => {
    const tr = new MotionTransport();
    tr.end = 2;
    tr.play();
    tr.advance(0.25);
    close(tr.time, 0.25);
    tr.advance(0.2);
    tr.advance(0.25);
    close(tr.time, 0.7);
    tr.seek(1.9);
    tr.advance(0.2);
    close(tr.time, 0.1, 1e-9);                                     // wrapped
    tr.setLoop(false);
    tr.seek(1.9);
    tr.advance(0.2);
    expect(tr.time).toBe(2);
    expect(tr.playing).toBe(false);
    // A long frame (a tab in the background) moves at most a quarter second.
    tr.play(); tr.seek(0); tr.advance(5);
    close(tr.time, 0.25);
  });

  it('plays a loop range, backwards too, and steps frames paused', () => {
    const tr = new MotionTransport();
    tr.end = 10;
    tr.setRange([2, 3]);
    tr.seek(0.5);
    tr.play();
    tr.advance(0.1);
    expect(tr.time).toBe(2);                                       // outside the range: starts it over
    tr.setRate(-1);
    tr.advance(0.1);
    close(tr.time, 2.9);                                           // backwards wraps to the end of the range
    tr.grid = { fps: 10 };
    tr.step(1);
    expect(tr.playing).toBe(false);
    close(tr.time, 3.0);
    tr.toStart();
    expect(tr.time).toBe(2);
    tr.setRange(null);
    tr.toEnd();
    expect(tr.time).toBe(10);
  });

  it('marks in and out at the playhead and tells listeners about state, not time', () => {
    const tr = new MotionTransport();
    tr.end = 5;
    let heard = 0;
    tr.subscribe(() => heard++);
    tr.seek(1); tr.markIn();
    tr.seek(4); tr.markOut();
    expect(tr.range).toEqual([1, 4]);
    tr.seek(2);
    tr.advance(0.1);
    expect(heard).toBe(2);                                         // the two marks; seeking and playing are not news
    tr.setLoop(true);                                              // unchanged: still silent
    expect(heard).toBe(2);
  });

  it('holds the clip’s last frame past its end, or cycles it when the motion loops', () => {
    expect(motionClipTime(0.5, 2, false)).toBe(0.5);
    expect(motionClipTime(3, 2, false)).toBe(2);
    close(motionClipTime(3.5, 2, true), 1.5);
    expect(motionClipTime(1, 0, true)).toBe(0);
  });
});

describe('video reference: the film gate', () => {
  it('fits the frame inside the viewport, centred, and maps points both ways', () => {
    const wide = gateRect(1000, 500, 1920, 1080);
    close(wide.w, 500 * 16 / 9, 1e-9); close(wide.h, 500); close(wide.x, (1000 - 500 * 16 / 9) / 2, 1e-9); close(wide.y, 0);
    const tall = gateRect(400, 800, 1920, 1080);
    expect(tall.w).toBe(400);
    close(tall.h, 225);
    close(tall.y, (800 - 225) / 2);
    const g = gateRect(1000, 500, 1920, 1080);
    const p = videoToView([960, 540], g, 1920, 1080);
    close(p[0], 500); close(p[1], 250);
    const back = viewToVideo(p, g, 1920, 1080);
    close(back[0], 960, 1e-9); close(back[1], 540, 1e-9);
  });

  it('zooms onto a crop of the frame, keeping it centred', () => {
    const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const g = gateRect(1600, 900, 1600, 900, crop);
    // The crop's centre (the frame's centre) lands mid-view, at twice the size.
    expect(g.w).toBe(3200);
    const c = videoToView([800, 450], g, 1600, 900);
    close(c[0], 800); close(c[1], 450);
    const corner = videoToView([400, 225], g, 1600, 900);
    close(corner[0], 0); close(corner[1], 0);
  });
});

describe('video reference: the motion and its caches', () => {
  it('keeps the reference in the document and out of the sidecar', () => {
    const d = normaliseMotion({ ...DEFAULT_MOTION, fps: 29.97, reference: { videoId: 'video_a', offset: 1, speed: 1, in: 0, out: 4 } });
    expect(d.reference).toEqual({ videoId: 'video_a', offset: 1, speed: 1, in: 0, out: 4 });
    expect(d.fps).toBe(29.97);
    expect(normaliseMotion({ ...DEFAULT_MOTION, fps: 23.9761234 }).fps).toBe(23.976);
    const clip = { name: 'm', samplers: [{ input: [0, 1], output: [0, 0, 0, 1, 0, 0, 0, 1], interpolation: 'LINEAR' as const }], channels: [] };
    const files = exportMotion(d, clip, { joints: [], nodeParents: new Map(), nodeTransforms: new Map(), nodeNames: new Map() } as any);
    const sidecar = JSON.parse(new TextDecoder().decode(files.find(f => f.name.endsWith('.motion.json'))!.bytes));
    expect(sidecar.params.reference).toBeUndefined();
    expect(sidecar.params.fps).toBe(29.97);
  });

  it('packs thumbnails and peaks into one blob each and reads them back', async () => {
    const strip = { times: [0, 0.5], images: [new Blob(['aa']), new Blob(['bbb'])], height: 54 };
    const back = await unpackThumbs(packThumbs(strip));
    expect(back!.times).toEqual([0, 0.5]);
    expect(await back!.images[1].text()).toBe('bbb');
    const peaks = { start: 0.1, perSecond: 50, peaks: Float32Array.from([0, 0.5, 1]) };
    const p = await unpackPeaks(packPeaks(peaks));
    expect(Array.from(p!.peaks)).toEqual([0, 0.5, 1]);
    expect(p!.start).toBe(0.1);
    // Another kind, or junk: missing (made again), never thrown.
    expect(await unpackCache(packPeaks(peaks), 'thumbs')).toBeNull();
    expect(await unpackThumbs(new Blob(['junk']))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  cameraBasis, cameraFromBasis, focalOfVfov, forwardOf, projectPoint, rolledUp, viewportFov, vfovOfFocal, normaliseCamera,
  type ReferenceCamera, type Vec2, type Vec3,
} from '../src/motion/reference/referenceCamera';
import {
  defaultCalibration, horizonOf, normaliseCalibration, solveCalibration, solvePnp, turnCamera, type CalibrationDoc,
} from '../src/motion/reference/calibrate';

const W = 1280, H = 720;
const TRUE: ReferenceCamera = { target: [0.3, 0.9, 0.2], distance: 4.5, pitch: 12, yaw: 200, roll: 4, vfov: 48 };

const px = (c: ReferenceCamera, p: Vec3): Vec2 => projectPoint(cameraBasis(c), c.vfov, W, H, p)!.px;
const angleClose = (a: number, b: number, deg: number) => expect(Math.abs((((a - b) % 360) + 540) % 360 - 180)).toBeLessThan(deg);
const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps: number) => { for (let i = 0; i < b.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps); };

/** What a person would draw on the true camera's frame: floor lines along X and Z, the subject's feet and head. */
function drawn(c: ReferenceCamera, height = 1.75): CalibrationDoc {
  const seg = (a: Vec3, b: Vec3): [Vec2, Vec2] => [px(c, a), px(c, b)];
  return {
    ...defaultCalibration(W, H, height),
    x: [seg([-1.5, 0, 0.8], [1.5, 0, 0.8]), seg([-1.5, 0, -0.8], [1.5, 0, -0.8])],
    z: [seg([-1, 0, -1.5], [-1, 0, 1.5]), seg([1, 0, -1.5], [1, 0, 1.5])],
    origin: px(c, [0, 0, 0]), head: px(c, [0, height, 0]),
    ruler: { a: px(c, [-0.5, 0, 0.5]), b: px(c, [0.5, 0, 0.5]), length: 1 },
  };
}

describe('reference camera: the model', () => {
  it('round-trips a camera through its basis, roll included', () => {
    const b = cameraBasis(TRUE);
    const back = cameraFromBasis(b.position, b.forward, b.up, TRUE.vfov, [0, 0, 0], TRUE.distance);
    angleClose(back.yaw, TRUE.yaw, 1e-6);
    expect(back.pitch).toBeCloseTo(TRUE.pitch, 6);
    expect(back.roll).toBeCloseTo(TRUE.roll, 6);
    near(back.target, TRUE.target, 1e-9);
    // Roll turns the up about the view axis and never the view itself.
    const f = forwardOf(TRUE.pitch, TRUE.yaw);
    const u = rolledUp(f, 30);
    expect(Math.abs(f[0] * u[0] + f[1] * u[1] + f[2] * u[2])).toBeLessThan(1e-12);
    // Screen right is forward × up, as the engine's lookAt has it: +X world reads as right from behind.
    const plain = cameraBasis({ ...TRUE, yaw: 180, pitch: 0, roll: 0 });
    near(plain.right, [1, 0, 0], 1e-12);
  });

  it('frames the video’s lens in a letterboxed viewport', () => {
    // A viewport as tall as the gate: the same lens.
    expect(viewportFov(48, 600, 600)).toBeCloseTo(48, 9);
    // The gate a half of the viewport's height: twice the tangent.
    const v = viewportFov(48, 300, 600);
    expect(Math.tan((v * Math.PI) / 360)).toBeCloseTo(2 * Math.tan((48 * Math.PI) / 360), 9);
    expect(vfovOfFocal(focalOfVfov(39.6, 24), 24)).toBeCloseTo(39.6, 9);
    expect(vfovOfFocal(50, 24)).toBeCloseTo(26.99, 2);       // a 50 mm lens on full frame
  });

  it('normalises a stored camera', () => {
    expect(normaliseCamera(null)).toBeUndefined();
    expect(normaliseCamera({ target: [0, 'x', 0] })).toBeUndefined();
    expect(normaliseCamera({ target: [0, 1, 0], vfov: 500, pitch: 120 })).toMatchObject({ vfov: 170, pitch: 89.9, roll: 0 });
  });
});

describe('reference camera: solving from the frame', () => {
  it('recovers the camera from two vanishing points and the subject’s height', () => {
    const r = solveCalibration(drawn(TRUE), W, H);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.solve.camera;
    expect(c.vfov).toBeCloseTo(TRUE.vfov, 4);
    expect(c.pitch).toBeCloseTo(TRUE.pitch, 4);
    angleClose(c.yaw, TRUE.yaw, 1e-3);
    expect(c.roll).toBeCloseTo(TRUE.roll, 4);
    near(cameraBasis(c).position, cameraBasis(TRUE).position, 1e-6);
    // The horizon passes through both vanishing points.
    const hz = horizonOf(cameraBasis(c), c.vfov, W, H)!;
    const vx = r.solve.vanishing.x!;
    const yAt = (x: number) => hz[0][1] + (hz[1][1] - hz[0][1]) * (x / W);
    expect(Math.abs(yAt(vx[0]) - vx[1])).toBeLessThan(1e-6);
  });

  it('scales by a ruler on the ground as well as by height', () => {
    const r = solveCalibration({ ...drawn(TRUE), scale: 'ruler' }, W, H);
    expect(r.ok && r.solve.camera).toBeTruthy();
    if (!r.ok) return;
    near(cameraBasis(r.solve.camera).position, cameraBasis(TRUE).position, 1e-6);
  });

  it('recovers it from one vanishing point, a known lens and one X line', () => {
    const r = solveCalibration({ ...drawn(TRUE), mode: '1vp', vfov: TRUE.vfov }, W, H);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.solve.camera.pitch).toBeCloseTo(TRUE.pitch, 4);
    expect(r.solve.camera.roll).toBeCloseTo(TRUE.roll, 4);
    angleClose(r.solve.camera.yaw, TRUE.yaw, 1e-3);
    near(cameraBasis(r.solve.camera).position, cameraBasis(TRUE).position, 1e-6);
  });

  it('explains what is wrong instead of solving nonsense', () => {
    const cal = drawn(TRUE);
    const parallel = { ...cal, z: [[[0, 0], [100, 100]], [[0, 50], [100, 150]]] as CalibrationDoc['z'] };
    const r = solveCalibration(parallel, W, H);
    expect(r.ok).toBe(false);
    const sky = solveCalibration({ ...cal, origin: [W / 2, 5] }, W, H);
    expect(sky.ok).toBe(false);
  });

  it('matches a pose: four pins put the camera where the joints project onto them', () => {
    const joints: Vec3[] = [[0, 0.05, 0.1], [0.12, 1.0, 0], [-0.12, 1.0, 0], [0, 1.55, 0.05], [0.35, 1.3, 0.2], [-0.3, 0.6, -0.15]];
    const pins = joints.map(j => px(TRUE, j));
    const start: ReferenceCamera = { ...TRUE, yaw: TRUE.yaw + 12, pitch: TRUE.pitch - 6, roll: 0, distance: TRUE.distance * 1.3 };
    const r = solvePnp(joints, pins, W, H, start)!;
    expect(r).not.toBeNull();
    expect(r.rms).toBeLessThan(1e-3);
    near(cameraBasis(r.camera).position, cameraBasis(TRUE).position, 1e-4);
    expect(r.camera.roll).toBeCloseTo(TRUE.roll, 3);
    // With the lens free (five pins or more), from a wrong lens.
    const lens = solvePnp(joints, pins, W, H, { ...start, vfov: 60 }, { solveLens: true })!;
    expect(lens.camera.vfov).toBeCloseTo(TRUE.vfov, 2);
    expect(solvePnp(joints.slice(0, 3), pins.slice(0, 3), W, H, start)).toBeNull();
  });

  it('turns the shot about the subject', () => {
    const c = turnCamera(TRUE, 90, [0, 0, 0]);
    const b0 = cameraBasis(TRUE), b1 = cameraBasis(c);
    expect(Math.hypot(...b1.position)).toBeCloseTo(Math.hypot(...b0.position), 9);
    angleClose(c.yaw, TRUE.yaw + 90, 1e-9);
    // The origin stays where it was in the frame.
    near(px(c, [0, 0, 0]), px(TRUE, [0, 0, 0]), 1e-6);
  });

  it('fills a stored calibration from the defaults', () => {
    const d = normaliseCalibration({ mode: '1vp', height: 1.6, pins: [{ joint: 'Head', at: [10, 20] }, { joint: 3 }] }, W, H)!;
    expect(d.mode).toBe('1vp');
    expect(d.height).toBe(1.6);
    expect(d.pins).toEqual([{ joint: 'Head', at: [10, 20] }]);
    expect(d.x).toEqual(defaultCalibration(W, H).x);
    expect(normaliseCalibration(undefined, W, H)).toBeUndefined();
  });
});

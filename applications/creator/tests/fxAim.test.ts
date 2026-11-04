import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import { DEFAULT_FX, FX_PRESETS, normaliseFx, type FxParams } from '../src/fx/fxParams';
import { newBody } from '../src/fx/fxScene';
import { LiquidSource, aimVector, sourceCenter } from '../src/fx/liquidCpu';
import { LiquidFilm } from '../src/fx/liquidFilm';
import { flipRows, liquidReplayTime } from '../src/fx/liveLiquid';
import { gasReplayTime } from '../src/fx/liveSim';
import { viewBasis } from '../src/fx/volumeRender';
import { aimArrows, aimFromQuat, emitterPose, quatFromAim, regionEdit } from '../src/fx/ui/FxGizmos';

// Where a liquid goes against where it is aimed, the gizmo that aims it, the bake camera, the preview's
// floor decal, bodies in the way, and the playback bar's cycles.

const spatter = (p: Partial<FxParams> = {}) => normaliseFx({ ...FX_PRESETS.find(x => x.id === 'blood-splash')!.params, ...p });
const deg = (r: number) => (r * 180) / Math.PI;

/** A burst's release: its mean direction, and the angle (degrees) from `aim`. */
function burst(p: FxParams) {
  const b = new LiquidSource(p.dropletSize).take(p, 0, 1 / 600, 1e6);
  let mx = 0, my = 0, mz = 0, hx = 0, hz = 0, elevation = 0;
  for (let k = 0; k < b.count; k++) {
    const x = b.vel[k * 3], y = b.vel[k * 3 + 1], z = b.vel[k * 3 + 2], l = Math.hypot(x, y, z);
    mx += x / l; my += y / l; mz += z / l; hx += x; hz += z; elevation += deg(Math.asin(y / l));
  }
  const a = aimVector(p), ml = Math.hypot(mx, my, mz);
  return {
    error: deg(Math.acos(Math.min(1, (mx * a[0] + my * a[1] + mz * a[2]) / ml))),
    sideways: Math.hypot(hx, hz) / b.count, elevation: elevation / b.count,
  };
}

describe('the aim', () => {
  it('is where an aimed burst goes, at any yaw, steep pitch, spread and seed', () => {
    for (const [yaw, pitch, spread, shape] of [[0, 10, 30, 'point'], [90, 10, 60, 'point'], [-135, 40, 30, 'disc'], [0, 70, 30, 'point'], [90, 66, 30, 'sphere']] as const)
      for (const seed of [1, 3, 6])
        expect(burst(spatter({ sourceYaw: yaw, sourcePitch: pitch, sourceSpread: spread, sourceShape: shape, seed })).error, `${shape} ${yaw}/${pitch} seed ${seed}`).toBeLessThan(2);
  });

  it('throws a crown out evenly all round, at its pitch', () => {
    for (const seed of [1, 3, 6]) {
      const c = burst(spatter({ sourceShape: 'ring', sourcePitch: 72, sourceSpread: 12, ringCore: 0, seed }));
      expect(c.sideways).toBeLessThan(1e-3);
      expect(Math.abs(c.elevation - 72)).toBeLessThan(3);
    }
  });

  it('turns the emitter marker to the aim, and reads the aim back off it', () => {
    for (const [yaw, pitch] of [[0, 0], [90, 10], [-135, 45], [170, -30], [30, 80]]) {
      const back = aimFromQuat(quatFromAim(yaw, pitch));
      expect(back.yaw).toBeCloseTo(yaw, 4);
      expect(back.pitch).toBeCloseTo(pitch, 4);
      // The marker's forward is the solver's aim.
      const f = vec3.transformQuat(vec3.create(), [0, 0, 1], quatFromAim(yaw, pitch));
      const a = aimVector({ sourceYaw: yaw, sourcePitch: pitch });
      for (let k = 0; k < 3; k++) expect(f[k]).toBeCloseTo(a[k], 5);
    }
  });

  it('draws one arrow along a liquid\'s aim, four round a crown, none for a gas', () => {
    expect(aimArrows(spatter(), [0, 0, 0])).toHaveLength(1);
    expect(aimArrows(spatter({ sourceShape: 'ring' }), [0, 0, 0])).toHaveLength(4);
    expect(aimArrows(normaliseFx(FX_PRESETS[0].params), [0, 0, 0])).toHaveLength(0);
    expect(aimArrows(spatter({ sourceYaw: 90 }), [0, 0, 0])[0].dir[0]).toBeGreaterThan(0.9);
  });
});

describe('the bake camera', () => {
  it('is a real camera in every view (right x up = -dir), the top one oriented as the floor decal', () => {
    const dims = { nx: 32, ny: 32, nz: 32 };
    for (const view of ['front', 'side', 'top', 'angle'] as const) {
      const b = viewBasis(dims, view, 37);
      const back = vec3.cross(vec3.create(), b.right as vec3, b.up as vec3);
      for (let k = 0; k < 3; k++) expect(back[k], view).toBeCloseTo(-b.dir[k], 6);
    }
    const top = viewBasis(dims, 'top', 0);
    expect([...top.right]).toEqual([1, 0, 0]);
    expect([...top.up]).toEqual([0, 0, -1]);
  });
});

describe('the preview floor decal', () => {
  it('puts the film\'s first row (-Z) where an uploaded image\'s top goes', () => {
    const rows = new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
    expect([...flipRows(rows, 1, 3)]).toEqual([3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1]);
  });

  it('keeps a pool out from under a body, and loses none of it', () => {
    const p = spatter({ flow: 1, pinning: 0, soak: 0, regionSize: [1, 1, 1] });
    const film = new LiquidFilm(p);
    // A wall across the floor at x 0.6..0.7 (region metres).
    film.setObstacle((x, _y, _z) => Math.max(0.6 - x, x - 0.7));
    film.deposit(0.45, 0.5, 4e-5, 0, 0, 1);
    const before = film.volume();
    for (let i = 0; i < 120; i++) film.step(p, 1 / 30);
    let under = 0, beyond = 0;
    let cells = 0;
    for (let iz = 0; iz < film.rows; iz++) for (let ix = 0; ix < film.cols; ix++) {
      const [x] = film.cellCenter(ix, iz);
      const h = film.h[ix + film.cols * iz];
      if (h > 0) cells++;
      if (x > 0.6 && x < 0.7) under += h;
      if (x > 0.72) beyond += h;
    }
    expect(cells).toBeGreaterThan(0);
    expect(under).toBe(0);
    expect(beyond).toBe(0);
    expect(Math.abs(film.volume() - before) / before).toBeLessThan(1e-5);
  });
});

describe('bodies for a liquid', () => {
  it('go in its path: a ball along the aim, a wall across it, a block where it comes down', () => {
    const p = spatter();
    const c = sourceCenter(p);
    const spray = { source: [c.x - p.regionSize[0] / 2, c.y, c.z - p.regionSize[2] / 2] as [number, number, number], aim: aimVector(p) };
    const ahead = (pos: readonly number[]) => (pos[0] - spray.source[0]) * spray.aim[0] + (pos[2] - spray.source[2]) * spray.aim[2];
    for (const kind of ['sphere', 'wall', 'box', 'capsule'] as const) {
      const b = newBody(kind, p.regionSize, spray);
      expect(ahead(b.position), kind).toBeGreaterThan(0);
      for (const k of [0, 2]) expect(Math.abs(b.position[k]), kind).toBeLessThanOrEqual(p.regionSize[k] / 2);
    }
    // A wall turned to face the spray: its thin side along the aim.
    const wall = newBody('wall', p.regionSize, { ...spray, aim: aimVector({ sourceYaw: 90, sourcePitch: 0 }) });
    expect(wall.yaw).toBeCloseTo(90, 5);
    expect(wall.size[2]).toBeLessThan(wall.size[0]);
  });
});

describe('the playback bar\'s cycles', () => {
  it('a burst replays after it plays out; a steady effect never', () => {
    expect(gasReplayTime({ emitDuration: 1.5 })).toBe(5.5);
    expect(gasReplayTime({ emitDuration: 0 })).toBe(Infinity);
    expect(liquidReplayTime(spatter())).toBeGreaterThan(0);
    expect(liquidReplayTime(spatter({ sourceMode: 'jet', jetDuration: 0 }))).toBe(Infinity);
  });
});

describe('resizing the region', () => {
  it('keeps the emitter where it stands in the world as one face moves', () => {
    const p = normaliseFx({ ...DEFAULT_FX, regionSize: [2, 3, 2], emitterPosition: [0.3, 0.5, -0.2] });
    const offset: [number, number, number] = [1, 0, 2];
    const before = emitterPose(p, offset).position;
    // The +X face dragged out 1 m: the box's centre moves 0.5 m along +X.
    const centre = [offset[0] + 0.5, offset[1] + 1.5, offset[2]];
    const edit = regionEdit(p, [3, 3, 2], centre, before);
    expect(edit.regionOffset).toEqual([1.5, 0, 2]);
    expect(edit.params.regionSize).toEqual([3, 3, 2]);
    const after = emitterPose(edit.params, edit.regionOffset).position;
    for (let a = 0; a < 3; a++) expect(after[a]).toBeCloseTo(before[a], 9);
    // The top face up 1 m: the floor stays, and so does the emitter.
    const taller = regionEdit(p, [2, 4, 2], [offset[0], offset[1] + 2, offset[2]], before);
    expect(taller.regionOffset).toEqual(offset);
    taller.params.emitterPosition.forEach((c, a) => expect(c).toBeCloseTo(p.emitterPosition[a], 9));
  });
});

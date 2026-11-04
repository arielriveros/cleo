import { describe, it, expect } from 'vitest';
import { fnv1a } from '../src/core/generator';
import { atlasLayout } from '../src/fx/flipbook';
import { DEFAULT_FX, FX_PRESETS, LIQUID_DEFAULTS, normaliseFx, particleCount, schemaGroupsFor, tileDims, type FxParams } from '../src/fx/fxParams';
import { bakeKinds, exportFx, generateFx } from '../src/fx/generateFx';
import { LiquidCpu } from '../src/fx/liquidCpu';
import { filmCell, LiquidFilm, type FilmSnapshot } from '../src/fx/liquidFilm';
import {
  bakeWindow, dropBounds, filmAlbedoOpacity, filmExtent, filmFrame, liquidSurface, previewWindow, renderFilm, renderLiquidTile, resampleFilm, shadeLiquid, splatLiquid,
  LIQUID_ISO, previewAlbedoOpacity, type Bounds,
} from '../src/fx/liquidRender';
import { liquidPreviewGrid, liquidReplayTime } from '../src/fx/liveLiquid';
import { cropTile, viewBasis } from '../src/fx/volumeRender';

// The liquid medium: the particle solver, the floor film, their rendering, and the bake's decal output.

/** A small blood splash: a few hundred drops, a coarse grid, quick to run. */
const liquid = (p: Partial<FxParams> = {}): FxParams => normaliseFx({
  ...DEFAULT_FX, medium: 'liquid', regionSize: [1, 1.2, 1], voxelSize: 0.025, dropletSize: 0.012, sourceVolume: 0.25,
  sourceHeight: 0.6, emitterZ: 0.4, sourceSpeed: [0.6, 1.2], sourcePitch: 0, sourceSpread: 25, frames: 6, frameTime: 1 / 30, warmup: 0,
  loopBlend: 0, tileSize: 16, decalTileSize: 32, decalFrames: 4, decalSettle: 0.3, view: 'side', ...p,
});

const centreY = (sim: LiquidCpu) => { let s = 0; for (let i = 0; i < sim.count; i++) s += sim.y[i]; return s / Math.max(1, sim.count); };

describe('liquid parameters', () => {
  it('reads a save from before liquids as a gas effect with every liquid default', () => {
    const old = { ...DEFAULT_FX } as Partial<FxParams>;
    for (const k of Object.keys(LIQUID_DEFAULTS)) delete (old as Record<string, unknown>)[k];
    delete old.tileAspect;
    const p = normaliseFx(old as FxParams);
    expect(p.medium).toBe('gas');
    expect(p.tileAspect).toBe('square');
    expect(p.dropletSize).toBe(LIQUID_DEFAULTS.dropletSize);
    expect(p.sourceSpeed).toEqual(LIQUID_DEFAULTS.sourceSpeed);
  });

  it('shows the liquid sections only for a liquid, and the gas ones only for a gas', () => {
    const titles = (m: 'gas' | 'liquid', side: 'parameters' | 'bake') => schemaGroupsFor(m, side).map(g => g.title);
    expect(titles('liquid', 'parameters')).toEqual(['Domain', 'Splash source', 'Liquid', 'Floor', 'Liquid look', 'Simulation']);
    expect(titles('gas', 'parameters')).toEqual(['Domain', 'Emitter', 'Combustion', 'Forces', 'Dissipation', 'Simulation', 'Look']);
    expect(titles('liquid', 'bake')).toEqual(['Flipbook', 'Outputs']);
  });

  it('raises the droplet size when the volume would need too many particles', () => {
    const p = normaliseFx({ ...liquid(), sourceVolume: 20, dropletSize: 0.001 });
    expect(particleCount(p)).toBeLessThanOrEqual(60_000);
  });

  it('bakes the decal outputs only for a liquid on a solid floor', () => {
    expect(bakeKinds(liquid())).toEqual(['color', 'decal', 'decalNormal', 'decalOrm']);
    expect(bakeKinds(liquid({ floorMode: 'absorb' }))).toEqual(['color']);
    expect(bakeKinds({ ...DEFAULT_FX, bakeDecal: true })).toEqual(['color']);
  });
});

describe('liquid solver', () => {
  it('releases the whole volume and keeps account of every drop', () => {
    const p = liquid();
    const sim = new LiquidCpu(p);
    for (let f = 0; f < 30; f++) sim.step(p, p.frameTime);
    expect(sim.released).toBe(particleCount(p));
    // Live drops + film + sunk + gone = released, to float precision.
    expect(sim.totalVolume()).toBeCloseTo(particleCount(p) * sim.particleVolume, 9);
    expect(sim.film!.volume()).toBeCloseTo(sim.deposited, 9);
  });

  it('falls under gravity, and floats without it', () => {
    const p = liquid({ sourceSpeed: [0, 0], floorMode: 'none' });
    const falling = new LiquidCpu(p);
    falling.step(p, p.frameTime);
    const y0 = centreY(falling);
    for (let f = 0; f < 5; f++) falling.step(p, p.frameTime);
    expect(centreY(falling)).toBeLessThan(y0 - 0.05);
    const still = new LiquidCpu({ ...p, gravity: 0, airDrag: 0 });
    still.step({ ...p, gravity: 0 }, p.frameTime);
    const s0 = centreY(still);
    for (let f = 0; f < 5; f++) still.step({ ...p, gravity: 0 }, p.frameTime);
    expect(Math.abs(centreY(still) - s0)).toBeLessThan(0.01);
  });

  it('holds a thrown blob together with surface tension, and sprays it apart without', () => {
    const spreadOf = (tension: number) => {
      const p = liquid({ surfaceTension: tension, sourceSpeed: [0.8, 2], sourceSpread: 30, gravity: 0, floorMode: 'none', viscosity: 0 });
      const sim = new LiquidCpu(p);
      for (let f = 0; f < 6; f++) sim.step(p, p.frameTime);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < sim.count; i++) { lo = Math.min(lo, sim.x[i]); hi = Math.max(hi, sim.x[i]); }
      return hi - lo;
    };
    expect(spreadOf(1)).toBeLessThan(spreadOf(0) * 0.6);
  });

  it('is deterministic, and changes with the seed', () => {
    const run = (seed: number) => {
      const p = liquid({ seed });
      const sim = new LiquidCpu(p);
      for (let f = 0; f < 8; f++) sim.step(p, p.frameTime);
      return fnv1a(new Uint8Array(sim.x.buffer, 0, sim.count * 4));
    };
    expect(run(1)).toBe(run(1));
    expect(run(2)).not.toBe(run(1));
  });

  it('lands on a solid floor as film, and sinks into a water surface', () => {
    const solid = liquid();
    const a = new LiquidCpu(solid);
    for (let f = 0; f < 40; f++) a.step(solid, solid.frameTime);
    expect(a.deposited).toBeGreaterThan(0.5 * particleCount(solid) * a.particleVolume);
    const water = liquid({ floorMode: 'absorb' });
    const b = new LiquidCpu(water);
    for (let f = 0; f < 40; f++) b.step(water, water.frameTime);
    expect(b.film).toBeNull();
    expect(b.absorbed).toBeGreaterThan(0.5 * particleCount(water) * b.particleVolume);
  });
});

describe('the floor film', () => {
  const film = (p: Partial<FxParams> = {}) => new LiquidFilm(liquid(p));
  /** A snapshot drawn at its own cells: the frame over where it is wet, and its cells there. */
  const drawn = (s: FilmSnapshot) => { const frame = filmFrame(filmExtent(s)!, s.cell, 512); return { frame, grid: resampleFilm(s, frame) }; };

  it('has cells half a droplet across, whatever the region', () => {
    expect(film().cell).toBeCloseTo(0.006, 9);
    expect(new LiquidFilm(liquid({ regionSize: [4, 1.2, 4] })).cell).toBeCloseTo(0.006, 9);
    expect(filmCell({ dropletSize: 0.004 })).toBeCloseTo(0.002, 9);
    // The same drop lands the same in a 1 m region as in a 4 m one (both measured from the floor centre).
    const a = film(), b = new LiquidFilm(liquid({ regionSize: [4, 1.2, 4] }));
    a.deposit(0.5 + 0.1, 0.5, 3e-5, 1, 0, 2);
    b.deposit(2 + 0.1, 2, 3e-5, 1, 0, 2);
    expect([b.gx0, b.gz0, b.cols, b.rows]).toEqual([a.gx0, a.gz0, a.cols, a.rows]);
    expect(Array.from(b.h)).toEqual(Array.from(a.h));
  });

  it('grows its window as the liquid lands and spreads, losing none of it', () => {
    const p = liquid({ flow: 1, pinning: 0, soak: 0 });
    const f = new LiquidFilm(p);
    expect(f.cols).toBe(0);
    f.deposit(0.5, 0.5, 4e-5, 0, 0, 1);
    const first = f.cols;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(200);
    f.deposit(0.85, 0.2, 4e-5, 0, 0, 2);
    expect(f.cols).toBeGreaterThan(first);
    // Both drops are in it, where they landed.
    const at = (x: number, z: number) => { const ix = Math.floor((x - f.x0) / f.cell), iz = Math.floor((z - f.z0) / f.cell); return f.h[ix + f.cols * iz]; };
    expect(at(0.5, 0.5)).toBeGreaterThan(1e-3);
    expect(at(0.85, 0.2)).toBeGreaterThan(1e-3);
    for (let s = 0; s < 90; s++) f.step(p, 1 / 30);
    expect(Math.abs(f.volume() - 8e-5) / 8e-5).toBeLessThan(1e-5);
  });

  it('stays stable at fine cells, never going negative', () => {
    const p = liquid({ dropletSize: 0.002, flow: 4, pinning: 0, soak: 0 });
    const f = new LiquidFilm(p);
    f.deposit(0.5, 0.5, 2e-5, 0, 0, 1);
    for (let s = 0; s < 30; s++) f.step(p, 1 / 30);
    expect(Array.from(f.h).every(h => Number.isFinite(h) && h >= 0)).toBe(true);
    expect(Math.abs(f.volume() - 2e-5) / 2e-5).toBeLessThan(1e-5);
  });

  it('lands a deposit whole, and keeps its volume as it flows and soaks', () => {
    const p = liquid({ flow: 1, soak: 0.5 });
    const f = new LiquidFilm(p);
    f.deposit(0.5, 0.5, 2e-5, 2, 0, 7);
    expect(f.volume()).toBeCloseTo(2e-5, 10);
    for (let s = 0; s < 30; s++) f.step(p, 1 / 30);
    expect(f.volume()).toBeCloseTo(2e-5, 10);
    expect(f.stain.some(v => v > 0)).toBe(true);
  });

  it('spreads a thick pool out, and stops at the edge hold', () => {
    const wetCells = (f: LiquidFilm) => f.h.reduce((n, h) => n + (h > 1e-5 ? 1 : 0), 0);
    const p = liquid({ flow: 1, pinning: 1, soak: 0 });
    const f = new LiquidFilm(p);
    f.deposit(0.5, 0.5, 4e-5, 0, 0, 1);
    const before = wetCells(f);
    for (let s = 0; s < 60; s++) f.step(p, 1 / 30);
    const after = wetCells(f);
    expect(after).toBeGreaterThan(before);
    for (let s = 0; s < 120; s++) f.step(p, 1 / 30);
    // Pinned: another four seconds barely moves the edge.
    expect(wetCells(f)).toBeLessThan(after * 1.15);
    // Held thicker, it covers less.
    const q = liquid({ flow: 1, pinning: 4, soak: 0 });
    const g = new LiquidFilm(q);
    g.deposit(0.5, 0.5, 4e-5, 0, 0, 1);
    for (let s = 0; s < 180; s++) g.step(q, 1 / 30);
    expect(wetCells(g)).toBeLessThan(wetCells(f));
  });

  it('smears a fast drop along the way it was going', () => {
    const f = film();
    f.deposit(0.5, 0.5, 1e-5, 0, 3, 3);
    let zs = 0, xs = 0, w = 0;
    for (let iz = 0; iz < f.rows; iz++) for (let ix = 0; ix < f.cols; ix++) {
      const h = f.h[ix + f.cols * iz];
      const [x, z] = f.cellCenter(ix, iz);
      zs += h * (z - 0.5) ** 2; xs += h * (x - 0.5) ** 2; w += h;
    }
    expect(zs / w).toBeGreaterThan((xs / w) * 1.5);
  });

  it('draws a decal whose coverage follows the film, darkening only for a clear liquid', () => {
    const blood = liquid();
    const f = new LiquidFilm(blood);
    f.deposit(0.5, 0.5, 3e-5, 0, 0, 1);
    const snap = f.snapshot();
    const { frame, grid } = drawn(snap);
    // The frame hugs the drop, at the film's own cells, centred where it landed (the floor's centre).
    expect(frame.cell).toBeCloseTo(f.cell, 9);
    expect(frame.cols * frame.cell).toBeLessThan(0.2);
    expect(Math.abs(frame.x0 + (frame.cols * frame.cell) / 2)).toBeLessThan(f.cell * 1.01);
    const k = filmAlbedoOpacity(blood, grid);
    expect(k).toBeGreaterThan(0.8);
    const color = renderFilm(blood, grid, frame, 'color', k);
    const centre = (Math.floor(frame.cols / 2) + frame.cols * Math.floor(frame.rows / 2)) * 4;
    expect(color[centre + 3]).toBeGreaterThan(200);
    expect(color[3]).toBe(0);
    expect(color[centre]).toBeGreaterThan(color[centre + 1] * 3);   // red
    const water = liquid({ liquidAbsorption: 2, liquidTint: [0.9, 0.95, 0.97, 1], liquidColor: [0.8, 0.85, 0.9, 1] });
    expect(filmAlbedoOpacity(water, grid)).toBeLessThan(0.5);
    // The relief: flat (0.5, 0.5, 1) off the pool.
    const normal = renderFilm(blood, grid, frame, 'normal', k);
    expect([normal[0], normal[1], normal[2]]).toEqual([128, 128, 255]);
  });

  it('lands a drop as a compact cap: nothing past its reach, so no halo, and all of it', () => {
    const f = film();
    f.deposit(0.5, 0.5, 1e-5, 0, 0, 1);
    const r0 = Math.max(f.cell * 1.2, Math.cbrt(1e-5) * 0.9);
    let farthest = 0;
    for (let iz = 0; iz < f.rows; iz++) for (let ix = 0; ix < f.cols; ix++) {
      if (f.h[ix + f.cols * iz] <= 0) continue;
      const [x, z] = f.cellCenter(ix, iz);
      farthest = Math.max(farthest, Math.hypot(x - 0.5, z - 0.5));
    }
    expect(farthest).toBeLessThanOrEqual(r0 * 1.05 + f.cell);
    expect(f.volume()).toBeCloseTo(1e-5, 10);
  });

  it('hides the ground under a millimetre of blood, and keeps the preview albedo share fixed', () => {
    const p = liquid({ liquidColor: [0.42, 0.03, 0.03, 1], liquidTint: [0.55, 0.04, 0.04, 1], liquidAbsorption: 900 });
    expect(filmAlbedoOpacity(p, { h: new Float32Array([1e-3]), stain: new Float32Array([0]) })).toBeGreaterThan(0.95);
    expect(previewAlbedoOpacity(p)).toBeGreaterThan(0.9);
    expect(previewAlbedoOpacity(p)).toBe(previewAlbedoOpacity({ ...p, seed: 99 }));
  });

  it('keeps the liquid\'s volume when drawn at coarser cells', () => {
    const f = film();
    f.deposit(0.5, 0.5, 3e-5, 2, 1, 4);
    const s = f.snapshot();
    const frame = filmFrame(filmExtent(s)!, s.cell, 8);
    expect(frame.cell).toBeGreaterThan(s.cell * 1.5);
    expect(Math.max(frame.cols, frame.rows)).toBeLessThanOrEqual(10);
    const g = resampleFilm(s, frame);
    const vol = (h: Float32Array, c: number) => h.reduce((a, v) => a + v, 0) * c * c;
    expect(vol(g.h, frame.cell)).toBeCloseTo(vol(s.h, s.cell), 10);
  });
});

describe('liquid rendering and bake', () => {
  it('splats an isolated droplet into a surface the size of a droplet', () => {
    const p = liquid({ sourceVolume: 0.027, dropletSize: 0.03, gravity: 0, sourceSpeed: [0, 0] });
    const sim = new LiquidCpu(p);
    sim.step(p, 1e-3);
    expect(sim.count).toBe(1);
    const dims = { nx: 40, ny: 48, nz: 40 };
    const g = splatLiquid(sim, p, dims, 0.025);
    let inside = 0;
    for (const d of g.density) if (d >= LIQUID_ISO) inside++;
    expect(inside).toBeGreaterThan(0);
    expect(inside).toBeLessThan(30);
  });

  it('is deterministic, writes the decal flipbook beside the sprite, and changes with the seed', async () => {
    const a = await generateFx(liquid());
    const b = await generateFx(liquid());
    expect(fnv1a(a.atlas)).toBe(fnv1a(b.atlas));
    expect(fnv1a(a.outputs.decal!.atlas)).toBe(fnv1a(b.outputs.decal!.atlas));
    const c = await generateFx(liquid({ seed: 5 }));
    expect(fnv1a(c.outputs.decal!.atlas)).not.toBe(fnv1a(a.outputs.decal!.atlas));
    // Drawn where the liquid lies, no larger than `decalTileSize` a side.
    expect(Math.max(a.decal!.layout.tileWidth, a.decal!.layout.tileHeight)).toBeLessThanOrEqual(32);
    expect(a.decal!.size[0] / a.decal!.layout.tileWidth).toBeCloseTo(a.decal!.size[1] / a.decal!.layout.tileHeight, 9);
    expect(a.outputs.decal!.frames).toHaveLength(4);
    // The last decal frame is the settled one, and something landed in it.
    expect(a.decal!.final.color.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
  });

  it('exports the decal atlases, the settled stills and the sidecar block a decal plays them by', async () => {
    const p = liquid();
    const out = await generateFx(p);
    const files = await exportFx(out, p, 'blood');
    const names = files.map(f => f.name);
    for (const n of ['blood_flipbook.png', 'blood_decal_flipbook.png', 'blood_decal_normal_flipbook.png', 'blood_decal_orm_flipbook.png',
                     'blood_decal.png', 'blood_decal_normal.png', 'blood_decal_orm.png', 'blood.json']) expect(names).toContain(n);
    const meta = JSON.parse(new TextDecoder().decode(files.find(f => f.name === 'blood.json')!.bytes));
    const decal = meta.output.outputs.decal;
    expect(decal.flipbook).toMatchObject({ frames: 4, loop: false, blend: true });
    // Where the liquid lies: inside the 1 m floor, its box beside the wound (0.4 m toward -z of the floor's centre... and around).
    expect(decal.size[0]).toBeGreaterThan(0.05);
    expect(decal.size[0]).toBeLessThan(1.5);
    expect(decal.offset).toHaveLength(2);
    expect(decal.tile).toEqual([out.decal!.layout.tileWidth, out.decal!.layout.tileHeight]);
    expect(decal.atlas.color).toBe('blood_decal_flipbook.png');
    expect(meta.output.medium).toBe('liquid');
    // A one-shot sprite plays over the particle's life.
    expect(meta.output.particleFlipbook.mode).toBe('life');
  });

  it('draws the decal at the droplets\' definition, in a small region or a large one', async () => {
    // The same splash (the emitter in metres from the floor's centre) in a 1 m and a 3 m region.
    const texel = async (w: number) => {
      const out = await generateFx(liquid({ regionSize: [w, 1.2, w], emitterPosition: [0, 0.6, -0.1], decalTileSize: 512, frames: 4, decalFrames: 2 }));
      return out.decal!.size[0] / out.decal!.layout.tileWidth;
    };
    const small = await texel(1), large = await texel(3);
    expect(small).toBeCloseTo(0.006, 9);
    expect(large).toBeCloseTo(small, 9);
  });

  it('runs every liquid preset to a frame without NaN', () => {
    for (const preset of FX_PRESETS.filter(x => x.params.medium === 'liquid')) {
      const p = normaliseFx(preset.params);
      const sim = new LiquidCpu(p);
      for (let f = 0; f < 3; f++) sim.step(p, p.frameTime);
      expect(sim.count + sim.deposited + sim.absorbed + sim.escaped, preset.id).toBeGreaterThan(0);
      expect(Array.from(sim.x.subarray(0, sim.count)).every(Number.isFinite), preset.id).toBe(true);
    }
  });

  it('bakes a lit particle\'s surface maps beside the colour: base colour, normals facing the viewer, roughness and metallic', async () => {
    const p = liquid({ bakeSurfaceMaps: true, liquidMetallic: 1, liquidRoughness: 0.2, bakeDecal: false });
    expect(bakeKinds(p)).toEqual(['color', 'albedo', 'normal', 'orm']);
    const out = await generateFx(p);
    for (const kind of ['albedo', 'normal', 'orm'] as const) expect(out.outputs[kind]!.frames, kind).toHaveLength(6);
    // Every covered texel: a normal toward the viewer (B in the upper half), roughness and metallic as set.
    let covered = 0;
    out.outputs.normal!.frames.forEach((tile, f) => {
      const orm = out.outputs.orm!.frames[f];
      for (let i = 0; i < tile.length; i += 4) {
        if (tile[i + 3] < 128) continue;
        covered++;
        expect(tile[i + 2]).toBeGreaterThanOrEqual(127);
        expect(orm[i + 1]).toBe(Math.round(0.2 * 255));
        expect(orm[i + 2]).toBe(255);
      }
    });
    expect(covered).toBeGreaterThan(0);
    const files = await exportFx(out, p, 'hg');
    for (const n of ['hg_albedo_flipbook.png', 'hg_normal_flipbook.png', 'hg_orm_flipbook.png']) expect(files.map(f => f.name)).toContain(n);
    const meta = JSON.parse(new TextDecoder().decode(files.find(f => f.name === 'hg.json')!.bytes));
    expect(meta.output.outputs.surface).toMatchObject({ albedo: 'hg_albedo_flipbook.png', normal: 'hg_normal_flipbook.png', orm: 'hg_orm_flipbook.png', metallic: 1 });
    // A gas effect has no surface to bake.
    expect(bakeKinds({ ...DEFAULT_FX, bakeSurfaceMaps: true })).not.toContain('normal');
  });

  it('shades a metal opaque, all reflection, tinted by its colour; a liquid at metallic 0 as before', () => {
    const n: [number, number, number] = [0, 0, 1], v: [number, number, number] = [0, 0, 1], l: [number, number, number] = [0, 0.6, 0.8];
    const gold = liquid({ liquidColor: [1, 0.78, 0.34, 1], liquidMetallic: 1, liquidAbsorption: 0 });
    const c = shadeLiquid(gold, n, v, l, 1, 0, 0.001);
    expect(c[3]).toBe(1);
    expect(c[0]).toBeGreaterThan(c[2] * 2);
    // A clear liquid stays see-through and grey in what it reflects.
    const water = shadeLiquid(liquid({ liquidColor: [1, 0.78, 0.34, 1], liquidMetallic: 0, liquidAbsorption: 0 }), n, v, l, 1, 0, 0.001);
    expect(water[3]).toBeLessThan(0.1);
    const s = liquidSurface(gold, 0, 0.001);
    expect([s.alpha, s.metallic]).toEqual([1, 1]);
    expect(s.albedo[0]).toBeCloseTo(1, 5);
    // On the floor a metal hides the ground and is metallic in the decal's ORM.
    const f = new LiquidFilm(gold);
    f.deposit(0.5, 0.5, 3e-5, 0, 0, 1);
    const albedo = filmAlbedoOpacity(gold, f);
    expect(albedo).toBeGreaterThan(0.9);
    const frame = filmFrame(filmExtent(f)!, f.cell, 512);
    const orm = renderFilm(gold, resampleFilm(f, frame), frame, 'orm', albedo);
    expect(orm[(Math.floor(frame.cols / 2) + frame.cols * Math.floor(frame.rows / 2)) * 4 + 2]).toBe(255);
  });

  it('replays a one-shot after it settles, and never a pour that does not stop', () => {
    expect(liquidReplayTime(liquid())).toBeCloseTo(6 / 30 + 0.3 + 0.8, 6);
    expect(liquidReplayTime(liquid({ sourceMode: 'jet', jetDuration: 0 }))).toBe(Infinity);
  });
});

describe("the liquid's grid follows its drops", () => {
  it("previews at the droplets' voxels, whatever the region", () => {
    const small = liquidPreviewGrid(liquid({ regionSize: [0.6, 0.6, 0.6], previewQuality: 'medium' }));
    const large = liquidPreviewGrid(liquid({ regionSize: [6, 3, 6], previewQuality: 'medium' }));
    expect(small.voxelSize).toBeCloseTo(0.012 * 1.4, 9);
    expect(large.voxelSize).toBeCloseTo(small.voxelSize, 9);
    expect(small.windowed).toBe(false);
    // Too many of them for the whole of the large region: a window, within the budget.
    expect(large.windowed).toBe(true);
    expect(large.dims.nx * large.dims.ny * large.dims.nz).toBeLessThanOrEqual(700_000);
  });

  it('keeps the preview window over the drops, still while they stay in it, coarser only as they spread', () => {
    const dims = { nx: 40, ny: 30, nz: 40 }, v = 0.01, region = [6, 3, 6];
    const inside = (w: ReturnType<typeof previewWindow>, b: Bounds) =>
      [0, 1, 2].every(a => b[a] >= w.origin[a] - 1e-9 && b[a + 3] <= w.origin[a] + [dims.nx, dims.ny, dims.nz][a] * w.voxelSize + 1e-9);
    const b0: Bounds = [2.9, 1, 2.9, 3.1, 1.1, 3.1];
    const w0 = previewWindow(b0, 0.02, dims, v, region, null);
    expect(w0.voxelSize).toBeCloseTo(v, 9);
    expect(inside(w0, b0)).toBe(true);
    // On the voxel lattice from the region's corner.
    for (const c of w0.origin) expect(Math.abs(c / v - Math.round(c / v))).toBeLessThan(1e-6);
    // A little movement inside: the same window.
    expect(previewWindow([2.92, 1, 2.9, 3.12, 1.1, 3.1], 0.02, dims, v, region, w0)).toBe(w0);
    // Spread past it: coarser voxels (in steps), and still around them.
    const b1: Bounds = [2.5, 0.5, 2.6, 3.5, 1.2, 3.4];
    const w1 = previewWindow(b1, 0.02, dims, v, region, w0);
    expect(w1.voxelSize).toBeGreaterThan(v * 2);
    expect(inside(w1, b1)).toBe(true);
    // Gathered again: back to finer voxels.
    expect(previewWindow(b0, 0.02, dims, v, region, w1).voxelSize).toBeLessThan(w1.voxelSize);
  });

  it("bakes each frame over its drops at the droplets' voxels, framed by the region", () => {
    const p = liquid({ regionSize: [1.5, 1.2, 1.5], emitterPosition: [0, 0.6, 0] });
    const sim = new LiquidCpu(p);
    for (let f = 0; f < 4; f++) sim.step(p, p.frameTime);
    const b = dropBounds(sim)!;
    const w = bakeWindow(b, 0.03, p.regionSize, 0.009, 2_500_000);
    expect(w.voxelSize).toBeCloseTo(0.009, 9);
    // Far smaller than the region's grid at those voxels.
    expect(w.dims.nx * w.dims.ny * w.dims.nz).toBeLessThan((1.5 / 0.009) * (1.2 / 0.009) * (1.5 / 0.009) / 20);
    const g = splatLiquid(sim, p, w.dims, w.voxelSize, { origin: w.origin });
    // The same drops in a grid over the whole region draw the same tile.
    const whole = splatLiquid(sim, p, { nx: Math.round(1.5 / 0.009), ny: Math.round(1.2 / 0.009), nz: Math.round(1.5 / 0.009) }, 0.009);
    const a = new Uint8Array(64 * 64 * 4), c = new Uint8Array(64 * 64 * 4);
    renderLiquidTile(g, p, a, 64);
    renderLiquidTile(whole, p, c, 64);
    let differ = 0, covered = 0;
    for (let i = 3; i < a.length; i += 4) { if (a[i] > 0) covered++; if (Math.abs(a[i] - c[i]) > 8) differ++; }
    expect(covered).toBeGreaterThan(0);
    expect(differ).toBeLessThanOrEqual(2);
  });
});

describe('tile shapes', () => {
  it('packs tall and wide tiles into a near-square atlas', () => {
    expect(atlasLayout(32, 128, 256)).toMatchObject({ columns: 8, rows: 4, width: 1024, height: 1024, tileWidth: 128, tileHeight: 256 });
    expect(atlasLayout(32, 256, 128)).toMatchObject({ columns: 4, rows: 8, width: 1024, height: 1024 });
    expect(atlasLayout(16, 64)).toMatchObject({ columns: 4, rows: 4 });
    expect(tileDims({ tileSize: 128, tileAspect: 'tall' })).toEqual({ width: 128, height: 256 });
  });

  it('frames a tall tile so the region fits its narrow width, and cuts it from the square', () => {
    const dims = { nx: 20, ny: 40, nz: 20 };
    const square = viewBasis(dims, 'front', 0), tall = viewBasis(dims, 'front', 0, 0.5);
    // The region's height fills the tall tile, whose width (half the square's) still holds its width.
    expect(tall.half).toBeCloseTo(square.half, 6);
    const wide = viewBasis({ nx: 40, ny: 20, nz: 20 }, 'front', 0, 0.5);
    expect(wide.half).toBeGreaterThan(viewBasis({ nx: 40, ny: 20, nz: 20 }, 'front', 0).half * 1.9);
    const px = new Uint8Array(4 * 4 * 4).map((_, i) => i);
    const cut = cropTile(px, 4, 2, 4);
    expect(cut).toHaveLength(2 * 4 * 4);
    expect(Array.from(cut.subarray(0, 4))).toEqual([4, 5, 6, 7]);   // column 1 of row 0
  });

  it('bakes a gas flipbook with tall tiles', async () => {
    const out = await generateFx(normaliseFx({ ...DEFAULT_FX, regionSize: [1.6, 2.4, 1.6], voxelSize: 0.1, frames: 4, warmup: 6, tileSize: 16, tileAspect: 'tall', loopBlend: 0, pressureIterations: 12 }));
    expect(out.layout).toMatchObject({ tileWidth: 16, tileHeight: 32 });
    expect(out.frames[0]).toHaveLength(16 * 32 * 4);
  });
});

describe('edge fade', () => {
  it('fades coverage out toward a tile\'s edges and leaves its middle alone', async () => {
    const { fadeEdges } = await import('../src/fx/flipbook');
    const tile = new Uint8Array(20 * 10 * 4).fill(255);
    fadeEdges(tile, 20, 10, 0.2);
    const a = (x: number, y: number) => tile[(y * 20 + x) * 4 + 3];
    expect(a(10, 5)).toBe(255);
    expect(a(0, 5)).toBeLessThan(40);
    expect(a(10, 0)).toBeLessThan(60);
    expect(a(2, 5)).toBeGreaterThan(a(0, 5));
    // Colour is untouched (straight alpha); 0 is off.
    expect(tile[0]).toBe(255);
    const same = new Uint8Array(16).fill(200);
    expect(Array.from(fadeEdges(same, 2, 2, 0))).toEqual(Array.from(new Uint8Array(16).fill(200)));
  });
});

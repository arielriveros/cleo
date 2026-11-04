import { describe, it, expect } from 'vitest';
import { FluidCpu, fluidDims } from '../src/fx/fluidCpu';
import { DEFAULT_FX, FX_SCHEMA, FX_SCENE_SPECS, normaliseFx, tileDims, type FxParams } from '../src/fx/fxParams';
import { bakeFireLut, renderTile } from '../src/fx/volumeRender';
import { applySceneValues, EFFECT_SECTION_PRESETS, effectPresetLabel, effectPresetParams, SCENE_PRESETS, SCENE_SECTION_PRESETS } from '../src/fx/fxPresets';
import { FX_PRESETS } from '../src/fx/fxParams';
import { DEFAULT_SCENE, SCENE_SCHEMA, VIEW_KEYS, type FxScene } from '../src/fx/fxScene';
import { BLUE_CORE_SOOT, BLUE_CORE_ZONE, blueCoreSource, detailBlend, emissionTemperature, groundShadow, SHADOW_RES } from '../src/fx/realism';

// The realism models (realism.ts) in the CPU reference solver, and the preset contracts.

const small = (p: Partial<FxParams> = {}): FxParams =>
  normaliseFx({ ...DEFAULT_FX, regionSize: [2, 3, 2], voxelSize: 0.1, frameTime: 1 / 24, pressureIterations: 16, ...p });

const run = (p: FxParams, steps: number, setup?: (f: FluidCpu) => void) => {
  const f = new FluidCpu(fluidDims(p));
  setup?.(f);
  for (let i = 0; i < steps; i++) f.step(p, p.frameTime / p.substeps);
  return f;
};
const sum = (a: ArrayLike<number>) => Array.from(a).reduce((s, v) => s + v, 0);

describe('realism models', () => {
  it('stay deterministic with everything on', () => {
    const p = small({
      boundaries: 'open', disturbance: 10, shredding: 0.8, diffusion: 0.02, flameShape: 0.8, coolingT4: 0.2, flicker: 2,
      detailStrength: 0.4, advection: 'maccormack', pressureSolver: 'sor', expansion: 1, blast: 10,
    });
    const a = run(p, 10), b = run(p, 10);
    expect(Array.from(a.density)).toEqual(Array.from(b.density));
    expect(Array.from(a.flame)).toEqual(Array.from(b.flame));
    for (const v of a.temperature) expect(Number.isFinite(v)).toBe(true);
  });

  it('marks the flame field only where fuel burns, and lets it fade over its lifetime', () => {
    const p = small({ flameShape: 1, flameLifetime: 0.05 });
    const f = run(p, 6);
    expect(sum(f.flame)).toBeGreaterThan(0);
    const noFuel = run(small({ fuel: 0, flameShape: 1 }), 6);
    expect(sum(noFuel.flame)).toBe(0);
    // Stop the fuel: the flame field decays.
    const before = sum(f.flame);
    f.fuel.fill(0);   // nothing left to burn
    const stop = { ...p, fuel: 0, emitDuration: 0.0001 };
    for (let i = 0; i < 6; i++) f.step(stop, p.frameTime / p.substeps);
    expect(sum(f.flame)).toBeLessThan(before * 0.5);
  });

  it('draws fire only where the flame is, at flame shape 1', () => {
    expect(emissionTemperature(1.5, 0, 0.25, 1)).toBeCloseTo(0.25, 9);
    expect(emissionTemperature(1.5, 1, 0.25, 1)).toBeCloseTo(1.5, 9);
    expect(emissionTemperature(1.5, 0, 0.25, 0)).toBe(1.5);
  });

  it('cools the hottest gas fastest with radiative cooling', () => {
    const peak = (c4: number) => Math.max(...Array.from(run(small({ heat: 2.5, fuel: 2, coolingT4: c4 }), 12).temperature));
    expect(peak(0.5)).toBeLessThan(peak(0));
  });

  it('lets the flow through the sides with open boundaries, where closed walls stop it', () => {
    const p = small({ fuel: 0, heat: 0.4, smoke: 3, wind: 1.5 });
    const sideFlow = (open: boolean) => {
      const f = run({ ...p, boundaries: open ? 'open' : 'closed' }, 40);
      let s = 0;
      for (let z = 0; z < f.dims.nz; z++) for (let y = 1; y < f.dims.ny; y++) s += Math.abs(f.u[f.index(f.dims.nx - 1, y, z)]);
      return s;
    };
    expect(sideFlow(false)).toBe(0);
    expect(sideFlow(true)).toBeGreaterThan(1);
  });

  it('condenses vapour into visible steam only below the dew point', () => {
    const hot = run(small({ fuel: 0, heat: 2, smoke: 3, condensation: 10, dewPoint: 0.1, cooling: 0 }), 6);
    const cold = run(small({ fuel: 0, heat: 0.2, smoke: 3, condensation: 10, dewPoint: 1.5 }), 6);
    expect(sum(cold.density)).toBeGreaterThan(sum(hot.density) * 2);
  });

  it('settles dust toward the floor', () => {
    const p = small({ fuel: 0, heat: 0, smoke: 0, buoyancy: 0, weight: 0, emitSpeed: 0, turbulence: 0 });
    const centroidY = (settling: number) => {
      const f = run({ ...p, settling }, 12, g => {
        for (let z = 0; z < g.dims.nz; z++) for (let x = 0; x < g.dims.nx; x++) g.density[g.index(x, 20, z)] = 1;
      });
      let sy = 0, sw = 0;
      for (let z = 0; z < f.dims.nz; z++) for (let y = 0; y < f.dims.ny; y++) for (let x = 0; x < f.dims.nx; x++) { const d = f.density[f.index(x, y, z)]; sy += y * d; sw += d; }
      return sy / sw;
    };
    expect(centroidY(1)).toBeLessThan(centroidY(0) - 2);
  });

  it('pushes outward at the emitter with a blast', () => {
    const speed = (blast: number) => {
      const f = run(small({ blast, fuel: 0, heat: 0, smoke: 1, emitSpeed: 0 }), 2);
      return sum(Array.from(f.u).map(Math.abs)) + sum(Array.from(f.w).map(Math.abs));
    };
    expect(speed(30)).toBeGreaterThan(speed(0) + 1);
  });

  it('carries the detail coordinates with the flow, and cross-fades the two sets', () => {
    const f = run(small({ detailStrength: 0.5, emitSpeed: 2 }), 8);
    expect(f.detailA).not.toBeNull();
    const d = f.detailDims;
    // Some coordinate has left its rest position (x*2, y*2, z*2).
    let moved = 0;
    for (let z = 0, i = 0; z < d.nz; z++) for (let y = 0; y < d.ny; y++) for (let x = 0; x < d.nx; x++, i++)
      moved = Math.max(moved, Math.hypot(f.detailA![i * 3] - x * 2, f.detailA![i * 3 + 1] - y * 2, f.detailA![i * 3 + 2] - z * 2));
    expect(moved).toBeGreaterThan(0.5);
    expect(detailBlend(0)).toBe(0);
    expect(detailBlend(0.75)).toBeCloseTo(1, 9);
  });

  it('burns blue only where fresh fuel first burns, the base of a flame, and less of it in a sooty one', () => {
    // Fresh from the emitter and burning: the whole zone.
    expect(blueCoreSource(0.5, 1, 1, 0)).toBeCloseTo(1, 9);
    // Cold gas holds no reaction zone, however fresh its fuel.
    expect(blueCoreSource(0, 1, 1, 0)).toBe(0);
    // Ramps in with the burning gas.
    expect(blueCoreSource(0.1, 1, 1, 0)).toBeCloseTo(0.4, 9);
    // Gone once BLUE_CORE_ZONE of a clean fuel has burnt, and fading toward that.
    expect(blueCoreSource(0.5, 1 - BLUE_CORE_ZONE, 1, 0)).toBe(0);
    expect(blueCoreSource(0.5, 0.2, 1, 0)).toBe(0);
    expect(blueCoreSource(0.5, 1 - BLUE_CORE_ZONE / 2, 1, 0)).toBeCloseTo(0.25, 9);
    // Soot forms sooner in a sooty fuel: at the same burn, a thinner zone.
    const fresh = 1 - BLUE_CORE_ZONE / 4;
    expect(blueCoreSource(0.5, fresh, 1, 0.6)).toBeLessThan(blueCoreSource(0.5, fresh, 1, 0.05));
    expect(blueCoreSource(0.5, 1 - BLUE_CORE_ZONE / (1 + BLUE_CORE_SOOT * 0.6), 1, 0.6)).toBe(0);
    // Relative to the emitter's fuel, never above 1; no emitter fuel, no zone (steam's vapour).
    expect(blueCoreSource(0.5, 2.5, 3, 0)).toBeCloseTo(blueCoreSource(0.5, 2.5 / 3, 1, 0), 9);
    expect(blueCoreSource(1, 5, 1, 0)).toBeLessThanOrEqual(1);
    expect(blueCoreSource(0.5, 1, 0, 0)).toBe(0);
  });

  it('draws a candle orange, with no blue body or violet tip', () => {
    // The preset run and rendered as the bake renders it: the share of the flame's pixels that read blue
    // (more blue than red). The old core lit two thirds of the burn at full strength.
    const bluePixels = (id: string, coarse: number) => {
      const preset = FX_PRESETS.find(q => q.id === id)!.params;
      const p = normaliseFx({ ...preset, voxelSize: preset.voxelSize * coarse, tileSize: 96, seed: 3 });
      const f = run(p, Math.round(0.35 / p.frameTime) * p.substeps);
      const { width, height } = tileDims(p);
      const square = Math.max(width, height);
      const tile = new Uint8Array(square * square * 4);
      renderTile(f, p, tile, square, bakeFireLut(p));
      let flame = 0, blue = 0;
      for (let k = 0; k < tile.length; k += 4) {
        if (tile[k + 3] < 51 || tile[k] + tile[k + 1] + tile[k + 2] < 60) continue;
        flame++;
        if (tile[k + 2] > tile[k]) blue++;
      }
      expect(flame).toBeGreaterThan(20);
      return blue / flame;
    };
    // (The old core read blue over a third of the candle.)
    expect(bluePixels('candle', 1.5)).toBeLessThan(0.03);
  });

  it('casts a ground shadow under smoke and none in clear air', () => {
    const dims = { nx: 16, ny: 16, nz: 16 };
    const clear = groundShadow(dims, [0, 1, 0], 2, () => 0);
    expect(clear.some((v, i) => i % 4 === 3 && v > 0)).toBe(false);
    const smoky = groundShadow(dims, [0, 1, 0], 2, () => 0.5);
    expect(smoky[(Math.floor(SHADOW_RES / 2) * SHADOW_RES + Math.floor(SHADOW_RES / 2)) * 4 + 3]).toBeGreaterThan(200);
  });
});

describe('section and scene presets', () => {
  const effectKeys = (title: string) => new Set(FX_SCHEMA.find(g => g.title === title)!.specs.map(s => s.key));

  it('on the effect side only touch their own section', () => {
    for (const [title, presets] of Object.entries(EFFECT_SECTION_PRESETS)) {
      const keys = effectKeys(title);
      for (const p of presets) for (const k of Object.keys(p.values)) expect(keys.has(k), `${title} / ${p.label}: ${k}`).toBe(true);
    }
  });

  it('on the scene side only touch their own section', () => {
    for (const [title, presets] of Object.entries(SCENE_SECTION_PRESETS)) {
      // What the eye menu shows and hides may be set by any section's preset (a sunset turns the sky on).
      const stageKeys = new Set([...(SCENE_SCHEMA.find(g => g.title === title)?.specs ?? []).map(s => s.key), ...VIEW_KEYS]);
      const paramKeys = new Set(((FX_SCENE_SPECS as Record<string, { key: string }[]>)[title] ?? []).map(s => s.key));
      for (const p of presets) {
        for (const k of Object.keys(p.values.scene ?? {})) expect(stageKeys.has(k), `${title} / ${p.label}: ${k}`).toBe(true);
        for (const k of Object.keys(p.values.params ?? {})) expect(paramKeys.has(k), `${title} / ${p.label}: ${k}`).toBe(true);
      }
    }
  });

  it('replace every effect parameter but the preview quality, and Reset returns to the preset', () => {
    const tweaked = normaliseFx({ ...DEFAULT_FX, seed: 999, lightYaw: 123, buoyancy: 77, frames: 3, previewQuality: 'low' });
    const preset = FX_PRESETS.find(p => p.id === 'campfire-hq')!;
    expect(effectPresetParams('campfire-hq', tweaked)).toEqual(normaliseFx({ ...preset.params, previewQuality: 'low' }));
    expect(effectPresetParams(null, tweaked)).toEqual(normaliseFx({ ...DEFAULT_FX, previewQuality: 'low' }));
    expect(effectPresetLabel('campfire-hq')).toBe(preset.label);
    expect(effectPresetLabel(null)).toBe('Defaults');
  });

  it('leave visibility to the eye menu: no scene section draws a view toggle', () => {
    for (const k of VIEW_KEYS) expect(k in DEFAULT_SCENE, k).toBe(true);
    const drawn = new Set(SCENE_SCHEMA.flatMap(g => g.specs.map(s => s.key)));
    for (const k of VIEW_KEYS) expect(drawn.has(k), k).toBe(false);
  });

  it('replace the bodies as whole scenes, and add to them as body presets', () => {
    const region: [number, number, number] = [4, 6, 4];
    const scene: FxScene = { ...DEFAULT_SCENE, bodies: [] };
    const lid = SCENE_SECTION_PRESETS.Bodies.find(p => p.id === 'lid')!;
    const once = applySceneValues(lid.values, scene, DEFAULT_FX, region, false);
    const twice = applySceneValues(lid.values, once.scene, DEFAULT_FX, region, false);
    expect(twice.scene.bodies.length).toBe(2);
    const indoor = SCENE_PRESETS.find(p => p.id === 'indoor')!;
    const room = applySceneValues(indoor.values, twice.scene, DEFAULT_FX, region, true);
    expect(room.scene.bodies.length).toBe(3);   // ceiling and two walls; the lids are gone
    const studio = applySceneValues(SCENE_PRESETS.find(p => p.id === 'studio')!.values, room.scene, DEFAULT_FX, region, true);
    expect(studio.scene.bodies.length).toBe(0);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assembleCustomFragment } from 'cleo/graphics/systems/customShaders';
import { WATER_SOURCE, WATER_UNIFORMS } from '../src/world/water/waterShader';
import { waterHeightField, waterNormalMap } from '../src/world/water/waterNormals';
import { buildWaterMesh } from '../src/world/water/waterMesh';
import { WATER_DRY, WATER_LAKE, WATER_SEA } from '../src/world/lakes';

// The World preview's water: its GLSL must reach WGSL through the engine's vendored naga (the Creator
// translates it at runtime on WebGPU, and a shader naga or the WGSL validator rejects draws nothing), its
// normal map must tile, and its mesh must cover the water and nothing else.

const NAGA_DIR = path.resolve(__dirname, '../../../src/graphics/rhi/webgpu/naga');
let glslToWgsl: (source: string, stage: string) => string;

beforeAll(async () => {
  const mod: any = await import(pathToFileURL(path.join(NAGA_DIR, 'nagaGlsl.js')).href);
  await mod.default({ module_or_path: readFileSync(path.join(NAGA_DIR, 'nagaGlsl_bg.wasm')) });
  glslToWgsl = mod.glsl_to_wgsl;
}, 60_000);

describe('World water shader', () => {
  it('translates to WGSL and passes naga\'s validation', () => {
    const vulkan = assembleCustomFragment('forward', WATER_SOURCE, WATER_UNIFORMS, 'vulkan');
    const wgsl = glslToWgsl(vulkan, 'fragment');
    expect(wgsl).toContain('fn main');
  });

  // naga validates types and bindings but not WGSL's uniformity rule, which the browser's compiler
  // enforces: implicit-derivative sampling (textureSample) is only legal in uniform control flow. The
  // terrain texture is read in helpers that branch, so it must use an explicit LOD.
  it('samples the terrain texture with an explicit LOD', () => {
    const wgsl = glslToWgsl(assembleCustomFragment('forward', WATER_SOURCE, WATER_UNIFORMS, 'vulkan'), 'fragment');
    expect(wgsl).toMatch(/textureSampleLevel\(u_terrainHeight_t/);
    // The one implicit sample allowed is the prelude's keep-alive touch of every sampler at the top of main.
    const implicit = wgsl.match(/textureSample\(u_terrainHeight_t[^\n]*/g) ?? [];
    expect(implicit.every(line => line.includes('vec2(0f)'))).toBe(true);
  });
});

describe('World water normal map', () => {
  it('tiles: the height field wraps', () => {
    const n = 64;
    const h = waterHeightField(n, 7);
    let seam = 0, inner = 0;
    for (let y = 0; y < n; y++) {
      seam += Math.abs(h[y * n] - h[y * n + n - 1]);
      inner += Math.abs(h[y * n + 1] - h[y * n]);
    }
    expect(seam).toBeLessThan(inner * 2.5);
  });

  it('is deterministic and unit-ish', () => {
    const a = waterNormalMap(32, 3), b = waterNormalMap(32, 3);
    expect(Array.from(a)).toEqual(Array.from(b));
    for (let i = 0; i < a.length; i += 4) {
      const v = [a[i], a[i + 1], a[i + 2]].map(x => x / 255 * 2 - 1);
      expect(Math.hypot(v[0], v[1], v[2])).toBeGreaterThan(0.9);
      expect(v[2]).toBeGreaterThan(0);
    }
  });
});

describe('World water mesh', () => {
  const R = 9;
  const kind = new Uint8Array(R * R).fill(WATER_DRY);
  const level = new Float32Array(R * R).fill(NaN);

  it('is empty without water', () => {
    expect(buildWaterMesh({ resolution: R, kind, level, seaLevel: 0 }, 80)).toBeNull();
  });

  it('puts a lake at its level and adds no sea skirt', () => {
    const k = Uint8Array.from(kind), l = Float32Array.from(level);
    for (let r = 3; r <= 5; r++) for (let c = 3; c <= 5; c++) { k[r * R + c] = WATER_LAKE; l[r * R + c] = 12; }
    const m = buildWaterMesh({ resolution: R, kind: k, level: l, seaLevel: 0 }, 80)!;
    for (let i = 1; i < m.positions.length; i += 3) expect(m.positions[i]).toBe(12);
    let maxX = 0;
    for (let i = 0; i < m.positions.length; i += 3) maxX = Math.max(maxX, Math.abs(m.positions[i]));
    expect(maxX).toBeLessThanOrEqual(40);
  });

  it('carries the sea past the map', () => {
    const k = Uint8Array.from(kind), l = Float32Array.from(level);
    for (let c = 0; c < R; c++) { k[c] = WATER_SEA; l[c] = 0; }
    const m = buildWaterMesh({ resolution: R, kind: k, level: l, seaLevel: 0 }, 80)!;
    let maxX = 0;
    for (let i = 0; i < m.positions.length; i += 3) maxX = Math.max(maxX, Math.abs(m.positions[i]));
    expect(maxX).toBeGreaterThan(40);
  });
});

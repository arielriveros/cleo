import { describe, it, expect } from 'vitest';
import { selectShaders, variantsNamed, type ShaderLibraryJson } from '../src/features/publish/shaderSelection';

// What a publish copies from the player's shader library into a game (shaderSelection.ts): every module's
// base program, the variants the program list names, and the GLSL only for a game that may run on WebGL 2.

const program = (name: string) => ({ wgsl: `// ${name}`, vertex: `#version 300 es // ${name} vs`, fragment: `#version 300 es // ${name} fs`, entryPoints: {}, resources: [], vertexInputs: [], uniformBlocks: [] });

const library: ShaderLibraryJson = {
  'wgsl/pbr.wgsl': { base: program('pbr'), variants: { pcf: program('pbr~pcf'), poisson: program('pbr~poisson'), 'pcf.pom': program('pbr~pcf.pom') } },
  'wgsl/sky.wgsl': { base: program('sky') },
  'wgsl/particleSim.wgsl': { base: program('sim'), variants: { s1: program('sim~s1'), s2: program('sim~s2') } },
  'wgsl/chunks.wgsl': { base: { ...program('chunks'), glslChunk: 'vec3 f();' } },
};
const programModules = { pbr: 'wgsl/pbr.wgsl', pbrSkinned: 'wgsl/pbrSkinned.wgsl', skybox: 'wgsl/sky.wgsl', particleSim: 'wgsl/particleSim.wgsl' };

describe('the shaders a game ships', () => {
  it('reads which variants of which module a program list names', () => {
    const named = variantsNamed(['pbr~pcf', 'pbr~pcf.pom', 'skybox', 'particleSim~s2', 'custom~x'], programModules);
    expect([...named.get('wgsl/pbr.wgsl')!].sort()).toEqual(['pcf', 'pcf.pom']);
    expect([...named.get('wgsl/particleSim.wgsl')!]).toEqual(['s2']);
    expect(named.has('wgsl/sky.wgsl')).toBe(false);
  });

  it('keeps every base and only the listed variants', () => {
    const out = selectShaders(library, { programs: ['pbr~pcf', 'skybox'], programModules, webgl2: true });
    expect(Object.keys(out).sort()).toEqual(Object.keys(library).sort());
    expect(Object.keys(out['wgsl/pbr.wgsl'].variants!)).toEqual(['pcf']);
    expect(out['wgsl/particleSim.wgsl'].variants).toBeUndefined();
    expect(out['wgsl/sky.wgsl'].base).toEqual(library['wgsl/sky.wgsl'].base);
  });

  it('keeps every variant without a program list: the game builds them as it goes', () => {
    const out = selectShaders(library, { programModules, webgl2: true });
    expect(Object.keys(out['wgsl/pbr.wgsl'].variants!).sort()).toEqual(['pcf', 'pcf.pom', 'poisson']);
    expect(Object.keys(out['wgsl/particleSim.wgsl'].variants!).sort()).toEqual(['s1', 's2']);
  });

  it('drops the program GLSL of a WebGPU-only game, and keeps the rest', () => {
    const out = selectShaders(library, { programs: ['pbr~pcf'], programModules, webgl2: false });
    for (const entry of Object.values(out))
      for (const data of [entry.base, ...Object.values(entry.variants ?? {})]) {
        expect(data.vertex).toBeUndefined();
        expect(data.fragment).toBeUndefined();
        expect(typeof data.wgsl).toBe('string');
        expect(data.uniformBlocks).toEqual([]);
      }
    expect(JSON.stringify(out)).not.toContain('#version 300 es');
    // A custom material's prelude is GLSL on WebGPU as well.
    expect(out['wgsl/chunks.wgsl'].base.glslChunk).toBe('vec3 f();');
  });

  it('leaves out the modules of features the game is built without, unless a listed program draws with one', () => {
    const leaveOut = new Set(['wgsl/particleSim.wgsl', 'wgsl/sky.wgsl'])
    const out = selectShaders(library, { programs: ['pbr~pcf', 'skybox'], programModules, webgl2: true, leaveOut });
    expect(out['wgsl/particleSim.wgsl']).toBeUndefined();
    expect(out['wgsl/sky.wgsl']).toBeDefined();
    expect(out['wgsl/pbr.wgsl']).toBeDefined();
  });

  it('ignores a listed variant the library does not have', () => {
    const out = selectShaders(library, { programs: ['pbr~wind'], programModules, webgl2: true });
    expect(out['wgsl/pbr.wgsl'].variants).toBeUndefined();
  });
});

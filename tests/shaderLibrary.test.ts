import { describe, it, expect, afterEach } from 'vitest';
import { installShaderLibrary, shaderModuleHandle, shadersAreLibraryHandles, shaderIsShipped } from '../src/graphics/shaderLibrary';
import { programModules, programTable } from '../src/graphics/render/programs';
import PbrProgram from '../src/graphics/shaders/wgsl/pbr.wgsl';

// The published player imports its shaders as handles onto the library its game carries
// (src/graphics/shaderLibrary.ts, tools/viteGlsl.mjs library mode). Everywhere else a shader import is the
// program itself; these check that the two read alike, and what a handle does with a program left out.

const data = (tag: string) => ({ wgsl: `// ${tag}`, vertex: `vs ${tag}`, fragment: `fs ${tag}`, entryPoints: { vertex: 'vs', fragment: 'fs' }, resources: [], vertexInputs: [], uniformBlocks: [] });

afterEach(() => installShaderLibrary(null));

describe('a shader handle', () => {
  it('reads its module from the installed library, field by field, and spreads like the program', () => {
    const handle = shaderModuleHandle('wgsl/test.wgsl', []);
    expect(shadersAreLibraryHandles()).toBe(true);
    installShaderLibrary({ 'wgsl/test.wgsl': { base: data('base') } });
    expect(handle.wgsl).toBe('// base');
    expect(handle.module).toBe('wgsl/test.wgsl');
    // A program is built from `{ ...descriptor, label }`: the spread must carry every field.
    const spread = { ...handle, label: 'test' };
    expect(spread).toMatchObject({ wgsl: '// base', vertex: 'vs base', fragment: 'fs base', entryPoints: { vertex: 'vs', fragment: 'fs' }, label: 'test' });
  });

  it('lists only the variants the game shipped, each one object for the session', () => {
    const handle = shaderModuleHandle('wgsl/v.wgsl', ['pcf', 'poisson']);
    installShaderLibrary({ 'wgsl/v.wgsl': { base: data('base'), variants: { pcf: data('pcf') } } });
    const variants = handle.variants as Record<string, any>;
    expect(Object.keys(variants)).toEqual(['pcf']);
    expect(variants.pcf.wgsl).toBe('// pcf');
    expect((handle.variants as any).pcf).toBe(variants.pcf);
  });

  it('tells a module the game left out from one it shipped, and lists no variants for it', () => {
    const gone = shaderModuleHandle('wgsl/off.wgsl', ['pcf']);
    const kept = shaderModuleHandle('wgsl/on.wgsl', ['pcf']);
    installShaderLibrary({ 'wgsl/on.wgsl': { base: data('on') } });
    expect(shaderIsShipped(gone)).toBe(false);
    expect(shaderIsShipped(kept)).toBe(true);
    expect(gone.variants).toBeUndefined();
    expect(kept.variants).toEqual({});
    // An inline program (every build but the published player) is always at hand.
    expect(shaderIsShipped(PbrProgram)).toBe(true);
  });

  it('says what is missing: no library, or a module the game did not ship', () => {
    const handle = shaderModuleHandle('wgsl/gone.wgsl', []);
    expect(() => handle.wgsl).toThrow(/no shader library is installed/);
    installShaderLibrary({});
    expect(() => handle.wgsl).toThrow(/wgsl\/gone\.wgsl was not shipped/);
  });
});

describe('an inline shader import', () => {
  it('names its module, which is how a publish finds a program\'s variants', () => {
    expect((PbrProgram as any).module).toBe('wgsl/pbr.wgsl');
    const modules = programModules();
    expect(modules.pbr).toBe('wgsl/pbr.wgsl');
    // Every program-table entry names one.
    for (const [name] of programTable()) expect(modules[name], name).toMatch(/\.wgsl$/);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The compute kernels never pass through naga's GLSL backend at build time (ES 300 has no compute
// stage), so nothing else checks them before a browser does. This parses and validates each one with
// the engine's vendored naga -- the same front end and validator the build uses for every raster shader.
// The GLSL writer then refuses (storage buffers and compute are not ES 300); only parse and validation
// errors fail the test.

const NAGA = path.resolve(__dirname, '../../../src/graphics/rhi/webgpu/naga');
const DIRS = ['../src/fx/shaders', '../src/world/shaders'].map(d => path.resolve(__dirname, d));

async function loadNaga() {
  const mod = await import(pathToFileURL(path.join(NAGA, 'nagaGlsl.js')).href);
  await mod.default({ module_or_path: readFileSync(path.join(NAGA, 'nagaGlsl_bg.wasm')) });
  return mod as { wgsl_to_glsl(src: string, stage: string, entry: string): string };
}

function expandIncludes(file: string): string {
  return readFileSync(file, 'utf8').replace(/#include "([^"]+)"/g, (_, rel) => expandIncludes(path.resolve(path.dirname(file), rel)));
}

describe('Creator compute kernels', () => {
  const kernels = DIRS.flatMap(dir => readdirSync(dir)
    .filter(f => f.endsWith('.wgsl') && !/Common\.wgsl$/.test(f))
    .map(f => path.join(dir, f)));

  it('finds the kernels', () => {
    expect(kernels.length).toBe(15);
  });

  it('parses and validates every kernel', async () => {
    const naga = await loadNaga();
    const failures: string[] = [];
    for (const file of kernels) {
      const src = expandIncludes(file);
      const entry = src.match(/@compute[^\n]*\n\s*fn\s+(\w+)/)?.[1];
      if (!entry) { failures.push(`${path.basename(file)}: no @compute entry point`); continue; }
      try {
        naga.wgsl_to_glsl(src, 'compute', entry);
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        if (/parse failed|validation failed/.test(message)) failures.push(`${path.basename(file)}: ${message.slice(0, 600)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

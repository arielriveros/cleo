// WGSL -> GLSL ES 300, at build time.
//
// The engine authors shaders in WGSL and generates GLSL for the WebGL2 backend, because that is the
// only direction naga supports: its GLSL *frontend* is Vulkan-flavoured and cannot read the ES dialect
// this engine writes, while its GLSL *backend* emits precisely that dialect. See WEBGPU_ROADMAP.md M3.
//
// This module is the BUILD side: it loads naga off disk. The procedure itself lives in wgslGlsl.mjs,
// which the editor also runs (for particle custom code). No naga wasm reaches a player.

import { readFileSync } from 'node:fs';
import path from 'node:path';
// `findResources` / `findUniformBlocks` live in wgslLayout.mjs so the ENGINE can import them too:
// a custom material's WGSL arrives at runtime and has to be reflected with the same code that
// reflects the engine's own at build time. Re-exported here because this module is where every
// existing caller looks for them.
import { findResources, findUniformBlocks } from './wgslLayout.mjs';
export { findResources, findUniformBlocks };
import { translateWgslWith } from './wgslGlsl.mjs';
export { findEntryPoints, findVertexInputs, buildRenames, extractGlslChunk, translateWgslWith } from './wgslGlsl.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAGA_DIR = path.resolve(HERE, '..', 'src', 'graphics', 'rhi', 'webgpu', 'naga');

let naga = null;

/** Load the vendored naga artifact once per process. It is a `--target web` build, which Node loads
 *  fine as long as the wasm bytes are handed over explicitly rather than fetched. */
async function loadNaga() {
    if (naga) return naga;
    const mod = await import(pathToFileURL(path.join(NAGA_DIR, 'nagaGlsl.js')).href);
    await mod.default({ module_or_path: readFileSync(path.join(NAGA_DIR, 'nagaGlsl_bg.wasm')) });
    naga = mod;
    return naga;
}

/**
 * Translate one WGSL module into the GLSL its declared stages need. See `translateWgslWith`, which
 * holds the whole procedure; this only supplies the naga loaded from disk.
 */
export async function translateWgsl(wgsl, label = 'shader') {
    const mod = await loadNaga();
    return translateWgslWith((source, stage, entry) => mod.wgsl_to_glsl(source, stage, entry), wgsl, label);
}

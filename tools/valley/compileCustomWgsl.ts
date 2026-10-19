// Translate a custom material's GLSL to WGSL OFFLINE, for a generator to store in `compiledWgsl`.
//
//     npx vite-node --config vitest.config.ts tools/valley/compileCustomWgsl.ts < request.json
//
// request.json: `{ "renderMode": "forward", "fragmentSource": "...", "uniforms": [...] }`.
// Prints `{ "wgsl": "...", "hash": "...", "type": "custom:..." }` on stdout — `type` being the shader key
// `CustomMaterial.refreshType` derives, which `compiledWgslType` records.
//
// Why this exists: a published game ships no GLSL translator, so on WebGPU a custom material renders
// only from the WGSL it was saved with (customShaders.ts `webgpuHalf`). The editor stores that when a
// material is compiled in its inspector; a material written by a generator has to bring it along.
// Run through vite-node with the engine's own config because customShaders.ts imports `.wgsl` chunks,
// which only the engine's shader plugin can load — the same reason the dialect tests run under vitest.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assembleCustomFragment, customWgslHash } from '../../src/graphics/systems/customShaders'
import { CustomMaterial } from '../../src/graphics/material'

const NAGA_DIR = path.resolve(__dirname, '..', '..', 'src', 'graphics', 'rhi', 'webgpu', 'naga')

async function main() {
    const request = JSON.parse(readFileSync(0, 'utf8'))
    const naga: any = await import(pathToFileURL(path.join(NAGA_DIR, 'nagaGlsl.js')).href)
    await naga.default({ module_or_path: readFileSync(path.join(NAGA_DIR, 'nagaGlsl_bg.wasm')) })
    const vulkan = assembleCustomFragment(request.renderMode, request.fragmentSource, request.uniforms, 'vulkan')
    const wgsl: string = naga.glsl_to_wgsl(vulkan, 'fragment')
    const m = CustomMaterial.Create(request.baseType ?? null, request.renderMode)
    m.fragmentSource = request.fragmentSource
    m.uniforms = request.uniforms
    m.refreshType()
    process.stdout.write(JSON.stringify({
        wgsl, type: m.type, hash: customWgslHash(request.renderMode, request.fragmentSource, request.uniforms),
    }))
}

main().catch(e => { process.stderr.write(String(e?.stack ?? e)); process.exit(1) })

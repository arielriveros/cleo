// Bake an octahedral foliage impostor offline, with the engine's own baker (src/terrain/octahedralBake.ts)
// — the one the editor's "Bake impostor" runs — so the generator's atlas and an editor re-bake agree.
//
//     npx vite-node --config vitest.config.ts tools/valley/bakeOctahedral.ts <request.json>
//
// request.json: `{ frames, frameSize, normalFrameSize, supersample, albedoOut, normalOut, parts: [{
//   positions, normals, uvs, indices,           raw little-endian f32 / f32 / f32 / u32 files
//   diffuse: { file, width, height },           raw RGBA8 (tools/valley/rawimage.py decode)
//   mask?: { file, width, height },             its RED channel is the alpha
//   cutoff }] }`
// Writes the two atlases as raw RGBA8 to albedoOut/normalOut and prints
// `{ info, albedoSize, normalSize, coverage }` on stdout.

import { readFileSync, writeFileSync } from 'node:fs'
import { bakeOctahedralImpostor, rgbaSampler, type OctahedralBakePart } from '../../src/terrain/octahedralBake'

function f32(file: string): Float32Array {
    const b = readFileSync(file)
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
}
function u32(file: string): Uint32Array {
    const b = readFileSync(file)
    return new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
function rgba(t: { file: string; width: number; height: number }): Uint8Array {
    return new Uint8Array(readFileSync(t.file))
}

const request = JSON.parse(readFileSync(process.argv[process.argv.length - 1], 'utf8'))
const parts: OctahedralBakePart[] = request.parts.map((p: any) => {
    const diffuse = rgbaSampler(rgba(p.diffuse), p.diffuse.width, p.diffuse.height)
    const mask = p.mask ? rgbaSampler(rgba(p.mask), p.mask.width, p.mask.height) : null
    const m = new Float32Array(4)
    return {
        positions: f32(p.positions), normals: p.normals ? f32(p.normals) : null,
        uvs: f32(p.uvs), indices: u32(p.indices),
        sample: mask ? (u: number, v: number, out: Float32Array) => { diffuse(u, v, out); mask(u, v, m); out[3] = m[0] } : diffuse,
        cutoff: p.cutoff ?? 0,
    }
})
const t0 = performance.now()
const bake = bakeOctahedralImpostor(parts, {
    frames: request.frames, frameSize: request.frameSize, normalFrameSize: request.normalFrameSize,
    supersample: request.supersample,
})
writeFileSync(request.albedoOut, bake.albedo)
writeFileSync(request.normalOut, bake.normal)
process.stdout.write(JSON.stringify({
    info: bake.info, albedoSize: bake.albedoSize, normalSize: bake.normalSize, coverage: bake.coverage,
    ms: Math.round(performance.now() - t0),
}) + '\n')

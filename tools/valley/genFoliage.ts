// Generate the Valley's plants with the Foliage Creator, headless: the same generator, presets and
// impostor baker the Creator runs in the browser, so every tree, bush and grass clump in the example is
// one a user could make (and tweak) in the Creator.
//
//     npx vite-node --config applications/creator/vitest.config.ts tools/valley/genFoliage.ts <request.json>
//
// request.json: `{ items: [{ key, kind, preset, seed, params, outDir }] }` -- a Foliage Creator preset of
// that kind, with `params` laid over it (as editing it in the Creator would) and the seed. `barkImage`
// (raw RGBA8, `{ file, width, height }`) replaces the generated bark colour, as the Creator's Materials tab
// Image… does: the scanned bark the Valley's trees wear, so their impostors are baked in its colour.
// Writes per item, into its outDir:
//   - `<texture>.png`              every texture the materials use (the Creator's own PNGs);
//   - `lod<i>_<part>.bin`          a part's positions, normals, uvs, indices (f32/f32/f32/u32, in that order),
//                                  uvs ALREADY flipped to the engine's v (meshes.mjs: v = 0 at the bottom);
//   - `impostor_albedo.png`, `impostor_normal.png`   when the document asks for an impostor;
//   - `manifest.json`              levels, materials (MaterialSpec), textures, impostor info, collider, bounds.
// Prints one line per item on stdout.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bakeImpostor, buildFoliage, encodeTextures, levelStats } from '../../applications/creator/src/foliage/buildFoliage'
import { DEFAULT_DOC, type FoliageDoc, type FoliageKind } from '../../applications/creator/src/foliage/foliageParams'
import { applyPreset, FOLIAGE_PRESETS } from '../../applications/creator/src/foliage/foliagePresets'

interface RawImage { file: string; width: number; height: number }
interface Item { key: string; kind: FoliageKind; preset: string; seed: number; params?: Record<string, unknown>; barkImage?: RawImage; outDir: string }

const rawImage = (r: RawImage) => ({ width: r.width, height: r.height, data: new Uint8Array(readFileSync(r.file)) })

function docOf(item: Item): FoliageDoc {
    const preset = FOLIAGE_PRESETS.find(p => p.id === item.preset && p.kind === item.kind)
    if (!preset) throw new Error(`${item.key}: no ${item.kind} preset "${item.preset}"`)
    return { ...DEFAULT_DOC, kind: item.kind, seed: item.seed, name: item.key, [item.kind]: { ...applyPreset(preset), ...(item.params ?? {}) } }
}

const request = JSON.parse(readFileSync(process.argv[process.argv.length - 1], 'utf8')) as { items: Item[] }

for (const item of request.items) {
    const t0 = performance.now()
    mkdirSync(item.outDir, { recursive: true })
    const model = buildFoliage(docOf(item), item.barkImage ? { bark: rawImage(item.barkImage) } : {})

    const pngs = await encodeTextures(model)
    const textures: Record<string, string> = {}
    for (const [key, bytes] of Object.entries(pngs)) {
        const file = `${key}.png`
        writeFileSync(join(item.outDir, file), bytes!)
        textures[key] = file
    }

    const levels = model.levels.map((level, li) => ({
        distance: level.distance,
        parts: level.parts.map((part, pi) => {
            const { positions, normals, uvs, indices } = part.buffers
            const flipped = new Float32Array(uvs.length)
            for (let i = 0; i < uvs.length; i += 2) { flipped[i] = uvs[i]; flipped[i + 1] = 1 - uvs[i + 1] }
            const file = `lod${li}_${pi}.bin`
            writeFileSync(join(item.outDir, file), Buffer.concat([positions, normals, flipped, indices].map(a => Buffer.from(a.buffer, a.byteOffset, a.byteLength))))
            return { name: part.name, material: part.material, file, vertices: positions.length / 3, indices: indices.length }
        }),
    }))

    // From the LAST mesh level (the Creator's rule): the impostor replaces it, so it must match it.
    let impostor = null
    if (model.impostor) {
        const bake = await bakeImpostor(model)
        if (bake) {
            writeFileSync(join(item.outDir, 'impostor_albedo.png'), bake.albedo)
            writeFileSync(join(item.outDir, 'impostor_normal.png'), bake.normal)
            impostor = { ...model.impostor, info: bake.info, albedoSize: bake.albedoSize, normalSize: bake.normalSize,
                         albedo: 'impostor_albedo.png', normal: 'impostor_normal.png' }
        }
    }

    writeFileSync(join(item.outDir, 'manifest.json'), JSON.stringify({
        key: item.key, kind: model.kind, levels, materials: model.materials, textures, impostor,
        cullDistance: model.cullDistance, collider: model.collider, bounds: model.bounds,
    }, null, 1))
    process.stdout.write(`${item.key}: ${model.kind} ${levelStats(model).map(s => s.triangles).join('/')} tris` +
        `${impostor ? `, impostor ${impostor.albedoSize}px` : ''}, ${Math.round(performance.now() - t0)} ms\n`)
}

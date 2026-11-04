// Bake the Valley's effects with the FX Creator, headless: the same solvers, presets and exporter the
// Creator runs in the browser (its CPU backends), so every flame, splash and pool in the example is one a
// user could open in the Creator and tweak.
//
//     npx vite-node --config applications/creator/vitest.config.ts tools/valley/genFx.ts <request.json>
//
// request.json: `{ items: [{ key, preset, seed, params, outDir }] }` -- an FX Creator preset with `params`
// laid over it (as editing it in the Creator would) and the seed. Writes per item, into its outDir, exactly
// what the Creator's Export flipbook writes (`<key>_flipbook.png`, the `.tileset`, the extra atlases, a
// liquid's decal atlases and stills, `<key>.json`), and `manifest.json`: the sidecar's `output` block, the
// parameters it was baked from and the file names. Prints one line per item on stdout.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FX_PRESETS, normaliseFx, type FxParams } from '../../applications/creator/src/fx/fxParams'
import { exportFx, generateFx } from '../../applications/creator/src/fx/generateFx'

interface Item { key: string; preset: string; seed: number; params?: Partial<FxParams>; outDir: string }

function paramsOf(item: Item): FxParams {
    const preset = FX_PRESETS.find(p => p.id === item.preset)
    if (!preset) throw new Error(`${item.key}: no FX preset "${item.preset}"`)
    return normaliseFx({ ...preset.params, ...(item.params ?? {}), seed: item.seed } as FxParams)
}

const request = JSON.parse(readFileSync(process.argv[process.argv.length - 1], 'utf8')) as { items: Item[] }

for (const item of request.items) {
    const t0 = performance.now()
    mkdirSync(item.outDir, { recursive: true })
    const p = paramsOf(item)
    const out = await generateFx(p)
    const files = await exportFx(out, p, item.key)
    for (const f of files) writeFileSync(join(item.outDir, f.name), f.bytes)
    const sidecar = JSON.parse(new TextDecoder().decode(files.find(f => f.name === `${item.key}.json`)!.bytes))
    writeFileSync(join(item.outDir, 'manifest.json'), JSON.stringify({
        key: item.key, preset: item.preset, seed: item.seed, files: files.map(f => f.name), output: sidecar.output, params: p,
    }, null, 2))
    const decal = out.decal ? `, decal ${out.decal.layout.columns}x${out.decal.layout.rows} of ${out.decal.layout.tileWidth} px` : ''
    console.log(`${item.key}: ${out.frames.length} frames of ${out.layout.tileWidth}x${out.layout.tileHeight} (${out.dims.nx}x${out.dims.ny}x${out.dims.nz})${decal} in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}

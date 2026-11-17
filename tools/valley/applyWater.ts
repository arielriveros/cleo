// Move the shipped Valley's pond onto the Water node's own surface: the Pond Water Volume draws the water
// with a Water material ("Pond Water", a clear-lake look a little greener and siltier), and the old
// custom-material plane (Pond Water) and its material go. Re-runnable: a pond already moved is left as is.
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/valley/applyWater.ts [--dry]
//
// tools/valley/build.mjs builds the pond this way too (pondVolume), so a full rebuild agrees.

import { VALLEY_DIR, log, nodes, prune, read, write } from './bundleOps'
import { stableId } from '../exampleKit/bundle.mjs'
import { WaterMaterial } from '../../src/graphics/material'
import { POND_WATER_LOOK } from './pondWater.mjs'

const args = new Set(process.argv.slice(2))
const bundle = await read(VALLEY_DIR)

// The id build.mjs gives it (soulsDemo's material(): `souls:material:<key>`), so a rebuild agrees.
const MATERIAL_ID = stableId('souls:material:valley:pond-water')
const materials: any[] = bundle.libraries.materials ?? (bundle.libraries.materials = [])
if (!materials.some(m => m.id === MATERIAL_ID)) {
    materials.push({ id: MATERIAL_ID, name: 'Pond Water', material: new WaterMaterial(POND_WATER_LOOK).serialize(), textureIds: [], thumbnail: '' })
}
const material = materials.find(m => m.id === MATERIAL_ID)!

let moved = 0
for (const scene of Object.values(bundle.scenes) as any[]) {
    const root = scene.scene ?? scene
    for (const n of nodes(root)) {
        if (n.type !== 'waterVolume' || n.name !== 'Pond Water Volume') continue
        if (n.waterVolume.waterMaterialId === MATERIAL_ID && !n.waterVolume.surfaceNodeId) continue
        const v = n.waterVolume
        // The plane it pointed at is gone: the node draws its own surface now.
        const surfaceId = v.surfaceNodeId
        delete v.surfaceNodeId
        v.waterMaterialId = MATERIAL_ID
        v.waterMaterial = material.material
        v.windSpeed = v.windSpeed ?? 2
        if (surfaceId) {
            for (const p of nodes(root)) {
                const i = (p.children ?? []).findIndex((c: any) => c.id === surfaceId)
                if (i >= 0) { p.children.splice(i, 1); break }
            }
        }
        moved++
    }
}
log(`pond moved onto the Water node in ${moved} scene(s)`)
// The custom water material and its normal map are now reached by nothing.
const removed = prune(bundle, new Set([`material:${MATERIAL_ID}`]))
log('pruned', JSON.stringify(removed))
await write(VALLEY_DIR, bundle, 'Valley', args.has('--dry'))

// Furnish the shipped Valley's two enterable houses (interiorProps.ts): the library pieces from
// build/additional_valley_props and the `Furniture` group in the scene.
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/valley/applyInteriorProps.ts [--reimport] [--dry]
//
//   --reimport  rebuild the library pieces from build/additional_valley_props even when the library has them
//               (the first run imports them anyway); needs Python with Pillow for the GLBs' maps
//   --dry       build everything, write nothing to the example
//
// The GI bakes of the volumes round the furniture go stale with it: bake them again afterwards with
// `node tools/valley/bakeGI.cjs`.

import { VALLEY_DIR, read, write } from './bundleOps'
import { applyInteriorProps } from './interiorProps'

const args = new Set(process.argv.slice(2))
const bundle = await read(VALLEY_DIR)
applyInteriorProps(bundle, { reimport: args.has('--reimport') })
await write(VALLEY_DIR, bundle, 'Valley', args.has('--dry'))

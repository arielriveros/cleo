// Dress the shipped Valley's hamlet (hamletDressing.ts): the well on the square and the light poles along the
// stone trail in place of the standing torches, their library models from build/additional_valley_props.
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/valley/applyHamletDressing.ts [--reimport] [--dry]
//
//   --reimport  rebuild the light pole and the well from build/additional_valley_props even when the library
//               has them (the first run imports them anyway); needs Python with Pillow for their maps
//   --dry       build everything, write nothing to the example
//
// The Hamlet GI bake goes stale with it: bake it again afterwards with `node tools/valley/bakeGI.cjs`.

import { VALLEY_DIR, read, write } from './bundleOps'
import { applyHamletDressing } from './hamletDressing'

const args = new Set(process.argv.slice(2))
const bundle = await read(VALLEY_DIR)
applyHamletDressing(bundle, { reimport: args.has('--reimport') })
await write(VALLEY_DIR, bundle, 'Valley', args.has('--dry'))

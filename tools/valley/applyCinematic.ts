// Apply the start menu and the cinematic tour (cinematic.ts) to the shipped Valley example, after the fixes in
// valleyFixes.ts (the puddle decals removed), the houses' furniture (interiorProps.ts, its models already in the
// library; tools/valley/applyInteriorProps.ts --reimport rebuilds them from build/additional_valley_props) and the
// hamlet's well and light poles (hamletDressing.ts; applyHamletDressing.ts --reimport rebuilds their models).
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/valley/applyCinematic.ts [--regenerate] [--dry]
//
//   --regenerate  rebuild tools/valley/cinematic/valley-tour.sequence.json from the shot list (tour.ts)
//   --dry         build everything, write nothing to the example

import { VALLEY_DIR, read, write } from './bundleOps'
import { applyCinematic } from './cinematic'
import { removePuddles } from './valleyFixes'
import { applyInteriorProps } from './interiorProps'
import { applyHamletDressing } from './hamletDressing'

const args = new Set(process.argv.slice(2))
const bundle = await read(VALLEY_DIR)
removePuddles(bundle)
applyInteriorProps(bundle)
applyHamletDressing(bundle)
applyCinematic(bundle, { regenerate: args.has('--regenerate') })
await write(VALLEY_DIR, bundle, 'Valley', args.has('--dry'))

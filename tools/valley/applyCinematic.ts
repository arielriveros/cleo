// Apply the start menu and the cinematic tour (cinematic.ts) to the shipped Valley example, and nothing else.
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/valley/applyCinematic.ts [--regenerate] [--dry]
//
//   --regenerate  rebuild tools/valley/cinematic/valley-tour.sequence.json from the shot list (tour.ts)
//   --dry         build everything, write nothing to the example

import { VALLEY_DIR, read, write } from './bundleOps'
import { applyCinematic } from './cinematic'

const args = new Set(process.argv.slice(2))
const bundle = await read(VALLEY_DIR)
applyCinematic(bundle, { regenerate: args.has('--regenerate') })
await write(VALLEY_DIR, bundle, 'Valley', args.has('--dry'))

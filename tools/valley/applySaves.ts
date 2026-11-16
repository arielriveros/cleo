// Apply saving (saves.ts) to the shipped Dungeon example: the souls scripts' current sources, the title menu,
// the pause menu's Load Last Rest and the Saved bloodstain. Re-runnable.
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/valley/applySaves.ts [--dry]
//
// Run it again after changing a Souls*.ts script: the Dungeon embeds every script's source.

import { DUNGEON_DIR, read, write } from './bundleOps'
import { applySaves } from './saves'

const args = new Set(process.argv.slice(2))
const bundle = await read(DUNGEON_DIR)
applySaves(bundle)
await write(DUNGEON_DIR, bundle, 'Dungeon', args.has('--dry'))

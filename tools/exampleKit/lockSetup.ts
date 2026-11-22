// Before an example's tests run (vitestPreset.ts: each example project's globalSetup), its data lock is brought up
// to the folder: what an edit in the desktop editor added or changed is locked, what nothing references any more
// leaves (tools/examples/data.mjs `lock`, no network). So `npm test` after an edit passes on the edit's data, and
// the lock the next commit carries is the folder's. Uploading the packs that changed stays `examples:publish`.

import path from 'node:path'
import type { TestProject } from 'vitest/node'
import { lock, lockSummary } from '../examples/data.mjs'

export default function lockExampleData(project: TestProject): void {
  const dir = project.config.root
  const slug = path.basename(dir)
  const r = lock(slug, dir)
  const line = lockSummary(slug, r)
  if (line) console.log(`[examples] ${line}`)
}

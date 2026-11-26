// What every example project is held to, run by each example's tests/project.test.ts on its own folder. An example
// is edited in the desktop editor, so these are what the editor's own writes keep true, not rules about content:
//
//   - every text file is LF;
//   - its data lock covers its text, no data is in git and no text is ignored (tools/examples/data.mjs; the lock
//     itself is brought up to the folder before the tests run, lockSetup.ts);
//   - each script's stored fields are what its source declares (a .ts edited outside Cleo: npm run examples:sync);
//   - nothing in it is what the editor rewrites when it opens a project (editorNormalize.mjs), so opening it in Cleo
//     leaves a checkout clean;
//   - the folder is a fixed point of the editor's folder codec: read and written again it is the same bytes, so a
//     codec change that would rewrite the examples fails here first.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { EXAMPLE, dataReady, readThisExample } from '../testKit'
import { isDataFile, projectFiles, readSnapshot } from '../folder.mjs'
import { folderModules } from '../editorModules.mjs'
import { reflectScripts } from '../syncScripts.mjs'
import { normalizeForEditor } from '../editorNormalize.mjs'
import { check } from '../../examples/data.mjs'

export interface ProjectSpecOptions {
  /** The example folder (default: the one whose tests run). */
  dir?: string
}

export function projectSpecs(options: ProjectSpecOptions = {}): void {
  const dir = options.dir ?? EXAMPLE
  const slug = path.basename(dir)
  const ready = dataReady(dir)

  describe(`the ${slug} example folder`, () => {
    it('keeps every text file LF', () => {
      for (const rel of projectFiles(dir)) {
        if (isDataFile(dir, rel)) continue
        expect(fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8').includes('\r'), rel).toBe(false)
      }
    })

    it('is consistent with its data lock: no data in git, no text ignored, every blob locked', () => {
      expect(check(slug, dir)).toEqual([])
    })

    describe.skipIf(!ready)('with its data', () => {
      it("stores each script's fields as its source declares them (npm run examples:sync)", async () => {
        const { bundle } = await readThisExample(dir)
        const fresh = reflectScripts(bundle)
        for (const s of bundle.libraries.scripts ?? []) {
          if (!fresh.has(s.id)) continue
          expect(JSON.stringify(s.variables), s.name).toBe(JSON.stringify(fresh.get(s.id)))
        }
      })

      it('holds nothing the editor would write back on opening it', async () => {
        const { bundle } = await readThisExample(dir)
        expect(normalizeForEditor(structuredClone(bundle))).toEqual([])
      })

      it("reads and writes back through the editor's folder codec byte for byte", async () => {
        const { bundleToFolder, folderToBundle, parseProjectFile, blobRel } = folderModules()
        const snapshot = readSnapshot(dir)
        const read = await folderToBundle({ files: snapshot.files, dirs: snapshot.dirs, blobs: snapshot.blobs })
        expect(read.blocked, 'files the codec cannot read').toEqual([])
        expect([...read.fixes.keys()], 'files the codec would fix on open').toEqual([])
        const project = parseProjectFile(fs.readFileSync(path.join(dir, 'project.cleo'), 'utf8'))
        expect(project.ok).toBe(true)
        const { snapshot: again } = await bundleToFolder(read.bundle, { uid: project.file.uid, name: project.file.name })
        const bytes = (v: string | Uint8Array) => typeof v === 'string' ? Buffer.from(v) : Buffer.from(v)
        expect([...again.files.keys()].sort()).toEqual([...snapshot.files.keys()].sort())
        for (const [rel, content] of snapshot.files) expect(bytes(again.files.get(rel)!).equals(bytes(content)), rel).toBe(true)
        // Every blob a file references is one the folder holds (an orphan the editor let go of is not an error).
        for (const hash of again.blobs.keys()) expect(snapshot.blobs.has(hash), blobRel(hash)).toBe(true)
      }, 300_000) // every file and blob read, then written again, in this process: minutes for a big example under load
    })
  })
}

// What every example project is held to, run by each example's tests/project.test.ts on its own folder:
//
//   - the folder is what the editor's codec writes, byte for byte (so opening and saving it changes nothing, and a
//     codec change that would rewrite the examples fails here first), with every text file LF;
//   - each script's stored fields are what its source declares (a .ts edited outside Cleo: npm run examples:sync);
//   - nothing in it is what the editor rewrites when it opens a project (editorNormalize.mjs), so opening it in Cleo
//     leaves a checkout clean;
//   - its data lock covers its text, no data is in git and no text is ignored (tools/examples/data.mjs);
//   - nothing is placed twice outside a template, every instance is what its template builds, every variant is its
//     base plus its diff (tools/exampleKit/templatize.ts, what the editor rebuilds on open);
//   - a 3D example keeps its static scenery merged in Static Collision (tools/exampleKit/mergeStaticColliders.ts).

import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXAMPLE, dataReady, readThisExample } from '../testKit'
import { isDataFile, projectFiles, writeExampleFolder } from '../folder.mjs'
import { reflectScripts } from '../syncScripts.mjs'
import { normalizeForEditor } from '../editorNormalize.mjs'
import { check } from '../../examples/data.mjs'
import { instanceProblems, templatizeScene } from '../templatize'
import { mergeStaticColliders } from '../mergeColliders'
import { materializeVariant } from '../../../applications/editor/src/utils/templateVariants'

export interface ProjectSpecOptions {
  /** The example folder (default: the one whose tests run). */
  dir?: string
  /** A 3D example: its static scenery is in Static Collision colliders. */
  staticColliders?: boolean
  /** Templates whose placed instances are known to differ from them (placed before the rule; see each example). */
  knownDivergent?: string[]
}

const allNodes = (root: any): any[] => { const out: any[] = []; const walk = (n: any) => { out.push(n); (n?.children ?? []).forEach(walk) }; walk(root); return out }

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
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cleo-${slug}-`))
      afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

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

      it("is what the editor's folder codec writes, byte for byte", async () => {
        const { bundle } = await readThisExample(dir)
        const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.cleo'), 'utf8'))
        await writeExampleFolder(tmp, structuredClone(bundle), { uid: project.uid, name: project.name })
        const mine = projectFiles(dir)
        expect(projectFiles(tmp)).toEqual(mine)
        for (const rel of mine) {
          const a = fs.readFileSync(path.join(dir, ...rel.split('/')))
          const b = fs.readFileSync(path.join(tmp, ...rel.split('/')))
          expect(a.equals(b), rel).toBe(true)
        }
      })

      it('repeats no group of nodes outside a template', async () => {
        const { bundle } = await readThisExample(dir)
        for (const scene of Object.values(bundle.scenes) as any[]) {
          const { templates: made, log } = templatizeScene(structuredClone(scene.scene), { takenNames: new Set(), idFor: (k: string) => k })
          expect(log, 'groups placed more than once without a template').toEqual([])
          expect(made).toHaveLength(0)
        }
      })

      it('places every instance exactly as its template builds it', async () => {
        const { bundle } = await readThisExample(dir)
        const byId = new Map((bundle.libraries.templates ?? []).map((t: any) => [t.id, t]))
        for (const scene of Object.values(bundle.scenes) as any[])
          for (const n of allNodes(scene.scene)) {
            const id = n.variables?.__templateId?.value
            if (!id) continue
            const template: any = byId.get(id)
            expect(template, `${n.name} names a missing template`).toBeDefined()
            if (options.knownDivergent?.includes(template.name)) continue
            expect(instanceProblems(template, n), `${n.name}`).toEqual([])
          }
      })

      it('stores every variant as its base plus its diff', async () => {
        const { bundle } = await readThisExample(dir)
        const templates: any[] = bundle.libraries.templates ?? []
        const byId = new Map(templates.map(t => [t.id, t]))
        for (const v of templates.filter(t => t.variant)) {
          const base = byId.get(v.variant.baseTemplateId)
          expect(base, `${v.name}'s base`).toBeDefined()
          expect(JSON.stringify(materializeVariant(base, v.id, v.variant.diff).nodeJson), v.name).toBe(JSON.stringify(v.nodeJson))
        }
      })

      it('never shares a node id between two templates', async () => {
        const { bundle } = await readThisExample(dir)
        const owner = new Map<string, string>()
        for (const t of bundle.libraries.templates ?? []) for (const n of allNodes(t.nodeJson)) {
          expect(owner.get(n.id), `${n.name} in ${t.name} reuses an id of ${owner.get(n.id)}`).toBeUndefined()
          owner.set(n.id, t.name)
        }
      })

      it.runIf(!!options.staticColliders)('keeps its static scenery in Static Collision, at the origin, with nothing left to merge', async () => {
        const { bundle } = await readThisExample(dir)
        const strings = new Set<string>()
        for (const s of bundle.libraries.scripts ?? []) for (const m of String(s.source).matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) strings.add(m[2])
        for (const scene of Object.values(bundle.scenes) as any[]) {
          const merged = scene.scene.children.filter((c: any) => c.type === 'collider' && /^Static Collision/.test(c.name))
          expect(merged.length, 'Static Collision colliders').toBeGreaterThan(0)
          for (const c of merged) {
            expect([c.position, c.rotation, c.scale]).toEqual([[0, 0, 0], [0, 0, 0], [1, 1, 1]])
            expect(c.collider.mass).toBe(0)
          }
          expect(mergeStaticColliders(structuredClone(scene.scene), { scriptStrings: strings, idFor: (k: string) => k }).merged).toBe(0)
        }
      })
    })
  })
}

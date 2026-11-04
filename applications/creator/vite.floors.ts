// The Creators' stage floors: the PBR sets in <engine>/build/terrain_textures (Poly Haven 1k sets, each
// `<set>/textures/<name>_{diff|diffuse,nor_gl,arm,disp}_1k.png`), served in dev and copied into the build
// as `floors/index.json` + `floors/<set>/<file>`, so the desktop app (which serves only the build) has them.
// A machine without the folder gets an empty manifest, and the floor menu then offers only the plain floor.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

export interface FloorSetEntry {
  id: string
  name: string
  /** File names relative to `floors/<id>/`. */
  diff: string
  nor?: string
  arm?: string
  disp?: string
}

const ROLES: [keyof Omit<FloorSetEntry, 'id' | 'name'>, RegExp][] = [
  ['diff', /_diff(use)?_[^_]*\.png$/i],
  ['nor', /_nor_gl_[^_]*\.png$/i],
  ['arm', /_arm_[^_]*\.png$/i],
  ['disp', /_disp_[^_]*\.png$/i],
]

/** "rocky_trail_02_1k" -> "Rocky trail 02". */
export function floorSetName(id: string): string {
  const words = id.replace(/_[0-9]+k$/i, '').split('_').filter(Boolean)
  const s = words.join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** The sets under `dir`: a folder whose `textures/` holds a colour map. Zips and empty folders are skipped. */
export function scanFloorSets(dir: string): FloorSetEntry[] {
  if (!existsSync(dir)) return []
  const out: FloorSetEntry[] = []
  for (const id of readdirSync(dir).sort()) {
    const tex = path.join(dir, id, 'textures')
    if (!existsSync(tex) || !statSync(tex).isDirectory()) continue
    const files = readdirSync(tex)
    const entry: Partial<FloorSetEntry> = { id, name: floorSetName(id) }
    for (const [role, re] of ROLES) {
      const f = files.find(n => re.test(n))
      if (f) entry[role] = `textures/${f}`
    }
    if (entry.diff) out.push(entry as FloorSetEntry)
  }
  return out
}

const MIME: Record<string, string> = { '.png': 'image/png', '.json': 'application/json' }

export function floorSetsPlugin(floorsDir: string, base = '/creator/'): Plugin {
  const prefix = `${base}floors/`
  let outDir = ''
  return {
    name: 'cleo:creator-floors',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir) },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (!url?.startsWith(prefix)) return next()
        const rel = decodeURIComponent(url.slice(prefix.length))
        if (rel === 'index.json') {
          res.setHeader('Content-Type', MIME['.json'])
          return res.end(JSON.stringify({ sets: scanFloorSets(floorsDir) }))
        }
        const file = path.join(floorsDir, ...rel.split('/').filter(p => p && p !== '..'))
        if (!file.startsWith(floorsDir)) { res.statusCode = 403; return res.end('Forbidden') }
        const [id, ...restParts] = rel.split('/')
        const listed = scanFloorSets(floorsDir).find(s => s.id === id)
        const rest = restParts.join('/')
        if (!listed || ![listed.diff, listed.nor, listed.arm, listed.disp].includes(rest)) return next()
        let body: Buffer
        try { body = readFileSync(file) } catch { return next() }
        res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream')
        res.end(body)
      })
    },
    closeBundle() {
      const sets = scanFloorSets(floorsDir)
      const dest = path.join(outDir, 'floors')
      mkdirSync(dest, { recursive: true })
      for (const s of sets) {
        for (const f of [s.diff, s.nor, s.arm, s.disp]) {
          if (!f) continue
          mkdirSync(path.dirname(path.join(dest, s.id, f)), { recursive: true })
          copyFileSync(path.join(floorsDir, s.id, 'textures', path.basename(f)), path.join(dest, s.id, f))
        }
      }
      writeFileSync(path.join(dest, 'index.json'), JSON.stringify({ sets }))
    },
  }
}

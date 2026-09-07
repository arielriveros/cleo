// Bundle plumbing for the Night Shift example generator.
//
// An exported Cleo project is a folder of plain JSON plus a pile of opaque texture payloads, and every
// reader on the other side is deliberately tolerant. That is what makes authoring one by hand viable at
// all — but two pieces still have to be exactly right, and they live here:
//
//   - the texture side table, because a dangling texture id renders as nothing with no error; and
//   - the reflected `variables` cache on each script asset, because the editor's inspector is built
//     from it.
//
// The reflector is not reimplemented. It is loaded out of the editor's own TypeScript through sucrase,
// with its two imports stubbed, so what this writes is by construction what the editor would compute.
// A hand-rolled copy would drift, and the failure mode is an inspector quietly missing a field.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { transform } from 'sucrase'

/**
 * A stable 32-hex id derived from a key.
 *
 * Deterministic on purpose: re-running the generator must produce byte-identical output, or every run
 * churns the diff of a 100 MB folder and review becomes impossible.
 */
export function stableId(key) {
  return crypto.createHash('md5').update('night-shift:' + key).digest('hex')
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
  return fs.statSync(file).size
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Load `parseScriptVariables` out of `editor/src/utils/scripts.ts`.
 *
 * The module imports `Node` from the engine barrel — a value import that would drag in the renderer and
 * a GL context we do not have — and `cryptoRandomId` from a sibling. Neither is used by the reflector,
 * so both are stubbed. Sucrase emits CommonJS, which a tiny `require` shim then satisfies.
 */
export function loadScriptReflector(root) {
  const file = path.join(root, 'editor', 'src', 'utils', 'scripts.ts')
  const code = transform(fs.readFileSync(file, 'utf8'), {
    transforms: ['typescript', 'imports'],
    filePath: file,
  }).code

  const stubs = {
    cleo: { Node: class {} },
    './ids': { cryptoRandomId: () => 'stub' },
  }
  const module = { exports: {} }
  const require = (name) => {
    if (name in stubs) return stubs[name]
    throw new Error(`scripts.ts reached for an unstubbed module: ${name}`)
  }
  new Function('require', 'module', 'exports', code)(require, module, module.exports)

  const parse = module.exports.parseScriptVariables
  if (typeof parse !== 'function') throw new Error('parseScriptVariables did not load out of scripts.ts')
  return parse
}

/**
 * The texture side table.
 *
 * Payloads are raw image bytes in `textures/N.bin`, and `textures/index.json` maps a logical texture id
 * to the file plus its sampler config. Ids are carried over from the source project unchanged, because
 * materials, tilesets and model nodes all reference them by that id — renaming one would silently
 * unbind every reference to it.
 */
export class TextureSet {
  constructor(sourceDir) {
    this._sourceDir = sourceDir
    this._sourceIndex = new Map()
    if (sourceDir) {
      for (const entry of readJson(path.join(sourceDir, 'textures', 'index.json')))
        this._sourceIndex.set(entry.id, entry)
    }
    /** id -> { id, mime, config, bytes } in insertion order. */
    this._entries = new Map()
  }

  /** Every id the source project holds, for diagnostics. */
  get available() { return [...this._sourceIndex.keys()] }

  /** The ids this project actually ships — what a scene's `refs.textureIds` must list. */
  get included() { return [...this._entries.keys()] }

  /** Carry a texture over from the source project, keeping its id and sampler config. */
  copy(id) {
    if (this._entries.has(id)) return id
    const entry = this._sourceIndex.get(id)
    if (!entry) throw new Error(`no texture "${id}" in the source project`)
    this._entries.set(id, {
      id,
      mime: entry.mime,
      config: entry.config,
      bytes: fs.readFileSync(path.join(this._sourceDir, entry.file)),
    })
    return id
  }

  /** Add a texture from a file on disk. `config` follows the source project's shape. */
  add(id, file, config) {
    if (this._entries.has(id)) return id
    this._entries.set(id, {
      id,
      mime: 'image/png',
      config: {
        flipY: false, usage: 'color', wrapping: 'clamp',
        mipMap: false, mipMapFilter: 'linear', precision: 'low', target: 'texture2D',
        ...config,
      },
      bytes: fs.readFileSync(file),
    })
    return id
  }

  get size() { return this._entries.size }

  get bytes() {
    let total = 0
    for (const e of this._entries.values()) total += e.bytes.length
    return total
  }

  /** Write `textures/index.json` and the numbered payloads. */
  write(outDir) {
    const dir = path.join(outDir, 'textures')
    fs.mkdirSync(dir, { recursive: true })
    const index = []
    let n = 0
    for (const entry of this._entries.values()) {
      const file = `textures/${n}.bin`
      fs.writeFileSync(path.join(outDir, file), entry.bytes)
      index.push({ id: entry.id, mime: entry.mime, config: entry.config, file })
      n++
    }
    writeJson(path.join(dir, 'index.json'), index)
    return index.length
  }
}

/** Every required key on a scene node, so nothing downstream has to guess a default. */
export function node(name, type, extra = {}) {
  return {
    id: extra.id ?? stableId(`node:${name}:${type}`),
    name,
    type,
    position: extra.position ?? [0, 0, 0],
    rotation: extra.rotation ?? [0, 0, 0],
    scale: extra.scale ?? [1, 1, 1],
    children: extra.children ?? [],
    variables: extra.variables ?? {},
    spawnOnStart: extra.spawnOnStart ?? true,
    ...omit(extra, ['id', 'position', 'rotation', 'scale', 'children', 'variables', 'spawnOnStart']),
  }
}

/**
 * Per-type UI defaults, mirroring each node class's constructor.
 *
 * Written out in full rather than only where they differ, because `_parseUIBase` reads several fields
 * through a fallback to the BASE default rather than the subclass's — so an omitted key does not mean
 * "use the sensible value", it means "use the wrong one". `tests/nightShiftProject.test.ts` compares
 * these key sets against what the classes actually serialize.
 */
const UI_TYPE_DEFAULTS = {
  uiRoot: {
    space: 'screen', referenceResolution: [1920, 1080], scaleMode: 'scaleWithScreen',
    matchWidthOrHeight: 0.5, referenceDpr: 1, uiTargetId: null, referenceDistance: 10,
    minScale: 0.1, maxScale: 4, billboard: true, clampToScreen: false, hideBehindCamera: true,
  },
  uiPanel: {},
  uiStack: { direction: 'column', gap: 4, justify: 'start', align: 'stretch', reverse: false },
  uiSpacer: { flex: 1 },
  uiText: {
    text: 'Text', fontSize: 16, fontFamily: '', fontWeight: 400,
    align: 'left', vAlign: 'top', wrap: true, lineHeight: 1.2,
  },
  uiButton: {
    label: 'Button', disabled: false, hoverTint: [1, 1, 1, 0.15],
    pressedTint: [0, 0, 0, 0.2], disabledTint: [0.5, 0.5, 0.5, 0.4],
  },
  uiProgressBar: {
    min: 0, max: 1, value: 1, fillTint: [0.2, 0.8, 0.3, 1], direction: 'ltr', smoothing: 0,
  },
}

/**
 * A UI node.
 *
 * `visible` sits at the node's TOP level while everything else lives inside `ui` — and UI is the only
 * node family that persists `visible` at all, which is what lets the end screen be authored hidden.
 *
 * The base rect fields are always written out. `_parseUIBase` reads several of them through a
 * `numTuple(value, HARD_DEFAULT)` that falls back to the BASE default rather than the subclass's
 * constructor value, so omitting `offsetMax` on a button would silently resize it.
 */
export function uiNode(name, type, ui = {}, extra = {}) {
  const typeDefaults = UI_TYPE_DEFAULTS[type]
  if (!typeDefaults) throw new Error(`no UI defaults registered for "${type}"`)
  return node(name, type, {
    ...extra,
    visible: extra.visible ?? true,
    ui: {
      anchorMin: [0, 0], anchorMax: [0, 0], offsetMin: [0, 0], offsetMax: [100, 100],
      pivot: [0, 0], rotationDeg: 0, scale2d: [1, 1],
      opacity: 1, tint: [1, 1, 1, 1], zOrder: 0,
      interactive: false, clip: false, sizing: 'fixed',
      padding: [0, 0, 0, 0], borderRadius: 0, borderWidth: 0, borderColor: [0, 0, 0, 1],
      ...typeDefaults,
      ...ui,
    },
  })
}

/** A node variable, in the object-keyed-by-name shape `_serializeVariables` writes. */
export function vars(entries) {
  const out = {}
  for (const [name, value] of Object.entries(entries)) {
    const type = typeof value === 'number' ? 'number'
      : typeof value === 'boolean' ? 'boolean'
        : Array.isArray(value) ? 'vec3' : 'string'
    out[name] = { type, value, access: 'public' }
  }
  return out
}

function omit(source, keys) {
  const out = {}
  for (const [k, v] of Object.entries(source)) if (!keys.includes(k)) out[k] = v
  return out
}

/** Human-readable size, for the generator's report. */
export function mb(bytes) {
  return (bytes / 1e6).toFixed(1) + ' MB'
}

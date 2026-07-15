// Gives Monaco's TypeScript worker a real type for a script's `this`, per selected node — the piece a
// static .d.ts can't express, because `this` is a *different* concrete type (Node subclass + that node's
// own declared Variables) for every node the panel shows.
//
// Two halves that MonacoCodeEditor.tsx wires together:
//   1. buildThisLib(node) — a generated declaration registered via addExtraLib. It declares a single
//      global `CleoScriptThis` interface extending the node's concrete class (ModelNode, LightNode, …)
//      with each declared Variable typed. Rewritten whenever the selected node or its Variables change.
//   2. wrapForThis(source) — the same script, with its body wrapped in `function (this: CleoScriptThis)`
//      so TS actually binds `this` to that interface (top-level `this` in a module is otherwise untyped).
//      Imports must stay at module scope, so only the body after the leading import block is wrapped.
//
// The wrapped text goes into a hidden shadow model; TS diagnostics from it are mapped back onto the
// visible model (see MonacoCodeEditor.tsx). Completions/hover for `this.<Variable>` still come from the
// scriptAnalysisCore providers; this layer adds what those can't: TS-native type inference on `this`
// expressions and typed handler-callback parameters (node, delta, other, …).
import type { Node, NodeVariableType } from 'cleo'

/** The exported class name for each Node subtype, so the generated interface extends the right shape. */
const NODE_CLASS: Record<string, string> = {
  node: 'Node',
  model: 'ModelNode',
  light: 'LightNode',
  lightProbe: 'LightProbeNode',
  skybox: 'SkyboxNode',
  camera: 'CameraNode',
  sprite: 'SpriteNode',
  animatedSprite: 'AnimatedSpriteNode',
  landscape: 'LandscapeNode',
  volumetricClouds: 'VolumetricCloudsNode',
  skyAtmosphere: 'SkyAtmosphereNode',
  lodGroup: 'LodGroupNode',
}

/** NodeVariableType -> its TypeScript type. vec3 is a fixed 3-tuple, matching the runtime value shape. */
function tsType(t: NodeVariableType): string {
  switch (t) {
    case 'number': return 'number'
    case 'string': return 'string'
    case 'boolean': return 'boolean'
    case 'vec3': return '[number, number, number]'
    default: return 'any'
  }
}

/** Variables the engine owns (template/mesh ids) are hidden from the author, same as the analysis core. */
const isReserved = (name: string) => name.startsWith('__')
/** A declared name safe to emit as a bare interface key (else we'd produce invalid syntax). */
const isIdentifier = (name: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)

export const THIS_LIB_URI = 'file:///node_modules/cleo/__cleoThis.d.ts'
export const THIS_INTERFACE = 'CleoScriptThis'

/**
 * The generated declaration for a node's `this`. A single global interface (no import needed at the use
 * site) extending the node's concrete class with each declared Variable. Regenerate and re-register on
 * every node switch / Variables change.
 *
 * The `declare module 'cleo'` block augments every Node with a string index signature. That is what keeps
 * the engine's dynamic model honest under a static type-checker: `other.HealthPoints`, `findNode('X').hp`
 * etc. read a runtime Variable off *another* node the checker can't see, so they resolve to `any` instead
 * of "property does not exist". Explicitly declared members still win over the index, so a node's OWN
 * declared Variables (on `CleoScriptThis`) keep their real types and still catch mis-typed assignments.
 */
export function buildThisLib(node: Node): string {
  const base = NODE_CLASS[node.nodeType] ?? 'Node'
  const lines: string[] = []
  for (const [name, variable] of node.variables) {
    if (isReserved(name) || !isIdentifier(name)) continue
    // JSDoc so hover (thisTypeProvider) shows where the member comes from and its access level, the way
    // nodeHoverProvider used to — now folded into the type itself.
    lines.push(`    /** Script Variable · ${variable.access ?? 'public'} (declared in the Variables panel). */`)
    lines.push(`    ${name}: ${tsType(variable.type)};`)
  }
  return [
    `import type { ${base} } from 'cleo';`,
    "declare module 'cleo' {",
    '  interface Node { [key: string]: any }',
    '}',
    'declare global {',
    `  interface ${THIS_INTERFACE} extends ${base} {`,
    ...lines,
    '  }',
    '}',
    'export {};',
    '',
  ].join('\n')
}

export interface WrappedScript {
  /** The script text with its body wrapped so `this` is typed. Feed this to the shadow model. */
  text: string
  /** Visible-model line = shadow line for the import head; shadow line - `bodyLineShift` for the body. */
  bodyLineShift: number
  /** Shadow lines below this (1-based) are body lines; at/above map 1:1 to the visible model. */
  headLines: number
  /** False when the body still contains an `import` (illegal inside the wrapper) — skip typed `this`. */
  ok: boolean
}

/**
 * Splits off the leading block of top-level `import` statements (with the blank lines/comments among
 * them) from the body, so the body can be wrapped in a function while imports stay at module scope.
 * Handles single-line imports and brace-spanning multi-line imports; bails (ok:false) if a body line
 * still starts with `import`, so an unusual layout degrades to untyped `this` rather than bogus errors.
 */
function splitLeadingImports(source: string): { head: string[]; body: string[]; ok: boolean } {
  const lines = source.split('\n')
  let i = 0
  let inBlockComment = false
  let braceDepth = 0
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    if (inBlockComment) { if (t.includes('*/')) inBlockComment = false; continue }
    if (braceDepth > 0) {
      braceDepth += (t.match(/{/g)?.length ?? 0) - (t.match(/}/g)?.length ?? 0)
      continue
    }
    if (t === '' || t.startsWith('//')) continue
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlockComment = true; continue }
    if (t.startsWith('import')) {
      braceDepth = (t.match(/{/g)?.length ?? 0) - (t.match(/}/g)?.length ?? 0)
      continue
    }
    break // first real body statement
  }
  const head = lines.slice(0, i)
  const body = lines.slice(i)
  const ok = !body.some((l) => /^\s*import\b/.test(l))
  return { head, body, ok }
}

const WRAP_OPEN = `;(function (this: ${THIS_INTERFACE}) {`
const WRAP_CLOSE = `}).call(void 0 as any);`

export function wrapForThis(source: string): WrappedScript {
  const { head, body, ok } = splitLeadingImports(source)
  if (!ok) return { text: source, bodyLineShift: 0, headLines: source.split('\n').length, ok: false }
  // head lines keep their positions; one WRAP_OPEN line is inserted before the body, so every body line
  // shifts down by exactly one. WRAP_CLOSE is appended and produces no user-facing diagnostics.
  const text = [...head, WRAP_OPEN, ...body, WRAP_CLOSE].join('\n')
  return { text, bodyLineShift: 1, headLines: head.length, ok: true }
}

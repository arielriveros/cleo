import { Node } from 'cleo'
import type { NodeVariableType, NodeVariableAccess } from 'cleo'
import { cryptoRandomId } from './ids'

// A reusable, class-based Script asset, referenced by many nodes via the SCRIPT_ID_VAR node variable.
//
// The source is a single class (`export default class XNode extends Node { ... }`): handler methods are
// overrides, and class FIELDS are the node's variables, held as NATIVE per-node properties at runtime.
// Access modifiers are enforced by the editor's type-checker at author time; a leading underscore marks a
// field internal and hides it from the inspector's reflection view.

// Node variable linking a node to a shared script asset. A link marker, not a script variable, but it
// still lives in the node's variable Map.
export const SCRIPT_ID_VAR = '__scriptId'

// The node types a script may extend from (`class X extends <Base>Node`). Matches the engine's NodeType.
export type ScriptBaseType =
  | 'node' | 'model' | 'light' | 'lightProbe' | 'skybox' | 'camera' | 'cameraRig'
  | 'sprite' | 'animatedSprite' | 'landscape' | 'volumetricClouds' | 'skyAtmosphere' | 'skyLight' | 'lodGroup'
  | 'sound' | 'character' | 'controller'
  | 'uiRoot' | 'uiPanel' | 'uiText' | 'uiImage' | 'uiButton' | 'uiStack' | 'uiSpacer'
  | 'uiProgressBar' | 'uiSlider' | 'uiToggle' | 'uiTextInput'

/** The exported base class name for each script base type (what the generated class extends). */
export const BASE_CLASS: Record<ScriptBaseType, string> = {
  node: 'Node',
  model: 'ModelNode',
  light: 'LightNode',
  lightProbe: 'LightProbeNode',
  skybox: 'SkyboxNode',
  camera: 'CameraNode',
  cameraRig: 'CameraRigNode',
  sprite: 'SpriteNode',
  animatedSprite: 'AnimatedSpriteNode',
  landscape: 'LandscapeNode',
  volumetricClouds: 'VolumetricCloudsNode',
  skyAtmosphere: 'SkyAtmosphereNode',
  skyLight: 'SkyLightNode',
  lodGroup: 'LodGroupNode',
  sound: 'SoundNode',
  character: 'CharacterNode',
  controller: 'ControllerNode',
  // Concrete UI classes, not a single UINode base, so a script gets typed members in Monaco.
  uiRoot: 'UIRootNode',
  uiPanel: 'UIPanelNode',
  uiText: 'UITextNode',
  uiImage: 'UIImageNode',
  uiButton: 'UIButtonNode',
  uiStack: 'UIStackNode',
  uiSpacer: 'UISpacerNode',
  uiProgressBar: 'UIProgressBarNode',
  uiSlider: 'UISliderNode',
  uiToggle: 'UIToggleNode',
  uiTextInput: 'UITextInputNode',
}

export const BASE_TYPE_LABEL: Record<ScriptBaseType, string> = {
  node: 'Node', model: 'Model', light: 'Light', lightProbe: 'Light Probe', skybox: 'Skybox',
  camera: 'Camera', cameraRig: 'Camera Rig', sprite: 'Sprite', animatedSprite: 'Animated Sprite', landscape: 'Landscape',
  volumetricClouds: 'Volumetric Clouds', skyAtmosphere: 'Sky Atmosphere', skyLight: 'Sky Light',
  lodGroup: 'LOD Group', sound: 'Sound', character: 'Character', controller: 'Controller',
  uiRoot: 'UI Canvas', uiPanel: 'UI Panel', uiText: 'UI Text', uiImage: 'UI Image',
  uiButton: 'UI Button', uiStack: 'UI Stack', uiSpacer: 'UI Spacer',
  uiProgressBar: 'UI Progress Bar', uiSlider: 'UI Slider', uiToggle: 'UI Toggle',
  uiTextInput: 'UI Text Input',
}

/** One reflected script variable, parsed from a class field declaration. */
export type ScriptVarSchema = {
  name: string
  type: NodeVariableType          // 'number' | 'string' | 'boolean' | 'vec3'
  access: NodeVariableAccess      // 'public' | 'private' | 'protected'
  default: any
  hidden: boolean                 // underscore-prefixed: internal state, not shown in the inspector
}

export type ScriptAsset = {
  id: string
  name: string
  baseType: ScriptBaseType
  source: string                  // the class source
  variables: ScriptVarSchema[]    // derived cache, parsed from the class field declarations
}

/** The script asset id a node references, or undefined. */
export function getScriptIdOf(node: Node | null | undefined): string | undefined {
  return node?.getVariable(SCRIPT_ID_VAR)
}

/** True if a script with `baseType` may attach to a node of `nodeType` (a 'node'-based script attaches to any). */
export function baseTypeMatchesNode(baseType: ScriptBaseType, nodeType: string): boolean {
  return baseType === 'node' || baseType === nodeType
}

/* -------------------------------------------------------------------------- */
/* Field-declaration parser — the reflection system, moved from UI into script */
/* -------------------------------------------------------------------------- */

/** Strip line and block comments (so a commented-out field is never reflected). Preserves length loosely. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')
}

/** Extract the top-level class body `{ ... }` of the first class in the source, or '' if none. */
function classBody(src: string): string {
  const m = /\bclass\b[^{]*\{/.exec(src)
  if (!m) return ''
  let i = m.index + m[0].length
  let depth = 1
  const start = i
  for (; i < src.length && depth > 0; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
  }
  return src.slice(start, i - 1)
}

const TS_TO_VAR_TYPE: Record<string, NodeVariableType> = {
  number: 'number', string: 'string', boolean: 'boolean', bool: 'boolean',
  vec3: 'vec3', 'number[]': 'vec3', '[number,number,number]': 'vec3',
}

function typeDefault(type: NodeVariableType): any {
  switch (type) {
    case 'number': return 0
    case 'string': return ''
    case 'boolean': return false
    case 'vec3': return [0, 0, 0]
  }
}

/** Parse a literal initializer (`= 5`, `= 'hi'`, `= true`, `= [1,2,3]`) to a value, or undefined if dynamic. */
function parseDefault(raw: string): any {
  const t = raw.trim()
  if (t === '') return undefined
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  const str = /^(['"`])(.*)\1$/.exec(t)
  if (str) return str[2]
  const arr = /^\[([^\]]*)\]$/.exec(t)
  if (arr) {
    const nums = arr[1].split(',').map(s => Number(s.trim()))
    if (nums.every(n => Number.isFinite(n))) return nums
  }
  return undefined
}

/** Infer the variable type from a TS annotation and/or a default value. */
function inferType(annotation: string, def: any): NodeVariableType {
  const key = annotation.replace(/\s+/g, '').toLowerCase()
  if (key && TS_TO_VAR_TYPE[key]) return TS_TO_VAR_TYPE[key]
  if (typeof def === 'number') return 'number'
  if (typeof def === 'boolean') return 'boolean'
  if (Array.isArray(def)) return 'vec3'
  if (typeof def === 'string') return 'string'
  return 'number'
}

// A class field declaration at the top of the class body:
//   [public|private|protected|readonly|declare]* name [?|!] [: type] [= initializer] ;
// A method is excluded by requiring no '(' before the ':'/'='/';' terminator.
const ACCESS_KEYWORDS = new Set(['public', 'private', 'protected'])
const MODIFIER_KEYWORDS = new Set(['public', 'private', 'protected', 'readonly', 'declare', 'static', 'override', 'abstract'])

/**
 * Reflect a script's class fields into variable schemas. Underscore-prefixed fields are hidden (internal);
 * methods, getters and dynamic-type fields are skipped. Never throws — an unparseable declaration is
 * simply not reflected.
 */
export function parseScriptVariables(source: string): ScriptVarSchema[] {
  const body = classBody(stripComments(source))
  if (!body) return []

  const out: ScriptVarSchema[] = []
  const seen = new Set<string>()

  // Walk statements at class-body depth 0, tracking brace/paren depth so method bodies and
  // object/array initializers are skipped as single units.
  let i = 0
  let depth = 0
  let stmtStart = 0
  const flush = (end: number) => {
    const stmt = body.slice(stmtStart, end).trim()
    stmtStart = end + 1
    if (!stmt) return

    // A call/parameter list before '=' means a method or getter/setter, not a field.
    const eq = stmt.indexOf('=')
    const head = eq >= 0 ? stmt.slice(0, eq) : stmt
    if (head.includes('(') || head.startsWith('get ') || head.startsWith('set ') || head.startsWith('*')) return

    // Peel modifiers off the head.
    let tokens = head.trim().split(/\s+/)
    let access: NodeVariableAccess = 'public'
    while (tokens.length && MODIFIER_KEYWORDS.has(tokens[0])) {
      if (ACCESS_KEYWORDS.has(tokens[0])) access = tokens[0] as NodeVariableAccess
      tokens.shift()
    }
    const decl = tokens.join(' ').trim()
    if (!decl) return

    // decl is `name[?|!][: type]`
    const nameMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*[?!]?\s*(?::\s*([^]*))?$/.exec(decl)
    if (!nameMatch) return
    const name = nameMatch[1]
    if (seen.has(name)) return
    const annotation = (nameMatch[2] ?? '').trim()

    const def = eq >= 0 ? parseDefault(stmt.slice(eq + 1)) : undefined
    const type = inferType(annotation, def)
    seen.add(name)
    out.push({
      name,
      type,
      access,
      default: def ?? typeDefault(type),
      hidden: name.startsWith('_'),
    })
  }

  // Split on ';' AND newline at class-body depth 0: class fields routinely omit their semicolons (ASI).
  // Depth tracking keeps method bodies and multi-line initializers together as single units.
  for (; i < body.length; i++) {
    const c = body[i]
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    else if (depth === 0 && (c === ';' || c === '\n')) flush(i)
  }
  flush(body.length)
  return out
}

/* -------------------------------------------------------------------------- */
/* Build / apply / unlink                                                      */
/* -------------------------------------------------------------------------- */

/** A valid PascalCase class identifier for a script named `name`, always ending in `Node` (e.g. Playable -> PlayableNode). */
export function scriptClassName(name: string): string {
  const cleaned = (name || 'Script').replace(/[^A-Za-z0-9_$]/g, ' ').split(/\s+/).filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1)).join('') || 'Script'
  const ident = /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`
  return ident.endsWith('Node') ? ident : `${ident}Node`
}

/** Handler stubs that actually apply to a given UI base type. */
/**
 * Starters for the control node pair. Functions rather than strings, because both need the class name.
 *
 * The Character one deliberately shows a script READING its own state and leaves locomotion alone; the
 * Controller one shows `onThink` writing intent, which is the whole extension point for custom AI.
 */
const CONTROL_STARTERS: Partial<Record<ScriptBaseType, (className: string, base: string) => string>> = {
  character: (className, base) => `import { Logger, ${base} } from 'cleo'
import type { ActionState } from 'cleo'

// ${className} runs on a Character — a pawn whose walking, turning and jumping the ENGINE owns.
//
// Do not write this.velocity here: the character's locomotion writes it every frame from the intent a
// Controller gave it, and a script fighting for the same field produces a character that stutters. To
// influence movement, either tune the fields in the Character inspector or write the intent itself:
//
//   this.drive().speedScale = 0.5     // half speed, whatever is driving
//
// What a script on a Character IS for: reacting to what the character is doing, and holding game state.
export default class ${className} extends ${base} {
  public health: number = 100

  onUpdate(delta: number, time: number) {
    // Measured motion, from the physics body — see the Character's Animator outputs in the inspector.
    if (this.planarSpeed > 0.1 && !this.isGrounded) Logger.log(this.name + ' is airborne', 'Script')
  }

  onAction(action: string, state: ActionState) {
    if (action === 'Interact' && state.started) Logger.log(this.name + ' interacted', 'Script')
  }
}
`,
  controller: (className, base) => `import { Logger, ${base} } from 'cleo'

// ${className} runs on a Controller — the thing that DRIVES a Character.
//
// onThink runs once per frame in the scene's control pass, before any node's onUpdate, and it runs LAST
// within this controller — so whatever the Source (Player / AI) decided is already in place and this
// method patches or replaces it.
//
// Set Source to "AI" in the inspector to write the whole intent yourself.
export default class ${className} extends ${base} {
  public followDistance: number = 3

  onThink(delta: number) {
    const pawn = this.possessed
    if (!pawn) return

    // \`drive()\` returns the pawn's intent for this frame and marks it fresh. \`move\` is [right, forward]
    // in the frame named by \`basisYaw\` — leave basisYaw at 0 for world-relative movement.
    const intent = pawn.drive()
    intent.basisYaw = 0
    intent.move[0] = 0
    intent.move[1] = 1
    // Face where you are going. Set speedScale below 1 to approach gently.
    intent.aimYaw = 0
    intent.speedScale = 1
  }
}
`,
}

const UI_STARTERS: Partial<Record<ScriptBaseType, string>> = {
  uiButton: `  onPress() {
    Logger.log(this.name + ' pressed', 'Script')
  }`,
  uiToggle: `  onValueChanged(checked: boolean) {
    Logger.log(this.name + ' = ' + checked, 'Script')
  }`,
  uiSlider: `  onValueChanged(value: number) {
    Logger.log(this.name + ' = ' + value, 'Script')
  }`,
  uiTextInput: `  onValueChanged(value: string) {
    Logger.log(this.name + ' = ' + value, 'Script')
  }

  onSubmit(value: string) {
    Logger.log('submitted: ' + value, 'Script')
  }`,
  uiProgressBar: `  onUpdate(delta: number, time: number) {
    // Bind the bar to whatever it reports on; the layout pass runs AFTER every onUpdate, so a value
    // written here lands on screen the same frame.
    const player = this.findNode('player')
    if (player) this.value = (player as any).health ?? this.value
  }`,
  uiText: `  onUpdate(delta: number, time: number) {
    // Assigning the same string is a no-op, so this is safe to run every frame.
    this.text = 'Time: ' + time.toFixed(1)
  }`,
}

/**
 * The starter class source for a new script of `name` extending `baseType`. Handlers are method overrides;
 * fields are the node's variables (public shows in the inspector, a leading _ stays internal).
 */
export function defaultScriptClass(name: string, baseType: ScriptBaseType): string {
  const base = BASE_CLASS[baseType]
  const className = scriptClassName(name)

  // Control scripts get their own starter for the same reason UI ones do: the generic stub below drives
  // the node by writing its position, which is exactly what a Character must NOT do — its locomotion
  // owns its velocity, and a script fighting it produces a character that stutters.
  const control = CONTROL_STARTERS[baseType]
  if (control) return control(className, base)

  // UI scripts need a starter built from the handlers their base class actually has; the generic stub
  // below moves the node and reacts to collisions, which a screen rectangle cannot do.
  if (base.startsWith('UI')) {
    const body = UI_STARTERS[baseType] ?? `  onStart() {
    Logger.log('Started: ' + this.name, 'Script')
  }`
    return `import { Logger, ${base} } from 'cleo'

// ${className} runs on the UI element this script is attached to. Handlers are method overrides; class
// fields become the node's variables (public/private/protected controls inspector visibility, and a leading
// underscore hides a field from the inspector).
//
// The node already exists, so this class is never CONSTRUCTED — its methods are bound onto the live node.
// UI layout is resolved once per frame AFTER every onUpdate, so anything written here is on screen the
// same frame rather than one behind.
export default class ${className} extends ${base} {
${body}
}
`
  }

  const imports = base === 'Node' ? 'Input, Logger, Node' : `Input, Logger, Node, ${base}`
  return `import { ${imports} } from 'cleo'
import type { ActionState } from 'cleo'

// ${className} runs on every node this script is attached to. Handlers are method overrides; class fields are
// the node's variables — public/private/protected controls inspector visibility & cross-node access, and a
// leading underscore marks an internal field hidden from the inspector.
//
// The node already exists, so this class is never CONSTRUCTED — its methods are bound onto the live node.
// Field initializers above still apply, but a constructor() you write here would never run. Use:
//   onConstruct — once per node, even if it is dormant (spawnOnStart off). The only handler an unspawned
//                 node gets, so it is where one decides whether to spawn itself.
//   onSpawn     — once each time the node becomes live (again after a despawn/spawn cycle).
//   onStart     — once per node, on its first spawn.
export default class ${className} extends ${base} {
  public speed: number = 5
  private _elapsed: number = 0

  onStart() {
    Logger.log('Started: ' + this.name, 'Script')
  }

  onUpdate(delta: number, time: number) {
    // ACTIONS, not key codes. 'Move' and 'Jump' are authored in the Input panel, so the same two lines
    // work on a keyboard, a gamepad and a touch screen — and the player can rebind them.
    const move = Input.vector('Move')
    this.addX(move[0] * this.speed * delta)
    this.addZ(move[1] * this.speed * delta)
    this._elapsed += delta
  }

  // Fires when an action changes phase. state.started is true on exactly the frame of the press.
  onAction(action: string, state: ActionState) {
    if (action === 'Jump' && state.started) Logger.log(this.name + ' jumped', 'Script')
  }

  onCollision(other: Node) {
    Logger.log(this.name + ' hit ' + other.name, 'Script')
  }
}
`
}

/** Snapshot a class source into a saveable Script asset, parsing its field declarations into the schema. */
export function buildScriptAsset(name: string, baseType: ScriptBaseType, source: string, id?: string): ScriptAsset {
  return { id: id ?? cryptoRandomId(), name, baseType, source, variables: parseScriptVariables(source) }
}

/**
 * Link a script asset to a node: stamp the SCRIPT_ID_VAR marker, seed the script's native field defaults as
 * own properties (unless already present), and cache the resolved source in the per-node `scripts` map.
 * Returns false and does nothing if the script's base type is incompatible with the node.
 */
export function applyScriptAsset(node: Node, asset: ScriptAsset, scripts: Map<string, string>): boolean {
  if (!baseTypeMatchesNode(asset.baseType, node.nodeType)) return false
  node.setVariable(SCRIPT_ID_VAR, asset.id, 'string')
  seedScriptFields(node, asset, false)
  scripts.set(node.id, asset.source)
  return true
}

/**
 * Ensure a node carries each of the script's fields as a native own property. With `overwrite=false` an
 * existing per-node value is kept; missing or removed fields are added/pruned to match the schema.
 */
export function seedScriptFields(node: Node, asset: ScriptAsset, overwrite: boolean): void {
  const n = node as any
  const wanted = new Set(asset.variables.map(v => v.name))
  for (const v of asset.variables) {
    if (overwrite || !(v.name in n) || n[v.name] === undefined) n[v.name] = cloneDefault(v.default)
  }
  // Prune native fields the schema no longer declares.
  for (const name of scriptFieldNames(node, asset)) {
    if (!wanted.has(name)) delete n[name]
  }
}

function cloneDefault(v: any): any {
  return Array.isArray(v) ? [...v] : v
}

/** The names a node currently carries as own properties that are declared by the schema. */
function scriptFieldNames(node: Node, asset: ScriptAsset): string[] {
  const n = node as any
  return asset.variables.map(v => v.name).filter(name => name in n)
}

/** Drop a node's script link and its script-owned native fields. */
export function unlinkScript(node: Node, asset: ScriptAsset | undefined, scripts: Map<string, string>): void {
  const n = node as any
  if (asset) for (const v of asset.variables) delete n[v.name]
  node.removeVariable(SCRIPT_ID_VAR)
  scripts.delete(node.id)
}

/**
 * Read a node's native script-field values into a `{ name: value }` object for serialization. Injected onto
 * the node JSON as `scriptVars` at save/play/publish time; the engine restores them as native own
 * properties in _commonParse without knowing the field schema.
 */
export function collectScriptVars(node: Node, asset: ScriptAsset): Record<string, any> {
  const n = node as any
  const out: Record<string, any> = {}
  for (const v of asset.variables) if (v.name in n) out[v.name] = n[v.name]
  return out
}

/**
 * Fan a shared script library out onto the nodes that reference it: caches each asset's SOURCE into the
 * per-node `scripts` map and collects the node's native field values.
 * Returns `nodeId -> scriptVars` for injection. Must be called before serializing a scene.
 */
export function fanOutScripts(
  nodes: Iterable<Node>,
  assets: ScriptAsset[],
  scripts: Map<string, string>,
): Map<string, Record<string, any>> {
  const byId = new Map(assets.map(a => [a.id, a]))
  const scriptVars = new Map<string, Record<string, any>>()
  for (const node of nodes) {
    const sid = getScriptIdOf(node)
    if (!sid) continue
    const asset = byId.get(sid)
    if (!asset) continue
    scripts.set(node.id, asset.source)
    scriptVars.set(node.id, collectScriptVars(node, asset))
  }
  return scriptVars
}

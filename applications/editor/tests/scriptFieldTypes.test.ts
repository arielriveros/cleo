import { describe, it, expect } from 'vitest'
import { parseScriptVariables, upgradeScriptVar, seedScriptFields, buildScriptAsset, type ScriptVarSchema } from '../src/utils/scripts'

// The native attribute types: a field's TYPE says what it is, and so what the inspector edits it with. The
// reflection reads it from the annotation (or a literal default) into one of the engine's property types.

const field = (src: string, name: string) => parseScriptVariables(src).find(v => v.name === name)
const cls = (body: string, head = '') => `${head}\nexport default class S extends Node {\n${body}\n}`

describe('value types', () => {
  it('reads colours and vectors', () => {
    const src = cls(`
      public tint: Color = [1, 0.5, 0]
      public fade: ColorAlpha = [1, 1, 1, 0.5]
      public size: Vec2 = [1, 2]
      public offset: Vec3 = [0, 1, 0]
      public plane: Vec4 = [0, 1, 0, 0]
      public glMatrix: vec3 = [0, 0, 0]
      public qualified: Vec.vec2 = [0, 0]
      public tuple: [number, number, number] = [1, 2, 3]
      public bare = [1, 2, 3]
      public legacy: number[] = [4, 5, 6]
      public pair: number[] = [1, 2]
      public numbers: number[] = []`)
    expect(field(src, 'tint')).toMatchObject({ type: { kind: 'color' }, default: [1, 0.5, 0] })
    expect(field(src, 'fade')).toMatchObject({ type: { kind: 'color', alpha: true } })
    expect(field(src, 'size')?.type).toEqual({ kind: 'vector', size: 2 })
    expect(field(src, 'offset')?.type).toEqual({ kind: 'vector', size: 3 })
    expect(field(src, 'plane')?.type).toEqual({ kind: 'vector', size: 4 })
    expect(field(src, 'glMatrix')?.type).toEqual({ kind: 'vector', size: 3 })
    expect(field(src, 'qualified')?.type).toEqual({ kind: 'vector', size: 2 })
    expect(field(src, 'tuple')?.type).toEqual({ kind: 'vector', size: 3 })
    expect(field(src, 'bare')?.type).toEqual({ kind: 'vector', size: 3 })
    expect(field(src, 'legacy')?.type).toEqual({ kind: 'vector', size: 3 })
    expect(field(src, 'pair')?.type).toEqual({ kind: 'vector', size: 2 })
    expect(field(src, 'numbers')?.type).toEqual({ kind: 'list', of: { kind: 'number' } })
  })

  it('gives a colour with no default white, and a vector zeros', () => {
    const src = cls(`
      public tint: Color
      public fade: ColorAlpha
      public at: Vec2`)
    expect(field(src, 'tint')?.default).toEqual([1, 1, 1])
    expect(field(src, 'fade')?.default).toEqual([1, 1, 1, 1])
    expect(field(src, 'at')?.default).toEqual([0, 0])
  })
})

describe('name types', () => {
  it('maps every engine name type to a name of its kind', () => {
    const src = cls(`
      public clip: ClipName = 'Souls_Sword_L1'
      public sound: SoundName = 'Swing'
      public socket: SocketName = 'RightHand'
      public projectile: TemplateName = 'Magic Bolt'
      public next: NodeName = ''
      public roll: TriggerName = 'Roll'
      public sprite: SpriteClipName = 'run'
      public jump: ActionName = 'Jump'
      public scene: SceneName = 'Dungeon'
      public layer: LayerName = 'Character'
      public param: ParamName = 'Speed'`)
    const kinds = ['clip', 'sound', 'socket', 'template', 'node', 'trigger', 'spriteClip', 'action', 'scene', 'layer', 'param']
    const names = ['clip', 'sound', 'socket', 'projectile', 'next', 'roll', 'sprite', 'jump', 'scene', 'layer', 'param']
    names.forEach((n, i) => expect(field(src, n)?.type, n).toEqual({ kind: 'name', name: kinds[i] }))
    expect(field(src, 'roll')?.default).toBe('Roll')
    expect(field(src, 'next')?.default).toBe('')
  })

  it('accepts lists, qualified names, optional unions and cast initializers', () => {
    const src = cls(`
      public moves: ClipName[] = ['A', 'B']
      public cues: Array<SoundName> = []
      public q: Cleo.ClipName = 'Idle'
      public maybe: ClipName | undefined = 'Run'
      public cast = 'Roll' as ClipName
      public ro: readonly SocketName[] = []`)
    expect(field(src, 'moves')).toMatchObject({ type: { kind: 'list', of: { kind: 'name', name: 'clip' } }, default: ['A', 'B'] })
    expect(field(src, 'cues')).toMatchObject({ type: { kind: 'list', of: { kind: 'name', name: 'sound' } }, default: [] })
    expect(field(src, 'q')).toMatchObject({ type: { kind: 'name', name: 'clip' }, default: 'Idle' })
    expect(field(src, 'maybe')).toMatchObject({ type: { kind: 'name', name: 'clip' }, default: 'Run' })
    expect(field(src, 'cast')).toMatchObject({ type: { kind: 'string' }, default: 'Roll' })
    expect(field(src, 'ro')?.type).toEqual({ kind: 'list', of: { kind: 'name', name: 'socket' } })
  })

  it('no longer reads a @pick tag: a plain string stays a string', () => {
    const src = cls(`
      /** The swing. @pick clip */
      public a: string = 'x'`)
    expect(field(src, 'a')?.type).toEqual({ kind: 'string' })
  })
})

describe('asset types', () => {
  it('reads the engine classes as assets, starting empty', () => {
    const src = cls(`
      public skin: Material = null
      public icon: Texture | null = null
      public hit: Sound
      public tiles: Tileset = null
      public decals: Texture[] = []`)
    expect(field(src, 'skin')).toMatchObject({ type: { kind: 'asset', asset: 'material' }, default: null })
    expect(field(src, 'icon')).toMatchObject({ type: { kind: 'asset', asset: 'texture' }, default: null })
    expect(field(src, 'hit')).toMatchObject({ type: { kind: 'asset', asset: 'sound' }, default: null })
    expect(field(src, 'tiles')).toMatchObject({ type: { kind: 'asset', asset: 'tileset' }, default: null })
    expect(field(src, 'decals')).toMatchObject({ type: { kind: 'list', of: { kind: 'asset', asset: 'texture' } }, default: [] })
  })
})

describe('node types', () => {
  it('reads a node class as a node in the scene, starting empty', () => {
    const src = cls(`
      public target: Node = null
      public lamp: LightNode | null = null
      public tour: SequenceNode
      public buttons: UIButtonNode[] = []`)
    expect(field(src, 'target')).toMatchObject({ type: { kind: 'node', className: 'Node' }, default: null })
    expect(field(src, 'lamp')).toMatchObject({ type: { kind: 'node', className: 'LightNode' }, default: null })
    expect(field(src, 'tour')?.type).toEqual({ kind: 'node', className: 'SequenceNode' })
    expect(field(src, 'buttons')?.type).toEqual({ kind: 'list', of: { kind: 'node', className: 'UIButtonNode' } })
  })

  it("reads another project script's class as a node running it, when the script imports it", () => {
    const src = cls(`
      public door: SoulsDoor = null
      public base: Base = null
      public other: Unrelated = null`,
      `import SoulsDoor from './SoulsDoor'\nimport { Base } from '@/Shared/Base'\nimport { Unrelated } from 'cleo'`)
    expect(field(src, 'door')?.type).toEqual({ kind: 'node', className: 'SoulsDoor', script: true })
    expect(field(src, 'base')?.type).toEqual({ kind: 'node', className: 'Base', script: true })
    // An engine name that is no type of its own falls back to the default's type, as it always did.
    expect(field(src, 'other')?.type).toEqual({ kind: 'number' })
  })
})

describe('string literal unions', () => {
  it('reflects a union as fixed choices, defaulting to the first', () => {
    const src = cls(`
      public mode: 'melee' | 'ranged' = 'ranged'
      public stance: 'low' | "high"
      public multi:
        | 'a'
        | 'b'
      public after: number = 3`)
    expect(field(src, 'mode')).toMatchObject({ type: { kind: 'choice', values: ['melee', 'ranged'] }, default: 'ranged' })
    expect(field(src, 'stance')).toMatchObject({ type: { kind: 'choice', values: ['low', 'high'] }, default: 'low' })
    expect(field(src, 'multi')?.type).toEqual({ kind: 'choice', values: ['a', 'b'] })
    expect(field(src, 'after')).toMatchObject({ type: { kind: 'number' }, default: 3 })
  })

  it('does not treat a mixed union as choices', () => {
    const src = cls(`public m: 'a' | number = 2`)
    expect(field(src, 'm')?.type.kind).not.toBe('choice')
  })
})

describe('schemas reflected before the property types', () => {
  it('read as the type they meant', () => {
    const old = (v: object) => upgradeScriptVar({ name: 'x', access: 'public', default: null, hidden: false, ...v } as unknown as ScriptVarSchema)
    expect(old({ type: 'vec3' }).type).toEqual({ kind: 'vector', size: 3 })
    expect(old({ type: 'vec3', attribute: { color: true, label: 'Tint' } })).toMatchObject({ type: { kind: 'color' }, attribute: { label: 'Tint' } })
    expect(old({ type: 'vec3', attribute: { color: true } }).attribute).not.toHaveProperty('color')
    expect(old({ type: 'string', pick: 'clip' }).type).toEqual({ kind: 'name', name: 'clip' })
    expect(old({ type: 'stringList', pick: 'template' }).type).toEqual({ kind: 'list', of: { kind: 'name', name: 'template' } })
    expect(old({ type: 'stringList' }).type).toEqual({ kind: 'list', of: { kind: 'string' } })
    expect(old({ type: 'string', choices: ['a', 'b'] }).type).toEqual({ kind: 'choice', values: ['a', 'b'] })
    expect(old({ type: 'string', pick: 'clip' })).not.toHaveProperty('pick')
  })
})

describe('seeding a node', () => {
  it('starts a field over when its value no longer fits its type', () => {
    const node: any = { variables: new Map(), setVariable() {} }
    node.weapon = 'Sword'
    node.tint = [1, 0, 0]
    node.lamp = { $nodePath: '../Lamp' }
    const asset = buildScriptAsset('S', 'node', cls(`
      @attribute public weapon: Material = null
      @attribute public tint: Color = [1, 1, 1]
      @attribute public lamp: LightNode = null`, `import { attribute } from 'cleo/decorators'`))
    seedScriptFields(node, asset, false)
    expect(node.weapon).toBeNull()
    expect(node.tint).toEqual([1, 0, 0])
    expect(node.lamp).toEqual({ $nodePath: '../Lamp' })
  })
})

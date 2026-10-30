import { describe, it, expect } from 'vitest'
import { parseScriptVariables } from '../src/utils/scripts'

// Typed name fields: a script types a field with an engine name type (ClipName, SoundName, ...) and the
// inspector offers that node's valid names. The value is still a plain string; only `pick` is added.

const field = (src: string, name: string) => parseScriptVariables(src).find(v => v.name === name)

describe('name-typed fields', () => {
  it('maps every engine name type to a string field with its pick kind', () => {
    const src = `export default class S extends Node {
      public clip: ClipName = 'Souls_Sword_L1'
      public sound: SoundName = 'Swing'
      public socket: SocketName = 'RightHand'
      public projectile: TemplateName = 'Magic Bolt'
      public next: NodeName = ''
    }`
    expect(field(src, 'clip')).toMatchObject({ type: 'string', pick: 'clip', default: 'Souls_Sword_L1' })
    expect(field(src, 'sound')).toMatchObject({ type: 'string', pick: 'sound', default: 'Swing' })
    expect(field(src, 'socket')).toMatchObject({ type: 'string', pick: 'socket' })
    expect(field(src, 'projectile')).toMatchObject({ type: 'string', pick: 'template' })
    expect(field(src, 'next')).toMatchObject({ type: 'string', pick: 'node', default: '' })
  })

  it('accepts lists, qualified names, optional unions and cast initializers', () => {
    const src = `export default class S extends Node {
      public moves: ClipName[] = ['A', 'B']
      public cues: Array<SoundName> = []
      public q: Cleo.ClipName = 'Idle'
      public maybe: ClipName | undefined = 'Run'
      public cast = 'Roll' as ClipName
      public ro: readonly SocketName[] = []
    }`
    expect(field(src, 'moves')).toMatchObject({ type: 'stringList', pick: 'clip', default: ['A', 'B'] })
    expect(field(src, 'cues')).toMatchObject({ type: 'stringList', pick: 'sound', default: [] })
    expect(field(src, 'q')).toMatchObject({ type: 'string', pick: 'clip', default: 'Idle' })
    expect(field(src, 'maybe')).toMatchObject({ type: 'string', pick: 'clip', default: 'Run' })
    expect(field(src, 'cast')).toMatchObject({ type: 'string', default: 'Roll' })
    expect(field(src, 'ro')).toMatchObject({ type: 'stringList', pick: 'socket' })
  })

  it('reads a @pick tag on a plain string, and ignores an unknown kind', () => {
    const src = `export default class S extends Node {
      /** The swing. @pick clip */
      public a: string = 'x'
      /** @pick nonsense */
      public b: string = 'y'
      public c: string = 'z'
    }`
    expect(field(src, 'a')).toMatchObject({ type: 'string', pick: 'clip' })
    expect(field(src, 'b')?.pick).toBeUndefined()
    expect(field(src, 'c')?.pick).toBeUndefined()
  })
})

describe('string literal unions', () => {
  it('reflects a union as fixed choices, defaulting to the first', () => {
    const src = `export default class S extends Node {
      public mode: 'melee' | 'ranged' = 'ranged'
      public stance: 'low' | "high"
      public multi:
        | 'a'
        | 'b'
      public after: number = 3
    }`
    expect(field(src, 'mode')).toMatchObject({ type: 'string', choices: ['melee', 'ranged'], default: 'ranged' })
    expect(field(src, 'stance')).toMatchObject({ type: 'string', choices: ['low', 'high'], default: 'low' })
    expect(field(src, 'multi')).toMatchObject({ type: 'string', choices: ['a', 'b'] })
    expect(field(src, 'after')).toMatchObject({ type: 'number', default: 3 })
  })

  it('does not treat a mixed union as choices', () => {
    const src = `export default class S extends Node { public m: 'a' | number = 2 }`
    expect(field(src, 'm')?.choices).toBeUndefined()
  })
})

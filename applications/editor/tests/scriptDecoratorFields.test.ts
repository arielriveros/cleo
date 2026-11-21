import { describe, it, expect } from 'vitest'
import { parseScriptVariables, saveFieldNames } from '../src/utils/scripts'

// The decorators a script may carry (`@save`, `@options`, `@attribute`, `@child`, `@find`, `@onAction`) are
// read from the source text, to the same schema the doc-comment tags produce.

const parse = (body: string) => parseScriptVariables(`import { Node } from 'cleo'\nexport default class A extends Node {\n${body}\n}`)
const byName = (vars: ReturnType<typeof parse>) => Object.fromEntries(vars.map(v => [v.name, v]))

describe('@attribute', () => {
  it('shows only the fields it marks, whatever their access', () => {
    const v = byName(parse(`  speed = 3\n  @attribute private _armor = 2\n  @attribute protected reach = 1.5\n  @attribute public label = 'x'`))
    expect(v.speed.hidden).toBe(true)
    expect(v._armor).toMatchObject({ hidden: false, access: 'private', attribute: {} })
    expect(v.reach).toMatchObject({ hidden: false, access: 'protected' })
    expect(v.label.hidden).toBe(false)
  })

  it('takes a group, options, or both', () => {
    const v = byName(parse([
      `  @attribute('Combat') damage = 10`,
      `  @attribute('Combat', { min: 0, max: 1, step: 0.05, label: 'Crit chance' }) crit = 0.1`,
      `  @attribute({ readonly: true }) hp = 100`,
      `  @attribute({ color: true }) tint: Color = [1, 0.5, 0]`,
      `  @attribute({ multiline: true, showIf: 'talks' }) line = ''`,
      `  @attribute({ showIf: ['mode', 'ranged'] }) range = 8`,
      `  @attribute talks = false`,
    ].join('\n')))
    expect(v.damage.attribute).toEqual({ group: 'Combat' })
    expect(v.crit.attribute).toEqual({ group: 'Combat', min: 0, max: 1, step: 0.05, label: 'Crit chance' })
    expect(v.hp.attribute).toEqual({ readonly: true })
    // The type is what makes a colour now; an old `color` option is not an option any more.
    expect(v.tint).toMatchObject({ type: { kind: 'color' }, attribute: {} })
    expect(v.tint.attribute).not.toHaveProperty('color')
    expect(v.line.attribute).toEqual({ multiline: true, showIf: 'talks' })
    expect(v.range.attribute).toEqual({ showIf: ['mode', 'ranged'] })
  })

  it('takes the doc comment as the tooltip, without its tags', () => {
    const v = byName(parse(`  /**\n   * Seconds between shots.\n   * @save\n   */\n  @attribute('Combat') cooldown = 0.5\n  /** Not an attribute. */\n  plain = 1`))
    expect(v.cooldown).toMatchObject({ save: true, attribute: { group: 'Combat', tooltip: 'Seconds between shots.' } })
    expect(v.plain.attribute).toBeUndefined()
  })

  it('never runs its arguments: a non-literal reads as absent, and the field still shows', () => {
    const v = byName(parse(`  @attribute(GROUP, { min: limit(), max: 5 }) x = 1`))
    expect(v.x).toMatchObject({ hidden: false, attribute: {} })
  })
})

describe('decorated script fields', () => {
  it('reads @save, in front of the field or on its own line', () => {
    const v = parse(`  @attribute @save hp = 100\n  @save\n  private _gold: number = 5\n  other = 1`)
    expect(saveFieldNames(v)).toEqual(['hp', '_gold'])
    expect(byName(v).hp).toMatchObject({ type: { kind: 'number' }, default: 100, hidden: false })
  })

  it('reads @options like its doc tag', () => {
    const v = byName(parse(`  list: string[] = ['a', 'b']\n  @options('list') choice = 'a'\n  cue: SoundName = ''`))
    expect(v.choice.options).toBe('list')
    expect(v.cue.type).toEqual({ kind: 'name', name: 'sound' })
  })

  it('hides @child / @find fields and keeps the name they look for', () => {
    const v = byName(parse(`  @child('Fire Light') private light?: Node\n  @find('GameManager') gm: Node | null = null\n  speed = 3`))
    expect(v.light).toMatchObject({ hidden: true, ref: { kind: 'child', name: 'Fire Light' } })
    expect(v.gm).toMatchObject({ hidden: true, ref: { kind: 'find', name: 'GameManager' } })
    expect(v.speed.hidden).toBe(true)   // not an @attribute
  })

  it('stacks decorators and ignores @onAction methods', () => {
    const v = parse(`  @save @attribute clip: ClipName = 'Idle'\n  @onAction('Jump') jump(state) { return 1 }\n  after = 2`)
    expect(v.map(x => x.name)).toEqual(['clip', 'after'])
    expect(v[0]).toMatchObject({ save: true, hidden: false, type: { kind: 'name', name: 'clip' } })
  })

  it('skips behaviour decorators, whatever their arguments, without disturbing the fields around them', () => {
    const v = parse(`  a = 1
  @every(0.5) tick() {}
  @onHold('Roll', 0.5) sprint(state) { return 'x)(' }
  @onEnter('Player') hit(o) {}
  @onEvent('Died') died(p) {}
  @onTap('Roll') roll() {}
  @save b = 2`)
    expect(v.map(x => x.name)).toEqual(['a', 'b'])
    expect(v[1].save).toBe(true)
  })

  it('still reads the doc-comment tags', () => {
    const v = parse(`  /** @save */\n  hp = 1`)
    expect(saveFieldNames(v)).toEqual(['hp'])
  })

  it('does not mistake an @ inside a string for a decorator', () => {
    const v = byName(parse(`  email = 'a@save.com'`))
    expect(v.email.default).toBe('a@save.com')
    expect(v.email.save).toBeUndefined()
  })
})

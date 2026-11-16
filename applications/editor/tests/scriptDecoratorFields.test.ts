import { describe, it, expect } from 'vitest'
import { parseScriptVariables, saveFieldNames } from '../src/utils/scripts'

// The decorators a script may carry (`@save`, `@options`, `@pick`, `@child`, `@find`, `@onAction`) are
// read from the source text, to the same schema the doc-comment tags produce.

const parse = (body: string) => parseScriptVariables(`import { Node } from 'cleo'\nexport default class A extends Node {\n${body}\n}`)
const byName = (vars: ReturnType<typeof parse>) => Object.fromEntries(vars.map(v => [v.name, v]))

describe('decorated script fields', () => {
  it('reads @save, in front of the field or on its own line', () => {
    const v = parse(`  @save hp = 100\n  @save\n  private _gold: number = 5\n  other = 1`)
    expect(saveFieldNames(v)).toEqual(['hp', '_gold'])
    expect(byName(v).hp).toMatchObject({ type: 'number', default: 100, hidden: false })
  })

  it('reads @options and @pick like their doc tags', () => {
    const v = byName(parse(`  list: string[] = ['a', 'b']\n  @options('list') choice = 'a'\n  @pick('sound') cue: string = ''`))
    expect(v.choice.options).toBe('list')
    expect(v.cue.pick).toBe('sound')
  })

  it('hides @child / @find fields and keeps the name they look for', () => {
    const v = byName(parse(`  @child('Fire Light') private light?: Node\n  @find('GameManager') gm: Node | null = null\n  speed = 3`))
    expect(v.light).toMatchObject({ hidden: true, ref: { kind: 'child', name: 'Fire Light' } })
    expect(v.gm).toMatchObject({ hidden: true, ref: { kind: 'find', name: 'GameManager' } })
    expect(v.speed.hidden).toBe(false)
  })

  it('stacks decorators and ignores @onAction methods', () => {
    const v = parse(`  @save @pick('clip') clip: string = 'Idle'\n  @onAction('Jump') jump(state) { return 1 }\n  after = 2`)
    expect(v.map(x => x.name)).toEqual(['clip', 'after'])
    expect(v[0]).toMatchObject({ save: true, pick: 'clip' })
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

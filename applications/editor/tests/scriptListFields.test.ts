import { describe, it, expect } from 'vitest'
import { parseScriptVariables } from '../src/utils/scripts'

// `string[]` fields reflect as an editable list, and a string field tagged `@options <list>` is picked from
// that list in the inspector (the Hollow Keep enemy spawner chooses its template this way).

const field = (src: string, name: string) => parseScriptVariables(src).find(v => v.name === name)

describe('string list fields', () => {
  it('reflects a literal string array, with or without an annotation', () => {
    const src = `export default class S extends Node {
      public a: string[] = ['Hollow', "Elite Knight", 'it\\'s']
      public b = ['x', 'y']
    }`
    expect(field(src, 'a')).toMatchObject({ type: 'stringList', default: ['Hollow', 'Elite Knight', "it's"] })
    expect(field(src, 'b')).toMatchObject({ type: 'stringList', default: ['x', 'y'] })
  })

  it('reflects an empty and a multi-line initializer', () => {
    const src = `export default class S extends Node {
      public empty: string[] = []
      public multi: string[] = [
        'one',
        'two, three',
      ]
      public after: number = 2
    }`
    expect(field(src, 'empty')).toMatchObject({ type: 'stringList', default: [] })
    expect(field(src, 'multi')).toMatchObject({ type: 'stringList', default: ['one', 'two, three'] })
    expect(field(src, 'after')).toMatchObject({ type: 'number', default: 2 })
  })

  it('keeps number arrays as vec3', () => {
    const src = `export default class S extends Node { public p = [1, 2, 3]; public q: number[] = [] }`
    expect(field(src, 'p')).toMatchObject({ type: 'vec3', default: [1, 2, 3] })
    expect(field(src, 'q')?.type).toBe('vec3')
  })
})

describe('@options', () => {
  it('links the next string field to a list, and only that field', () => {
    const src = `export default class S extends Node {
      public spawnables: string[] = ['Hollow', 'Elite Knight']
      /**
       * Which entry this placement creates.
       * @options spawnables
       */
      public templateName: string = 'Hollow'
      public other: string = 'x'
      /** @options spawnables */ public inline: string = 'Elite Knight'
    }`
    expect(field(src, 'templateName')).toMatchObject({ type: 'string', options: 'spawnables', default: 'Hollow' })
    expect(field(src, 'other')?.options).toBeUndefined()
    expect(field(src, 'inline')).toMatchObject({ options: 'spawnables', default: 'Elite Knight' })
    expect(field(src, 'spawnables')?.options).toBeUndefined()
  })

  it('ignores a tag on a non-string field and never reflects commented-out fields', () => {
    const src = `export default class S extends Node {
      /** @options list */
      public count: number = 3
      // public hidden: string = 'no'
      /* public gone: string[] = ['no'] */
    }`
    expect(field(src, 'count')?.options).toBeUndefined()
    expect(field(src, 'hidden')).toBeUndefined()
    expect(field(src, 'gone')).toBeUndefined()
  })
})

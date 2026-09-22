import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Selecting a node must not mark its tab unsaved.
 *
 * The Transform section used to push its local state back into the node from a `useEffect` on
 * `[position, rotation, scale]`. That effect runs on mount and after every selection change, and every
 * transform setter emits a `transform` change once the engine is in authoring mode. So each click in the tree
 * dirtied the tab and round-tripped the node's rotation through Euler angles. The writes belong in the change
 * handlers. This pins that no effect body in the file calls a transform setter.
 */

const SOURCE = readFileSync(join(__dirname, '../src/features/nodeInspector/propertyEditors/TransformEditor.tsx'), 'utf8')

/** The body text of every `useEffect(() => { ... }` in the file, brace-matched. */
function effectBodies(src: string): string[] {
  const bodies: string[] = []
  let at = 0
  while ((at = src.indexOf('useEffect(', at)) >= 0) {
    const open = src.indexOf('{', at)
    let depth = 0, i = open
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) break
    }
    bodies.push(src.slice(open, i + 1))
    at = i
  }
  return bodies
}

describe('TransformEditor', () => {
  it('never writes the node from an effect', () => {
    const bodies = effectBodies(SOURCE)
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) expect(body).not.toMatch(/props\.node\.set(Position|Rotation|Scale|Quaternion)\(/)
  })

  it('still writes the node when the user edits a field', () => {
    expect(SOURCE).toMatch(/props\.node\.setPosition\(/)
    expect(SOURCE).toMatch(/props\.node\.setRotation\(/)
    expect(SOURCE).toMatch(/props\.node\.setScale\(/)
  })
})

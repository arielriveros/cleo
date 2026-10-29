import { describe, it, expect } from 'vitest'
import type { FuzzyTermNode } from 'cleo'
import { antecedentLeaves, withLeaf, withoutVariable } from '../src/features/ai/FuzzyGraph'

/**
 * The antecedent-tree surgery behind the Fuzzy canvas.
 *
 * A rule is drawn as a NODE with one incoming edge per antecedent variable, so wiring an edge means
 * grafting a leaf onto a tree and cutting one means pruning it — and pruning is where the traps are.
 * `parseFuzzyModel` silently drops a rule whose antecedent it cannot read, so a prune that leaves a
 * malformed tree does not error: the rule just quietly stops existing, taking the author's work.
 */

const is = (variable: string, set: string): FuzzyTermNode => ({ op: 'is', variable, set })

describe('antecedentLeaves', () => {
  it('reads a bare leaf', () => {
    expect(antecedentLeaves(is('distance', 'close'))).toEqual([{ variable: 'distance', set: 'close' }])
  })

  it('reads through AND, OR and hedges alike', () => {
    const term: FuzzyTermNode = {
      op: 'and',
      children: [
        is('distance', 'close'),
        { op: 'very', child: is('health', 'low') },
        { op: 'or', children: [is('ammo', 'empty'), is('cover', 'none')] },
      ],
    }
    expect(antecedentLeaves(term).map(l => l.variable))
      .toEqual(['distance', 'health', 'ammo', 'cover'])
  })
})

describe('withLeaf', () => {
  it('extends an existing AND rather than nesting another one', () => {
    const term: FuzzyTermNode = { op: 'and', children: [is('a', 'x'), is('b', 'y')] }
    const next = withLeaf(term, is('c', 'z'))
    expect(next.op).toBe('and')
    expect((next as { children: FuzzyTermNode[] }).children).toHaveLength(3)
  })

  it('wraps a bare leaf into an AND of two', () => {
    const next = withLeaf(is('a', 'x'), is('b', 'y'))
    expect(next.op).toBe('and')
    expect(antecedentLeaves(next).map(l => l.variable)).toEqual(['a', 'b'])
  })

  it('preserves an OR instead of flattening it into the new AND', () => {
    // Wiring one more antecedent must not silently rewrite "a OR b" into "a AND b" — that changes
    // when the rule fires, and nothing would say so.
    const term: FuzzyTermNode = { op: 'or', children: [is('a', 'x'), is('b', 'y')] }
    const next = withLeaf(term, is('c', 'z'))
    expect(next.op).toBe('and')
    const kept = (next as { children: FuzzyTermNode[] }).children[0]
    expect(kept.op).toBe('or')
  })
})

describe('withoutVariable', () => {
  it('removes the only leaf and reports that nothing is left', () => {
    expect(withoutVariable(is('a', 'x'), 'a')).toBeNull()
  })

  it('leaves an unrelated leaf alone', () => {
    expect(withoutVariable(is('a', 'x'), 'b')).toEqual(is('a', 'x'))
  })

  it('collapses a one-child AND rather than growing a tower of wrappers', () => {
    // Repeated pruning is the normal case (unwire two of three antecedents), and a wrapper left behind
    // each time builds `and(and(and(leaf)))` — still readable by the engine, but it makes every later
    // structural test say the tree is "richer than a flat AND" and drop into the read-only path.
    const term: FuzzyTermNode = { op: 'and', children: [is('a', 'x'), is('b', 'y')] }
    expect(withoutVariable(term, 'a')).toEqual(is('b', 'y'))
  })

  it('prunes through a hedge and drops the hedge with its child', () => {
    const term: FuzzyTermNode = { op: 'very', child: is('a', 'x') }
    expect(withoutVariable(term, 'a')).toBeNull()
  })

  it('keeps a hedge whose child survives', () => {
    const term: FuzzyTermNode = {
      op: 'and',
      children: [{ op: 'very', child: is('a', 'x') }, is('b', 'y')],
    }
    const next = withoutVariable(term, 'b')
    expect(next).toEqual({ op: 'very', child: is('a', 'x') })
  })

  it('removes EVERY occurrence of a variable, not just the first', () => {
    const term: FuzzyTermNode = {
      op: 'and',
      children: [is('a', 'x'), is('b', 'y'), is('a', 'z')],
    }
    expect(withoutVariable(term, 'a')).toEqual(is('b', 'y'))
  })

  it('empties a nested tree all the way to null', () => {
    const term: FuzzyTermNode = {
      op: 'and',
      children: [{ op: 'or', children: [is('a', 'x'), is('a', 'y')] }],
    }
    expect(withoutVariable(term, 'a')).toBeNull()
  })
})

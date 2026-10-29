import { isConditionGroup } from 'cleo'
import type { Condition, ConditionGroup, ConditionNode, ConditionOp } from 'cleo'
import { Button, cn, labelClass, NumberInput, OptionalNumberInput, SegmentedControl, Select } from '@cleo/app-kit/ui'

/**
 * Recursive editor for an AND/OR condition tree — the animation state machine's, the behaviour state
 * machine's, or anything else built on `core/conditions.ts`.
 *
 * Lifted out of `features/animation/ConditionTree.tsx`, which owned the recursion, the gate toggle and
 * the hysteresis input while being welded to `useStateMachine()`. None of that markup was about
 * animation; only the plumbing was. Here the whole tree arrives as a value and leaves as a new one, so
 * the caller owns where it is stored.
 *
 * `features/animation/ConditionTree.tsx` is now a thin adapter over this, so the animation editor is
 * behaviourally untouched.
 */

/** What a parameter looks like to this component: a name and how it can be compared. */
export interface ConditionParam {
  name: string
  type: ConditionParamType
}

export type ConditionParamType = 'float' | 'bool' | 'trigger'

/** Operators that make sense per parameter type. */
export const OPS_FOR_TYPE: Record<ConditionParamType, ConditionOp[]> = {
  float: ['gt', 'lt', 'eq', 'neq'],
  bool: ['true', 'false'],
  trigger: ['trigger'],
}

export const CONDITION_OP_LABEL: Record<ConditionOp, string> = {
  gt: '>', lt: '<', eq: '==', neq: '!=', true: 'is true', false: 'is false', trigger: 'on',
}

const HYSTERESIS_HINT =
  'Tolerance: how far past the threshold the value must go before this switches, and back before it '
  + 'switches back. ±0.4 on “> 1” engages at 1.2 and does not release until the value falls back through 0.8. '
  + 'Put the same tolerance on the opposite condition (“< 1”) and the pair stops flickering when the value '
  + 'hovers at 1. 0 or blank = off.'

/** Dense-row padding for the library controls (their default is px-2 py-1). */
const tight = 'px-1 py-0.5'

/** Index of the child at each level. The address of a node inside the tree. */
export type CondPath = number[]

export const emptyConditionGroup = (): ConditionGroup => ({ op: 'and', children: [] })

/**
 * Rewrite one node of the tree, addressed by `path`. Passing `next: null` removes it.
 *
 * Immutable all the way down, so React sees a new object and the caller can hold the old one for undo.
 */
export function patchConditionTree(
  root: ConditionGroup, path: CondPath, next: ConditionNode | null,
): ConditionGroup {
  const rec = (node: ConditionNode, rest: CondPath): ConditionNode | null => {
    if (rest.length === 0) return next
    if (!isConditionGroup(node)) return node
    const [i, ...deeper] = rest
    if (i < 0 || i >= node.children.length) return node
    const replaced = rec(node.children[i], deeper)
    const children = replaced === null
      ? node.children.filter((_, idx) => idx !== i)
      : node.children.map((c, idx) => (idx === i ? replaced : c))
    return { ...node, children }
  }
  return (rec(root, path) as ConditionGroup) ?? emptyConditionGroup()
}

/** The node at `path`, or the root. */
function nodeAt(root: ConditionGroup, path: CondPath): ConditionNode {
  let node: ConditionNode = root
  for (const i of path) {
    if (!isConditionGroup(node)) return node
    node = node.children[i] ?? node
  }
  return node
}

export interface ConditionTreeViewProps {
  params: readonly ConditionParam[]
  node: ConditionGroup
  onChange: (next: ConditionGroup) => void
}

export default function ConditionTreeView({ params, node, onChange }: ConditionTreeViewProps) {
  return <GroupBox params={params} root={node} path={[]} onChange={onChange} />
}

/** The AND/OR gate toggle for one group. */
function GateToggle({ op, onChange }: { op: 'and' | 'or'; onChange: (op: 'and' | 'or') => void }) {
  return (
    <SegmentedControl<'and' | 'or'>
      size='sm' value={op} onChange={onChange} itemClassName='px-1.5 py-0.5 text-ui-xs uppercase'
      options={[
        { value: 'and', label: 'and', title: 'Every child must match' },
        { value: 'or', label: 'or', title: 'Any one child may match' },
      ]} />
  )
}

interface NodeProps {
  params: readonly ConditionParam[]
  root: ConditionGroup
  path: CondPath
  onChange: (next: ConditionGroup) => void
}

function GroupBox({ params, root, path, onChange }: NodeProps) {
  const node = nodeAt(root, path)
  if (!isConditionGroup(node)) return <ConditionRow params={params} root={root} path={path} onChange={onChange} />
  const isRoot = path.length === 0
  const patch = (next: ConditionNode | null) => onChange(patchConditionTree(root, path, next))

  return (
    <div className={isRoot ? 'flex flex-col gap-1' : 'flex flex-col gap-1 border-l-2 border-control-hover pl-1.5 ml-1 py-1'}>
      <div className='flex items-center gap-1'>
        <GateToggle op={node.op} onChange={op => patch({ ...node, op })} />
        <span className='text-ui-xs text-dim flex-1'>
          {node.children.length === 0
            ? 'empty — always matches'
            : node.op === 'and' ? 'all of:' : 'any of:'}
        </span>
        {!isRoot && <Button variant='remove' size='sm' title='Remove group' onClick={() => patch(null)}>✕</Button>}
      </div>

      {node.children.map((_, i) => (
        <GroupBox key={i} params={params} root={root} path={[...path, i]} onChange={onChange} />
      ))}

      <div className='flex items-center gap-1'>
        <Button size='sm' variant='subtle' disabled={params.length === 0}
          title={params.length === 0 ? 'Add a parameter first' : 'Add a condition to this group'}
          onClick={() => {
            const first = params[0]
            if (!first) return
            const condition: Condition = { param: first.name, op: OPS_FOR_TYPE[first.type][0] }
            patch({ ...node, children: [...node.children, condition] })
          }}>+ Condition</Button>
        <Button size='sm' variant='subtle' title={`Nest a ${node.op === 'and' ? 'OR' : 'AND'} group inside this one`}
          onClick={() => patch({
            ...node,
            children: [...node.children, { op: node.op === 'and' ? 'or' : 'and', children: [] }],
          })}>+ Group</Button>
      </div>
    </div>
  )
}

function ConditionRow({ params, root, path, onChange }: NodeProps) {
  const node = nodeAt(root, path)
  if (isConditionGroup(node)) return null
  const param = params.find(p => p.name === node.param)
  const type: ConditionParamType = param?.type ?? 'float'
  const patch = (delta: Partial<Condition>) =>
    onChange(patchConditionTree(root, path, { ...node, ...delta }))

  return (
    <div className='flex items-center gap-1'>
      {/* A condition on a parameter that no longer exists can never match — flag it rather than hide it. */}
      <Select
        className={cn(tight, !param && 'border-danger-border text-danger-fg')}
        value={node.param}
        onChange={e => {
          const next = params.find(p => p.name === e.target.value)
          patch({ param: e.target.value, op: OPS_FOR_TYPE[next?.type ?? 'float'][0] })
        }}>
        {!param && <option value={node.param}>{node.param || '(none)'} — missing</option>}
        {params.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
      </Select>

      <Select className={tight} value={node.op} onChange={e => patch({ op: e.target.value as ConditionOp })}>
        {OPS_FOR_TYPE[type].map(op => <option key={op} value={op}>{CONDITION_OP_LABEL[op]}</option>)}
      </Select>

      {type === 'float' && (
        <NumberInput className={cn(tight, 'w-[52px]')} step='0.1' value={node.value ?? 0}
          title='Threshold'
          onChange={v => patch({ value: v })} />
      )}

      {/* The band, for the two operators that can chatter. A measured value sitting on a threshold
          satisfies `> x` and `< x` on alternating frames, so a machine with one of each flips state
          every frame. Centring the band is what pushes the two halves of such a pair apart. */}
      {(node.op === 'gt' || node.op === 'lt') && (
        <label className={cn(labelClass, 'flex items-center gap-0.5 text-ui-xs')} title={HYSTERESIS_HINT}>
          tol ±
          <OptionalNumberInput className={cn(tight, 'w-[46px]')} placeholder='0'
            value={node.hysteresis}
            onChange={v => patch({ hysteresis: v === undefined ? undefined : Math.max(0, v) })} />
        </label>
      )}

      <Button variant='remove' size='sm' title='Remove condition'
        onClick={() => onChange(patchConditionTree(root, path, null))}>✕</Button>
    </div>
  )
}

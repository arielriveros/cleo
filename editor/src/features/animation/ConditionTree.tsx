import { isConditionGroup } from 'cleo'
import type { AnimationConditionNode, AnimationConditionOp } from 'cleo'
import { useStateMachine, OPS_FOR, OP_LABEL, effectiveType, treeOf, CondPath } from './StateMachineContext'

// Recursive editor for a transition's AND/OR condition tree. Every node addresses itself by `path`, the
// child index at each level, so nothing here needs to know where the transition sits in the machine.

const input = 'bg-control text-white border border-control-hover rounded px-1 py-0.5 text-xs'
const ghost = 'px-1.5 py-0.5 rounded border border-control-hover hover:bg-control text-xs'
const danger = 'px-1.5 py-0.5 rounded bg-red-700 hover:bg-red-600 text-white text-xs'

/** The AND/OR gate toggle for one group. */
function GateToggle({ op, onChange }: { op: 'and' | 'or'; onChange: (op: 'and' | 'or') => void }) {
  return (
    <div className='flex rounded overflow-hidden border border-control-hover'>
      {(['and', 'or'] as const).map(o => (
        <button
          key={o}
          className={`px-1.5 py-0.5 text-[10px] uppercase ${op === o ? 'bg-primary text-white' : 'bg-control text-muted hover:bg-control-hover'}`}
          title={o === 'and' ? 'Every child must match' : 'Any one child may match'}
          onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  )
}

function ConditionRow({ from, to, path, node }: { from: string; to: string; path: CondPath; node: AnimationConditionNode }) {
  const { sm, paramOf, setCondition, removeNode } = useStateMachine()
  if (isConditionGroup(node)) return null
  const param = paramOf(node.param)
  const type = effectiveType(param)

  return (
    <div className='flex items-center gap-1'>
      {/* A condition on a parameter that no longer exists can never match — flag it rather than hide it. */}
      <select
        className={input + (param ? '' : ' border-red-500 text-red-300')}
        value={node.param}
        onChange={e => {
          const next = paramOf(e.target.value)
          setCondition(from, to, path, { param: e.target.value, op: OPS_FOR[effectiveType(next)][0] })
        }}>
        {!param && <option value={node.param}>{node.param || '(none)'} — missing</option>}
        {sm.parameters.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
      </select>
      <select className={input} value={node.op} onChange={e => setCondition(from, to, path, { op: e.target.value as AnimationConditionOp })}>
        {OPS_FOR[type].map(op => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
      </select>
      {type === 'float' && (
        <input className={input + ' w-[52px]'} type='number' step='0.1' value={node.value ?? 0}
          title='Threshold'
          onChange={e => setCondition(from, to, path, { value: parseFloat(e.target.value) || 0 })} />
      )}
      {/* Hysteresis band, for the two operators that can chatter. A measured value sitting on a threshold
          satisfies `> x` and `< x` on alternating frames, so a machine with one of each flips state every
          frame — which is what a spasming animation usually is. The band is centred on the threshold, which is
          what pushes the two halves of such a pair apart. */}
      {(node.op === 'gt' || node.op === 'lt') && (
        <label className='flex items-center gap-0.5 text-[10px] text-gray-400'
          title={'Hysteresis band, centred on the threshold. Full width — so ±0.4 on “> 1” engages at 1.2 and '
            + 'does not release until the value falls back through 0.8. Put the same band on the opposite '
            + 'condition (“< 1”) and the pair stops flipping every frame when the value hovers at 1. '
            + '0 or blank = off.'}>
          ±
          <input className={input + ' w-[46px]'} type='number' step='0.05' min='0' placeholder='0'
            value={node.hysteresis ?? ''}
            onChange={e => {
              const raw = e.target.value.trim()
              setCondition(from, to, path, { hysteresis: raw === '' ? undefined : Math.max(0, parseFloat(raw) || 0) })
            }} />
        </label>
      )}
      <button className={danger} title='Remove condition' onClick={() => removeNode(from, to, path)}>✕</button>
    </div>
  )
}

function GroupBox({ from, to, path, node }: { from: string; to: string; path: CondPath; node: AnimationConditionNode }) {
  const { sm, addCondition, addGroup, setGroupOp, removeNode } = useStateMachine()
  if (!isConditionGroup(node)) return <ConditionRow from={from} to={to} path={path} node={node} />
  const isRoot = path.length === 0

  return (
    <div className={isRoot ? 'flex flex-col gap-1' : 'flex flex-col gap-1 border-l-2 border-control-hover pl-1.5 ml-1 py-1'}>
      <div className='flex items-center gap-1'>
        <GateToggle op={node.op} onChange={op => setGroupOp(from, to, path, op)} />
        <span className='text-[10px] text-dim flex-1'>
          {node.children.length === 0
            ? 'empty — always matches'
            : node.op === 'and' ? 'all of:' : 'any of:'}
        </span>
        {!isRoot && <button className={danger} title='Remove group' onClick={() => removeNode(from, to, path)}>✕</button>}
      </div>

      {node.children.map((child, i) => (
        <GroupBox key={i} from={from} to={to} path={[...path, i]} node={child} />
      ))}

      <div className='flex items-center gap-1'>
        <button className={ghost} disabled={sm.parameters.length === 0}
          title={sm.parameters.length === 0 ? 'Add a parameter first' : 'Add a condition to this group'}
          onClick={() => addCondition(from, to, path)}>+ Condition</button>
        <button className={ghost} title={`Nest a ${node.op === 'and' ? 'OR' : 'AND'} group inside this one`}
          onClick={() => addGroup(from, to, path)}>+ Group</button>
      </div>
    </div>
  )
}

/** The condition gate for one direction of a link. */
export default function ConditionTree({ from, to }: { from: string; to: string }) {
  const { linkOf } = useStateMachine()
  const link = linkOf(from, to)
  const t = link?.forward?.from === from ? link.forward : link?.backward
  if (!t) return null
  return <GroupBox from={from} to={to} path={[]} node={treeOf(t)} />
}

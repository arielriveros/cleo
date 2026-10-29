import ConditionTreeView from '../../components/ConditionTreeView'
import type { ConditionParam } from '../../components/ConditionTreeView'
import { useStateMachine, effectiveType, treeOf } from './StateMachineContext'

/**
 * The condition gate for one direction of an animation link.
 *
 * An adapter, and nothing more. The recursion, the AND/OR gate and the hysteresis input live in
 * `components/ConditionTreeView`, because none of that markup was ever about animation — only the
 * plumbing was, and the behaviour state machine needs exactly the same editor over exactly the same
 * `core/conditions.ts` model.
 *
 * The one translation this does is the parameter TYPE: an animation parameter of type `variable` behaves
 * like a float or a bool depending on the node variable it is bound to, which is a fact only the
 * animation machine knows.
 */
export default function ConditionTree({ from, to }: { from: string; to: string }) {
  const { sm, linkOf, setTransitionCondition } = useStateMachine()
  const link = linkOf(from, to)
  const t = link?.forward?.from === from ? link.forward : link?.backward
  if (!t) return null

  const params: ConditionParam[] = sm.parameters.map(p => ({ name: p.name, type: effectiveType(p) }))

  return (
    <ConditionTreeView
      params={params}
      node={treeOf(t)}
      onChange={(next) => setTransitionCondition(from, to, next)}
    />
  )
}

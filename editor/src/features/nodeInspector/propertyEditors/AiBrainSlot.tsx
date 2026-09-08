import { ControllerNode } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import { AiBrainAsset } from '../../../utils/aiBrains'
import { Select, Button, Hint, cn, sectionTitleClass, valueClass } from '../../../components/ui'
import { useAssetDrop } from '../../../utils/useAssetDrop'

/**
 * The brain reference control on a Controller — what this agent decides with.
 *
 * Shaped like `TilesetSlot`, and linked the same way: assigning COPIES the asset onto the node, so the
 * controller keeps thinking even where the library is not in scope (a published game ships no brain
 * library at all). The id is kept beside the copy so an edited asset can be pushed back out.
 *
 * ## Empty means no brain
 *
 * This replaced a Machine/Goal/None segmented control. "None" is now simply an empty slot, and machine
 * versus goal is the asset's own business — a brain knows which kind it is, so asking the controller as
 * well was one more way for the two to disagree.
 */
export default function AiBrainSlot(props: { node: ControllerNode; onChange?: () => void }) {
  const {
    aiBrains, enterAiBrainEditor, extractBrainFromController, linkBrainToController, eventEmitter,
  } = useCleoEngine()

  const linkedId = props.node.brainId
  const asset = linkedId ? aiBrains.find(b => b.id === linkedId) : undefined

  const commit = () => {
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
    props.onChange?.()
  }

  const assign = (next: AiBrainAsset | undefined) => {
    if (!next) return
    linkBrainToController(props.node, next.id)
    commit()
  }
  /** Unlink WITHOUT changing behaviour — the copy stays, it just stops tracking the asset. */
  const unlink = () => {
    linkBrainToController(props.node, null)
    commit()
  }
  const extract = () => {
    const created = extractBrainFromController(props.node)
    commit()
    enterAiBrainEditor(created.id)
  }

  const { dragOver, dropProps } = useAssetDrop('text/cleo-ai-brain',
    id => assign(aiBrains.find(b => b.id === id)))

  /** What the linked brain actually holds, so the row says more than its name. */
  const summary = (b: AiBrainAsset) => (b.kind === 'goals'
    ? `${b.graph.goals.length} goal${b.graph.goals.length === 1 ? '' : 's'}`
    : `${b.machine.states.length} state${b.machine.states.length === 1 ? '' : 's'}`)

  // An inline brain worth offering to extract: something is authored, but no asset claims it.
  const hasInlineBrain = props.node.behavior.states.length > 0 || props.node.goals.goals.length > 0

  return (
    <div className='w-full' {...dropProps}>
      <div className={cn(sectionTitleClass, 'mt-3 mb-1')}>Brain</div>
      {asset ? (
        <div className={`flex items-center gap-2 p-2 bg-control border rounded ${dragOver ? 'border-selected' : 'border-border'}`}>
          <div className='flex-1 min-w-0'>
            <div className={cn(valueClass, 'truncate')} title={asset.name}>{asset.name}</div>
            <Hint>{asset.kind === 'goals' ? 'Goal graph' : 'Behaviour machine'} · {summary(asset)}</Hint>
          </div>
          <Button variant='ghost' size='icon' className='text-highlight' title='Edit this brain'
            onClick={() => enterAiBrainEditor(asset.id)}>✎</Button>
          <Button variant='ghost' size='icon' className='text-danger'
            title='Unlink. The agent keeps behaving exactly as it does now — only the link goes.'
            onClick={unlink}>✕</Button>
        </div>
      ) : (
        <div className={`flex flex-col gap-2 p-2 border-2 border-dashed rounded ${dragOver ? 'border-selected bg-border/30' : 'border-border'}`}>
          {linkedId && (
            <Hint className='text-warning'>
              This controller’s brain is missing from the library. It still runs the copy it holds —
              pick another below, or leave it as it is.
            </Hint>
          )}
          {aiBrains.length > 0 && (
            <Select value='' onChange={(e) => { if (e.target.value) assign(aiBrains.find(b => b.id === e.target.value)) }}>
              <option value=''>Use existing…</option>
              {aiBrains.map(b => (
                <option key={b.id} value={b.id}>{b.name} ({b.kind === 'goals' ? 'goals' : 'machine'})</option>
              ))}
            </Select>
          )}
          <div className='flex gap-2'>
            <Button variant='success' className='flex-1 py-2' onClick={() => enterAiBrainEditor(undefined, 'behavior')}
              title='Create an empty behaviour machine and open it'>+ Machine</Button>
            <Button variant='subtle' className='flex-1 py-2' onClick={() => enterAiBrainEditor(undefined, 'goals')}
              title='Create an empty goal graph and open it'>+ Goals</Button>
          </div>
          {hasInlineBrain && (
            <>
              <Button variant='subtle' className='w-full py-1.5' onClick={extract}
                title='Turn the brain already on this controller into a library asset, and link it'>
                Extract to asset
              </Button>
              <Hint>
                This controller has a brain authored on it directly. Extracting makes it reusable
                without changing what the agent does.
              </Hint>
            </>
          )}
          {!hasInlineBrain && <Hint>Empty — the Goal field above is in charge. Or drag a brain from the <b>Assets</b> tab here.</Hint>}
        </div>
      )}
    </div>
  )
}

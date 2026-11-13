import { SequenceNode } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import { SequenceAsset } from '../../../utils/sequenceAssets'
import { Select, Button, Hint, SectionTitle, cn, valueClass } from '@cleo/app-kit/ui'
import { useAssetDrop } from '../../../utils/useAssetDrop'
import { useInspectorLock } from '../inspectorLock'

/**
 * The timeline reference on a Sequence node — which `.sequence` asset it plays.
 *
 * Shaped like `ParticleSystemSlot`, and linked the same way: assigning COPIES the asset onto the node (a
 * published game ships no sequence library; the copy rides in the scene), and the id beside the copy lets a
 * saved edit be pushed back out.
 *
 * Never empty: a Sequence node always holds a timeline, a new one an empty one. The unlinked state is "a
 * timeline no asset claims", and the offer is to make it one — which is also how its timeline gets edited,
 * since the Sequencer edits assets.
 */
export default function SequenceSlot(props: { node: SequenceNode; onChange?: () => void }) {
  const {
    sequences, enterSequenceEditor, extractSequenceFromNode, linkSequenceToNode, eventEmitter,
  } = useCleoEngine()
  const lock = useInspectorLock()

  const linkedId = props.node.sequenceId
  const asset = linkedId ? sequences.find(q => q.id === linkedId) : undefined

  const commit = () => {
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
    props.onChange?.()
  }

  const assign = (next: SequenceAsset | undefined) => {
    if (!next || lock.locked) return
    linkSequenceToNode(props.node, next.id)
    commit()
  }
  /** Unlink WITHOUT changing what plays — the copy stays, it just stops tracking the asset. */
  const unlink = () => {
    linkSequenceToNode(props.node, null)
    commit()
  }
  /** Open the linked asset in its Sequencer tab, making this node's timeline an asset first if it is none. */
  const edit = () => {
    if (asset) { enterSequenceEditor(asset.id, { contextNodeId: props.node.id }); return }
    const created = extractSequenceFromNode(props.node)
    commit()
    enterSequenceEditor(created.id, { contextNodeId: props.node.id })
  }

  const { dragOver, dropProps } = useAssetDrop('text/cleo-sequence', id => assign(sequences.find(q => q.id === id)))

  const summary = (q: { duration: number; tracks: unknown[] }) =>
    `${q.duration.toFixed(1)} s, ${q.tracks.length} track${q.tracks.length === 1 ? '' : 's'}`

  return (
    <div className='w-full' {...(lock.locked ? {} : dropProps)}>
      <SectionTitle title='Timeline' className='mb-1' />
      {asset ? (
        <div className={`flex items-center gap-2 p-2 bg-control border rounded ${dragOver ? 'border-selected' : 'border-border'}`}>
          <div className='flex-1 min-w-0'>
            <div className={cn(valueClass, 'truncate')} title={asset.name}>{asset.name}</div>
            <Hint>Sequence · {summary(asset.sequence)}</Hint>
          </div>
          <Button variant='ghost' size='icon' className='text-highlight' title='Edit this sequence in Sequencer mode'
            onClick={edit}>✎</Button>
          <Button variant='remove' size='icon' disabled={lock.locked} title={lock.locked ? lock.reason
            : 'Unlink. The node keeps playing exactly what it plays now — only the link goes.'}
            onClick={unlink}>✕</Button>
        </div>
      ) : (
        <div className={`flex flex-col gap-2 p-2 border-2 border-dashed rounded ${dragOver ? 'border-selected bg-border/30' : 'border-border'}`}>
          {linkedId && (
            <Hint className='text-warning'>
              This node’s sequence is missing from the library. It still plays the copy it holds —
              pick another below, or make this one an asset again.
            </Hint>
          )}
          {sequences.length > 0 && (
            <Select value='' disabled={lock.locked} onChange={(e) => { if (e.target.value) assign(sequences.find(q => q.id === e.target.value)) }}>
              <option value=''>Use existing…</option>
              {sequences.map(q => (
                <option key={q.id} value={q.id}>{q.name}</option>
              ))}
            </Select>
          )}
          <Button variant='success' className='w-full py-1.5' disabled={lock.locked} onClick={edit}
            title={lock.locked ? lock.reason : 'Copy the timeline on this node into a new library asset, link it, and open it in Sequencer mode'}>
            Edit in Sequencer
          </Button>
          <Hint>
            Plays an embedded timeline ({summary(props.node.sequence)}). Sequences are edited as assets in Sequencer
            mode, so this makes one — or drag a sequence from the <b>Assets</b> tab here.
          </Hint>
        </div>
      )}
    </div>
  )
}

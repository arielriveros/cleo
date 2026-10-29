import { ParticleSystemNode } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import { ParticleSystemAsset } from '../../../utils/particleSystems'
import { Select, Button, Hint, SectionTitle, cn, valueClass } from '@cleo/app-kit/ui'
import { useAssetDrop } from '../../../utils/useAssetDrop'

/**
 * The effect reference control on a Particle System node — which `.vfx` asset this instance plays.
 *
 * Shaped like `AiBrainSlot`, and linked the same way: assigning COPIES the asset onto the node, so the
 * effect keeps playing where the library is not in scope (a published game ships no particle library at
 * all). The id is kept beside the copy so an edited asset can be pushed back out on save.
 *
 * ## Never empty
 *
 * Unlike a brain slot there is no "none": a particle node ALWAYS embeds an effect — a new one starts with
 * the default emitter. So the unlinked state is not "no effect", it is "an effect no asset claims", and
 * the offer is to make it one rather than to pick something to fill a hole.
 */
export default function ParticleSystemSlot(props: { node: ParticleSystemNode; onChange?: () => void }) {
  const {
    particleSystems, enterParticleSystemEditor, extractParticleSystemFromNode, linkParticleSystemToNode, eventEmitter,
  } = useCleoEngine()

  const linkedId = props.node.particleSystemId
  const asset = linkedId ? particleSystems.find(p => p.id === linkedId) : undefined

  const commit = () => {
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
    props.onChange?.()
  }

  const assign = (next: ParticleSystemAsset | undefined) => {
    if (!next) return
    linkParticleSystemToNode(props.node, next.id)
    commit()
  }
  /** Unlink WITHOUT changing what plays — the copy stays, it just stops tracking the asset. */
  const unlink = () => {
    linkParticleSystemToNode(props.node, null)
    commit()
  }
  const extract = () => {
    const created = extractParticleSystemFromNode(props.node)
    commit()
    enterParticleSystemEditor(created.id)
  }

  const { dragOver, dropProps } = useAssetDrop('text/cleo-particle-system',
    id => assign(particleSystems.find(p => p.id === id)))

  /** What the effect holds, so the row says more than its name. */
  const summary = (emitters: { enabled: boolean }[]) => {
    const on = emitters.filter(e => e.enabled).length
    const total = `${emitters.length} emitter${emitters.length === 1 ? '' : 's'}`
    return on === emitters.length ? total : `${total} (${on} enabled)`
  }

  return (
    <div className='w-full' {...dropProps}>
      <SectionTitle title='Effect' className='mb-1' />
      {asset ? (
        <div className={`flex items-center gap-2 p-2 bg-control border rounded ${dragOver ? 'border-selected' : 'border-border'}`}>
          <div className='flex-1 min-w-0'>
            <div className={cn(valueClass, 'truncate')} title={asset.name}>{asset.name}</div>
            <Hint>Particle system · {summary(asset.system.emitters)}</Hint>
          </div>
          <Button variant='ghost' size='icon' className='text-highlight' title='Edit this effect in the particle editor'
            onClick={() => enterParticleSystemEditor(asset.id)}>✎</Button>
          <Button variant='remove' size='icon'
            title='Unlink. The node keeps playing exactly what it plays now — only the link goes.'
            onClick={unlink}>✕</Button>
        </div>
      ) : (
        <div className={`flex flex-col gap-2 p-2 border-2 border-dashed rounded ${dragOver ? 'border-selected bg-border/30' : 'border-border'}`}>
          {linkedId && (
            <Hint className='text-warning'>
              This node’s effect is missing from the library. It still plays the copy it holds —
              pick another below, or make this one an asset again.
            </Hint>
          )}
          {particleSystems.length > 0 && (
            <Select value='' onChange={(e) => { if (e.target.value) assign(particleSystems.find(p => p.id === e.target.value)) }}>
              <option value=''>Use existing…</option>
              {particleSystems.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          )}
          <Button variant='success' className='w-full py-1.5' onClick={extract}
            title='Copy the effect on this node into a new library asset, link it, and open it for editing'>
            Create asset from this effect
          </Button>
          <Hint>
            Plays an embedded effect ({summary(props.node.system.emitters)}). Emitters are edited on an asset,
            so make this one an asset — or drag a particle system from the <b>Assets</b> tab here.
          </Hint>
        </div>
      )}
    </div>
  )
}

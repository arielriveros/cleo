import { useMemo, useState } from 'react'
import { buildBoneMapping, Logger } from 'cleo'
import type { BoneMapping, Node, Skin } from 'cleo'
import { mat4 } from 'gl-matrix'
import { useCleoEngine } from '../../EngineContext'
import { useAssetLibrary } from '../../AssetLibraryContext'
import { useEditorSessions } from '../../EditorSessionsContext'
import { useAssetDrop } from '../../../utils/useAssetDrop'
import { ownSkinnedModelNodeOf, skinnedModelJsonsOf } from '../../../utils/models'
import { loadSkin, storeSkin, type StoredSkin } from '../../../utils/animationAssets'
import {
  nativeRigOf, overridesFor, targetedRigs, withOverrides, withRetargetTarget, type RetargetOverride,
} from '../../../utils/rigAssets'
import { applyRetargetOverrides } from '../../../utils/animationResolve'
import { retargetView } from '../../../utils/retargetView'
import RetargetMapper from '../../rig/RetargetMapper'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Button, Hint, Select, cn, hintClass, valueClass } from '@cleo/app-kit/ui'
import { RigIcon } from '../sectionIcons'

// The skeleton a character uses, as an inspector slot — shaped like MaterialSlot and AiBrainSlot.
//
// The rig is what owns the clips, animators and blend spaces, so this is where you choose which set a
// character plays. The list is the model's OWN skeleton plus the skeletons it has been retargeted to —
// never every rig in the project, most of which would play as a tangle of mismatched bones. Another
// skeleton is added with "Retarget skeleton…": pick it, review the bone mapping, and use it.

const toMat4 = (a: number[]) => {
  const m = mat4.create()
  for (let i = 0; i < 16 && i < a.length; i++) m[i] = a[i]
  return m
}

export default function RigSlot(props: { node: Node }) {
  const { rigs, animations, updateRig } = useAssetLibrary()
  const { enterRigEditor, resolveModelAssetId, setModelRig, ensureRigForModel } = useEditorSessions()
  const { models } = useCleoEngine()
  // The retarget being set up: its source skeleton and the corrections made so far, not yet saved.
  const [retargetFrom, setRetargetFrom] = useState<string | null>(null)
  const [pending, setPending] = useState<RetargetOverride[]>([])
  const [mapperOpen, setMapperOpen] = useState(false)

  const modelNode = ownSkinnedModelNodeOf(props.node)
  const modelId = modelNode ? resolveModelAssetId(modelNode) : null
  const model = modelId ? models.find(m => m.id === modelId) : undefined

  /** This model's own skeleton, read from the asset: what every retarget maps onto. */
  const targetSkin = useMemo(() => {
    const stored = model ? storeSkin(skinnedModelJsonsOf(model.nodeJson)[0]?.skin) : null
    return stored ? loadSkin(stored as StoredSkin, toMat4) as Skin | null : null
  }, [model?.nodeJson])

  const native = model ? nativeRigOf(model, rigs) : undefined
  const choices = model ? targetedRigs(model, rigs) : []
  /** Skeletons with clips this model is not yet set up for. */
  const candidates = rigs.filter(r => !choices.includes(r) && animations.some(a => a.rigId === r.id))

  /** The mapping from the chosen skeleton onto this model's, saved corrections and pending ones replayed. */
  const preview = useMemo((): { mapping: BoneMapping; sourceSkin: Skin } | null => {
    if (!retargetFrom || !targetSkin) return null
    const source = rigs.find(r => r.id === retargetFrom)
    const sourceSkin = source ? loadSkin(source.skin as StoredSkin, toMat4) as Skin | null : null
    if (!sourceSkin) return null
    const clips = animations.filter(a => a.rigId === retargetFrom).flatMap(a => a.clips) as any[]
    if (!clips.length) return null
    const auto = buildBoneMapping(clips, sourceSkin, targetSkin)
    const saved = overridesFor(native, retargetFrom)
    const merged = [...saved.filter(o => !pending.some(p => p.sourceName === o.sourceName)), ...pending]
    const mapping = applyRetargetOverrides(auto, merged, sourceSkin, targetSkin, `slot:${model?.id}:${retargetFrom}:${pending.length}`)
    return { mapping, sourceSkin }
  }, [retargetFrom, targetSkin, rigs, animations, native, pending, model?.id])

  const status = useMemo(
    () => (preview && targetSkin ? retargetView(preview.mapping, preview.sourceSkin, targetSkin).counts : null),
    [preview, targetSkin],
  )

  const assign = (rigId: string | undefined) => {
    if (!model) return
    // Everything a rig change implies — clearing the retarget cache, re-resolving every placement, keeping
    // the model's own skeleton as `nativeRigId` — happens in setModelRig.
    setModelRig(model.id, rigId)
  }

  /** Save the reviewed retarget onto this model's own rig, and switch the model to the other skeleton. */
  const applyRetarget = () => {
    if (!model || !retargetFrom) return
    const nativeId = native?.id ?? ensureRigForModel(model.id)
    const base = rigs.find(r => r.id === nativeId) ?? (nativeId ? nativeRigOf({ rigId: nativeId }, rigs) : undefined)
    if (!nativeId || !base) { Logger.warn(`"${model.name}" has no skeleton of its own to retarget onto`, 'Editor'); return }
    updateRig(nativeId, withOverrides(withRetargetTarget(base, retargetFrom), retargetFrom, pending))
    assign(retargetFrom)
    setRetargetFrom(null); setPending([]); setMapperOpen(false)
  }

  const setPendingOverride = (sourceName: string, targetName: string | null | undefined) =>
    setPending(prev => {
      const rest = prev.filter(p => p.sourceName !== sourceName)
      return targetName === undefined ? rest : [...rest, { sourceName, targetName }]
    })
  const remap = (sourceNode: number, targetNode: number | null) => {
    const sourceName = preview?.sourceSkin.nodeNames?.get(sourceNode)
    if (!sourceName) return
    if (targetNode === null) { setPendingOverride(sourceName, null); return }
    const targetName = targetSkin?.nodeNames?.get(targetNode)
    if (!targetName) { Logger.warn('That bone has no name, so the correction cannot be saved.', 'Editor'); return }
    setPendingOverride(sourceName, targetName)
  }
  const restoreAuto = (sourceNode: number) => {
    const sourceName = preview?.sourceSkin.nodeNames?.get(sourceNode)
    if (sourceName) setPendingOverride(sourceName, undefined)
  }

  const { dragOver, dropProps } = useAssetDrop('text/cleo-rig', id => {
    // A dropped skeleton the model is not set up for starts its retarget rather than switching blindly.
    if (choices.some(r => r.id === id)) assign(id)
    else { setRetargetFrom(id); setPending([]) }
  })

  // Rendered away rather than disabled, exactly as AnimationSlot does: a rig means nothing on a node with
  // no skeleton, and a model that is not in the library has nothing to hang the link on.
  if (!modelNode || !model) return null

  const rig = model.rigId ? rigs.find(r => r.id === model.rigId) : undefined
  const sourceRig = retargetFrom ? rigs.find(r => r.id === retargetFrom) : undefined

  return (
    <Collapsable title='Skeleton' icon={<RigIcon />} persistKey='rigSlot'>
    <div className='w-full p-2 flex flex-col gap-2'>

      {rig ? (
        <div
          className={cn(
            'flex items-center gap-2 p-2 bg-control border rounded',
            dragOver ? 'border-selected' : 'border-border',
          )}
          {...dropProps}
        >
          <div className='min-w-0 flex-1'>
            <div className={cn(valueClass, 'truncate')} title={rig.name}>{rig.name}</div>
            <div className={hintClass}>
              {rig.skin.joints?.length ?? 0} bones · {rig.animationIds?.length ?? 0} clip
              {(rig.animationIds?.length ?? 0) === 1 ? '' : 's'}
              {model.nativeRigId ? ` · retargeted onto ${native?.name ?? 'its own skeleton'}` : ''}
            </div>
          </div>
          <Button
            variant='ghost' size='icon' className='text-highlight'
            title='Edit this skeleton — its clips, retargeting and IK'
            onClick={() => enterRigEditor(rig.id)}
          >✎</Button>
          <Button variant='remove' size='icon'
            title='Unlink this skeleton — the character stops playing its clips'
            onClick={() => assign(undefined)}
          >✕</Button>
        </div>
      ) : (
        <div
          className={cn(
            'flex flex-col gap-2 p-2 border-2 border-dashed rounded',
            dragOver ? 'border-selected bg-border/30' : 'border-border',
          )}
          {...dropProps}
        >
          {model.rigId && (
            <Hint className='text-warning'>
              Linked skeleton is missing from the library — link another below, or its clips will not play.
            </Hint>
          )}
          <Hint>…or drag a skeleton from the <b>Assets</b> tab here.</Hint>
        </div>
      )}

      {/* The skeletons this model can play: its own, and the ones it has been retargeted to. */}
      {choices.length > 1 || !rig ? (
        <Select value={model.rigId ?? ''} onChange={e => e.target.value && assign(e.target.value)}>
          {!rig && <option value=''>Use skeleton…</option>}
          {choices.map(r => (
            <option key={r.id} value={r.id}>{r.name}{r.id === native?.id ? ' (own)' : ''}</option>
          ))}
        </Select>
      ) : null}

      {/* Setting up another skeleton: pick it, review the mapping, use it. */}
      {retargetFrom === null ? (
        candidates.length > 0 && (
          <Button variant='subtle' className='py-1'
            title="Play another skeleton's clips, animators and blend spaces on this character"
            onClick={() => { setRetargetFrom(''); setPending([]) }}>
            Retarget skeleton…
          </Button>
        )
      ) : (
        <div className='flex flex-col gap-1 rounded border border-border p-2'>
          <Select value={retargetFrom} onChange={e => { setRetargetFrom(e.target.value); setPending([]) }}>
            <option value=''>Clips from…</option>
            {candidates.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
          {retargetFrom && !preview && <Hint>That skeleton has no clips to map.</Hint>}
          {preview && status && (
            <div className='text-ui-sm text-muted'
              title='Mapped: has a bone to drive. Merged: folded into the bone below it. Lost: animated but drives nothing.'>
              {status.mapped} mapped
              {status.merged ? ` · ${status.merged} merged` : ''}
              {status.lost ? <span className='text-danger-fg'> · {status.lost} lost</span> : ''}
              {' — '}{status.driven} of this skeleton's bones driven
            </div>
          )}
          <div className='flex items-center gap-1'>
            <Button variant='ghost' size='sm' className='flex-1 py-1' disabled={!preview}
              title='See both skeletons side by side and drag bones from one to the other'
              onClick={() => setMapperOpen(true)}>
              Map bones…
            </Button>
            <Button variant='primary' size='sm' className='flex-1 py-1' disabled={!preview}
              title="Save this mapping and switch the character to that skeleton's clips"
              onClick={applyRetarget}>
              Use skeleton
            </Button>
            <Button variant='ghost' size='sm' className='py-1'
              onClick={() => { setRetargetFrom(null); setPending([]); setMapperOpen(false) }}>
              Cancel
            </Button>
          </div>
          {mapperOpen && preview && targetSkin && (
            <RetargetMapper
              sourceLabel={sourceRig?.name ?? 'Clips'}
              targetLabel={native?.name ?? model.name}
              sourceSkin={preview.sourceSkin}
              targetSkin={targetSkin}
              mapping={preview.mapping}
              onRemap={remap}
              onAuto={restoreAuto}
              onResetAll={() => setPending([])}
              onClose={() => setMapperOpen(false)}
            />
          )}
        </div>
      )}
    </div>
    </Collapsable>
  )
}

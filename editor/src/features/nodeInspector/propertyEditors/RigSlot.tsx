import { useState } from 'react'
import { Node } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import { useAssetLibrary } from '../../AssetLibraryContext'
import { useEditorSessions } from '../../EditorSessionsContext'
import { useAssetDrop } from '../../../utils/useAssetDrop'
import { ownSkinnedModelNodeOf } from '../../../utils/models'
import { skeletonFingerprint } from '../../../utils/rigAssets'
import { Button, Hint, Select, cn, hintClass, sectionTitleClass, valueClass } from '../../../components/ui'

// The skeleton a character uses, as an inspector slot — shaped like MaterialSlot and AiBrainSlot.
//
// The rig is what owns the clips, so this is where you see which clip set a character will play, and the
// way to point it at a different one. Shows only for a skinned model, like AnimationSlot.

export default function RigSlot(props: { node: Node }) {
  const { rigs } = useAssetLibrary()
  const { enterRigEditor, resolveModelAssetId, setModelRig } = useEditorSessions()
  const { models } = useCleoEngine()
  // Raised when the incoming skeleton is a different SHAPE, and cleared by the next assignment. State, not
  // a modal: the swap itself is valid and reversible, and the corrections it may need are edited in
  // another tab — blocking here would only make the user dismiss something before they could act on it.
  const [retargetNeeded, setRetargetNeeded] = useState<string | null>(null)

  const modelNode = ownSkinnedModelNodeOf(props.node)
  const modelId = modelNode ? resolveModelAssetId(modelNode) : null
  const model = modelId ? models.find(m => m.id === modelId) : undefined

  const assign = (rigId: string | undefined) => {
    if (!model) return
    // Everything a rig change implies — clearing the retarget cache and re-resolving every placement —
    // happens in setModelRig. Doing it here with a bare updateModel is what left the old rig's bone
    // corrections in force, silently. See its doc comment.
    const before = model.rigId ? rigs.find(r => r.id === model.rigId) : undefined
    const after = rigId ? rigs.find(r => r.id === rigId) : undefined
    setModelRig(model.id, rigId)
    // Fingerprints compare the SHAPE of a skeleton — same armature, same answer — so this fires only when
    // the clips genuinely have to be remapped rather than merely re-resolved.
    setRetargetNeeded(
      before && after && skeletonFingerprint(before.skin) !== skeletonFingerprint(after.skin)
        ? after.id
        : null,
    )
  }

  const { dragOver, dropProps } = useAssetDrop('text/cleo-rig', id => assign(id))

  // Rendered away rather than disabled, exactly as AnimationSlot does: a rig means nothing on a node with
  // no skeleton, and a model that is not in the library has nothing to hang the link on.
  if (!modelNode || !model) return null

  const rig = model.rigId ? rigs.find(r => r.id === model.rigId) : undefined

  return (
    <div className='px-2'>
      <div className={cn(sectionTitleClass, 'mt-3 mb-1')}>Rig</div>

      {retargetNeeded && (
        <div className='mb-1 flex flex-col gap-1 rounded border border-warning/40 bg-warning/10 p-2'>
          <Hint className='text-warning'>
            That is a different skeleton, so the clips are being remapped automatically. Check the bone
            mapping if anything looks wrong.
          </Hint>
          <Button
            variant='subtle' className='py-1'
            onClick={() => { enterRigEditor(retargetNeeded); setRetargetNeeded(null) }}
          >
            Review retargeting
          </Button>
        </div>
      )}

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
            </div>
          </div>
          <Button
            variant='ghost' size='icon' className='text-highlight'
            title='Edit this rig — its clips, retargeting and IK'
            onClick={() => enterRigEditor(rig.id)}
          >✎</Button>
          <Button
            variant='ghost' size='icon' className='text-danger'
            title='Unlink this rig — the character stops playing its clips'
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
              Linked rig is missing from the library — link another below, or its clips will not play.
            </Hint>
          )}
          {rigs.length > 0 ? (
            <Select value='' onChange={e => e.target.value && assign(e.target.value)}>
              <option value=''>Link existing…</option>
              {rigs.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          ) : (
            <Hint>No rigs in this project yet — importing a skinned model creates one.</Hint>
          )}
          <Hint>…or drag a rig from the <b>Assets</b> tab here.</Hint>
        </div>
      )}
    </div>
  )
}

import { useMemo, useState } from 'react'
import { buildBoneMapping, Logger } from 'cleo'
import type { BoneMapping, Skin } from 'cleo'
import { mat4 } from 'gl-matrix'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useEditorSessions } from '../EditorSessionsContext'
import { useRig } from './RigContext'
import AnimationAssetPicker from '../animation/AnimationAssetPicker'
import RetargetMapper from './RetargetMapper'
import SocketsPanel from './SocketsPanel'
import RagdollPanel from './RagdollPanel'
import BoneMasksPanel from './BoneMasksPanel'
import PoseAssetsPanel from './PoseAssetsPanel'
import { loadSkin, type StoredSkin } from '../../utils/animationAssets'
import { overridesFor } from '../../utils/rigAssets'
import { applyRetargetOverrides } from '../../utils/animationResolve'
import { retargetView } from '../../utils/retargetView'
import { Button, Hint, Select, TextInput, cn, hintClass, sectionTitleClass, valueClass } from '../../components/ui'

// The rig editor's Properties panel: the clips this skeleton owns, the retarget corrections onto it, and
// which character it is previewed through.

const toMat4 = (a: number[]) => {
  const m = mat4.create()
  for (let i = 0; i < 16 && i < a.length; i++) m[i] = a[i]
  return m
}

export default function RigInspector() {
  // Every hook above any early return — a rig tab can be active before its working copy has been adopted.
  const { activeTab, setRigPreviewModel, modelsOnRig } = useCleoEngine()
  const { rigs, animations, animationFields } = useAssetLibrary()
  const { enterModelEditor, enterAnimationFieldEditor, createAnimationFieldForModel } = useEditorSessions()
  const { asset, patch, setOverride, clearOverrides } = useRig()
  const [sourceRigId, setSourceRigId] = useState<string>('')
  const [mapperOpen, setMapperOpen] = useState(false)

  const models = asset ? modelsOnRig(asset.id) : []
  const runtimeModelId = models[0]?.id

  /** The clips linked to this rig, grouped by the asset that holds them. */
  const linked = useMemo(
    () => (asset?.animationIds ?? []).map(id => animations.find(a => a.id === id)).filter(Boolean),
    [asset?.animationIds, animations],
  )

  /** This skeleton, read from the asset itself: mapping onto it needs no preview character. */
  const targetSkin = useMemo(() => (asset ? loadSkin(asset.skin as StoredSkin, toMat4) as Skin | null : null), [asset?.skin])

  /**
   * The mapping from `sourceRigId`'s skeleton onto this one, with the saved corrections replayed: the same
   * path the runtime retarget takes (`resolveAnimationAsset`), so what the mapper shows is what plays.
   *
   * Rebuilt from the two skeletons rather than stored: the automatic tiers keep improving, and only the
   * human's decisions are persisted. `clips` is the source rig's clip set, because `buildBoneMapping`
   * derives its rows from the bones the clips actually animate.
   */
  const preview = useMemo((): { mapping: BoneMapping; sourceSkin: Skin } | null => {
    if (!asset || !sourceRigId || !targetSkin) return null
    const sourceRig = rigs.find(r => r.id === sourceRigId)
    if (!sourceRig) return null
    const sourceSkin = loadSkin(sourceRig.skin as StoredSkin, toMat4) as Skin | null
    if (!sourceSkin) return null
    // Every clip authored on the source rig: that is the set whose bones need mapping.
    const clips = animations.filter(a => a.rigId === sourceRigId).flatMap(a => a.clips) as any[]
    if (!clips.length) return null
    const auto = buildBoneMapping(clips, sourceSkin, targetSkin)
    const mapping = applyRetargetOverrides(auto, overridesFor(asset, sourceRigId), sourceSkin, targetSkin, `mapper:${asset.id}:${sourceRigId}`)
    return { mapping, sourceSkin }
  }, [asset, sourceRigId, targetSkin, rigs, animations])

  const status = useMemo(() => (preview && targetSkin ? retargetView(preview.mapping, preview.sourceSkin, targetSkin).counts : null), [preview, targetSkin])

  if (!asset) return <div className={cn(hintClass, 'p-3')}>No skeleton open.</div>

  /** The blend spaces authored on this skeleton. Keyed by rig, so every character on it shares them. */
  const fields = animationFields.filter(f => f.rigId === asset.id)

  /** Other rigs whose clips could be retargeted onto this one. */
  const sourceRigs = rigs.filter(r => r.id !== asset.id && animations.some(a => a.rigId === r.id))
  const remap = (sourceNode: number, targetNode: number | null) => {
    if (!preview || !targetSkin) return
    const sourceName = preview.sourceSkin.nodeNames?.get(sourceNode)
    // Stored by NAME, so the correction survives a bone-name backfill or a re-export that renumbers nodes.
    if (!sourceName) return

    if (targetNode === null) { setOverride(sourceRigId, sourceName, null); return } // deliberate drop
    const targetName = targetSkin.nodeNames?.get(targetNode)
    // A joint with no NAME cannot be stored — and must not fall through to `null`, which means "drop this
    // bone's curve", the opposite of what was picked. Nameless skeletons cannot be corrected by name at
    // all; import the source file's bone names first.
    if (!targetName) {
      Logger.warn('That bone has no name, so the correction cannot be saved. Import skeleton names first.', 'Editor')
      return
    }
    setOverride(sourceRigId, sourceName, targetName)
  }

  /** Forget the saved correction for one bone: it goes back to whatever the automatic tiers match. */
  const restoreAuto = (sourceNode: number) => {
    const sourceName = preview?.sourceSkin.nodeNames?.get(sourceNode)
    if (sourceName) setOverride(sourceRigId, sourceName, undefined)
  }

  return (
    <div className='flex flex-col gap-3 p-2'>
      <div>
        <div className={cn(valueClass, 'truncate')} title={asset.name}>{asset.name}</div>
        <div className={hintClass}>{asset.skin.joints?.length ?? 0} bones</div>
      </div>

      {/* ---- Preview character ------------------------------------------------------------------ */}
      <div>
        <div className={cn(sectionTitleClass, 'mb-1')}>Preview</div>
        {models.length > 0 ? (
          <Select
            value={runtimeModelId ?? ''}
            onChange={e => e.target.value && setRigPreviewModel(activeTab.id, e.target.value)}
          >
            {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        ) : (
          <Hint>
            No model uses this rig yet, so only its skeleton is shown. Link one from a model's Rig slot.
          </Hint>
        )}
        {models.length > 0 && (
          <Hint className='mt-1'>
            {models.length === 1
              ? 'One character is built on this skeleton.'
              : `${models.length} characters are built on this skeleton — they all play its clips.`}
          </Hint>
        )}
      </div>

      {/* ---- Clips ------------------------------------------------------------------------------ */}
      <div>
        <div className={cn(sectionTitleClass, 'mb-1')}>Clips</div>
        <Hint className='mb-1'>Linked here, so every character on this skeleton plays them.</Hint>
        <AnimationAssetPicker rigId={asset.id} />
        {linked.length === 0 && <Hint className='mt-1'>No clips yet — link or drag one in.</Hint>}
      </div>

      {/* ---- Blend spaces ----------------------------------------------------------------------- */}
      {/* Moved here from the model node's inspector. A field is keyed by `rigId`, blends clips the RIG
          owns by name, and is shared by every character on the armature — so the model was only ever a
          way of reaching it. Creating one still goes through a model (`createAnimationFieldForModel`
          mints the rig if there is none), which is why this needs a preview character. */}
      <div>
        <div className={cn(sectionTitleClass, 'mb-1')}>Blend Spaces</div>
        {fields.length === 0 && (
          <Hint className='mb-1'>None yet — a blend space mixes this skeleton’s clips by speed, direction or any parameter.</Hint>
        )}
        <div className='flex flex-col gap-1'>
          {fields.map(f => (
            <Button
              key={f.id} variant='subtle' className='w-full py-1.5'
              onClick={() => enterAnimationFieldEditor(f.id)}
              title={`Open the “${f.name}” blend space`}
            >⊞ {f.name}</Button>
          ))}
          {runtimeModelId ? (
            <Button
              variant='subtle' className='w-full py-1.5'
              onClick={() => createAnimationFieldForModel(runtimeModelId)}
              title='Create a blend space that mixes this skeleton’s clips by 1D or 2D parameters'
            >+ New Blend Space</Button>
          ) : (
            <Hint>A character on this skeleton is needed to author one against.</Hint>
          )}
        </div>
      </div>

      {/* ---- Sockets ---------------------------------------------------------------------------- */}
      <SocketsPanel />

      <RagdollPanel />

      {/* ---- Bone masks ------------------------------------------------------------------------- */}
      <BoneMasksPanel />

      {/* ---- Poses ------------------------------------------------------------------------------ */}
      {/* Pose ASSETS on this skeleton (plus any legacy poses stored on the rig itself). Authored in the
          clip editor, where a character is posed bone by bone; managed here. */}
      <PoseAssetsPanel />

      {/* ---- Retargeting ------------------------------------------------------------------------ */}
      <div>
        <div className={cn(sectionTitleClass, 'mb-1')}>Retargeting</div>
        {sourceRigs.length === 0 ? (
          <Hint>
            Nothing to retarget: no other skeleton in this project has clips. Corrections are per source skeleton.
          </Hint>
        ) : (
          <>
            <Hint className='mb-1'>
              Fix a bone once and every clip from that skeleton retargets correctly onto this one, permanently.
            </Hint>
            <Select value={sourceRigId} onChange={e => setSourceRigId(e.target.value)}>
              <option value=''>Clips from…</option>
              {sourceRigs.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>

            {sourceRigId && !preview && (
              <Hint className='mt-1'>That skeleton has no clips to map.</Hint>
            )}
            {preview && status && (
              <>
                <div className='mt-1 text-ui-sm text-muted'
                  title='Mapped: has a bone to drive. Merged: folded into the bone below it. Lost: animated but drives nothing. Sharing: takes part of the bend below it. At rest: nothing drives it.'>
                  {status.mapped} mapped
                  {status.merged ? ` · ${status.merged} merged` : ''}
                  {status.lost ? <span className='text-danger-fg'> · {status.lost} lost</span> : ''}
                  {status.dropped ? ` · ${status.dropped} off` : ''}
                  {' — '}{status.driven} driven
                  {status.shared ? ` · ${status.shared} sharing` : ''}
                  {` · ${status.rest} at rest`}
                </div>
                <div className='flex items-center gap-1 mt-1'>
                  <Button variant='primary' className='flex-1 py-1.5' onClick={() => setMapperOpen(true)}
                    title='See both skeletons side by side and drag bones from one to the other'>
                    Map bones…
                  </Button>
                  <Button variant='ghost' size='sm' className='text-ui-sm'
                    title='Discard the saved corrections for this source skeleton'
                    onClick={() => clearOverrides(sourceRigId)}>
                    Reset
                  </Button>
                </div>
                {mapperOpen && targetSkin && (
                  <RetargetMapper
                    sourceLabel={rigs.find(r => r.id === sourceRigId)?.name ?? 'Clips'}
                    targetLabel={asset.name}
                    sourceSkin={preview.sourceSkin}
                    targetSkin={targetSkin}
                    mapping={preview.mapping}
                    onRemap={remap}
                    onAuto={restoreAuto}
                    onResetAll={() => clearOverrides(sourceRigId)}
                    onClose={() => setMapperOpen(false)}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Foot IK is NOT duplicated here. `IkRigPanel` already sits under the bone tree in the Skeleton
          panel, where it belongs: assigning a bone to a role starts with a click in that tree, so the two
          have to be visible at once. The rig tab shows that panel the same way the animation tab does. */}

      {models.length > 0 && runtimeModelId && (
        <Button variant='subtle' className='w-full py-1.5' onClick={() => enterModelEditor(runtimeModelId)}>
          Open “{models[0].name}”
        </Button>
      )}
    </div>
  )
}

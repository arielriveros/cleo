import { useMemo, useState } from 'react'
import { buildBoneMapping, applyManualMapping, Logger } from 'cleo'
import type { BoneMapping, Skin } from 'cleo'
import { mat4 } from 'gl-matrix'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useEditorSessions } from '../EditorSessionsContext'
import { useRig } from './RigContext'
import { getAnimationTarget } from '../animation/skeleton'
import AnimationAssetPicker from '../animation/AnimationAssetPicker'
import BoneMappingTable, { mappingCounts } from '../animation/BoneMappingTable'
import { loadSkin, type StoredSkin } from '../../utils/animationAssets'
import { nodeByName, overridesFor } from '../../utils/rigAssets'
import { Button, Hint, Select, cn, hintClass, sectionTitleClass, valueClass } from '../../components/ui'
import type { RetargetBoneOption } from '../engineContextTypes'

// The rig editor's Properties panel: the clips this skeleton owns, the retarget corrections onto it, and
// which character it is previewed through.

const toMat4 = (a: number[]) => {
  const m = mat4.create()
  for (let i = 0; i < 16 && i < a.length; i++) m[i] = a[i]
  return m
}

export default function RigInspector() {
  // Every hook above any early return — a rig tab can be active before its working copy has been adopted.
  const { editorScene, skeletonTargetId, activeTab, setRigPreviewModel, modelsOnRig } = useCleoEngine()
  const { rigs, animations } = useAssetLibrary()
  const { enterModelEditor } = useEditorSessions()
  const { asset, setOverride, clearOverrides } = useRig()
  const [sourceRigId, setSourceRigId] = useState<string>('')

  const target = getAnimationTarget(editorScene, skeletonTargetId)
  const models = asset ? modelsOnRig(asset.id) : []
  const runtimeModelId = models[0]?.id

  /** The clips linked to this rig, grouped by the asset that holds them. */
  const linked = useMemo(
    () => (asset?.animationIds ?? []).map(id => animations.find(a => a.id === id)).filter(Boolean),
    [asset?.animationIds, animations],
  )

  /**
   * The mapping from `sourceRigId`'s skeleton onto this one, with the saved corrections replayed.
   *
   * Rebuilt from the two skeletons rather than stored: the automatic tiers keep improving, and only the
   * human's decisions are persisted. `clips` is the source rig's clip set, because `buildBoneMapping`
   * derives its rows from the bones the clips actually animate.
   */
  const preview = useMemo((): { mapping: BoneMapping; targetBones: RetargetBoneOption[] } | null => {
    if (!asset || !sourceRigId || !target) return null
    const sourceRig = rigs.find(r => r.id === sourceRigId)
    if (!sourceRig) return null

    const sourceSkin = loadSkin(sourceRig.skin as StoredSkin, toMat4) as Skin | null
    if (!sourceSkin) return null

    // Every clip authored on the source rig — that is the set whose bones need mapping.
    const clips = animations.filter(a => a.rigId === sourceRigId).flatMap(a => a.clips) as any[]
    if (!clips.length) return null

    let mapping = buildBoneMapping(clips, sourceSkin, target.skin)
    const nodes = nodeByName(target.skin.nodeNames)
    const sourceNodes = nodeByName(sourceSkin.nodeNames)
    for (const o of overridesFor(asset, sourceRigId)) {
      const sn = sourceNodes.get(o.sourceName)
      if (sn === undefined) continue
      mapping = applyManualMapping(mapping, sn, o.targetName === null ? null : nodes.get(o.targetName) ?? null)
    }

    const nameOf = (n: number) => target.skin.nodeNames?.get(n) ?? `node ${n}`
    return {
      mapping,
      targetBones: target.skin.joints.map(j => ({ node: j.nodeIndex, name: nameOf(j.nodeIndex) })),
    }
  }, [asset, sourceRigId, target, rigs, animations])

  if (!asset) return <div className={cn(hintClass, 'p-3')}>No rig open.</div>

  /** Other rigs whose clips could be retargeted onto this one. */
  const sourceRigs = rigs.filter(r => r.id !== asset.id && animations.some(a => a.rigId === r.id))
  const counts = preview ? mappingCounts(preview.mapping) : null

  const remap = (sourceNode: number, targetNode: number | null) => {
    if (!preview || !target) return
    const sourceRig = rigs.find(r => r.id === sourceRigId)
    const sourceSkin = sourceRig ? loadSkin(sourceRig.skin as StoredSkin, toMat4) as Skin | null : null
    const sourceName = sourceSkin?.nodeNames?.get(sourceNode)
    // Stored by NAME, so the correction survives a bone-name backfill or a re-export that renumbers nodes.
    if (!sourceName) return

    if (targetNode === null) { setOverride(sourceRigId, sourceName, null); return } // deliberate drop
    const targetName = target.skin.nodeNames?.get(targetNode)
    // A joint with no NAME cannot be stored — and must not fall through to `null`, which means "drop this
    // bone's curve", the opposite of what was picked. Nameless skeletons cannot be corrected by name at
    // all; import the source file's bone names first.
    if (!targetName) {
      Logger.warn('That bone has no name, so the correction cannot be saved. Import skeleton names first.', 'Editor')
      return
    }
    setOverride(sourceRigId, sourceName, targetName)
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
              ? 'One character is built on this rig.'
              : `${models.length} characters are built on this rig — they all play its clips.`}
          </Hint>
        )}
      </div>

      {/* ---- Clips ------------------------------------------------------------------------------ */}
      <div>
        <div className={cn(sectionTitleClass, 'mb-1')}>Clips</div>
        <Hint className='mb-1'>Linked here, so every character on this rig plays them.</Hint>
        <AnimationAssetPicker rigId={asset.id} />
        {linked.length === 0 && <Hint className='mt-1'>No clips yet — link or drag one in.</Hint>}
      </div>

      {/* ---- Retargeting ------------------------------------------------------------------------ */}
      <div>
        <div className={cn(sectionTitleClass, 'mb-1')}>Retargeting</div>
        {sourceRigs.length === 0 ? (
          <Hint>
            Nothing to retarget: no other rig in this project has clips. Corrections are per source rig.
          </Hint>
        ) : (
          <>
            <Hint className='mb-1'>
              Fix a bone once and every clip from that rig retargets correctly onto this one, permanently.
            </Hint>
            <Select value={sourceRigId} onChange={e => setSourceRigId(e.target.value)}>
              <option value=''>Clips from…</option>
              {sourceRigs.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>

            {sourceRigId && !target && (
              <Hint className='mt-1 text-warning'>
                A preview character is needed to map bones onto — this rig has no model yet.
              </Hint>
            )}
            {sourceRigId && target && !preview && (
              <Hint className='mt-1'>That rig has no clips to map.</Hint>
            )}
            {preview && counts && (
              <>
                <div className='flex items-center justify-between mt-1'>
                  <span className='text-[11px] text-gray-300'>
                    {counts.mapped}/{counts.total} mapped
                    {counts.manual ? ` · ${counts.manual} manual` : ''}
                    {counts.unmapped ? ` · ${counts.unmapped} unmapped` : ''}
                  </span>
                  <Button
                    variant='ghost'
                    className='text-[11px]'
                    title='Discard the saved corrections for this source rig'
                    onClick={() => clearOverrides(sourceRigId)}
                  >
                    Reset
                  </Button>
                </div>
                <div className='border border-control rounded mt-1 max-h-[260px] overflow-y-auto'>
                  <BoneMappingTable
                    mapping={preview.mapping}
                    targetBones={preview.targetBones}
                    onRemap={remap}
                  />
                </div>
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

import { useEffect, useMemo, useState } from 'react'
import { skeletonTopology } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useRig } from './RigContext'
import { getAnimationTarget } from '../animation/skeleton'
import { Button, Hint, OptionalNumberInput, SectionTitle, Select, TextInput, Toggle, cn } from '@cleo/app-kit/ui'
import { buildBoneMaskAsset, presetMask, withBranch, type BoneTree } from '../../utils/boneMasks'

// The rig's BONE MASKS: which bones a controller layer or an action slot is allowed to move.
//
// Masks are their own assets (pickable by name from any controller), but they are a subset of THIS
// skeleton, so they are listed and edited here, against its bone tree. Edits go straight to the library:
// a mask is not part of the rig's working copy, and a controller re-embeds it on its next Apply.
//
// Ticking a bone takes its whole branch with it — "Spine" is the upper body — which is what a person
// means nine times in ten. Alt-click toggles the one bone alone.

const PRESETS = [
  { key: 'upperBody', label: 'Upper body' },
  { key: 'lowerBody', label: 'Lower body' },
  { key: 'leftArm', label: 'Left arm' },
  { key: 'rightArm', label: 'Right arm' },
  { key: 'head', label: 'Head' },
] as const

export default function BoneMasksPanel() {
  const { editorScene, skeletonTargetId, eventEmitter } = useCleoEngine()
  const { boneMasks, addBoneMask, updateBoneMask, removeBoneMask } = useAssetLibrary()
  const { asset } = useRig()
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    const onFocus = (e: { kind: string; id: string }) => { if (e?.kind === 'boneMask') setSelected(e.id) }
    eventEmitter.on('FOCUS_RIG_ASSET', onFocus)
    return () => { eventEmitter.off('FOCUS_RIG_ASSET', onFocus) }
  }, [eventEmitter])

  const target = getAnimationTarget(editorScene, skeletonTargetId)

  // The skeleton as names + parents, in tree order with depths for indenting.
  const { tree, rows } = useMemo(() => {
    const out: BoneTree = []
    const rowsOut: { name: string; depth: number }[] = []
    if (!target) return { tree: out, rows: rowsOut }
    const skin = target.skin
    const topo = skeletonTopology(skin)
    const nameOf = (j: number) => skin.nodeNames?.get(skin.joints[j].nodeIndex) ?? null
    // Depth-first, so a bone's branch is listed under it — `topo.order` is parent-before-child but
    // breadth-first, which would interleave the legs into the spine.
    const children = new Map<number, number[]>()
    const roots: number[] = []
    skin.joints.forEach((_, j) => {
      const parent = topo.parentJoint[j]
      if (parent >= 0) { const list = children.get(parent); if (list) list.push(j); else children.set(parent, [j]) }
      else roots.push(j)
    })
    const visit = (j: number, depth: number) => {
      const name = nameOf(j)
      const parent = topo.parentJoint[j]
      if (name) {
        out.push({ name, parent: parent >= 0 ? nameOf(parent) : null })
        rowsOut.push({ name, depth })
      }
      for (const c of children.get(j) ?? []) visit(c, depth + 1)
    }
    for (const r of roots) visit(r, 0)
    return { tree: out, rows: rowsOut }
  }, [target])

  if (!asset) return null
  const masks = boneMasks.filter(m => m.rigId === asset.id)
  const mask = masks.find(m => m.id === selected) ?? null

  const create = (preset: string) => {
    const label = PRESETS.find(p => p.key === preset)?.label ?? 'Mask'
    const weights = preset === 'empty' ? {} : presetMask(tree, preset as any) ?? {}
    const created = buildBoneMaskAsset(`${asset.name} ${label}`, asset.id, weights)
    addBoneMask(created)
    setSelected(created.id)
  }

  const toggle = (bone: string, branch: boolean) => {
    if (!mask) return
    const on = (mask.weights[bone] ?? 0) > 0
    const weights = branch
      ? withBranch(mask.weights, tree, bone, on ? 0 : 1)
      : (() => { const w = { ...mask.weights }; if (on) delete w[bone]; else w[bone] = 1; return w })()
    updateBoneMask(mask.id, { ...mask, weights })
  }
  const setWeight = (bone: string, w: number) => {
    if (!mask) return
    updateBoneMask(mask.id, { ...mask, weights: { ...mask.weights, [bone]: Math.max(0, Math.min(1, w)) } })
  }

  return (
    <div>
      <SectionTitle title='Bone Masks' className='mb-1' />

      <div className='flex flex-col gap-1'>
        {masks.map(m => (
          <div key={m.id} className={cn('flex items-center gap-1 rounded border p-1', m.id === selected ? 'border-highlight' : 'border-control')}>
            <button className='text-ui-sm px-1 text-muted hover:text-fg' onClick={() => setSelected(m.id === selected ? null : m.id)}
              title='Edit which bones this mask includes'>{m.id === selected ? '▾' : '▸'}</button>
            <TextInput className='flex-1' value={m.name} onChange={v => updateBoneMask(m.id, { ...m, name: v })} />
            <span className='text-ui-xs text-muted shrink-0'>{Object.keys(m.weights).length} bones</span>
            <Button variant='remove' size='sm' className='px-1 py-0 shrink-0' title='Delete this mask. Layers using it stop affecting anything.'
              onClick={() => { removeBoneMask(m.id); if (selected === m.id) setSelected(null) }}>✕</Button>
          </div>
        ))}
      </div>

      <Select className='mt-1' value='' disabled={!rows.length}
        onChange={e => { if (e.target.value) create(e.target.value) }}
        title={rows.length ? 'Create a mask, starting from a preset found by bone names' : 'This skeleton has no bone names'}>
        <option value=''>+ New mask…</option>
        {PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        <option value='empty'>Empty</option>
      </Select>

      {mask && (
        <div className='mt-1 border border-control rounded max-h-[320px] overflow-y-auto p-1'>
          <Hint className='mb-1'>Click a bone to include its whole branch; Alt-click for that bone alone.</Hint>
          {rows.map(({ name, depth }) => {
            const w = mask.weights[name] ?? 0
            return (
              <div key={name} className='flex items-center gap-1 text-ui-sm' style={{ paddingLeft: depth * 10 }}>
                {/* The click's altKey picks one bone vs the whole branch. */}
                <Toggle checked={w > 0} onChange={(_, e) => toggle(name, !e.altKey)} />
                <span className={cn('flex-1 truncate', w > 0 ? 'text-fg' : 'text-muted')} title={name}>{name.split(':').pop()}</span>
                {w > 0 && (
                  <OptionalNumberInput className='w-[44px] px-1 py-0'
                    value={w} title='How strongly this bone follows the layer'
                    onChange={v => { if (v !== undefined) setWeight(name, v) }} />
                )}
              </div>
            )
          })}
          <div className='flex gap-1 mt-1'>
            <Button variant='ghost' size='sm' className='text-ui-sm' onClick={() => updateBoneMask(mask.id, { ...mask, weights: {} })}>Clear</Button>
            <Button variant='ghost' size='sm' className='text-ui-sm'
              onClick={() => updateBoneMask(mask.id, { ...mask, weights: Object.fromEntries(rows.map(r => [r.name, 1])) })}>All</Button>
          </div>
        </div>
      )}
    </div>
  )
}

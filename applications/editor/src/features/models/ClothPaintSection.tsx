import { useEffect, useMemo, useRef, useState } from 'react'
import { vec3 } from 'gl-matrix'
import { clothFillRange, DEFAULT_CLOTH_SETTINGS } from 'cleo'
import type { SkinnedClothSettings as ClothSettings, ModelNode, SkinnedClothData } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useHistory } from '../HistoryContext'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Button, Field, Hint, SegmentedControl, Select, Slider, Toggle } from '@cleo/app-kit/ui'
import { getMaterialIdsOf } from '../../utils/materials'
import {
  announceClothEdit, clothHistoryEntry, clothTarget, commitCloth, setClothBrush, skinnedMeshesOf, storedCloth,
  subscribeClothPaint, useClothBrush, workingCopy, type ClothTool,
} from './clothBrushStore'

/** The simulation settings shown, in order, with their slider ranges. */
const SETTINGS: { key: keyof ClothSettings; label: string; min: number; max: number; step: number }[] = [
  { key: 'maxDistance', label: 'Max Distance', min: 0, max: 1, step: 0.01 },
  { key: 'stiffness', label: 'Stiffness', min: 0, max: 1, step: 0.01 },
  { key: 'bend', label: 'Bend', min: 0, max: 1, step: 0.01 },
  { key: 'damping', label: 'Damping', min: 0, max: 1, step: 0.01 },
  { key: 'mass', label: 'Mass', min: 0.1, max: 10, step: 0.1 },
  { key: 'gravityScale', label: 'Gravity Scale', min: 0, max: 3, step: 0.05 },
  { key: 'windResponse', label: 'Wind Response', min: 0, max: 2, step: 0.05 },
  { key: 'thickness', label: 'Thickness', min: 0, max: 0.05, step: 0.001 },
  { key: 'backstop', label: 'Backstop', min: 0, max: 0.1, step: 0.001 },
]

/** A settings drag is one undo step once it rests this long. */
const SETTINGS_IDLE_MS = 500
/** Preview sway: how far, and how fast, the model is swung so the cloth moves. */
const SWAY_METRES = 0.3
const SWAY_DEGREES = 20
const SWAY_HZ = 0.35

// The model tab's Cloth section: paint which vertices of a skinned mesh are cloth and how freely they move
// (AnimatedModel.skinnedCloth), set how the cloth behaves, and preview it swinging. The brush itself is
// ClothBrush in the viewport, the heat map ClothWeightOverlay; all three share clothBrushStore.
export default function ClothPaintSection() {
  const { modelSession, editorScene, eventEmitter, materials, withoutDirty } = useCleoEngine()
  const { push } = useHistory()
  const brush = useClothBrush()
  const [version, setVersion] = useState(0)
  useEffect(() => subscribeClothPaint(() => setVersion(v => v + 1)), [])
  useEffect(() => {
    const bump = () => setVersion(v => v + 1)
    eventEmitter.on('SCENE_CHANGED', bump)
    return () => { eventEmitter.off('SCENE_CHANGED', bump) }
  }, [eventEmitter])

  const rootId = modelSession?.levelIds[0]
  const root = rootId ? editorScene?.getNodeById(rootId) : null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const meshes = useMemo(() => skinnedMeshesOf(root), [root, version])
  const target = useMemo(() => clothTarget(root), [root, meshes, brush.targetId])
  const copy = target ? workingCopy(target) : null

  // Leaving the tab (or the model) turns painting and preview off: they belong to the open model.
  useEffect(() => () => setClothBrush({ painting: false, preview: false }), [rootId])

  // --- settings, one undo step per drag ------------------------------------------------------------
  const pending = useRef<{ nodeId: string; before: SkinnedClothData | null; timer: number } | null>(null)
  const flushSettings = () => {
    const p = pending.current
    if (!p) return
    window.clearTimeout(p.timer)
    pending.current = null
    const node = editorScene?.getNodeById(p.nodeId) as ModelNode | null
    if (!node || !editorScene) return
    push(clothHistoryEntry(editorScene, eventEmitter, p.nodeId, 'Cloth settings', p.before, storedCloth(node)))
    announceClothEdit(eventEmitter, p.nodeId)
  }
  useEffect(() => () => flushSettings())
  const setSetting = (key: keyof ClothSettings, value: number) => {
    if (!target || !copy) return
    if (!pending.current || pending.current.nodeId !== target.id) {
      flushSettings()
      pending.current = { nodeId: target.id, before: storedCloth(target), timer: 0 }
    }
    window.clearTimeout(pending.current.timer)
    pending.current.timer = window.setTimeout(flushSettings, SETTINGS_IDLE_MS)
    copy.settings = { ...copy.settings, [key]: value }
    commitCloth(copy)
  }

  /** A one-shot weight edit (fill, clear) as its own undo step. */
  const edit = (label: string, change: (weights: Float32Array) => void) => {
    if (!target || !copy || !editorScene) return
    flushSettings()
    const before = storedCloth(target)
    change(copy.weights)
    const after = commitCloth(copy)
    push(clothHistoryEntry(editorScene, eventEmitter, target.id, label, before, after))
    announceClothEdit(eventEmitter, target.id)
  }

  // --- preview ---------------------------------------------------------------------------------------
  useEffect(() => {
    if (!brush.preview || !target || !root) return
    const basePosition = vec3.clone(root.position)
    const baseRotation = vec3.clone(root.rotation)
    let raf = 0
    let last = performance.now()
    const start = last
    const tick = () => {
      const now = performance.now()
      const dt = Math.min(1 / 30, (now - last) / 1000)
      last = now
      const phase = Math.sin(((now - start) / 1000) * SWAY_HZ * Math.PI * 2)
      withoutDirty(() => {
        root.setPosition([basePosition[0] + phase * SWAY_METRES, basePosition[1], basePosition[2]])
        root.setRotation([baseRotation[0], baseRotation[1] + phase * SWAY_DEGREES, baseRotation[2]])
      })
      target.stepSkinnedCloth(dt, true)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      withoutDirty(() => { root.setPosition(basePosition); root.setRotation(baseRotation) })
      // Not playing: the cloth goes back on the skin, the bind range restored.
      target.stepSkinnedCloth(0, false)
    }
  }, [brush.preview, target, root, withoutDirty])

  if (!modelSession?.skinned || !target || !copy) return null

  let painted = 0
  for (let v = 0; v < copy.weights.length; v++) if (copy.weights[v] > 0.001) painted++
  const settings = { ...DEFAULT_CLOTH_SETTINGS, ...copy.settings }
  const ranges = target.model.submeshes
  const materialIds = getMaterialIdsOf(target)
  const materialName = (i: number) => (materialIds[i] && materials.find(m => m.id === materialIds[i])?.name) || `Sub-mesh ${i + 1}`
  const geometry = target.model.geometry

  return (
    <Collapsable title='Cloth' badge={painted || undefined}>
      <div className='p-2 space-y-1'>
        {meshes.length > 1 && (
          <Field label='Mesh'>
            <Select value={target.id} onChange={e => setClothBrush({ targetId: e.target.value })}>
              {meshes.map(m => <option key={m.id} value={m.id}>{m.name || 'Mesh'}</option>)}
            </Select>
          </Field>
        )}
        <div className='flex items-center gap-4 my-1'>
          <Toggle label='Paint' checked={brush.painting} onChange={on => setClothBrush({ painting: on, ...(on ? { preview: false } : {}) })} />
          <Toggle label='Preview' checked={brush.preview} onChange={on => setClothBrush({ preview: on, ...(on ? { painting: false } : {}) })} />
        </div>
        <Hint>{painted ? `${painted.toLocaleString()} of ${geometry.vertexCount.toLocaleString()} vertices are cloth.` : 'Nothing is cloth yet: paint where the mesh should move.'}</Hint>

        <SegmentedControl<ClothTool>
          className='grid grid-cols-4 gap-1 my-1' grow
          options={[
            { value: 'paint', label: 'Paint', doc: 'editor/models-and-materials#cloth::Paint tools' },
            { value: 'erase', label: 'Erase', doc: 'editor/models-and-materials#cloth::Paint tools' },
            { value: 'smooth', label: 'Smooth', doc: 'editor/models-and-materials#cloth::Paint tools' },
            { value: 'fill', label: 'Fill', doc: 'editor/models-and-materials#cloth::Paint tools' },
          ]}
          value={brush.tool}
          onChange={tool => setClothBrush({ tool })} />
        <Slider label='Value' min={0} max={1} step={0.01} value={brush.value} onChange={value => setClothBrush({ value })} />
        <Slider label='Radius' min={0.005} max={0.5} step={0.005} value={brush.radius}
          readout={v => `${(v * 100).toFixed(1)} cm`} onChange={radius => setClothBrush({ radius })} />
        <Slider label='Strength' min={0.05} max={1} step={0.01} value={brush.strength} onChange={strength => setClothBrush({ strength })} />
        <Slider label='Falloff' min={0} max={1} step={0.01} value={brush.falloff} onChange={falloff => setClothBrush({ falloff })} />

        <Field label='Fill material'>
          <Select value='' onChange={e => {
            const i = Number(e.target.value)
            const range = ranges[i] ?? { start: 0, count: geometry.indices.length }
            edit('Fill cloth', w => clothFillRange(geometry.indices, copy.twins, w, range.start, range.count, brush.value))
          }}>
            <option value='' disabled>Choose…</option>
            {(ranges.length ? ranges : [{ start: 0, count: geometry.indices.length }]).map((_, i) =>
              <option key={i} value={i}>{ranges.length ? materialName(i) : 'Whole mesh'}</option>)}
          </Select>
        </Field>
        <Button variant='subtle' className='w-full' disabled={!painted} onClick={() => edit('Clear cloth', w => w.fill(0))}>
          Clear
        </Button>

        <div className='pt-2 mt-1 border-t border-border'>
          {SETTINGS.map(s => (
            <Slider key={s.key} label={s.label} min={s.min} max={s.max} step={s.step}
              value={Number(settings[s.key] ?? 0)}
              readout={v => s.step < 0.01 ? v.toFixed(3) : s.step < 0.1 ? v.toFixed(2) : v.toFixed(1)}
              onChange={v => setSetting(s.key, v)} />
          ))}
        </div>
      </div>
    </Collapsable>
  )
}

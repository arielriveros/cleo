import { useEffect, useRef, useState } from 'react'
import type { FoliageCollision, TerrainFoliageRule } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { Button, Hint, Modal, ModalFooter, ModalHeader, NumberInput, Slider, Toggle, cn, labelClass } from '@cleo/app-kit/ui'
import { createColliderPreview, type ColliderPreview } from '../../utils/colliderPreview'
import { describeCollider, fitColliderToBounds, fitColliderToTrunk } from '../../utils/foliageColliderFit'
import { foliageRuleModels } from '../../utils/foliageRules'

type Shape = FoliageCollision['shape']

/** Starting values for a shape picked with nothing to fit to. */
const DEFAULTS: Record<Shape, FoliageCollision> = {
  cylinder: { shape: 'cylinder', radius: 0.4, height: 2 },
  box: { shape: 'box', width: 0.5, depth: 0.5, height: 2 },
  sphere: { shape: 'sphere', radius: 0.5 },
}

/**
 * The collider editor of one foliage prop: the prototype with its collider drawn over it, orbitable, and
 * every dimension of the collider — with fits to the trunk or the whole plant. Edits a DRAFT; Apply
 * hands it back. Box width/depth are shown as FULL sizes (stored as half-widths, see FoliageCollision).
 */
export default function FoliageColliderModal({ rule, onApply, onClose }: {
  rule: TerrainFoliageRule
  onApply: (collision: FoliageCollision | null) => void
  onClose: () => void
}) {
  const { instance } = useCleoEngine()
  const [draft, setDraft] = useState<FoliageCollision>(() => ({ ...(rule.collision ?? DEFAULTS.cylinder) }))
  const [yaw, setYaw] = useState(35)
  const [pitch, setPitch] = useState(12)
  const [zoom, setZoom] = useState(1)
  const minScale = rule.minScale ?? 0.8, maxScale = rule.maxScale ?? 1.4
  const [previewScale, setPreviewScale] = useState(1)
  const [image, setImage] = useState('')
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The prototype's geometry: the rule's baked models, rebuilt from its model asset if a save stripped them.
  const [models] = useState<any[]>(() => foliageRuleModels(rule))

  const preview = useRef<ColliderPreview | null>(null)
  useEffect(() => {
    if (!instance || !models.length) { setError('This prop has no geometry to preview.'); return }
    let alive = true
    createColliderPreview(instance, models).then(p => {
      if (!alive) { p.dispose(); return }
      preview.current = p
      requestRender()
    }).catch(e => setError(`${e}`))
    return () => { alive = false; preview.current?.dispose(); preview.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, models])

  // One capture in flight; the latest request wins. Smaller while dragging, full size at rest.
  const busy = useRef(false)
  const pending = useRef(false)
  const latest = useRef({ draft, yaw, pitch, zoom, previewScale, dragging })
  latest.current = { draft, yaw, pitch, zoom, previewScale, dragging }
  const requestRender = () => {
    const p = preview.current
    if (!p) return
    if (busy.current) { pending.current = true; return }
    busy.current = true
    const s = latest.current
    p.setCollider(s.draft, s.previewScale)
    p.render(s.dragging ? 256 : 512, s.yaw, s.pitch, s.zoom)
      .then(url => { if (url) setImage(url) })
      .finally(() => {
        busy.current = false
        if (pending.current) { pending.current = false; requestRender() }
      })
  }
  useEffect(requestRender, [draft, yaw, pitch, zoom, previewScale, dragging])

  const drag = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y
    drag.current = { x: e.clientX, y: e.clientY }
    setYaw(v => v - dx * 0.5)
    setPitch(v => Math.max(-80, Math.min(80, v + dy * 0.4)))
  }
  const onPointerUp = () => { drag.current = null; setDragging(false) }
  const onWheel = (e: React.WheelEvent) => setZoom(v => Math.max(0.2, Math.min(3, v * (e.deltaY > 0 ? 1.1 : 1 / 1.1))))

  const patch = (p: Partial<FoliageCollision>) => setDraft(d => ({ ...d, ...p }))
  const setShape = (shape: Shape) => setDraft(d => {
    if (d.shape === shape) return d
    return fitColliderToTrunk(models, shape) ?? DEFAULTS[shape]
  })
  const fit = (how: 'trunk' | 'bounds') => {
    const f = (how === 'trunk' ? fitColliderToTrunk : fitColliderToBounds)(models, draft.shape)
    if (f) setDraft(f)
  }

  const r = draft.radius ?? 0.5, h = draft.height ?? 2
  const autoCentre = draft.offsetY === undefined
  const centre = draft.offsetY ?? (draft.shape === 'sphere' ? r : h / 2)
  // Slider ranges sized to the prop: a 20 m pine and a 30 cm shrub both get usable travel.
  const span = Math.max(0.5, (preview.current?.radius ?? 2) * 2.2)
  const label = labelClass
  const row = 'flex items-center justify-between gap-2'

  return (
    <Modal onClose={onClose} className='w-[860px]'>
      <ModalHeader title={`Collider — ${rule.name}`} doc='Collider editor' aside={describeCollider(draft)} />
      <div className='flex gap-4 px-4 py-3'>
        <div className='flex flex-col gap-2'>
          <div
            className='w-[420px] h-[420px] rounded border border-control bg-surface overflow-hidden cursor-grab active:cursor-grabbing touch-none'
            title='Drag to orbit, wheel to zoom'
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel}>
            {error
              ? <div className='w-full h-full flex items-center justify-center text-muted text-ui p-4 text-center'>{error}</div>
              : image ? <img src={image} className='w-full h-full object-contain pointer-events-none' alt='' draggable={false} />
                : <div className='w-full h-full flex items-center justify-center text-muted text-ui'>Rendering…</div>}
          </div>
          {minScale !== maxScale && (
            <Slider label='Preview scale' labelClassName='w-28' min={minScale} max={maxScale} step={0.01}
              value={previewScale} onChange={setPreviewScale}
              title='Instances are scattered between the rule’s min and max scale; the collider scales with them.' />
          )}
        </div>

        <div className='flex-1 min-w-0 space-y-3'>
          <div className='flex gap-1'>
            {(['cylinder', 'box', 'sphere'] as Shape[]).map(s => (
              <Button key={s} size='sm' variant={draft.shape === s ? 'primary' : 'ghost'} className='flex-1 capitalize'
                onClick={() => setShape(s)}>{s}</Button>
            ))}
          </div>

          {draft.shape !== 'box' && (
            <Slider label='Radius' labelClassName='w-24' min={0.01} max={span} step={0.01} value={r}
              onChange={v => patch({ radius: v })} />
          )}
          {draft.shape === 'box' && <>
            <Slider label='Width' labelClassName='w-24' min={0.02} max={span * 2} step={0.01}
              value={(draft.width ?? r) * 2} onChange={v => patch({ width: v / 2 })} />
            <Slider label='Depth' labelClassName='w-24' min={0.02} max={span * 2} step={0.01}
              value={(draft.depth ?? r) * 2} onChange={v => patch({ depth: v / 2 })} />
          </>}
          {draft.shape !== 'sphere' && (
            <Slider label='Height' labelClassName='w-24' min={0.02} max={span * 2} step={0.01} value={h}
              onChange={v => patch({ height: v })} />
          )}

          <div className={row}>
            <span className={label} title='Where the shape’s centre sits above the instance’s base. Auto: half the height (a sphere: its radius), so it stands on the ground.'>Centre height</span>
            <span className='flex items-center gap-2'>
              <span className='text-ui-sm text-muted'>Auto</span>
              <Toggle checked={autoCentre} onChange={c => patch({ offsetY: c ? undefined : centre })} />
            </span>
          </div>
          <div className={cn(autoCentre && 'opacity-50 pointer-events-none')}>
            <div className={row}>
              <Slider className='flex-1' min={-span} max={span * 2} step={0.01} value={centre}
                onChange={v => patch({ offsetY: v })} />
              <NumberInput className='w-20' step={0.05} value={Math.round(centre * 100) / 100}
                onChange={v => patch({ offsetY: v })} />
            </div>
          </div>

          <div className='flex gap-1'>
            <Button size='sm' className='flex-1' onClick={() => fit('trunk')}
              title='Fit to the trunk: the radius of the bottom of the plant, spanning its lower part — what a character should bump into.'>Fit to trunk</Button>
            <Button size='sm' className='flex-1' onClick={() => fit('bounds')}
              title='Fit around the whole plant, canopy included.'>Fit to bounds</Button>
            <Button size='sm' variant='ghost' onClick={() => setDraft({ ...(rule.collision ?? DEFAULTS.cylinder) })}
              title='Back to the collider as it was when this opened'>Reset</Button>
          </div>

          <Hint>
            In prototype units; each instance scales it by its own random scale. In Play, instances near the
            player get a body (within 40 m by default). Turn on “Foliage colliders” in the viewport’s eye menu
            to see them on the landscape.
          </Hint>
        </div>
      </div>
      <ModalFooter className='justify-between'>
        <Button variant='remove' size='sm' onClick={() => { onApply(null); onClose() }}
          title='This prop gets no collider: characters walk through it.'>Remove collider</Button>
        <span className='flex gap-2'>
          <Button variant='ghost' onClick={onClose}>Cancel</Button>
          <Button variant='primary' onClick={() => { onApply(draft); onClose() }}>Apply</Button>
        </span>
      </ModalFooter>
    </Modal>
  )
}

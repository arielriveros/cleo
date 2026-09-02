import { useRef } from 'react'
import { virtualLayoutRect } from 'cleo'
import type { VirtualControl } from 'cleo'
import { Button, NumberInput, Select, Slider, TextInput, hintClass, labelClass } from '../../components/ui'

/**
 * Placement for the on-screen stick and buttons: drag them around a preview of the viewport.
 *
 * The preview is drawn with the ENGINE's own `virtualLayoutRect`, not with a second implementation
 * here. That is the whole point of that function being pure and shared — if the editor computed a
 * circle's position and the runtime computed it again, a stick would be drawn where it cannot be
 * pressed, and only on some aspect ratios.
 *
 * The preview is 16:9 because that is where the radius rule is visible: `radius` is in units of
 * viewport HEIGHT on both axes, which is what keeps a stick round on an ultrawide instead of stretching
 * it into an ellipse.
 */

const PREVIEW_W = 320
const PREVIEW_H = 180

interface Props {
  controls: readonly VirtualControl[]
  selectedId: string | null
  onSelect(id: string | null): void
  onChange(control: VirtualControl): void
  onAdd(kind: 'stick' | 'button'): void
  onRemove(id: string): void
}

export default function VirtualControlsEditor(props: Props) {
  const { controls, selectedId } = props
  const surface = useRef<HTMLDivElement>(null)
  const selected = controls.find(c => c.id === selectedId) ?? null

  /** Drag to place. Pointer capture, so the drag survives the cursor leaving the small preview. */
  const startDrag = (control: VirtualControl) => (event: React.PointerEvent) => {
    event.preventDefault()
    props.onSelect(control.id)
    const box = surface.current?.getBoundingClientRect()
    if (!box) return
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)

    const move = (e: PointerEvent) => {
      props.onChange({
        ...control,
        x: clamp01((e.clientX - box.left) / box.width),
        y: clamp01((e.clientY - box.top) / box.height),
      })
    }
    const up = () => {
      target.releasePointerCapture(event.pointerId)
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  return (
    <div className='flex flex-col gap-2'>
      <div
        ref={surface}
        className='relative rounded border border-border bg-black/40 mx-auto'
        style={{ width: PREVIEW_W, height: PREVIEW_H }}
        onPointerDown={e => { if (e.target === surface.current) props.onSelect(null) }}
      >
        {controls.map(control => {
          const layout = virtualLayoutRect(control, PREVIEW_W, PREVIEW_H)
          const active = control.id === selectedId
          return (
            <div
              key={control.id}
              onPointerDown={startDrag(control)}
              title={`${control.id} — drag to place`}
              className={`absolute rounded-full cursor-move flex items-center justify-center text-[9px] select-none
                ${active ? 'border-2 border-selected bg-selected/25 text-white' : 'border border-border bg-white/10 text-muted'}`}
              style={{
                left: layout.cx - layout.radius,
                top: layout.cy - layout.radius,
                width: layout.radius * 2,
                height: layout.radius * 2,
              }}
            >
              {control.kind === 'button' ? (control.label ?? control.id) : ''}
            </div>
          )
        })}
      </div>
      <p className={hintClass}>
        16:9 preview. Radius is measured in viewport HEIGHT on both axes, so a stick stays round at any
        aspect ratio.
      </p>

      <div className='flex gap-1'>
        <Button size='sm' onClick={() => props.onAdd('stick')}>Add stick</Button>
        <Button size='sm' onClick={() => props.onAdd('button')}>Add button</Button>
        {selected && (
          <Button size='sm' variant='ghost' className='ml-auto' onClick={() => props.onRemove(selected.id)}>
            Remove {selected.id}
          </Button>
        )}
      </div>

      {selected && (
        <div className='rounded border border-border bg-control/30 p-1.5 flex flex-col gap-1.5'>
          <div className='flex items-center gap-2'>
            <label className={labelClass}>id</label>
            {/* The id is what a `{device:'virtual'}` binding names, so renaming one here would silently
                unbind every action using it. Changing it is a delete-and-recreate, not an edit. */}
            <TextInput className='flex-1' value={selected.id} onChange={() => {}} disabled
              title='Bindings reference this id. Remove and re-add to change it.' />
            <Select className='w-[90px]' value={selected.kind} disabled onChange={() => {}}>
              <option value={selected.kind}>{selected.kind}</option>
            </Select>
          </div>

          <Slider label='Radius' min={0.02} max={0.4} step={0.005} value={selected.radius}
            onChange={radius => props.onChange({ ...selected, radius })} />

          {selected.kind === 'stick' && (
            <Slider label='Deadzone' min={0} max={0.9} step={0.01} value={selected.deadzone ?? 0}
              onChange={deadzone => props.onChange({ ...selected, deadzone })} />
          )}

          {selected.kind === 'button' && (
            <div className='flex items-center gap-2'>
              <label className={labelClass}>label</label>
              <TextInput className='flex-1' value={selected.label ?? ''}
                onChange={label => props.onChange({ ...selected, label })} />
            </div>
          )}

          <div className='flex items-center gap-2'>
            <label className={labelClass}>x</label>
            <NumberInput className='w-16' step={0.01} value={selected.x}
              onChange={x => props.onChange({ ...selected, x: clamp01(x) })} />
            <label className={labelClass}>y</label>
            <NumberInput className='w-16' step={0.01} value={selected.y}
              onChange={y => props.onChange({ ...selected, y: clamp01(y) })} />
          </div>
        </div>
      )}
    </div>
  )
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

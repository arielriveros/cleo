import { useEffect, useRef, useState } from 'react'
import { InputSystem, layoutVirtualControls } from 'cleo'
import type { VirtualControl, VirtualLayout } from 'cleo'

/**
 * The on-screen stick and buttons, drawn as DOM over the WebGL canvas.
 *
 * Shared verbatim between the editor viewport and the published player, so — like {@link UILayer} — it
 * takes everything as props and reads no React context: the player bundle has no `EngineContext`, and
 * `vite.player.config.ts` forbids anything editor-only from being reachable from its entry.
 *
 * It DRAWS ONLY. Touches are read by the engine's own pointer listeners on the canvas and resolved by
 * `stepVirtualControls`, which is why every element here is `pointer-events: none`: a DOM element that
 * swallowed the touch would take it away from the very system it is a picture of. The two agree about
 * where a control is because they call the same `layoutVirtualControls`.
 *
 * Hidden on a device with no touch screen. Drawing a thumbstick over a desktop game would be noise, and
 * the controls are still perfectly bindable from a keyboard through their normal bindings.
 */

export interface VirtualControlsLayerProps {
  controls: readonly VirtualControl[]
  /** Force them visible regardless of the device — the editor's Input mode uses this to preview. */
  alwaysShow?: boolean
}

/** Whether this device actually has a touch screen. Re-checked on nothing: it does not change. */
function hasTouch(): boolean {
  if (typeof window === 'undefined') return false
  return ('ontouchstart' in window) || (navigator.maxTouchPoints ?? 0) > 0
}

export default function VirtualControlsLayer({ controls, alwaysShow }: VirtualControlsLayerProps) {
  const host = useRef<HTMLDivElement>(null)
  const [layouts, setLayouts] = useState<VirtualLayout[]>([])
  const [pressed, setPressed] = useState<ReadonlyMap<string, Deflection>>(new Map())
  const visible = alwaysShow || hasTouch()

  // Lay the controls out for the CURRENT box, and tell the engine the same box, so a hit test and this
  // drawing cannot disagree. Re-run on resize, which on a phone means every rotation.
  useEffect(() => {
    if (!visible) return
    const element = host.current
    if (!element) return
    const measure = () => {
      const box = element.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0) return
      InputSystem.instance.layoutVirtualControls(box.width, box.height)
      setLayouts(layoutVirtualControls(controls, box.width, box.height))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [controls, visible])

  // The visual state, polled on rAF and read straight off the engine. It is what actually received the
  // touch; a second tracker built on our own pointer events would disagree with it the moment a thumb
  // slid outside the circle it had captured — which is exactly when a player is watching the stick.
  useEffect(() => {
    if (!visible) return
    let frame = 0
    const tick = () => {
      const next = new Map<string, Deflection>()
      for (const control of controls) {
        const reading = InputSystem.instance.virtualReading(control.id)
        if (reading?.pressed) next.set(control.id, { x: reading.vector[0], y: reading.vector[1] })
      }
      setPressed(next)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [controls, visible])

  return (
    <div
      ref={host}
      className='absolute inset-0 pointer-events-none select-none'
      style={{ display: visible ? undefined : 'none' }}
      aria-hidden
    >
      {layouts.map(layout => (
        <div
          key={layout.id}
          className='absolute rounded-full border-2 flex items-center justify-center text-xs font-semibold'
          style={{
            left: layout.cx - layout.radius,
            top: layout.cy - layout.radius,
            width: layout.radius * 2,
            height: layout.radius * 2,
            borderColor: 'rgba(255,255,255,0.55)',
            background: pressed.has(layout.id) ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(2px)',
          }}
        >
          {layout.kind === 'button'
            ? (layout.label ?? '')
            : <Knob radius={layout.radius} deflection={pressed.get(layout.id) ?? ZERO} />}
        </div>
      ))}
    </div>
  )
}

/** How far a stick is pushed, -1..1 per axis, Y UP — the engine's own convention. */
interface Deflection { x: number; y: number }

const ZERO: Deflection = { x: 0, y: 0 }

/**
 * The stick's inner knob, offset by the engine's reading rather than by the raw touch position. Y is
 * negated on the way out because the engine reports Y-up and CSS `translate` is Y-down.
 */
function Knob({ radius, deflection }: { radius: number; deflection: Deflection }) {
  const size = radius * 0.75
  const travel = radius - size / 2
  return (
    <span
      className='rounded-full'
      style={{
        width: size,
        height: size,
        background: 'rgba(255,255,255,0.35)',
        transform: `translate(${deflection.x * travel}px, ${-deflection.y * travel}px)`,
      }}
    />
  )
}

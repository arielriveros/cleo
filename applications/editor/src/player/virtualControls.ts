import { InputSystem, layoutVirtualControls } from 'cleo';
import type { VirtualControl } from 'cleo';

// The published player's on-screen stick and buttons, as plain DOM (no React: a game without Game UI ships none).
// The editor's preview of the same controls is features/gameUi/VirtualControlsLayer.tsx; both lay the controls out
// with `layoutVirtualControls`, as the engine's hit test does.
//
// It DRAWS ONLY. Touches are read by the engine's own pointer listeners on the canvas, which is why every element
// here takes no pointer events. Hidden on a device without a touch screen.

/** Whether this device has a touch screen. */
function hasTouch(): boolean {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints ?? 0) > 0;
}

interface ControlView {
  readonly id: string;
  readonly element: HTMLDivElement;
  readonly knob: HTMLSpanElement | null;
  /** How far the knob travels from the centre, px. */
  readonly travel: number;
}

const IDLE = 'rgba(255,255,255,0.12)';
const PRESSED = 'rgba(255,255,255,0.28)';

/** Draw `controls` over `root` (#ui-root) on a touch screen; returns what removes them. */
export function mountVirtualControls(root: HTMLElement, controls: readonly VirtualControl[]): () => void {
  if (controls.length === 0 || !hasTouch()) return () => {};
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'absolute', inset: '0', pointerEvents: 'none', userSelect: 'none' });
  host.setAttribute('aria-hidden', 'true');
  root.appendChild(host);

  let views: ControlView[] = [];
  // Lay the controls out for the current box and tell the engine the same box, so a hit test and the drawing cannot
  // disagree. Again on resize, which on a phone means every rotation.
  const measure = () => {
    const box = host.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    InputSystem.instance.layoutVirtualControls(box.width, box.height);
    host.replaceChildren();
    views = [];
    for (const layout of layoutVirtualControls(controls, box.width, box.height)) {
      const element = document.createElement('div');
      Object.assign(element.style, {
        position: 'absolute', boxSizing: 'border-box', borderRadius: '50%',
        left: `${layout.cx - layout.radius}px`, top: `${layout.cy - layout.radius}px`,
        width: `${layout.radius * 2}px`, height: `${layout.radius * 2}px`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '2px solid rgba(255,255,255,0.55)', background: IDLE, backdropFilter: 'blur(2px)',
        color: 'rgba(255,255,255,0.85)', font: '600 12px system-ui, sans-serif',
      });
      let knob: HTMLSpanElement | null = null;
      let travel = 0;
      if (layout.kind === 'button') {
        element.textContent = layout.label ?? '';
      } else {
        const size = layout.radius * 0.75;
        travel = layout.radius - size / 2;
        knob = document.createElement('span');
        Object.assign(knob.style, {
          width: `${size}px`, height: `${size}px`, borderRadius: '50%', background: 'rgba(255,255,255,0.35)',
        });
        element.appendChild(knob);
      }
      host.appendChild(element);
      views.push({ id: layout.id, element, knob, travel });
    }
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(host);

  // The state shown is the engine's own reading: what actually received the touch. Y is up in the engine and down
  // in CSS, hence the negation.
  let frame = 0;
  const tick = () => {
    for (const view of views) {
      const reading = InputSystem.instance.virtualReading(view.id);
      const pressed = !!reading?.pressed;
      view.element.style.background = pressed ? PRESSED : IDLE;
      if (view.knob) {
        const x = pressed ? reading!.vector[0] : 0, y = pressed ? reading!.vector[1] : 0;
        view.knob.style.transform = `translate(${x * view.travel}px, ${-y * view.travel}px)`;
      }
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(frame); observer.disconnect(); host.remove(); };
}

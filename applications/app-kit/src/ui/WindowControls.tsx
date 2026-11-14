import { useEffect, useRef, useState, type PointerEvent, type MouseEvent, type ReactNode } from 'react';
import { cn } from './cn';
import { getWindowBridge, type WindowBridge, type WindowState } from '../platform/desktopWindow';

/** What in the title bar is a control: a press on one is a click. A press anywhere else drags the window. */
export const TITLEBAR_CONTROL = "button, a, input, select, textarea, [role='button'], [role='menuitem']";

const onControl = (target: EventTarget | null) => target instanceof Element && !!target.closest(TITLEBAR_CONTROL);

/**
 * The handlers that make a title bar move its window: press anywhere but a control and drag, double-click to
 * maximize or restore. The main process does the moving (app-kit/desktop/windowControls.js): CSS
 * `app-region: drag` is ignored on the editor's cross-origin-isolated page. Pointer capture keeps the release
 * coming here even when the cursor has left the window, and every way a press can end ends the drag.
 */
export function useTitleBarDrag(bridge: WindowBridge | undefined) {
  const dragging = useRef(false);
  if (!bridge) return {};
  const end = () => {
    if (!dragging.current) return;
    dragging.current = false;
    void bridge.dragEnd();
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || onControl(e.target)) return;
      e.preventDefault();               // no text selection, no focus change
      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = true;
      void bridge.dragStart();
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onDoubleClick: (e: MouseEvent<HTMLElement>) => {
      if (!onControl(e.target)) void bridge.toggleMaximize();
    },
  };
}

// The title bar's buttons at the right end of the menu bar, in the desktop app's frameless windows
// (Topbar draws them only when the shell offers a window bridge). Windows' own shape: 46 px wide, the bar's
// full height, thin crisp glyphs, and a red Close.

const Glyph = ({ children }: { children: ReactNode }) => (
  <svg viewBox='0 0 10 10' width='10' height='10' fill='none' stroke='currentColor' strokeWidth='1'
       shapeRendering='crispEdges' aria-hidden>
    {children}
  </svg>
);

const MinimizeGlyph = () => <Glyph><path d='M0 5.5h10' /></Glyph>;
const MaximizeGlyph = () => <Glyph><rect x='0.5' y='0.5' width='9' height='9' /></Glyph>;
// Two windows, the front one lower-left: the window goes back to its size from before.
const RestoreGlyph = () => <Glyph><rect x='0.5' y='2.5' width='7' height='7' /><path d='M2.5 2.5v-2h7v7h-2' /></Glyph>;
const CloseGlyph = () => (
  <svg viewBox='0 0 10 10' width='10' height='10' fill='none' stroke='currentColor' strokeWidth='1' aria-hidden>
    <path d='M0.5 0.5l9 9M9.5 0.5l-9 9' />
  </svg>
);

const BUTTON = 'flex h-full w-[46px] items-center justify-center text-fg transition-colors';

export function WindowControls({ bridge }: { bridge: WindowBridge }) {
  const [state, setState] = useState<WindowState>({ maximized: false, fullscreen: false });
  useEffect(() => {
    let live = true;
    void bridge.getState().then(s => { if (live) setState(s); });
    const off = bridge.onState(setState);
    return () => { live = false; off(); };
  }, [bridge]);

  const restores = state.maximized || state.fullscreen;
  return (
    <div className='flex h-full shrink-0'>
      <button type='button' title='Minimize' className={cn(BUTTON, 'hover:bg-control-hover')}
              onClick={() => { void bridge.minimize(); }}>
        <MinimizeGlyph />
      </button>
      <button type='button' title={restores ? 'Restore Down' : 'Maximize'} className={cn(BUTTON, 'hover:bg-control-hover')}
              onClick={() => { void bridge.toggleMaximize(); }}>
        {restores ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button type='button' title='Close' className={cn(BUTTON, 'hover:bg-danger')}
              onClick={() => { void bridge.close(); }}>
        <CloseGlyph />
      </button>
    </div>
  );
}

/**
 * A bare title bar for a screen that covers the whole window, menu bar and all (the loading screen): it
 * drags the window and has the window's buttons, and nothing else. Without it a frameless window could not
 * be moved, minimized or closed while a project loads. Renders nothing outside the desktop app.
 */
export function BareTitleBar() {
  const bridge = getWindowBridge();
  const drag = useTitleBarDrag(bridge);
  if (!bridge) return null;
  return (
    <div className='cleo-titlebar absolute inset-x-0 top-0 z-10 flex h-[30px] select-none justify-end' {...drag}>
      <WindowControls bridge={bridge} />
    </div>
  );
}

export default WindowControls;

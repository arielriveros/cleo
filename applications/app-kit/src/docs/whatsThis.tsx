import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { isInspecting, resolveElementDoc, setInspecting, subscribeInspecting, type ResolvedDoc } from './docTargets';
import { openDocs } from './viewer/docsViewerStore';

// Help > What's This?: the pointer becomes a help cursor, whatever it hovers is outlined with the docs
// entry it would open, and one click opens that entry in the docs viewer. The click is the mode's alone:
// every pointer, mouse and click event is swallowed in the capture phase on window, before the viewport,
// a gizmo, a menu or a button can act on it. Esc or a right-click leaves without opening anything.

/** Enter What's This? mode. */
export function startWhatsThis(): void {
  setInspecting(true);
}

export function stopWhatsThis(): void {
  setInspecting(false);
}

/** The docs window: clicks inside it are reading, not inspecting, so they leave the mode and go through. */
export const DOCS_WINDOW_ATTR = 'data-cleo-docs-window';

const SWALLOWED = ['pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'dragstart'] as const;

interface Hover { doc: ResolvedDoc; rect: DOMRect; x: number; y: number }

/** The mode's listeners and its outline + label. Mounted once, by DocsViewerHost. */
export function WhatsThisOverlay({ home }: { home: string }) {
  const active = useSyncExternalStore(subscribeInspecting, isInspecting);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    if (!active) { setHover(null); return; }
    const root = document.documentElement;
    root.classList.add('cleo-whats-this');

    let raf = 0;
    let point: { x: number; y: number } | null = null;
    // Set once the click that picks a target went down: the rest of that press (up, click) is still the
    // mode's, so it is swallowed until the click arrives -- or a moment after the release, if none does.
    let picked = false;
    let finishTimer: number | undefined;

    const inDocsWindow = (t: EventTarget | null) => t instanceof Element && !!t.closest(`[${DOCS_WINDOW_ATTR}]`);
    const at = (x: number, y: number) => document.elementFromPoint(x, y);

    const finish = () => {
      window.clearTimeout(finishTimer);
      setInspecting(false);
    };

    const update = () => {
      raf = 0;
      if (!point || picked) return;
      const el = at(point.x, point.y);
      if (!el || inDocsWindow(el)) { setHover(null); return; }
      const doc = resolveElementDoc(el, home);
      setHover({ doc, rect: doc.box.getBoundingClientRect(), x: point.x, y: point.y });
    };

    const onMove = (e: PointerEvent) => {
      point = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(update);
    };

    const onDown = (e: PointerEvent) => {
      if (picked) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (inDocsWindow(e.target)) { finish(); return; }
      e.preventDefault();
      e.stopImmediatePropagation();
      picked = true;
      if (e.button !== 0) { finishOnRelease(); return; }
      const el = at(e.clientX, e.clientY) ?? (e.target instanceof Element ? e.target : null);
      if (el) openDocs(resolveElementDoc(el, home).target);
      setHover(null);
      finishOnRelease();
    };

    const finishOnRelease = () => {
      // A safety net for presses that never produce a click (a drag out of the window).
      window.clearTimeout(finishTimer);
      finishTimer = window.setTimeout(finish, 600);
    };

    const swallow = (e: Event) => {
      if (!picked && inDocsWindow(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (picked && (e.type === 'click' || e.type === 'contextmenu' || e.type === 'auxclick')) {
        // Let the click die first, then leave: removing the listeners inside its own dispatch is fine,
        // but a later listener of the same event must still be stopped.
        window.setTimeout(finish, 0);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      finish();
    };

    const onBlur = () => finish();

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    for (const type of SWALLOWED) window.addEventListener(type, swallow, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      root.classList.remove('cleo-whats-this');
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(finishTimer);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerdown', onDown, true);
      for (const type of SWALLOWED) window.removeEventListener(type, swallow, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [active, home]);

  if (!active || !hover) return null;
  const { doc, rect, x, y } = hover;
  // The label sits below-right of the pointer, flipped to stay on screen.
  const chipLeft = Math.min(x + 16, window.innerWidth - 300);
  const chipTop = y + 20 + 48 > window.innerHeight ? y - 56 : y + 20;
  return createPortal(
    <div className='fixed inset-0 z-[1200] pointer-events-none' aria-hidden>
      <div
        className={doc.exact ? 'absolute rounded border-2 border-highlight bg-highlight/10' : 'absolute rounded border-2 border-dashed border-highlight/70 bg-highlight/5'}
        style={{ left: rect.left - 2, top: rect.top - 2, width: rect.width + 4, height: rect.height + 4 }}
      />
      <div
        className='absolute max-w-[290px] rounded-md border border-border bg-surface-raised shadow-lg px-2.5 py-1.5 text-ui-sm leading-snug'
        style={{ left: Math.max(4, chipLeft), top: Math.max(4, chipTop) }}
      >
        <div className='font-semibold text-fg truncate'>{doc.label}</div>
        {doc.crumb !== doc.label && <div className='text-ui-xs text-dim truncate'>{doc.crumb}</div>}
      </div>
    </div>,
    document.body,
  );
}

import { useEffect, type RefObject } from 'react';
import type { CleoEngine } from 'cleo';

/**
 * Host an engine's canvas inside `ref`'s element and keep it sized to it.
 *
 * The canvas is sized from this element's clientWidth/Height (renderer.resize measures the parent), and
 * under dockview nothing else reacts to panel geometry -- sash drags, docking, floating and per-mode
 * panel changes all land on the observer. rAF-throttled because resize() reallocates the FBOs.
 */
export function useEngineViewport(ref: RefObject<HTMLElement | null>, instance: CleoEngine | null): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !instance) return;
    el.style.height = '100%';
    el.style.backgroundColor = 'black';
    instance.setViewport(el);
    instance.renderer.resize();
  }, [instance, ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !instance) return;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => instance.renderer.resize());
    });
    observer.observe(el);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, [instance, ref]);
}

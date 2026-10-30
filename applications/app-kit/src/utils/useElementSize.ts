import { useEffect, useState } from 'react'

export type ElementSize = { width: number; height: number }

/**
 * Measure a DOM element with a ResizeObserver.
 * Returns a *ref callback*, not a ref object: the element is held in state, so a consumer needing the
 * node itself (react-arborist wants pixel `width`/`height` and a container element) gets it on the pass
 * right after mount.
 */
export function useElementSize<T extends HTMLElement = HTMLDivElement>() {
  const [element, setElement] = useState<T | null>(null)
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 })

  useEffect(() => {
    if (!element) return
    const measure = () => setSize(prev => {
      const width = element.clientWidth, height = element.clientHeight
      return prev.width === width && prev.height === height ? prev : { width, height }
    })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return { ref: setElement, element, size }
}

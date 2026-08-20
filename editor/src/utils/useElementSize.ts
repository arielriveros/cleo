import { useEffect, useState } from 'react'

export type ElementSize = { width: number; height: number }

/**
 * Measure a DOM element with a ResizeObserver.
 *
 * Returns a *ref callback* rather than a ref object on purpose: the element is held in state, so a
 * consumer can render children that need the node itself (react-arborist wants explicit pixel
 * `width`/`height`, and its scoped drag-and-drop backend wants the container element) on the pass
 * right after it mounts.
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

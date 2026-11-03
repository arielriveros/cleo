import { useEffect } from 'react'

/**
 * Keeps a react-arborist tree from taking the keyboard away from wherever the user is typing.
 *
 * Arborist moves DOM focus itself: every row runs `if (node.isFocused) row.focus()`, and `isFocused` is
 * "the tree's focus slice says so" — which any `focus` dispatch sets, whether or not the tree has DOM
 * focus. The dispatch that bites is the one `reset()` and `submit()` schedule on a timer to "return focus"
 * after a rename: abandon an inline rename by clicking into another field (the inspector, the code
 * editor, a search box) and a tick later the row takes focus back from it. Typing then lands on the row —
 * the letters are lost, W / E / R switch the gizmo, and arborist's type-to-find selects whatever node
 * starts with them.
 *
 * So a row that gains focus from OUTSIDE the tree with no gesture inside it is handed back: the event is
 * stopped before arborist's own onFocus can re-mark the tree focused, the tree is told it is blurred (so
 * the row does not retry), and focus returns to the element it was taken from. Only the row element
 * itself is policed — a rename field opening inside a row is always the user asking.
 *
 * `element` is the tree's measured container (the one `useScopedDndManager` scopes to).
 */
export function useTreeFocusGuard(element: HTMLElement | null, treeRef: { readonly current: { onBlur(): void } | null | undefined }) {
  useEffect(() => {
    if (!element) return
    let gestureAt = -Infinity
    // A press anywhere else ends the tree's claim: clicking out of a rename is exactly the case above.
    const onPointerDown = (e: PointerEvent) => {
      gestureAt = element.contains(e.target as globalThis.Node | null) ? performance.now() : -Infinity
    }
    // Keys inside count too — Enter commits a rename, and arborist then puts focus back on its row.
    const onKeyDown = () => { gestureAt = performance.now() }
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null
      const from = e.relatedTarget as HTMLElement | null
      if (!isStolenTreeFocus({
        isRow: target?.getAttribute?.('role') === 'treeitem',
        fromInside: !!from && element.contains(from),
        sinceGestureMs: performance.now() - gestureAt,
      })) return
      e.stopPropagation()
      treeRef.current?.onBlur()
      if (from?.isConnected && typeof from.focus === 'function') from.focus({ preventScroll: true })
      else target?.blur()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    element.addEventListener('keydown', onKeyDown, true)
    element.addEventListener('focusin', onFocusIn, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      element.removeEventListener('keydown', onKeyDown, true)
      element.removeEventListener('focusin', onFocusIn, true)
    }
  }, [element, treeRef])
}

/** How long after a press or key inside the tree a row may still take focus from outside it. */
export const TREE_GESTURE_MS = 1000

/**
 * Whether a focus arriving on a tree element was taken rather than given: it landed on a row, came from
 * outside the tree (or from nowhere), and nothing in the tree was pressed or typed into just before.
 */
export function isStolenTreeFocus({ isRow, fromInside, sinceGestureMs }: {
  isRow: boolean
  fromInside: boolean
  sinceGestureMs: number
}): boolean {
  return isRow && !fromInside && sinceGestureMs > TREE_GESTURE_MS
}

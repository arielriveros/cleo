import { useCallback, useEffect, useRef, useState } from 'react'
import { InputSystem } from 'cleo'
import type { BindingSource, DeviceKind } from 'cleo'

/**
 * "Press a key" capture for a binding row.
 *
 * Wraps `InputSystem.beginRebind`, which reports the next raw input as a {@link BindingSource} and
 * suspends action resolution while it is listening — so the key being bound to Jump does not also make
 * the character jump. This hook adds the three things a UI needs on top: an escape hatch, a device
 * filter, and a timeout so a row cannot be left listening forever if the user walks away.
 *
 * Escape always CANCELS rather than being captured. Binding Escape itself is still possible — pick it
 * from the device dropdown — but a capture prompt with no way out is worse than one key being harder to
 * bind by listening.
 */
export interface RebindCapture {
  /** Which binding is listening (whatever id `start` was given), or null. */
  listeningFor: string | null
  start(id: string, options?: { device?: DeviceKind; timeoutMs?: number }): Promise<BindingSource | null>
  cancel(): void
}

const DEFAULT_TIMEOUT_MS = 8000

export function useRebindCapture(): RebindCapture {
  const [listeningFor, setListeningFor] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
    setListeningFor(null)
  }, [])

  const cancel = useCallback(() => {
    InputSystem.instance.cancelRebind()
    stop()
  }, [stop])

  const start = useCallback(async (id: string, options?: { device?: DeviceKind; timeoutMs?: number }) => {
    // Cancel any row already listening. Two live captures would race for the same next input.
    InputSystem.instance.cancelRebind()
    setListeningFor(id)

    const wanted = options?.device
    const promise = InputSystem.instance.beginRebind(
      wanted ? (source: BindingSource) => source.device === wanted : undefined,
    )
    timer.current = window.setTimeout(() => InputSystem.instance.cancelRebind(),
      options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    try {
      return await promise
    } finally {
      stop()
    }
  }, [stop])

  // Escape cancels. Capture phase, so it lands before anything else on the page can act on it — and
  // bound to the WINDOW, because the button that started the capture may have lost focus by now.
  useEffect(() => {
    if (!listeningFor) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listeningFor, cancel])

  // A panel unmounting mid-capture must not leave the system suspended: with a rebind in flight no
  // action resolves at all, so the editor's camera would silently stop responding.
  useEffect(() => () => { InputSystem.instance.cancelRebind() }, [])

  return { listeningFor, start, cancel }
}

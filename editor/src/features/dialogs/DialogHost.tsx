import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Modal, ModalHeader, ModalFooter, Button, TextInput, cn } from '../../components/ui'
import { getSnapshot, resolveDialog, subscribe } from './dialogStore'

// Renders whichever dialogStore request is at the head of the queue: the in-app alert/confirm/prompt.
// Mounted in index.tsx as a sibling of <App>, not here in features/, because the project launcher phase
// renders outside every provider and still needs to ask before deleting a project.

/** A blank line starts a paragraph; a single \n stays a hard break (whitespace-pre-line). */
function Message({ text, warn }: { text: string; warn: boolean }) {
  return (
    <div className='px-4 py-3 text-sm text-gray-300 space-y-2'>
      {text.split('\n\n').map((paragraph, i) => (
        <p key={i} className={cn('whitespace-pre-line select-text', warn && 'text-warning')}>{paragraph}</p>
      ))}
    </div>
  )
}

export default function DialogHost() {
  const request = useSyncExternalStore(subscribe, getSnapshot)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  const id = request?.id
  const isPrompt = request?.kind === 'prompt'

  // Keyed on the request identity, not on every publish: the draft belongs to one question.
  useEffect(() => {
    setValue(request?.kind === 'prompt' ? request.options.defaultValue ?? '' : '')
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const cancel = () => { if (id) resolveDialog(id, false) }

  const accept = () => {
    if (!request) return
    if (request.kind === 'prompt') {
      const message = request.options.validate?.(value) ?? null
      if (message) { setError(message); inputRef.current?.focus(); return }
      resolveDialog(request.id, true, value)
      return
    }
    resolveDialog(request.id, true)
  }

  // Move focus in, and hand it back where it was once the question is answered.
  useLayoutEffect(() => {
    if (!id) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    if (isPrompt) {
      inputRef.current?.focus()
      inputRef.current?.select()
    } else {
      confirmRef.current?.focus()
    }
    return () => { restoreFocusRef.current?.focus?.() }
  }, [id, isPrompt])

  // Capture phase, and stopPropagation on whatever we handle. ProjectsModal and the AssetsExplorer
  // popovers all listen for Escape on `document` in the bubble phase, so without this one Escape would
  // both answer the dialog and close the modal that raised it.
  useEffect(() => {
    if (!id) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return // an IME candidate window owns Enter and Escape while it is open
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancel()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        accept()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, value])

  // A real modal, and in the desktop shell there is no browser chrome to tab out into — without this,
  // Tab walks into the editor behind the backdrop, where clicks do not reach.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !cardRef.current) return
    const focusable = cardRef.current.querySelectorAll<HTMLElement>('input, button')
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  if (!request) return null
  const options = request.options

  return (
    // z-[60] so a confirm raised from inside another modal (the Projects modal's delete) sits over it.
    <Modal onClose={cancel} className='w-[440px] max-w-[92vw]' overlayClassName='z-[60]'>
      <div ref={cardRef} onKeyDown={trapTab}>
        <ModalHeader>
          <div className='text-sm font-semibold'>{options.title}</div>
        </ModalHeader>

        {options.message && <Message text={options.message} warn={options.tone === 'warning'} />}

        {/* The whole list, scrolled — the alert() strings this replaces had to truncate at six. */}
        {!!options.details?.length && (
          <ul className='mx-4 mb-3 max-h-[200px] overflow-y-auto rounded border border-border-subtle bg-surface-sunken px-3 py-2 text-xs text-muted space-y-1'>
            {options.details.map((detail, i) => <li key={i}>• {detail}</li>)}
          </ul>
        )}

        {request.kind === 'prompt' && (
          <div className='px-4 pb-3'>
            <TextInput
              ref={inputRef}
              value={value}
              onChange={setValue}
              placeholder={request.options.placeholder}
            />
            {error && <div className='mt-1 text-xs text-danger'>{error}</div>}
          </div>
        )}

        <ModalFooter>
          {request.kind !== 'alert' && (
            <Button size='sm' className='px-3 py-1.5' onClick={cancel}>
              {options.cancelLabel ?? 'Cancel'}
            </Button>
          )}
          <Button
            ref={confirmRef}
            size='sm'
            className='px-3 py-1.5 font-semibold'
            variant={options.tone === 'danger' ? 'danger' : 'primary'}
            onClick={accept}
          >
            {options.confirmLabel ?? 'OK'}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  )
}

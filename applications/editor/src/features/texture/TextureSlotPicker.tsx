import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TextureManager, isDerivedTextureId } from 'cleo'
import { cn, TextInput, Button } from '@cleo/app-kit/ui'
import { placeAnchored } from '@cleo/app-kit/ui/anchoredPosition'
import { useEventBus } from '../EventBusContext'
import { ImportIcon } from '../topbarIcons'
import { SpriteIcon } from '../nodeInspector/sectionIcons'
import { awaitTextureImage, textureImage } from '../../utils/textureReady'
import { importAtlasImage } from '../tileset/importAtlas'

// The editor's texture slot: a 96 px tile showing the bound image, with Select / Upload / ✕ on hover, a
// searchable list of the project's textures, and drops from the Assets explorer or the OS. It edits a bare
// texture id, so anything holding one can use it — a material slot (TextureInspector adapts a Material to
// it), a tileset's atlas and lighting maps.

/**
 * Texture ids a slot may be bound to: engine-derived channel packs, editor/debug internals and the engine's
 * `Null` placeholder (what draws when a texture is missing) never are.
 */
const assignableIds = (): string[] =>
  Array.from(TextureManager.Instance.textures.keys())
    .filter(id => !(id === 'Null' || id.includes('__editor__') || id.includes('__debug__') || isDerivedTextureId(id)))

const thumbSrc = (id: string): string | undefined => textureImage(id)?.src

export interface TextureSlotPickerProps {
  /** The bound texture id, or null for an empty slot. */
  value: string | null
  /** A texture was picked, dropped or uploaded (its id), or the slot was cleared (null). */
  onChange: (id: string | null) => void
  /**
   * Replace the default upload, which registers the file as a texture (decoded first, source bytes kept so it
   * survives a reload) and then calls `onChange` with its id.
   */
  onUpload?: (file: File) => void | Promise<unknown>
  /** Whether the slot can be emptied (✕ and the "None" row). Default true. */
  clearable?: boolean
  /** How the preview fills the tile. `cover` crops; `contain` shows the whole image (an atlas). */
  fit?: 'cover' | 'contain'
  /** Nearest-neighbour preview, for pixel art. */
  pixelated?: boolean
  accept?: string
  /** Shown on the tile while an upload is in flight. */
  busy?: boolean
}

export default function TextureSlotPicker({
  value, onChange, onUpload, clearable = true, fit = 'cover', pixelated = false, accept = 'image/*', busy = false,
}: TextureSlotPickerProps) {
  const eventEmitter = useEventBus()
  const [ids, setIds] = useState<string[]>(assignableIds)
  const [src, setSrc] = useState<string | undefined>(() => (value ? thumbSrc(value) : undefined))
  const [missing, setMissing] = useState(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const tileRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // The list and the preview follow the texture library: an import elsewhere shows up here at once, and a
  // texture that was missing appears when it lands.
  useEffect(() => {
    let cancelled = false
    const resolve = () => {
      setIds(assignableIds())
      if (!value) { setSrc(undefined); setMissing(false); return }
      const known = !!TextureManager.Instance.getTexture(value)
      setMissing(!known)
      setSrc(thumbSrc(value))
      // Registered but still decoding: wait for the pixels rather than showing an empty tile.
      if (known) void awaitTextureImage(value).then(img => { if (!cancelled && img) setSrc(img.src) })
    }
    resolve()
    eventEmitter.on('TEXTURES_CHANGED', resolve)
    return () => { cancelled = true; eventEmitter.off('TEXTURES_CHANGED', resolve) }
  }, [eventEmitter, value])

  // The list is portalled to <body> and placed against the tile: an absolute panel is clipped by the
  // Collapsable's overflow-hidden and the inspector's scroller, whatever its z-index.
  const place = useCallback(() => {
    const tile = tileRef.current, panel = panelRef.current
    if (!tile || !panel) return
    setPos(placeAnchored(tile.getBoundingClientRect(), panel.getBoundingClientRect()))
  }, [])
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    place()
  }, [open, place])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (tileRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onReflow = () => place()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onReflow, true)
    window.addEventListener('resize', onReflow)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onReflow, true)
      window.removeEventListener('resize', onReflow)
    }
  }, [open, place])

  const select = (id: string | null) => {
    setOpen(false)
    if (id === value) return
    onChange(id)
  }

  const upload = async (file: File) => {
    setOpen(false)
    setUploading(true)
    try {
      if (onUpload) { await onUpload(file); return }
      const imported = await importAtlasImage(file, (event) => eventEmitter.emit(event as any))
      if (imported) onChange(imported.textureId)
    } finally {
      setUploading(false)
    }
  }

  const accepts = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types || [])
    return types.includes('Files') || types.includes('text/cleo-asset') || types.includes('text/plain')
  }
  const onDragOver = (e: React.DragEvent) => {
    if (!accepts(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    // An image file from the OS uploads, like the Assets explorer's own drop.
    const file = e.dataTransfer.files?.item(0)
    if (file) { if (file.type.startsWith('image/') || !file.type) void upload(file); return }
    const custom = e.dataTransfer.getData('text/cleo-asset')
    let id: string | null = null
    if (custom) {
      try {
        const parsed = JSON.parse(custom)
        if (parsed?.type === 'texture' && typeof parsed.id === 'string') id = parsed.id
      } catch { /* fall through to the plain-text id */ }
    }
    if (!id) id = e.dataTransfer.getData('text/plain') || null
    if (id && TextureManager.Instance.getTexture(id)) select(id)
  }

  const filtered = ids.filter(id => id.toLowerCase().includes(query.toLowerCase()))
  const working = busy || uploading

  return (
    <div className='relative flex flex-col items-center'>
      <div
        ref={tileRef}
        className={cn('relative group h-24 w-24 panel', dragOver && 'ring-2 ring-primary')}
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        title={value ?? 'Drop a texture from Assets, or an image file, here'}
      >
        {src
          ? <img
              className={cn('h-full w-full rounded pointer-events-none cleo-texture-checker', fit === 'contain' ? 'object-contain' : 'object-cover')}
              style={pixelated ? { imageRendering: 'pixelated' } : undefined}
              src={src}
              alt=''
            />
          : (
            <div className={cn('h-full w-full rounded border border-dashed grid place-items-center text-ui text-muted text-center px-1',
              dragOver ? 'border-primary' : 'border-border')}>
              {working ? 'Importing…' : dragOver ? 'Release to assign' : missing ? 'Missing' : 'No texture'}
            </div>
          )}

        <div className={cn('absolute inset-0 transition-opacity',
          open ? 'opacity-100 visible' : 'opacity-0 invisible group-hover:opacity-100 group-hover:visible')}>
          {clearable && (
            <Button variant='remove' size='icon' className='absolute top-1 right-1 h-6 w-6 p-0 rounded-full disabled:opacity-50'
              title='Remove texture' disabled={!value} onClick={() => select(null)}>✕</Button>
          )}
          <div className='absolute left-1 right-1 bottom-1 flex items-center gap-1'>
            <Button className='flex-1 px-2 bg-scrim/60 hover:bg-scrim/80 border-fg/20' title='Select texture'
              onClick={() => { setQuery(''); setOpen(v => !v) }}>
              Select
            </Button>
            <Button className='px-2 bg-scrim/60 hover:bg-scrim/80 border-fg/20' title='Upload texture' aria-label='Upload texture'
              disabled={working} onClick={() => fileRef.current?.click()}>
              <span className='inline-flex items-center justify-center w-4 h-4 align-middle'><ImportIcon /></span>
            </Button>
          </div>
        </div>
      </div>

      <input
        ref={fileRef} className='hidden' type='file' accept={accept}
        onChange={(e) => {
          const file = e.target.files?.item(0)
          // Reset first: re-picking the same file fires no change event otherwise.
          e.target.value = ''
          if (file) void upload(file)
        }}
      />

      {missing && value && (
        <div className='absolute -bottom-2 left-1/2 -translate-x-1/2 translate-y-full max-w-[140px] truncate bg-warning text-bg text-ui-xs px-2 py-0.5 rounded shadow z-10'
          title={value}>
          Missing {value}
        </div>
      )}

      {open && createPortal(
        <div
          ref={panelRef}
          style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          className='z-[1000] w-64 rounded-md border border-border bg-surface-raised shadow-lg p-2 flex flex-col gap-2'
        >
          <TextInput placeholder='Search textures...' value={query} onChange={setQuery} autoFocus
            onKeyDown={(e) => {
              // Enter takes the only match, so a typed name is enough.
              if (e.key === 'Enter' && filtered.length === 1) select(filtered[0])
            }} />
          <div className='max-h-56 overflow-auto rounded border border-border bg-surface'>
            {clearable && (
              <button className={cn('w-full flex items-center gap-2 px-2 py-1 hover:bg-control text-left text-ui', !value && 'bg-control')}
                onClick={() => select(null)}>
                <span className='w-7 h-7 rounded bg-surface-raised grid place-items-center shrink-0 text-muted'>∅</span>
                <span className='truncate'>None</span>
              </button>
            )}
            {/* A bound id the library no longer has stays listed, so the slot never silently reads as empty. */}
            {value && missing && (
              <div className='w-full flex items-center gap-2 px-2 py-1 text-left text-ui bg-control text-warning'>
                <span className='w-7 h-7 rounded bg-surface-raised grid place-items-center shrink-0'>!</span>
                <span className='truncate flex-1'>{value} (missing)</span>
              </div>
            )}
            {filtered.map((id) => {
              const thumb = thumbSrc(id)
              return (
                <button key={id} className={cn('w-full flex items-center gap-2 px-2 py-1 hover:bg-control text-left text-ui', id === value && 'bg-control')}
                  onClick={() => select(id)}>
                  <span className='w-7 h-7 rounded bg-surface-raised overflow-hidden grid place-items-center shrink-0'>
                    {thumb
                      ? <img src={thumb} alt='' className={cn('w-full h-full', fit === 'contain' ? 'object-contain' : 'object-cover')}
                          style={pixelated ? { imageRendering: 'pixelated' } : undefined} />
                      : <span className='inline-flex w-4 h-4 text-dim [&>svg]:w-full [&>svg]:h-full'><SpriteIcon /></span>}
                  </span>
                  <span className='truncate flex-1'>{id}</span>
                  {id === value && <span className='text-primary'>✓</span>}
                </button>
              )
            })}
            {filtered.length === 0 && <div className='px-2 py-3 text-ui text-muted'>No matches</div>}
          </div>
          <Button className='w-full' disabled={working} onClick={() => fileRef.current?.click()}>Upload…</Button>
        </div>,
        document.body,
      )}
    </div>
  )
}

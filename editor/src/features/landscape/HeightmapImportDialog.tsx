import React, { useEffect, useMemo, useRef, useState } from 'react'
import { heightsFromImage, type HeightImage, type HeightImportOptions, type LandscapeNode, type Scene } from 'cleo'
import { Modal, ModalHeader, ModalFooter } from '../../components/ui/Modal'
import { Button, Hint, NumberInput, SegmentedControl, Toggle } from '../../components/ui'
import { setTerrainHeights } from '../../utils/terrainAccess'
import { rangeFromFileName } from './heightmapImport'

// Import a heightmap into a landscape, with the choices every terrain tool offers: the height range the
// image maps to, flips and a rotation — and a LIVE preview on the landscape itself, so the range is set
// by looking rather than by guessing. Cancel puts the ground back exactly; OK is one undo step.
//
// The height range is what "amplitude" used to be, generalised: amplitude was only a maximum, with the
// minimum pinned at 0 and applied once at import. A range can be re-typed while the dialog is open and
// the ground follows.

export interface HeightmapImportDialogProps {
  node: LandscapeNode
  scene: Scene
  image: HeightImage
  fileName: string
  onClose: () => void
  /** Record one undo step. Receives the heights before and after, by value. */
  onCommit: (before: Float32Array, after: Float32Array) => void
}

export default function HeightmapImportDialog({ node, image, fileName, onClose, onCommit }: HeightmapImportDialogProps) {
  const initial = rangeFromFileName(fileName)
  const [opts, setOpts] = useState<HeightImportOptions>({
    min: initial?.min ?? 0, max: initial?.max ?? Math.max(30, Math.round(node.terrain.size * 0.15)),
    flipX: false, flipY: false, rotate: 0,
  })
  const [live, setLive] = useState(true)
  // The ground as it was when the dialog opened: what Cancel restores and what the undo step records.
  const original = useRef<Float32Array>(node.terrain.heights.slice())
  const applied = useRef(false)

  const compute = () => heightsFromImage(image, node.terrain.resolution, opts)

  // Live preview, debounced so typing a number does not rebuild every chunk per keystroke.
  useEffect(() => {
    if (!live) return
    const t = setTimeout(() => { if (setTerrainHeights(node.terrain, compute())) applied.current = true }, 120)
    return () => clearTimeout(t)
  }, [opts, live])

  const restore = () => { if (applied.current) setTerrainHeights(node.terrain, original.current) }
  const cancel = () => { restore(); onClose() }
  const ok = () => {
    const after = compute()
    setTerrainHeights(node.terrain, after)
    onCommit(original.current, after)
    onClose()
  }

  const preview = useMemo(() => renderPreview(image), [image])
  const set = (patch: Partial<HeightImportOptions>) => setOpts(o => ({ ...o, ...patch }))
  const metresPerStep = (opts.max - opts.min) / (image.bitDepth >= 16 ? 65535 : 255)

  return (
    <Modal onClose={cancel} className='w-[520px]'>
      <ModalHeader>
        <div className='text-sm font-semibold'>Import heightmap</div>
        <div className='text-xs text-muted'>{fileName} · {image.width}×{image.height} · {image.bitDepth}-bit</div>
      </ModalHeader>
      <div className='p-4 flex gap-4'>
        <img src={preview} alt='' className='w-40 h-40 rounded border border-control object-cover shrink-0'
          style={{ transform: `rotate(${opts.rotate ?? 0}deg) scale(${opts.flipX ? -1 : 1}, ${opts.flipY ? -1 : 1})` }} />
        <div className='flex-1 space-y-2 text-xs'>
          <div className='flex items-center justify-between'>
            <span title='Height of a black pixel, terrain-local metres'>Lowest (black)</span>
            <NumberInput className='w-24' value={opts.min} step={1} onChange={min => set({ min })} />
          </div>
          <div className='flex items-center justify-between'>
            <span title='Height of a white pixel, terrain-local metres'>Highest (white)</span>
            <NumberInput className='w-24' value={opts.max} step={1} onChange={max => set({ max })} />
          </div>
          <div className='flex items-center justify-between'>
            <span>Rotate</span>
            <SegmentedControl<number> size='sm'
              options={[0, 90, 180, 270].map(r => ({ value: r, label: `${r}°` }))}
              value={opts.rotate ?? 0} onChange={r => set({ rotate: r as HeightImportOptions['rotate'] })} />
          </div>
          <div className='flex items-center justify-between'>
            <span>Flip horizontally</span>
            <Toggle checked={!!opts.flipX} onChange={flipX => set({ flipX })} />
          </div>
          <div className='flex items-center justify-between'>
            <span>Flip vertically</span>
            <Toggle checked={!!opts.flipY} onChange={flipY => set({ flipY })} />
          </div>
          <div className='flex items-center justify-between'>
            <span title='Apply to the landscape as you change the settings'>Live preview</span>
            <Toggle checked={live} onChange={v => { setLive(v); if (!v) restore() }} />
          </div>
          {image.bitDepth < 16 && metresPerStep > 0.25 && (
            <Hint>An 8-bit image has 256 levels: {metresPerStep.toFixed(2)} m per step over this range, which shows as terraces on slopes. A 16-bit PNG or RAW avoids that.</Hint>
          )}
          {(image.width < node.terrain.resolution || image.height < node.terrain.resolution) && (
            <Hint>The image is smaller than the landscape's {node.terrain.resolution}×{node.terrain.resolution} height grid; it is interpolated.</Hint>
          )}
        </div>
      </div>
      <ModalFooter>
        <Button variant='ghost' onClick={cancel}>Cancel</Button>
        <Button variant='primary' onClick={ok}>Import</Button>
      </ModalFooter>
    </Modal>
  )
}

/** A small grayscale PNG data URL of the image, for the dialog. */
function renderPreview(image: HeightImage): string {
  const size = 160
  const canvas = document.createElement('canvas')
  canvas.width = size; canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const out = ctx.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    const sy = Math.min(image.height - 1, Math.floor((y / size) * image.height))
    for (let x = 0; x < size; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x / size) * image.width))
      const v = Math.round(image.data[sy * image.width + sx] * 255)
      const i = (y * size + x) * 4
      out.data[i] = out.data[i + 1] = out.data[i + 2] = v; out.data[i + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)
  return canvas.toDataURL()
}

import React, { useMemo, useRef, useState } from 'react'
import { TextureManager, Logger } from 'cleo'
import type { TileMeta, WangKind } from 'cleo'
import Collapsable from '../../components/Collapsable'
import { Button, ButtonWithConfirm, NumberInput, Select, TextInput, Toggle, ColorInput, Hint } from '../../components/ui'
import { vec3ToHex } from '../../utils/UtilFunctions'
import { awaitTextureImage, textureImage } from '../../utils/textureReady'
import { useTileset } from './TilesetContext'

// The tileset tab's Properties panel: how the atlas is sliced, what the selected tiles mean (solid,
// animated, tinted, depth-anchored), and the auto-tile / variant sets built out of them.

const label = 'text-xs text-gray-300'

/** Import / drop target / picker for the atlas image. Accepts the same payloads TextureInspector does. */
function AtlasSlot() {
  const { asset, patch, importAtlas } = useTileset()
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const textureIds = useMemo(
    () => Array.from(TextureManager.Instance.textures.keys())
      .filter(id => !id.includes('__editor__') && !id.includes('__debug__') && id !== 'Null'),
    [],
  )

  if (!asset) return null

  const assign = async (id: string) => {
    // The dimensions are STORED, not re-derived at load, so they have to be read from a DECODED image —
    // TextureManager registers an id immediately and decodes afterwards, and reading `naturalWidth` during
    // that window returns 0 and would bake a 1x1 grid into the asset permanently. This used to bail
    // silently, which made dropping a just-imported texture look like nothing had happened.
    const image = await awaitTextureImage(id)
    if (!image) {
      Logger.warn(`"${id}" is not a usable image — it may still be loading, or may have failed to decode`, 'Editor')
      return
    }
    patch({ textureId: id, imageWidth: image.naturalWidth, imageHeight: image.naturalHeight })
  }

  const importFile = async (file: File) => {
    setBusy(true)
    try { await importAtlas(file) } finally { setBusy(false) }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    // An OS file dragged straight onto the slot imports it, like the Assets explorer's own drop handler.
    const file = e.dataTransfer.files?.item(0)
    if (file) { void importFile(file); return }
    const custom = e.dataTransfer.getData('text/cleo-asset')
    if (custom) {
      try {
        const parsed = JSON.parse(custom)
        if (parsed?.type === 'texture' && parsed.id) { void assign(parsed.id); return }
      } catch { /* fall through to the plain-text id below */ }
    }
    const plain = e.dataTransfer.getData('text/plain')
    if (plain) void assign(plain)
  }

  const src = textureImage(asset.textureId)?.src

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`space-y-1 border rounded p-2 ${dragOver ? 'border-selected' : 'border-control'}`}
    >
      <div className='flex items-center gap-2'>
        <div className='w-12 h-12 rounded overflow-hidden bg-surface-raised flex items-center justify-center shrink-0'>
          {src
            ? <img src={src} alt='' className='w-full h-full object-contain' style={{ imageRendering: 'pixelated' }} />
            : <span className='text-lg'>🧩</span>}
        </div>
        <div className='min-w-0 flex-1'>
          <p className='truncate text-xs' title={asset.textureId}>{asset.textureId || 'No atlas'}</p>
          <p className='text-[10px] text-muted'>{asset.imageWidth} x {asset.imageHeight} px</p>
        </div>
      </div>

      <Button size='sm' className='w-full' disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? 'Importing…' : asset.textureId ? 'Replace image…' : 'Import image…'}
      </Button>
      <input
        ref={fileRef} type='file' className='hidden' accept='.png,.jpg,.jpeg,.bmp,.gif,.webp'
        onChange={(e) => {
          const file = e.target.files?.item(0)
          // Reset first: re-picking the same file fires no change event otherwise.
          e.target.value = ''
          if (file) void importFile(file)
        }}
      />

      <Select value='' onChange={(e) => { if (e.target.value) void assign(e.target.value) }}>
        <option value=''>…or link an imported texture</option>
        {textureIds.map(id => <option key={id} value={id}>{id}</option>)}
      </Select>
      <Hint>You can also drop an image file, or a texture from the Assets explorer, onto this box.</Hint>
    </div>
  )
}

/** Metadata editor for the current selection. Every write applies to every selected tile. */
function TileMetaEditor() {
  const { asset, selection, setTileMeta } = useTileset()
  if (!asset || selection.length === 0) {
    return <Hint>Select one or more tiles in the atlas to edit what they mean.</Hint>
  }

  // With several tiles selected the fields show the FIRST one's values and writing applies to all — the
  // usual multi-edit compromise, and the alternative (blanking mixed fields) makes bulk marking painful.
  const primary = asset.tiles[selection[0]] ?? {}
  const apply = (p: Partial<TileMeta>) => {
    for (const index of selection) {
      const merged: TileMeta = { ...(asset.tiles[index] ?? {}), ...p }
      // Strip the fields that were reset to their default rather than storing an explicit copy of it.
      for (const key of Object.keys(merged) as (keyof TileMeta)[]) {
        const v = merged[key]
        if (v === undefined || v === null || v === false) delete merged[key]
      }
      setTileMeta(index, merged)
    }
  }

  const frames = primary.animation?.frames ?? []

  return (
    <div className='space-y-2'>
      <div className='flex items-center justify-between'>
        <span className={label}>Solid</span>
        <Toggle checked={!!primary.solid} onChange={(c) => apply({ solid: c })} />
      </div>
      <Hint>Solid tiles become colliders on any layer with parallax 1.</Hint>

      <div className='flex items-center justify-between'>
        <span className={label} title='Rows down from this tile that it sorts at — a 2-tall tree anchors at its trunk'>
          Anchor row
        </span>
        <NumberInput className='w-16' value={primary.anchorRow ?? 0} step={1}
          onChange={(v) => apply({ anchorRow: v || undefined })} />
      </div>
      <div className='flex items-center justify-between'>
        <span className={label} title='World-space nudge applied to this tile’s depth sort'>Z bias</span>
        <NumberInput className='w-16' value={primary.zBias ?? 0} step={0.05}
          onChange={(v) => apply({ zBias: v || undefined })} />
      </div>
      <div className='flex items-center justify-between'>
        <span className={label} title='Footprint in cells, for props larger than one tile'>Span (x, y)</span>
        <span className='flex gap-1'>
          <NumberInput className='w-14' value={primary.spanX ?? 1} step={1} min={1}
            onChange={(v) => apply({ spanX: Math.max(1, v) || undefined })} />
          <NumberInput className='w-14' value={primary.spanY ?? 1} step={1} min={1}
            onChange={(v) => apply({ spanY: Math.max(1, v) || undefined })} />
        </span>
      </div>

      <div className='flex items-center justify-between'>
        <span className={label}>Tint</span>
        <ColorInput
          color={vec3ToHex(primary.tint ?? [1, 1, 1])}
          onChange={(c) => apply({ tint: (c[0] === 1 && c[1] === 1 && c[2] === 1) ? undefined : c })}
        />
      </div>
      <div className='flex items-center justify-between'>
        <span className={label}>Opacity</span>
        <NumberInput className='w-16' value={primary.opacity ?? 1} step={0.05} min={0} max={1}
          onChange={(v) => apply({ opacity: v >= 1 ? undefined : v })} />
      </div>

      <div className='flex items-center justify-between pt-1'>
        <span className={label}>Animated</span>
        <Toggle
          checked={frames.length > 1}
          onChange={(c) => apply({
            // Seeded with this tile and the one after it so the sequence is immediately meaningful.
            animation: c ? { frames: [selection[0], Math.min(selection[0] + 1, asset.columns * asset.rows - 1)], fps: 8 } : undefined,
          })}
        />
      </div>
      {frames.length > 1 && (
        <>
          <div className='flex items-center justify-between'>
            <span className={label}>Frames</span>
            <TextInput
              className='w-32'
              value={frames.join(', ')}
              onChange={(text) => {
                const parsed = text.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n))
                apply({ animation: { frames: parsed, fps: primary.animation?.fps ?? 8 } })
              }}
              title='Tile indices, in play order'
            />
          </div>
          <div className='flex items-center justify-between'>
            <span className={label}>FPS</span>
            <NumberInput className='w-16' value={primary.animation?.fps ?? 8} step={1} min={1}
              onChange={(v) => apply({ animation: { frames, fps: Math.max(1, v) } })} />
          </div>
        </>
      )}

      <ButtonWithConfirm
        className='w-full'
        onClick={() => { for (const index of selection) setTileMeta(index, undefined) }}
      >
        Clear tile metadata
      </ButtonWithConfirm>
    </div>
  )
}

/** Auto-tile terrain sets: a named rule table mapping neighbour masks to tiles. */
function TerrainSetsEditor() {
  const { asset, patch, selection } = useTileset()
  if (!asset) return null

  const addSet = () => {
    const id = (asset.terrains.reduce((m, t) => Math.max(m, t.id), 0) + 1) || 1
    patch({ terrains: [...asset.terrains, { id, name: `Terrain ${id}`, kind: 'blob' as WangKind, tiles: {} }] })
  }

  return (
    <div className='space-y-2'>
      {asset.terrains.length === 0 && <Hint>An auto-tile set picks the right edge/corner tile as you paint.</Hint>}
      {asset.terrains.map((set, i) => (
        <div key={set.id} className='border border-control rounded p-2 space-y-1'>
          <div className='flex items-center gap-1'>
            <TextInput
              className='flex-1'
              value={set.name}
              onChange={(name) => {
                const next = [...asset.terrains]
                next[i] = { ...set, name }
                patch({ terrains: next })
              }}
            />
            <Select
              className='w-20'
              value={set.kind}
              onChange={(e) => {
                const next = [...asset.terrains]
                next[i] = { ...set, kind: e.target.value as WangKind }
                patch({ terrains: next })
              }}
            >
              <option value='edge'>Edge</option>
              <option value='corner'>Corner</option>
              <option value='blob'>Blob</option>
            </Select>
            <ButtonWithConfirm onClick={() => patch({ terrains: asset.terrains.filter(t => t.id !== set.id) })}>
              ✕
            </ButtonWithConfirm>
          </div>
          <div className='flex items-center justify-between'>
            <span className={label}>Rules</span>
            <span className='text-[10px] text-muted'>{Object.keys(set.tiles).length} masks</span>
          </div>
          <Button
            size='sm' variant='ghost' className='w-full'
            disabled={selection.length === 0}
            title='Assign the selected tiles to this set and record which mask each one fills'
            onClick={() => {
              // Membership lives on the tile (so the painter can tell what is "the same terrain"); the rule
              // table maps a neighbour mask to candidates. Assigning in index order is the convention every
              // Wang sheet on the internet follows, so it is what makes an imported sheet just work.
              const tiles = { ...asset.tiles }
              const rules: Record<number, number[]> = { ...set.tiles }
              selection.forEach((index, k) => {
                tiles[index] = { ...(tiles[index] ?? {}), terrain: { id: set.id, mask: k } }
                rules[k] = [...(rules[k] ?? []), index].filter((v, j, a) => a.indexOf(v) === j)
              })
              const next = [...asset.terrains]
              next[i] = { ...set, tiles: rules }
              patch({ tiles, terrains: next })
            }}
          >
            Assign {selection.length || 'no'} selected tile{selection.length === 1 ? '' : 's'}
          </Button>
        </div>
      ))}
      <Button size='sm' variant='ghost' className='w-full' onClick={addSet}>+ Auto-tile set</Button>
    </div>
  )
}

/** Variant sets: interchangeable tiles the randomize brush scatters. */
function VariantSetsEditor() {
  const { asset, patch, selection } = useTileset()
  if (!asset) return null

  return (
    <div className='space-y-2'>
      {asset.variantSets.length === 0 && <Hint>A variant set lets the randomize brush scatter alternatives.</Hint>}
      {asset.variantSets.map((set, i) => (
        <div key={set.id} className='border border-control rounded p-2 space-y-1'>
          <div className='flex items-center gap-1'>
            <TextInput
              className='flex-1'
              value={set.name}
              onChange={(name) => {
                const next = [...asset.variantSets]
                next[i] = { ...set, name }
                patch({ variantSets: next })
              }}
            />
            <ButtonWithConfirm onClick={() => patch({ variantSets: asset.variantSets.filter(v => v.id !== set.id) })}>
              ✕
            </ButtonWithConfirm>
          </div>
          {set.tiles.map((t, k) => (
            <div key={t.index} className='flex items-center justify-between'>
              <span className={label}>Tile {t.index}</span>
              <NumberInput
                className='w-16' value={t.weight} step={0.5} min={0}
                onChange={(v) => {
                  const tiles = [...set.tiles]
                  tiles[k] = { ...t, weight: Math.max(0, v) }
                  const next = [...asset.variantSets]
                  next[i] = { ...set, tiles }
                  patch({ variantSets: next })
                }}
              />
            </div>
          ))}
          <Button
            size='sm' variant='ghost' className='w-full'
            disabled={selection.length === 0}
            onClick={() => {
              const existing = new Set(set.tiles.map(t => t.index))
              const tiles = [...set.tiles, ...selection.filter(x => !existing.has(x)).map(index => ({ index, weight: 1 }))]
              const next = [...asset.variantSets]
              next[i] = { ...set, tiles }
              patch({ variantSets: next })
            }}
          >
            Add {selection.length || 'no'} selected tile{selection.length === 1 ? '' : 's'}
          </Button>
        </div>
      ))}
      <Button
        size='sm' variant='ghost' className='w-full'
        onClick={() => {
          const id = (asset.variantSets.reduce((m, v) => Math.max(m, v.id), 0) + 1) || 1
          patch({ variantSets: [...asset.variantSets, { id, name: `Variants ${id}`, tiles: [] }] })
        }}
      >
        + Variant set
      </Button>
    </div>
  )
}

export default function TilesetInspector() {
  const { asset, patch, save, dirty } = useTileset()

  if (!asset) return <div className='p-2 text-xs text-muted'>No tileset open.</div>

  return (
    <div className='flex flex-col text-white'>
      <Collapsable title='Atlas' persistKey='tileset.atlas' defaultOpen>
        <div className='p-2 space-y-2'>
          <AtlasSlot />
          <div className='flex items-center justify-between'>
            <span className={label}>Tile size</span>
            <span className='flex gap-1'>
              <NumberInput className='w-14' value={asset.tileWidth} step={1} min={1}
                onChange={(v) => patch({ tileWidth: Math.max(1, v) })} />
              <NumberInput className='w-14' value={asset.tileHeight} step={1} min={1}
                onChange={(v) => patch({ tileHeight: Math.max(1, v) })} />
            </span>
          </div>
          <div className='flex items-center justify-between'>
            <span className={label} title='Border around the whole atlas, in pixels'>Margin</span>
            <NumberInput className='w-16' value={asset.margin} step={1} min={0}
              onChange={(v) => patch({ margin: Math.max(0, v) })} />
          </div>
          <div className='flex items-center justify-between'>
            <span className={label} title='Gap between adjacent tiles, in pixels'>Spacing</span>
            <NumberInput className='w-16' value={asset.spacing} step={1} min={0}
              onChange={(v) => patch({ spacing: Math.max(0, v) })} />
          </div>
          <Hint>{asset.columns} x {asset.rows} = {asset.columns * asset.rows} tiles.</Hint>
        </div>
      </Collapsable>

      <Collapsable title='Selected tiles' persistKey='tileset.tile' defaultOpen>
        <div className='p-2'><TileMetaEditor /></div>
      </Collapsable>

      <Collapsable title='Auto-tiling' persistKey='tileset.terrains'>
        <div className='p-2'><TerrainSetsEditor /></div>
      </Collapsable>

      <Collapsable title='Variants' persistKey='tileset.variants'>
        <div className='p-2'><VariantSetsEditor /></div>
      </Collapsable>

      <div className='p-2'>
        <Button className='w-full' onClick={save} disabled={!dirty}>Save tileset</Button>
      </div>
    </div>
  )
}

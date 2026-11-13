import { useEffect, useState } from 'react'
import { Logger, MAX_TILESET_OVERDRIVE } from 'cleo'
import type { WangKind } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import {
  Button, ButtonWithConfirm, ColorInput, DiceIcon, Hint, LinkIcon, PropertyRow, PropertyTable, RestartIcon, SegmentedControl,
  Select, Slider, TextInput, Toggle, VectorInput, cn, labelClass, valueClass,
} from '@cleo/app-kit/ui'
import { TextureSlotFrame, TextureSlotGrid } from '@cleo/app-kit/materials/TextureSlots'
import { vec3ToHex } from '../../utils/UtilFunctions'
import { awaitTextureImage } from '../../utils/textureReady'
import {
  TILESET_LIGHTING_MAPS, clearTileMeta, copyableTileMeta, guessTileSize, leftoverPixels, moveFrame,
  pasteTileMeta, selectionFieldState, tilesetTextureIds, TILE_COLLISION_PRESETS, tileCollisionPreset, tileCollisionPatch,
} from '../../utils/tilesets'
import type { TileMeta, TilesetAsset, TilesetLightingMap, TileCollisionPreset } from '../../utils/tilesets'
import { useTileset } from './TilesetContext'
import TextureSlotPicker from '../texture/TextureSlotPicker'
import { TilePreview, TileThumb, useAtlasSrc } from './TileThumb'
import { LightIcon, SkyboxIcon, SpriteIcon, TilesetIcon } from '../nodeInspector/sectionIcons'

// The tileset tab's Properties panel: how the atlas is sliced, what the selected tiles mean (solid,
// animated, tinted, depth-anchored), the maps lit sprites shade with, and the variant and auto-tile sets
// built out of the tiles. What each field does is in docs/editor/tilemap-2d.md › Tilesets, which the
// labels' hover cards read.

/** Tile sizes offered as one-click presets. Atlases are overwhelmingly one of these. */
const TILE_SIZE_PRESETS = [8, 16, 24, 32, 48, 64]
/** The overdrive track's end. Higher values are legal (typed) but rarely useful: ~3-4 is a strong glow. */
const OVERDRIVE_TRACK_MAX = 8

const isWhite = (c: readonly number[] | undefined) => !c || (c[0] === 1 && c[1] === 1 && c[2] === 1)

/** A small "back to the default" button for a row whose value has been changed. */
function ResetButton({ onClick, title, hidden }: { onClick: () => void; title: string; hidden?: boolean }) {
  return (
    <Button variant='ghost' size='icon' className={cn('h-6 w-6 p-1 shrink-0', hidden && 'invisible')} title={title}
      onClick={onClick} disabled={hidden}>
      <RestartIcon />
    </Button>
  )
}

/** Shown beside a field when the selected tiles disagree on it: the field displays the first tile's value. */
function Mixed({ on }: { on: boolean }) {
  if (!on) return null
  return <span className='shrink-0 px-1 rounded bg-border-subtle text-ui-2xs text-muted' title='The selected tiles differ here; the field shows the first one'>mixed</span>
}

/** A scalar with a draggable handle: drag `unit` sideways to scrub, or click the box to type. */
function Scrub({ value, onChange, unit, step = 1, min, max, precision = 0, reset }: {
  value: number; onChange: (v: number) => void; unit: string; step?: number; min?: number; max?: number
  precision?: number; reset?: number
}) {
  return (
    <VectorInput value={[value]} labels={[unit]} axisColors={false} step={step} min={min} max={max}
      precision={precision} reset={reset === undefined ? undefined : [reset]}
      onChange={([v]) => onChange(precision === 0 ? Math.round(v) : Number(v.toFixed(precision)))} />
  )
}

// --- Atlas ---------------------------------------------------------------------------------------------

function AtlasCard({ asset }: { asset: TilesetAsset }) {
  const { patch, importAtlas } = useTileset()
  // Square tiles are the common case, so the lock starts on for a tileset that has them.
  const [square, setSquare] = useState(asset.tileWidth === asset.tileHeight)
  useEffect(() => { setSquare(asset.tileWidth === asset.tileHeight) }, [asset.id])

  const assign = async (id: string | null) => {
    if (!id) return
    // The dimensions are STORED, not re-derived at load, so they must come from a DECODED image:
    // TextureManager registers an id immediately and decodes afterwards, and `naturalWidth` during that
    // window is 0, which would bake a 1x1 grid into the asset permanently.
    const image = await awaitTextureImage(id)
    if (!image) {
      Logger.warn(`"${id}" is not a usable image — it may still be loading, or may have failed to decode`, 'Editor')
      return
    }
    patch({ textureId: id, imageWidth: image.naturalWidth, imageHeight: image.naturalHeight })
  }

  const setTileSize = ([w, h]: number[]) => {
    const tw = Math.max(1, Math.round(w)), th = Math.max(1, Math.round(h))
    if (!square) { patch({ tileWidth: tw, tileHeight: th }); return }
    // Locked: whichever side moved drives both.
    const v = tw !== asset.tileWidth ? tw : th
    patch({ tileWidth: v, tileHeight: v })
  }

  const left = leftoverPixels(asset)
  const overdrive = asset.overdrive ?? 1
  const guess = guessTileSize(asset.imageWidth, asset.imageHeight)

  return (
    <Collapsable title='Atlas' icon={<SpriteIcon />} persistKey='tileset.atlas'>
      <div className='w-full p-2 space-y-2'>
        <div className='flex items-start gap-3'>
          <TextureSlotFrame label='Image' caption={asset.textureId ? `${asset.imageWidth} × ${asset.imageHeight} px` : undefined}>
            <TextureSlotPicker value={asset.textureId || null} clearable={false} fit='contain' pixelated
              accept='.png,.jpg,.jpeg,.bmp,.gif,.webp' onChange={(id) => void assign(id)}
              onUpload={(file) => importAtlas(file)} />
          </TextureSlotFrame>
          <div className='min-w-0 flex-1 pt-4 space-y-1'>
            <p className={cn(valueClass, 'truncate')} title={asset.textureId}>{asset.textureId || 'No atlas yet'}</p>
            <p className='text-ui-sm text-muted tabular-nums'>
              {asset.columns} × {asset.rows} = {asset.columns * asset.rows} tiles
            </p>
            {asset.textureId && (left.right > 0 || left.bottom > 0) && (
              <p className='text-ui-xs text-warning'
                title='The slicing does not divide the image: check the tile size, margin and spacing against the dimmed strip on the atlas.'>
                {left.right} px unused right · {left.bottom} px bottom
              </p>
            )}
          </div>
        </div>

        <PropertyTable columns={['32%', '68%']}>
          <PropertyRow label='Tile size'>
            <div className='flex items-center gap-1'>
              <VectorInput value={[asset.tileWidth, asset.tileHeight]} labels={['W', 'H']} step={1} min={1}
                precision={0} reset={[guess, guess]} onChange={setTileSize} />
              <Button variant='ghost' size='icon' active={square} className='h-6 w-6 p-1 shrink-0'
                title={square ? 'Square tiles: width and height move together (click to unlock)' : 'Lock width and height together'}
                onClick={() => {
                  setSquare(s => !s)
                  if (!square && asset.tileWidth !== asset.tileHeight) patch({ tileHeight: asset.tileWidth })
                }}>
                <LinkIcon />
              </Button>
            </div>
            <div className='flex flex-wrap items-center gap-1 mt-1'>
              {TILE_SIZE_PRESETS.map(s => (
                <Button key={s} size='sm' className='px-1.5 py-0 text-ui-sm tabular-nums'
                  active={asset.tileWidth === s && asset.tileHeight === s}
                  onClick={() => { setSquare(true); patch({ tileWidth: s, tileHeight: s }) }}>{s}</Button>
              ))}
              <Button size='sm' variant='ghost' className='px-1.5 py-0 text-ui-sm' disabled={!asset.textureId}
                title={`Guess from the image: ${guess} px`}
                onClick={() => { setSquare(true); patch({ tileWidth: guess, tileHeight: guess }) }}>Guess</Button>
            </div>
          </PropertyRow>
          <PropertyRow label='Margin'>
            <Scrub value={asset.margin} unit='px' min={0} reset={0} onChange={(v) => patch({ margin: Math.max(0, v) })} />
          </PropertyRow>
          <PropertyRow label='Spacing'>
            <Scrub value={asset.spacing} unit='px' min={0} reset={0} onChange={(v) => patch({ spacing: Math.max(0, v) })} />
          </PropertyRow>
          <PropertyRow label='Pixels per unit' hint='Art pixels in a world unit: sprites drawn from this tileset are their tile’s pixel size over this (a 16 px tile at 16 is one unit), and new tilemap layers take their cells from it. Off: a sprite is a unit quad sized by its scale.'>
            <div className='flex items-center gap-1'>
              <Scrub value={asset.pixelsPerUnit ?? 0} unit='px' min={0} reset={0}
                onChange={(v) => { const p = Math.max(0, Math.round(v)); patch({ pixelsPerUnit: p > 0 ? p : undefined }) }} />
              <Button size='sm' className='px-1.5 py-0 text-ui-sm tabular-nums' active={asset.pixelsPerUnit === asset.tileWidth}
                title='One tile is one world unit' onClick={() => patch({ pixelsPerUnit: asset.tileWidth })}>= tile</Button>
            </div>
          </PropertyRow>
          <PropertyRow label='Overdrive'>
            <div className='flex items-center gap-1'>
              <Slider className='flex-1 my-0' min={0} max={OVERDRIVE_TRACK_MAX} step={0.05} hardMax={MAX_TILESET_OVERDRIVE}
                value={overdrive}
                onChange={(v) => {
                  const o = Math.min(MAX_TILESET_OVERDRIVE, Math.max(0, v))
                  patch({ overdrive: o === 1 ? undefined : o })
                }} />
              <ResetButton title='Back to 1 (the texture as drawn)' hidden={overdrive === 1}
                onClick={() => patch({ overdrive: undefined })} />
            </div>
          </PropertyRow>
        </PropertyTable>
      </div>
    </Collapsable>
  )
}

// --- Selected tiles ------------------------------------------------------------------------------------

/**
 * The frames of one tile's animation as chips in play order: each shows its position and the tile, and can
 * be nudged earlier/later or removed. Frames are ADDED by picking tiles on the atlas, not typed.
 */
function FrameStrip({ asset, tile, frames, fps, src }: { asset: TilesetAsset; tile: number; frames: number[]; fps: number; src: string }) {
  const { setTileMeta, framePick, startFramePick, finishFramePick, cancelFramePick } = useTileset()
  const picking = framePick === tile
  const write = (next: number[]) =>
    setTileMeta(tile, { ...(asset.tiles[tile] ?? {}), animation: { frames: next, fps } })

  return (
    <div className='space-y-1.5'>
      <div className='flex items-center justify-between gap-1'>
        <span className={labelClass}>Frames ({frames.length})</span>
        <span className='flex gap-1'>
          <Button size='sm' variant={picking ? 'primary' : 'default'}
            title='Click tiles on the atlas to add them as frames, in order. Right-click a tile removes its last use.'
            onClick={() => picking ? finishFramePick() : startFramePick(tile)}>
            {picking ? 'Done picking' : 'Pick on atlas'}
          </Button>
          {picking && (
            <Button size='sm' variant='ghost' title='Discard the frames picked this time (Esc)' onClick={cancelFramePick}>
              Cancel
            </Button>
          )}
          <ButtonWithConfirm size='sm' disabled={frames.length === 0} onClick={() => write([])}>Clear</ButtonWithConfirm>
        </span>
      </div>
      {frames.length === 0
        ? <Hint>No frames yet. Press “Pick on atlas”, then click the tiles in the order they play.</Hint>
        : (
          <div className='flex flex-wrap gap-1'>
            {frames.map((f, i) => (
              <span key={i}
                className='inline-flex items-center gap-1 rounded border border-border bg-surface-sunken pl-1 text-ui-sm'
                title={`Frame ${i + 1}: tile ${f}`}>
                <span className='text-warning font-semibold tabular-nums'>{i + 1}</span>
                <TileThumb asset={asset} index={f} size={20} src={src} />
                <button className='px-0.5 text-muted hover:text-fg disabled:opacity-30' disabled={i === 0}
                  title='Play earlier' onClick={() => write(moveFrame(frames, i, i - 1))}>‹</button>
                <button className='px-0.5 text-muted hover:text-fg disabled:opacity-30' disabled={i === frames.length - 1}
                  title='Play later' onClick={() => write(moveFrame(frames, i, i + 1))}>›</button>
                <button className='px-1 text-muted hover:text-danger-fg' title='Remove this frame'
                  onClick={() => write(frames.filter((_, k) => k !== i))}>×</button>
              </span>
            ))}
          </div>
        )}
      {frames.length === 1 && <Hint>Add at least one more frame for the tile to animate.</Hint>}
    </div>
  )
}

function SelectedTilesCard({ asset }: { asset: TilesetAsset }) {
  const {
    selection, setSelection, setTileMeta, setTilesMeta, edit, clipboard, setClipboard, framePick, startFramePick,
    finishFramePick,
  } = useTileset()
  const src = useAtlasSrc(asset.textureId)
  // During frame picking the atlas selects nothing; the card keeps showing the tile being animated.
  const tiles = framePick !== null ? [framePick] : selection

  const body = (() => {
    if (tiles.length === 0) return <Hint>Select one or more tiles on the atlas to edit what they mean.</Hint>

    const { primary, mixed } = selectionFieldState(asset, tiles)
    const set = (p: Partial<TileMeta>) => setTilesMeta(tiles, p)
    const first = tiles[0]
    const frames = primary.animation?.frames ?? []
    const ownOverdrive = primary.overdrive !== undefined
    const overdrive = primary.overdrive ?? asset.overdrive ?? 1

    return (
      <>
        <div className='flex items-center gap-2 mb-2'>
          <TilePreview asset={asset} index={first} size={56} />
          <div className='min-w-0 flex-1'>
            <p className={valueClass}>{tiles.length === 1 ? `Tile ${first}` : `${tiles.length} tiles`}</p>
            <p className='text-ui-xs text-muted tabular-nums'>
              {tiles.length === 1
                ? `col ${first % asset.columns}, row ${Math.floor(first / asset.columns)}`
                : `showing tile ${first}; edits apply to all`}
            </p>
            <div className='flex gap-1 mt-1'>
              <Button size='sm' title='Copy this tile’s metadata (Ctrl+C on the atlas)'
                onClick={() => setClipboard(copyableTileMeta(asset.tiles[first]))}>Copy</Button>
              <Button size='sm' disabled={!clipboard} title='Paste the copied metadata onto the selected tiles (Ctrl+V on the atlas)'
                onClick={() => clipboard && edit(prev => pasteTileMeta(prev, tiles, clipboard), 'Paste tile metadata')}>Paste</Button>
              <ButtonWithConfirm size='sm' variant='default' title='Clear the selected tiles’ metadata (Delete on the atlas)'
                onClick={() => edit(prev => clearTileMeta(prev, tiles), 'Clear tile metadata')}>Clear</ButtonWithConfirm>
            </div>
          </div>
        </div>

        <PropertyTable columns={['32%', '68%']}>
          <PropertyRow label='Collision' hint='What a body meets here: a solid block, a one-way platform (stood on from above, passed from below), or a slope or half block, solid below its line. 2D bodies read all of them; 3D bodies the solid ones.'>
            <div className='flex items-center gap-2'>
              <Select className='flex-1' value={tileCollisionPreset(primary)}
                onChange={(e) => set(tileCollisionPatch(e.target.value as TileCollisionPreset))}>
                {TILE_COLLISION_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </Select>
              <Mixed on={mixed.has('solid') || mixed.has('oneWay') || mixed.has('slope')} />
            </div>
          </PropertyRow>
          <PropertyRow label='Anchor row'>
            <div className='flex items-center gap-1'>
              <Scrub value={primary.anchorRow ?? 0} unit='rows' reset={0} onChange={(v) => set({ anchorRow: v || undefined })} />
              <Mixed on={mixed.has('anchorRow')} />
            </div>
          </PropertyRow>
          <PropertyRow label='Z bias'>
            <div className='flex items-center gap-1'>
              <Scrub value={primary.zBias ?? 0} unit='z' step={0.05} precision={2} reset={0}
                onChange={(v) => set({ zBias: v || undefined })} />
              <Mixed on={mixed.has('zBias')} />
            </div>
          </PropertyRow>
          <PropertyRow label='Span' divider>
            <div className='flex items-center gap-1'>
              <VectorInput value={[primary.spanX ?? 1, primary.spanY ?? 1]} labels={['X', 'Y']} step={1} min={1}
                precision={0} reset={[1, 1]}
                onChange={([x, y]) => {
                  const sx = Math.max(1, Math.round(x)), sy = Math.max(1, Math.round(y))
                  set({ spanX: sx > 1 ? sx : undefined, spanY: sy > 1 ? sy : undefined })
                }} />
              <Mixed on={mixed.has('spanX') || mixed.has('spanY')} />
            </div>
          </PropertyRow>

          <PropertyRow label='Tint'>
            <div className='flex items-center gap-1'>
              <ColorInput color={vec3ToHex(primary.tint ?? [1, 1, 1])}
                onChange={(c) => set({ tint: isWhite(c) ? undefined : c })} />
              <ResetButton title='Back to white (no tint)' hidden={isWhite(primary.tint)} onClick={() => set({ tint: undefined })} />
              <Mixed on={mixed.has('tint')} />
            </div>
          </PropertyRow>
          <PropertyRow label='Opacity'>
            <div className='flex items-center gap-1'>
              <Slider className='flex-1 my-0' min={0} max={1} step={0.01} value={primary.opacity ?? 1}
                onChange={(v) => set({ opacity: v >= 1 ? undefined : v })} />
              <Mixed on={mixed.has('opacity')} />
            </div>
          </PropertyRow>
          <PropertyRow label='Overdrive' divider>
            <div className='flex items-center gap-1'>
              <Slider className={cn('flex-1 my-0', !ownOverdrive && 'opacity-60')} min={0} max={OVERDRIVE_TRACK_MAX}
                step={0.05} hardMax={MAX_TILESET_OVERDRIVE} value={overdrive}
                onChange={(v) => set({ overdrive: Math.min(MAX_TILESET_OVERDRIVE, Math.max(0, v)) })} />
              {ownOverdrive
                ? <ResetButton title='Follow the tileset’s overdrive again' onClick={() => set({ overdrive: undefined })} />
                : <span className='shrink-0 text-ui-2xs text-dim' title='This tile follows the tileset’s overdrive. Move the slider to give it its own.'>tileset</span>}
              <Mixed on={mixed.has('overdrive')} />
            </div>
          </PropertyRow>

          <PropertyRow label='Animated'>
            <div className='flex items-center gap-2'>
              <Toggle
                checked={!!primary.animation}
                onChange={(c) => {
                  if (!c) { if (framePick !== null) finishFramePick(); set({ animation: undefined }); return }
                  // An animation belongs to ONE tile: turning it on narrows to the first selected tile, seeds it
                  // as frame 1 and goes straight to picking the rest on the atlas.
                  // Cancel restores the tile from BEFORE the seed, so cancelling also turns Animated back off.
                  const before = asset.tiles[first] ?? null
                  setSelection([first])
                  setTileMeta(first, { ...(asset.tiles[first] ?? {}), animation: { frames: [first], fps: 8 } })
                  startFramePick(first, before)
                }}
              />
              <Mixed on={mixed.has('animation')} />
            </div>
          </PropertyRow>
          {primary.animation && tiles.length === 1 && (
            <PropertyRow label='FPS'>
              <Slider className='my-0' min={1} max={30} step={1} hardMax={120} value={primary.animation.fps ?? 8}
                onChange={(v) => set({ animation: { frames, fps: Math.max(1, Math.round(v)) } })} />
            </PropertyRow>
          )}
        </PropertyTable>

        {primary.animation && (
          <div className='mt-2'>
            {tiles.length > 1
              ? <Hint>Select a single tile to edit its animation frames.</Hint>
              : <FrameStrip asset={asset} tile={first} frames={frames} fps={primary.animation.fps ?? 8} src={src} />}
          </div>
        )}
      </>
    )
  })()

  return (
    <Collapsable title='Selected tiles' icon={<TilesetIcon />} persistKey='tileset.tile' badge={tiles.length || undefined}>
      <div className='w-full p-2'>{body}</div>
    </Collapsable>
  )
}

// --- Lighting maps -------------------------------------------------------------------------------------

const LIGHTING_MAP_LABELS: Record<TilesetLightingMap, { label: string; title: string }> = {
  sixWayPositiveTextureId: { label: 'Six-way +', title: 'The FX Creator\'s Six-way + output: lit from the right, top and back (RGB), coverage (A).' },
  sixWayNegativeTextureId: { label: 'Six-way −', title: 'The FX Creator\'s Six-way − output: lit from the left, bottom and front (RGB), emission (A).' },
  normalTextureId: { label: 'Normal', title: 'A tangent-space normal map (OpenGL: R right, G up, B toward the viewer). The atlas is then the base colour.' },
  ormTextureId: { label: 'ORM', title: 'Occlusion (R), roughness (G) and metallic (B), beside the normal map.' },
}

/**
 * The atlases a LIT sprite (Sprite.lit) shades with, cut into the same cells as the atlas: six-way
 * lightmaps for smoke and the like, or a normal (and ORM) map for a surface. The asset's `textureIds`
 * follow, so the maps ship with whatever uses the tileset.
 */
function LightingMapsCard({ asset }: { asset: TilesetAsset }) {
  const { patch } = useTileset()
  const sixWay = !!asset.sixWayPositiveTextureId && !!asset.sixWayNegativeTextureId
  const mode = sixWay ? 'Six-way' : asset.normalTextureId ? 'Surface' : 'Flat'
  const set = (key: TilesetLightingMap, id: string | null) => {
    const next = { ...asset, [key]: id || undefined }
    patch({ [key]: id || undefined, textureIds: tilesetTextureIds(next) })
  }
  return (
    <Collapsable title='Lighting maps' icon={<LightIcon />} persistKey='tileset.lighting' defaultOpen={false} badge={mode}>
      <div className='w-full p-2'>
        <TextureSlotGrid>
          {TILESET_LIGHTING_MAPS.map(key => (
            <TextureSlotFrame key={key} label={LIGHTING_MAP_LABELS[key].label} title={LIGHTING_MAP_LABELS[key].title}>
              <TextureSlotPicker value={asset[key] ?? null} fit='contain' onChange={(id) => set(key, id)} />
            </TextureSlotFrame>
          ))}
        </TextureSlotGrid>
      </div>
    </Collapsable>
  )
}

// --- Variants ------------------------------------------------------------------------------------------

/** Variant sets: interchangeable tiles the Random brush scatters, by weight. */
function VariantsCard({ asset }: { asset: TilesetAsset }) {
  const { patch, selection, setSelection } = useTileset()
  const src = useAtlasSrc(asset.textureId)
  const write = (i: number, next: TilesetAsset['variantSets'][number]) => {
    const sets = [...asset.variantSets]
    sets[i] = next
    patch({ variantSets: sets })
  }

  return (
    <Collapsable title='Variants' icon={<DiceIcon />} persistKey='tileset.variants' defaultOpen={false}
      badge={asset.variantSets.length || undefined}>
      <div className='w-full p-2 space-y-2'>
        {asset.variantSets.map((set, i) => {
          const total = set.tiles.reduce((s, t) => s + t.weight, 0)
          return (
            <div key={set.id} className='border border-border rounded p-2 space-y-1.5'>
              <div className='flex items-center gap-1'>
                <TextInput className='flex-1' value={set.name} onChange={(name) => write(i, { ...set, name })} />
                <ButtonWithConfirm variant='remove' title='Delete this variant set'
                  onClick={() => patch({ variantSets: asset.variantSets.filter(v => v.id !== set.id) })}>✕</ButtonWithConfirm>
              </div>
              {set.tiles.map((t, k) => (
                <div key={t.index} className='flex items-center gap-2'>
                  <TileThumb asset={asset} index={t.index} size={24} src={src} title={`Tile ${t.index}`} />
                  <Slider className='flex-1 my-0' min={0} max={5} step={0.1} hardMax={100} value={t.weight}
                    onChange={(v) => {
                      const tiles = [...set.tiles]
                      tiles[k] = { ...t, weight: Math.max(0, v) }
                      write(i, { ...set, tiles })
                    }} />
                  <span className='w-9 shrink-0 text-right text-ui-xs text-muted tabular-nums'
                    title='How often the Random brush picks this tile'>
                    {total > 0 ? Math.round((t.weight / total) * 100) : 0}%
                  </span>
                  <Button variant='remove' size='icon' className='h-6 w-6 p-0 shrink-0' title='Remove this tile from the set'
                    onClick={() => write(i, { ...set, tiles: set.tiles.filter((_, j) => j !== k) })}>✕</Button>
                </div>
              ))}
              <div className='flex gap-1'>
                <Button size='sm' variant='ghost' className='flex-1' disabled={selection.length === 0}
                  onClick={() => {
                    const existing = new Set(set.tiles.map(t => t.index))
                    const tiles = [...set.tiles, ...selection.filter(x => !existing.has(x)).map(index => ({ index, weight: 1 }))]
                    write(i, { ...set, tiles })
                  }}>
                  Add {selection.length || 'no'} selected
                </Button>
                <Button size='sm' variant='ghost' disabled={set.tiles.length === 0} title='Select this set’s tiles on the atlas'
                  onClick={() => setSelection(set.tiles.map(t => t.index))}>Select on atlas</Button>
              </div>
            </div>
          )
        })}
        <Button size='sm' variant='ghost' className='w-full'
          onClick={() => {
            const id = (asset.variantSets.reduce((m, v) => Math.max(m, v.id), 0) + 1) || 1
            patch({ variantSets: [...asset.variantSets, { id, name: `Variants ${id}`, tiles: [] }] })
          }}>
          + Variant set
        </Button>
      </div>
    </Collapsable>
  )
}

// --- Auto-tiling ---------------------------------------------------------------------------------------

const WANG_KINDS: { value: WangKind; label: string }[] = [
  { value: 'edge', label: 'Edge' },
  { value: 'corner', label: 'Corner' },
  { value: 'blob', label: 'Blob' },
]

/** A terrain set's tiles in mask order — the order Assign reads a selection in, so the two round-trip. */
const ruleTilesInOrder = (rules: Record<number, number[]>): { mask: number; index: number }[] => {
  const seen = new Set<number>()
  const out: { mask: number; index: number }[] = []
  for (const mask of Object.keys(rules).map(Number).sort((a, b) => a - b)) {
    for (const index of rules[mask] ?? []) {
      if (seen.has(index)) continue
      seen.add(index)
      out.push({ mask, index })
    }
  }
  return out
}

/** Auto-tile terrain sets: a named rule table mapping neighbour masks to tiles. */
function AutoTilingCard({ asset }: { asset: TilesetAsset }) {
  const { patch, selection, setSelection } = useTileset()
  const src = useAtlasSrc(asset.textureId)
  const write = (i: number, next: TilesetAsset['terrains'][number]) => {
    const sets = [...asset.terrains]
    sets[i] = next
    patch({ terrains: sets })
  }
  const addSet = () => {
    const id = (asset.terrains.reduce((m, t) => Math.max(m, t.id), 0) + 1) || 1
    patch({ terrains: [...asset.terrains, { id, name: `Terrain ${id}`, kind: 'blob' as WangKind, tiles: {} }] })
  }

  return (
    <Collapsable title='Auto-tiling' icon={<SkyboxIcon />} persistKey='tileset.terrains' defaultOpen={false}
      badge={asset.terrains.length || undefined}>
      <div className='w-full p-2 space-y-2'>
        {asset.terrains.map((set, i) => {
          const ordered = ruleTilesInOrder(set.tiles)
          const masks = Object.keys(set.tiles).length
          return (
            <div key={set.id} className='border border-border rounded p-2 space-y-1.5'>
              <div className='flex items-center gap-1'>
                <TextInput className='flex-1' value={set.name} onChange={(name) => write(i, { ...set, name })} />
                <ButtonWithConfirm variant='remove' title='Delete this auto-tile set'
                  onClick={() => patch({ terrains: asset.terrains.filter(t => t.id !== set.id) })}>✕</ButtonWithConfirm>
              </div>
              <SegmentedControl size='sm' grow options={WANG_KINDS} value={set.kind}
                onChange={(kind) => write(i, { ...set, kind })} />
              <div className='flex items-center justify-between'>
                <span className={labelClass}>Rules</span>
                <span className='text-ui-xs text-muted tabular-nums'>{masks} mask{masks === 1 ? '' : 's'}</span>
              </div>
              {ordered.length > 0 && (
                <div className='flex flex-wrap gap-0.5'>
                  {ordered.map(({ mask, index }) => (
                    <TileThumb key={index} asset={asset} index={index} size={22} src={src} title={`Mask ${mask}: tile ${index}`} />
                  ))}
                </div>
              )}
              <div className='flex gap-1'>
                <Button size='sm' variant='ghost' className='flex-1' disabled={selection.length === 0}
                  title='Assign the selected tiles to this set and record which mask each one fills'
                  onClick={() => {
                    // Membership lives on the tile (so the painter can tell what is "the same terrain"); the rule
                    // table maps a neighbour mask to candidates. Index order is the Wang-sheet convention.
                    const tiles = { ...asset.tiles }
                    const rules: Record<number, number[]> = { ...set.tiles }
                    selection.forEach((index, k) => {
                      tiles[index] = { ...(tiles[index] ?? {}), terrain: { id: set.id, mask: k } }
                      rules[k] = [...(rules[k] ?? []), index].filter((v, j, a) => a.indexOf(v) === j)
                    })
                    const next = [...asset.terrains]
                    next[i] = { ...set, tiles: rules }
                    patch({ tiles, terrains: next })
                  }}>
                  Assign {selection.length || 'no'} selected
                </Button>
                <Button size='sm' variant='ghost' disabled={ordered.length === 0} title='Select this set’s tiles on the atlas, in mask order'
                  onClick={() => setSelection(ordered.map(t => t.index))}>Select on atlas</Button>
              </div>
            </div>
          )
        })}
        <Button size='sm' variant='ghost' className='w-full' onClick={addSet}>+ Auto-tile set</Button>
      </div>
    </Collapsable>
  )
}

export default function TilesetInspector() {
  const { asset } = useTileset()
  if (!asset) return <div className='p-2 text-ui text-muted'>No tileset open.</div>
  return (
    <div className='flex flex-col text-fg'>
      <AtlasCard asset={asset} />
      <SelectedTilesCard asset={asset} />
      <LightingMapsCard asset={asset} />
      <VariantsCard asset={asset} />
      <AutoTilingCard asset={asset} />
    </div>
  )
}


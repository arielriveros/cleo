import { Material, TextureManager } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useAssetDrop } from '../../utils/useAssetDrop'
import { buildMaterialAsset, type MaterialAsset } from '../../utils/materials'
import { Button, MenuItem, Popover, cn, hintClass } from '@cleo/app-kit/ui'
import { blankSlotSurface } from '../../utils/landscapeSlots'

// Where a landscape slot gets its surface: a library Material, or a NEW one made right here. Making a
// material used to mean a trip to the Assets panel and back; "New material" creates and registers the
// asset and links it in one click, and ✎ opens it in the material editor like any other.

/** A library material as a live one, with its textures restored the way `applyMaterialAsset` does. */
export function liveMaterial(asset: MaterialAsset): Material {
  for (const t of asset.textures || []) {
    if (t?.id && !TextureManager.Instance.getTexture(t.id))
      TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id)
  }
  return Material.parse(asset.material)
}

/**
 * Create a Material asset, add it to the library and return it. Its thumbnail is drawn when it is opened.
 * `seed` is the surface it starts from (a blank grey one by default).
 */
export function useCreateMaterial(): (name: string, seed?: Material) => MaterialAsset {
  const { addMaterial } = useCleoEngine()
  return (name: string, seed?: Material) => {
    const asset = buildMaterialAsset(seed ?? blankSlotSurface(), name, '')
    addMaterial(asset)
    return asset
  }
}

/** The library as a menu, "New material" first. Shared by a slot's picker and the add-slot menu. */
export function MaterialMenu({ onPick, onNew, close }: {
  onPick: (asset: MaterialAsset) => void
  onNew: () => void
  close: () => void
}) {
  const { materials } = useCleoEngine()
  return (
    <div data-cleo-overlay className='flex flex-col p-1 min-w-[200px] max-h-[300px] overflow-y-auto text-ui'>
      <MenuItem className='items-center text-highlight' title='Create a new Material asset and use it here'
        onClick={() => { onNew(); close() }}>+ New material</MenuItem>
      {materials.length > 0 && <div className='my-1 h-px bg-fg/10' />}
      {materials.map(m => (
        <MenuItem key={m.id} className='items-center' onClick={() => { onPick(m); close() }}
          icon={<Thumb src={m.thumbnail} />}>
          {m.name}
        </MenuItem>
      ))}
    </div>
  )
}

export interface MaterialPickerProps {
  /** The linked Material asset id, or null for an unlinked surface. */
  value: string | null
  onPick: (asset: MaterialAsset) => void
  /** Name for a material created from this picker. */
  newName: () => string
  title?: string
  /** What an unlinked surface is called. */
  placeholder?: string
  /** The surface "+ New material" starts from — the current one, so turning it into an asset loses nothing. */
  seed?: () => Material
}

/** A slot's material: thumbnail and name, a menu to swap it or make a new one, ✎ to edit it, and a drop target. */
export default function MaterialPicker({ value, onPick, newName, title, seed, placeholder = '(unlinked surface)' }: MaterialPickerProps) {
  const { materials, enterMaterialEditor } = useCleoEngine()
  const create = useCreateMaterial()
  const asset = value ? materials.find(m => m.id === value) : undefined
  const pickId = (id: string) => { const a = materials.find(m => m.id === id); if (a) onPick(a) }
  const { dragOver, dropProps } = useAssetDrop('text/cleo-material', pickId, { stopPropagation: true })

  return (
    <div className='space-y-0.5'>
      <div {...dropProps} title={title ?? 'The Material this surface draws — drop one here too'}
        className={cn('flex items-center gap-1 rounded border px-1 py-0.5', dragOver ? 'border-selected bg-control' : 'border-control')}>
        <Popover rootClassName='flex-1 min-w-0' triggerClassName='w-full' title='Choose or create a material'
          trigger={
            <span className='flex items-center gap-2 min-w-0 text-ui'>
              <Thumb src={asset?.thumbnail} />
              <span className='truncate'>{asset ? asset.name : value ? '(missing material)' : placeholder}</span>
              <span className='ml-auto text-muted'>▾</span>
            </span>
          }>
          {close => <MaterialMenu close={close} onPick={onPick} onNew={() => onPick(create(newName(), seed?.()))} />}
        </Popover>
        {asset && <Button size='sm' variant='ghost' className='px-1' title='Edit this material'
          onClick={e => { e.stopPropagation(); enterMaterialEditor(asset.id) }}>✎</Button>}
      </div>
      {value && !asset &&
        <p className={cn(hintClass, 'text-warning')}>The linked material is missing from the library; this slot’s copy still draws.</p>}
    </div>
  )
}

function Thumb({ src }: { src?: string }) {
  return (
    <span className='block w-5 h-5 shrink-0 rounded overflow-hidden bg-surface-raised border border-control'>
      {src && <img src={src} className='w-full h-full object-cover' alt='' />}
    </span>
  )
}

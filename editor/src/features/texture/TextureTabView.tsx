import { useCallback, useState } from 'react'
import { Button, SegmentedControl, TextInput } from '../../components/ui'
import { useTexture } from './TextureContext'
import TextureCanvas from './TextureCanvas'
import type { Channel } from './mipChain'

// The texture tab's main area: the image, drawn the way its settings say it is sampled. A texture has no
// 3D preview, so nothing here touches the renderer — the same shape as TilesetTabView.

const CHANNELS: { value: Channel; label: string }[] = [
  { value: 'rgb', label: 'RGB' }, { value: 'r', label: 'R' }, { value: 'g', label: 'G' },
  { value: 'b', label: 'B' }, { value: 'a', label: 'A' },
]
const TILES = [{ value: 1, label: '1x' }, { value: 3, label: '3x' }, { value: 9, label: '9x' }]

export default function TextureTabView() {
  const { asset, image, rename, save, dirty } = useTexture()
  const [channel, setChannel] = useState<Channel>('rgb')
  const [level, setLevel] = useState(0)
  const [tile, setTile] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [levels, setLevels] = useState(1)

  const onLevels = useCallback((n: number) => setLevels(Math.max(1, n)), [])

  if (!asset) return null

  const maxLevel = asset.settings.mipMap ? levels - 1 : 0

  return (
    <div className='absolute inset-0 flex flex-col bg-surface-sunken text-white'>
      <div className='h-[30px] shrink-0 flex items-center gap-2 px-2 border-b border-border bg-surface-raised'>
        <TextInput className='w-44' value={asset.name} onChange={rename} title='Texture name' />
        <span className='text-[11px] text-muted'>
          {image ? `${image.width || '?'} x ${image.height || '?'}` : 'no image'}
          {image?.mime ? ` · ${image.mime.replace('image/', '')}` : ''}
        </span>

        <div className='ml-auto flex items-center gap-1'>
          <SegmentedControl value={channel} onChange={setChannel} options={CHANNELS} size='sm' />
          <SegmentedControl value={tile} onChange={setTile} options={TILES} size='sm' />
          <Button size='sm' variant='ghost' onClick={() => setZoom(z => Math.max(0.05, z / 1.5))} title='Zoom out'>-</Button>
          <span className='text-[11px] text-muted w-10 text-center'>{Math.round(zoom * 100)}%</span>
          <Button size='sm' variant='ghost' onClick={() => setZoom(z => Math.min(32, z * 1.5))} title='Zoom in'>+</Button>
          <Button size='sm' onClick={save} disabled={!dirty} title='Save this texture (Ctrl+S)'>Save</Button>
        </div>
      </div>

      <TextureCanvas
        textureId={asset.id}
        settings={asset.settings}
        channel={channel}
        level={Math.min(level, maxLevel)}
        tile={tile}
        zoom={zoom}
        onZoom={setZoom}
        onLevels={onLevels}
      />

      <div className='h-[22px] shrink-0 flex items-center gap-3 px-2 text-[11px] text-muted border-t border-border'>
        <span>Ctrl+wheel zooms.</span>
        {asset.settings.mipMap ? (
          <span className='flex items-center gap-1'>
            Mip
            <button
              className='px-1 disabled:opacity-40'
              disabled={level <= 0}
              onClick={() => setLevel(l => Math.max(0, l - 1))}
            >&lt;</button>
            <span className='w-16 text-center'>{Math.min(level, maxLevel)} / {maxLevel}</span>
            <button
              className='px-1 disabled:opacity-40'
              disabled={level >= maxLevel}
              onClick={() => setLevel(l => Math.min(maxLevel, l + 1))}
            >&gt;</button>
          </span>
        ) : (
          <span>Mipmaps off — the GPU samples level 0 at every distance.</span>
        )}
        <span className='ml-auto'>
          Anisotropy and mip transitions need a perspective view; they apply on the GPU but cannot be shown here.
        </span>
      </div>
    </div>
  )
}

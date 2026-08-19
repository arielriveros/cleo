import React, { useRef, useState } from 'react'
import { SpriteNode } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import Collapsable from '../../../components/Collapsable'
import { TilesetAsset, toRuntimeTileset } from '../../../utils/tilesets'
import { Select, Button, Hint, cn, valueClass } from '../../../components/ui'
import { TilesetIcon } from '../sectionIcons'

// The tileset reference control on a sprite node — the sprite counterpart of MaterialSlot, and the only
// way a sprite gets an image. Assigning stores the runtime copy on the node (the sprite embeds its
// tileset the way a tilemap does), so the sprite keeps drawing even if the library is not in scope.

export function tilesetAssetOf(node: SpriteNode, tilesets: TilesetAsset[]): TilesetAsset | undefined {
  const id = node.tileset?.id
  return id ? tilesets.find(t => t.id === id) : undefined
}

export default function TilesetSlot(props: { node: SpriteNode; onChange?: () => void }) {
  const { tilesets, enterTilesetEditor, createTilesetFromImage, eventEmitter } = useCleoEngine()
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const linkedId = props.node.tileset?.id
  const asset = tilesetAssetOf(props.node, tilesets)

  const commit = () => {
    eventEmitter.emit('TEXTURES_CHANGED')
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })
    props.onChange?.()
  }

  const assign = (asset: TilesetAsset | undefined) => {
    if (!asset) return
    props.node.tileset = toRuntimeTileset(asset)
    props.node.tileIndex = 0
    commit()
  }
  const unlink = () => {
    props.node.tileset = null
    commit()
  }

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // so re-picking the same file fires again
    if (!file) return
    // The freshly created asset is not in `tilesets` yet, so it is passed straight through.
    assign(await createTilesetFromImage(file) ?? undefined)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const id = e.dataTransfer.getData('text/cleo-tileset')
    if (id) assign(tilesets.find(t => t.id === id))
  }
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('text/cleo-tileset')) { e.preventDefault(); setDragOver(true) }
  }

  return (
    <Collapsable title='Tileset' icon={<TilesetIcon />} persistKey='tilesetSlot'>
      <div className='w-full p-2' onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        <input ref={fileInput} type='file' accept='image/*' className='hidden' onChange={onPickImage} />
        {asset ? (
          <div className={`flex items-center gap-2 p-2 bg-control border rounded ${dragOver ? 'border-selected' : 'border-border'}`}>
            <div className='w-[48px] h-[48px] rounded overflow-hidden bg-surface-raised flex items-center justify-center shrink-0'>
              {asset.thumbnail
                ? <img src={asset.thumbnail} className='w-full h-full object-contain' alt={asset.name} draggable={false} />
                : <span className='text-lg'>🔳</span>}
            </div>
            <div className='flex-1 min-w-0'>
              <div className={cn(valueClass, 'truncate')} title={asset.name}>{asset.name}</div>
              <Hint>{asset.columns} × {asset.rows} tiles</Hint>
            </div>
            <Button variant='ghost' size='icon' className='text-highlight' title='Edit this tileset' onClick={() => enterTilesetEditor(asset.id)}>✎</Button>
            <Button variant='ghost' size='icon' className='text-danger' title='Unlink (the sprite draws nothing)' onClick={unlink}>✕</Button>
          </div>
        ) : (
          <div className={`flex flex-col gap-2 p-2 border-2 border-dashed rounded ${dragOver ? 'border-selected bg-border/30' : 'border-border'}`}>
            {linkedId && <Hint className='text-warning'>This sprite’s tileset is missing from the library — pick or import one below.</Hint>}
            <Button variant='success' className='w-full py-2' onClick={() => fileInput.current?.click()}
              title='Import an image and slice it into a new tileset'>
              + Tileset from image…
            </Button>
            {tilesets.length > 0 && (
              <Select value='' onChange={(e) => { if (e.target.value) assign(tilesets.find(t => t.id === e.target.value)) }}>
                <option value=''>Use existing…</option>
                {tilesets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            )}
            <Hint>…or drag a tileset from the <b>Assets</b> tab here.</Hint>
          </div>
        )}
      </div>
    </Collapsable>
  )
}

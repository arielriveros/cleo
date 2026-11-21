import { useEffect, useState } from 'react';
import { SpriteNode } from 'cleo';
import Collapsable from '@cleo/app-kit/ui/Collapsable';
import TilesetSlot, { tilesetAssetOf } from './TilesetSlot';
import SpriteAppearance from './SpriteAppearance';
import TileGrid from '../../tileset/TileGrid';
import { useCleoEngine } from '../../EngineContext';
import { useEventBus } from '../../EventBusContext';
import { Hint, DocScope } from '@cleo/app-kit/ui';
import { SpriteIcon } from '../sectionIcons';
import { DeclaredSection } from '../../properties/DeclaredSections';

// A static sprite is a tileset plus one tile. TileGrid is the same picker the tilemap palette uses, with
// rectangle selection turned off.

export default function SpriteEditor(props: {node: SpriteNode}) {
  const eventEmitter = useEventBus();
  const { tilesets } = useCleoEngine();
  const [tileIndex, setTileIndex] = useState(props.node.tileIndex);
  const [zoom, setZoom] = useState(2);
  const [, force] = useState(0); // node mutations don't trigger React; bump to re-read the tileset

  useEffect(() => { eventEmitter.emit('TEXTURES_CHANGED') }, [])

  useEffect(() => {
    setTileIndex(props.node.tileIndex);
  }, [props.node])

  const asset = tilesetAssetOf(props.node, tilesets);

  // Sprites are documented with the rest of 2D, tileset slot and appearance included.
  return (
    <DocScope page='editor/tilemap-2d'>
      <TilesetSlot node={props.node} onChange={() => { setTileIndex(props.node.tileIndex); force(x => x + 1) }} />

      <Collapsable title='Sprite' icon={<SpriteIcon />} persistKey='sprite'>
        <div className='w-full p-2'>
          {asset ? (
            <>
              <Hint className='mb-1'>Tile {tileIndex} of {asset.columns * asset.rows}</Hint>
              <TileGrid
                className='max-h-[280px]'
                asset={asset}
                selection={[tileIndex]}
                rectSelect={false}
                zoom={zoom}
                onZoomChange={setZoom}
                onSelect={(indices) => {
                  const index = indices[0] ?? 0;
                  props.node.tileIndex = index;
                  setTileIndex(props.node.tileIndex);
                  eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node });
                }}
              />
            </>
          ) : (
            <Hint>Assign a tileset above to choose which tile this sprite shows.</Hint>
          )}

          <div className='mt-2'><DeclaredSection node={props.node} of={SpriteNode} title='' /></div>
        </div>
      </Collapsable>

      <SpriteAppearance node={props.node} />
    </DocScope>
  )
}

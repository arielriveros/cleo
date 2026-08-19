import { useEffect, useState } from 'react';
import { SpriteNode } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import TilesetSlot, { tilesetAssetOf } from './TilesetSlot';
import SpriteAppearance from './SpriteAppearance';
import TileGrid from '../../tileset/TileGrid';
import { useCleoEngine } from '../../EngineContext';
import { useEventBus } from '../../EventBusContext';
import { Field, Select, Hint } from '../../../components/ui';
import { SpriteIcon } from '../sectionIcons';

// A static sprite is a tileset plus one tile. Picking that tile is the whole job, so the atlas is shown
// here rather than behind a material tab — TileGrid is the same picker the tilemap palette uses, with
// rectangle selection turned off.

export default function SpriteEditor(props: {node: SpriteNode}) {
  const eventEmitter = useEventBus();
  const { tilesets } = useCleoEngine();
  const [constraints, setConstraints] = useState(props.node.constraints);
  const [tileIndex, setTileIndex] = useState(props.node.tileIndex);
  const [zoom, setZoom] = useState(2);
  const [, force] = useState(0); // node mutations don't trigger React; bump to re-read the tileset

  useEffect(() => { eventEmitter.emit('TEXTURES_CHANGED') }, [])

  useEffect(() => {
    setConstraints(props.node.constraints);
    setTileIndex(props.node.tileIndex);
  }, [props.node])

  const asset = tilesetAssetOf(props.node, tilesets);

  return (
    <>
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

          <Field label='Constraints' className='mt-2'>
            <Select value={constraints} onChange={(e) => {
              const v = e.target.value as typeof constraints;
              props.node.constraints = v;
              setConstraints(v);
              eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node });
            }}>
              <option value='free'>Free</option>
              <option value='spherical'>Spherical</option>
              <option value='cylindrical'>Cylindrical</option>
            </Select>
          </Field>
        </div>
      </Collapsable>

      <SpriteAppearance node={props.node} />
    </>
  )
}

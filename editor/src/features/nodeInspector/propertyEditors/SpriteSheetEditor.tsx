import { useEffect, useMemo, useState } from 'react';
import { AnimatedSpriteNode, SpriteFrameSource } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import TilesetSlot, { tilesetAssetOf } from './TilesetSlot';
import SpriteAppearance from './SpriteAppearance';
import TileGrid from '../../tileset/TileGrid';
import { useCleoEngine } from '../../EngineContext';
import { PropertyTable, PropertyRow, Field, Section, NumberInput, TextInput, Toggle, Select, Hint, Button } from '../../../components/ui';
import { SpriteIcon } from '../sectionIcons';

// An animated sprite is a tileset plus an ordered list of tiles. Dragging a rectangle over the atlas
// produces that list directly, since TileGrid emits its selection row-major. The alternative source is the
// tile's own animation (TileMeta.animation), shared by every sprite that picks that tile.

export default function SpriteSheetEditor() {
  const { editorScene, selectedNode, tilesets, eventEmitter, enterTilesetEditor } = useCleoEngine();
  const [node, setNode] = useState<AnimatedSpriteNode | null>(null);

  useEffect(() => {
    if (!editorScene || !selectedNode) { setNode(null); return; }
    const n = editorScene.getNodeById(selectedNode);
    setNode(n && (n as any).nodeType === 'animatedSprite' ? n as AnimatedSpriteNode : null);
  }, [editorScene, selectedNode]);

  const [frameSource, setFrameSource] = useState<SpriteFrameSource>('node');
  const [frames, setFrames] = useState<number[]>([]);
  const [framesText, setFramesText] = useState('');
  const [tileIndex, setTileIndex] = useState(0);
  const [fps, setFps] = useState(12);
  const [loop, setLoop] = useState(true);
  const [zoom, setZoom] = useState(2);
  // The tileset lives on the engine node, which React cannot observe: `revision` is bumped whenever the
  // slot reassigns it, and is a memo dependency of the lookup below.
  const [revision, bump] = useState(0);

  useEffect(() => {
    if (!node) return;
    setFrameSource(node.frameSource);
    setFrames([...node.frames]);
    setFramesText(node.frames.join(','));
    setTileIndex(node.tileIndex);
    setFps(node.fps);
    setLoop(node.loop);
  }, [node]);

  const asset = useMemo(() => node ? tilesetAssetOf(node, tilesets) : undefined, [node, tilesets, revision]);
  const tileAnimation = asset && frameSource === 'tile' ? asset.tiles[tileIndex]?.animation : undefined;

  if (!node) return null;

  const changed = () => eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node });

  const applyFrames = (next: number[]) => {
    node.frames = next;
    setFrames(next);
    setFramesText(next.join(','));
    changed();
  };

  // The text field is the escape hatch for a non-rectangular order. Parsed leniently, and pushed to the
  // node only when it yields something usable.
  const applyFramesText = (text: string) => {
    setFramesText(text);
    const max = asset ? asset.columns * asset.rows : Infinity;
    const parsed = text.split(',').map(t => parseInt(t.trim(), 10)).filter(n => !isNaN(n) && n >= 0 && n < max);
    node.frames = parsed;
    setFrames(parsed);
    changed();
  };

  return (
    <>
      <TilesetSlot node={node} onChange={() => { setTileIndex(node.tileIndex); bump(x => x + 1) }} />

      <Collapsable title='Animated Sprite' icon={<SpriteIcon />} persistKey='animatedSprite'>
        <div className='w-full p-2'>
          <Field label='Frames from'>
            <Select value={frameSource} onChange={(e) => {
              const v = e.target.value as SpriteFrameSource;
              node.frameSource = v; setFrameSource(v); changed();
            }}>
              <option value='node'>This sprite’s frame list</option>
              <option value='tile'>The tile’s own animation</option>
            </Select>
          </Field>

          {!asset ? (
            <Hint className='mt-2'>Assign a tileset above to choose this sprite’s frames.</Hint>
          ) : frameSource === 'node' ? (
            <Section title='Frames' hint='Drag a rectangle over the atlas to set the frames, in reading order.'>
              <TileGrid
                className='max-h-[280px]'
                asset={asset}
                selection={frames}
                zoom={zoom}
                onZoomChange={setZoom}
                onSelect={(indices) => applyFrames(indices)}
                markerOf={(index) => asset.tiles[index]?.animation ? '#f2c14b' : null}
              />
              <Hint className='mt-1'>Order ({frames.length} frame{frames.length === 1 ? '' : 's'}):</Hint>
              <TextInput value={framesText} onChange={applyFramesText} placeholder='e.g. 0,1,2,3,2,1' />
            </Section>
          ) : (
            <Section title='Tile' hint='Pick the tile whose animation this sprite plays.'>
              <TileGrid
                className='max-h-[280px]'
                asset={asset}
                selection={[tileIndex]}
                rectSelect={false}
                zoom={zoom}
                onZoomChange={setZoom}
                onSelect={(indices) => {
                  node.tileIndex = indices[0] ?? 0;
                  setTileIndex(node.tileIndex);
                  changed();
                }}
                markerOf={(index) => asset.tiles[index]?.animation ? '#f2c14b' : null}
              />
              {tileAnimation ? (
                <Hint className='mt-1'>Plays {tileAnimation.frames.join(', ')} at {tileAnimation.fps} fps.</Hint>
              ) : (
                <Hint className='mt-1 text-warning'>Tile {tileIndex} has no animation — it will hold still.</Hint>
              )}
              <Button size='sm' variant='ghost' className='mt-1' onClick={() => enterTilesetEditor(asset.id)}>
                Edit in tileset…
              </Button>
            </Section>
          )}

          {frameSource === 'node' && (
            <Section title='Playback'>
              <PropertyTable columns={['45%', '55%']}>
                <PropertyRow label='FPS'>
                  <NumberInput min={0.01} step={0.01} value={fps} onChange={(v) => {
                    const f = Math.max(0.01, v); node.fps = f; setFps(f); changed();
                  }} />
                </PropertyRow>
                <PropertyRow label='Loop' divider={false}>
                  <Toggle checked={loop} onChange={(c) => { node.loop = c; setLoop(c); changed() }} />
                </PropertyRow>
              </PropertyTable>
            </Section>
          )}

          <Field label='Constraints' className='mt-2'>
            <Select value={node.constraints} onChange={(e) => {
              node.constraints = e.target.value as any; changed(); bump(x => x + 1);
            }}>
              <option value='free'>Free</option>
              <option value='spherical'>Spherical</option>
              <option value='cylindrical'>Cylindrical</option>
            </Select>
          </Field>
        </div>
      </Collapsable>

      <SpriteAppearance node={node} />
    </>
  )
}

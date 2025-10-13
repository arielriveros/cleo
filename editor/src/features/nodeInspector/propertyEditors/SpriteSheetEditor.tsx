import { useEffect, useMemo, useState } from 'react';
import { AnimatedSpriteNode } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import TextureInspector from './TextureInspector';
import { useCleoEngine } from '../../EngineContext';

export default function SpriteSheetEditor() {
  const { editorScene, selectedNode, eventEmitter } = useCleoEngine();
  const [node, setNode] = useState<AnimatedSpriteNode | null>(null);
  const animatedNode = node;

  useEffect(() => {
    if (!editorScene || !selectedNode) return;
    const n = editorScene.getNodeById(selectedNode);
    if (n && (n as any).nodeType === 'animatedSprite') setNode(n as AnimatedSpriteNode);
  }, [editorScene, selectedNode]);

  const [columns, setColumns] = useState(4);
  const [rows, setRows] = useState(4);
  const [fps, setFps] = useState(12);
  const [loop, setLoop] = useState(true);
  const [startFrame, setStartFrame] = useState(0);
  const [endFrame, setEndFrame] = useState(15);
  const [sequenceText, setSequenceText] = useState('');

  useEffect(() => {
    if (!animatedNode) return;
    setColumns(animatedNode.columns);
    setRows(animatedNode.rows);
    setFps(animatedNode.fps);
    setLoop(animatedNode.loop);
    setStartFrame(animatedNode.startFrame);
    setEndFrame(animatedNode.endFrame);
    setSequenceText(animatedNode.sequence ? animatedNode.sequence.join(',') : '');
  }, [animatedNode]);

  const maxFrames = useMemo(() => columns * rows, [columns, rows]);

  const applySequence = (text: string) => {
    setSequenceText(text);
    if (!animatedNode) return;
    const clean = text.replace(/\s/g, '');
    if (clean.length === 0) { animatedNode.sequence = null; return; }
    const arr = clean.split(',').map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 0 && n < maxFrames);
    animatedNode.sequence = arr.length > 0 ? arr : null;
  };

  if (!animatedNode) return null;

  const sprite = animatedNode.sprite;
  const material = sprite.material;

  return (
    <Collapsable title='Animated Sprite'>
      <div className='w-full p-2 space-y-3'>
        <div>
          <h5 className='m-0 mb-1 font-bold'>Sprite Sheet Texture</h5>
          <TextureInspector tex='texture' material={material} />
        </div>

        <div className='grid grid-cols-2 gap-2'>
          <label className='flex items-center gap-2'>
            <span className='w-28'>Columns</span>
            <input className='input' type='number' min={1} value={columns} onChange={(e) => {
              const v = Math.max(1, parseInt(e.target.value || '1'));
              setColumns(v); animatedNode.columns = v; setEndFrame(Math.min(endFrame, v*rows-1));
            }} />
          </label>
          <label className='flex items-center gap-2'>
            <span className='w-28'>Rows</span>
            <input className='input' type='number' min={1} value={rows} onChange={(e) => {
              const v = Math.max(1, parseInt(e.target.value || '1'));
              setRows(v); animatedNode.rows = v; setEndFrame(Math.min(endFrame, columns*v-1));
            }} />
          </label>
          <label className='flex items-center gap-2'>
            <span className='w-28'>FPS</span>
            <input className='input' type='number' min={0.01} step={0.01} value={fps} onChange={(e) => {
              const v = Math.max(0.01, parseFloat(e.target.value || '0.01'));
              setFps(v); animatedNode.fps = v;
            }} />
          </label>
          <label className='flex items-center gap-2'>
            <span className='w-28'>Loop</span>
            <input type='checkbox' checked={loop} onChange={(e)=>{ setLoop(e.target.checked); animatedNode.loop = e.target.checked; }} />
          </label>
          <label className='flex items-center gap-2'>
            <span className='w-28'>Start Frame</span>
            <input className='input' type='number' min={0} max={maxFrames-1} value={startFrame} onChange={(e) => {
              const v = Math.max(0, Math.min(parseInt(e.target.value || '0'), maxFrames-1));
              setStartFrame(v); animatedNode.startFrame = v;
            }} />
          </label>
          <label className='flex items-center gap-2'>
            <span className='w-28'>End Frame</span>
            <input className='input' type='number' min={0} max={maxFrames-1} value={endFrame} onChange={(e) => {
              const v = Math.max(0, Math.min(parseInt(e.target.value || '0'), maxFrames-1));
              setEndFrame(v); animatedNode.endFrame = v;
            }} />
          </label>
        </div>

        <div>
          <h5 className='m-0 mb-1 font-bold'>Custom Sequence</h5>
          <p className='text-xs text-slate-400 m-0'>Comma-separated frame indices. Leave empty to use range.</p>
          <input className='input w-full' value={sequenceText} onChange={(e)=>applySequence(e.target.value)} placeholder='e.g. 0,1,2,3,2,1' />
        </div>

        <div>
          <h5 className='m-0 mb-1 font-bold'>Constraints</h5>
          <select className='input' value={animatedNode.constraints} onChange={(e)=>{ animatedNode.constraints = e.target.value as any; }}>
            <option value='free'>Free</option>
            <option value='spherical'>Spherical</option>
            <option value='cylindrical'>Cylindrical</option>
          </select>
        </div>

        <FramePreview node={animatedNode} columns={columns} rows={rows} />
      </div>
    </Collapsable>
  )
}

function FramePreview({ node, columns, rows }: { node: AnimatedSpriteNode, columns: number, rows: number }) {
  const texId = node.sprite.material.textures.get('texture');
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    // texture preview uses TextureInspector popup; here we just show grid overlay label
    setSrc(null);
  }, [texId]);

  const total = columns * rows;
  return (
    <div className='mt-2 text-xs text-slate-300'>
      Frames: {total} (0..{total-1})
    </div>
  )
}

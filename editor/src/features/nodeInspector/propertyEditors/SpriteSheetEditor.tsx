import { useEffect, useMemo, useState } from 'react';
import { AnimatedSpriteNode } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import TextureInspector from './TextureInspector';
import { useCleoEngine } from '../../EngineContext';
import { PropertyTable, PropertyRow, Field, Section, NumberInput, TextInput, Toggle, Select, Hint } from '../../../components/ui';
import { SpriteIcon } from '../sectionIcons';

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

  const material = animatedNode.sprite.material;

  return (
    <Collapsable title='Animated Sprite' icon={<SpriteIcon />} persistKey='animatedSprite'>
      <div className='w-full p-2'>
        <Section title='Sprite Sheet Texture'>
          <TextureInspector tex='texture' material={material} />
        </Section>

        <Section title='Frames'>
          <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Columns'>
              <NumberInput min={1} value={columns} onChange={(v) => { const c = Math.max(1, Math.round(v)); setColumns(c); animatedNode.columns = c; setEndFrame(Math.min(endFrame, c * rows - 1)); }} />
            </PropertyRow>
            <PropertyRow label='Rows'>
              <NumberInput min={1} value={rows} onChange={(v) => { const r = Math.max(1, Math.round(v)); setRows(r); animatedNode.rows = r; setEndFrame(Math.min(endFrame, columns * r - 1)); }} />
            </PropertyRow>
            <PropertyRow label='FPS'>
              <NumberInput min={0.01} step={0.01} value={fps} onChange={(v) => { const f = Math.max(0.01, v); setFps(f); animatedNode.fps = f; }} />
            </PropertyRow>
            <PropertyRow label='Loop'>
              <Toggle checked={loop} onChange={(c) => { setLoop(c); animatedNode.loop = c; }} />
            </PropertyRow>
            <PropertyRow label='Start Frame'>
              <NumberInput min={0} max={maxFrames - 1} value={startFrame} onChange={(v) => { const f = Math.max(0, Math.min(Math.round(v), maxFrames - 1)); setStartFrame(f); animatedNode.startFrame = f; }} />
            </PropertyRow>
            <PropertyRow label='End Frame' divider={false}>
              <NumberInput min={0} max={maxFrames - 1} value={endFrame} onChange={(v) => { const f = Math.max(0, Math.min(Math.round(v), maxFrames - 1)); setEndFrame(f); animatedNode.endFrame = f; }} />
            </PropertyRow>
          </PropertyTable>
        </Section>

        <Section title='Custom Sequence'>
          <Hint className='mb-1'>Comma-separated frame indices. Leave empty to use range.</Hint>
          <TextInput value={sequenceText} onChange={applySequence} placeholder='e.g. 0,1,2,3,2,1' />
        </Section>

        <Section title='Constraints'>
          <Field label='Mode'>
            <Select value={animatedNode.constraints} onChange={(e) => { animatedNode.constraints = e.target.value as any; }}>
              <option value='free'>Free</option>
              <option value='spherical'>Spherical</option>
              <option value='cylindrical'>Cylindrical</option>
            </Select>
          </Field>
        </Section>

        <Hint>Frames: {maxFrames} (0..{maxFrames - 1})</Hint>
      </div>
    </Collapsable>
  )
}

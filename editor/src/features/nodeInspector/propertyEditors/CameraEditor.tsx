import React, { useState, useEffect } from 'react';
import { CameraNode } from 'cleo';
import Collapsable from '../../../components/Collapsable';
import { PropertyTable, PropertyRow, Select, NumberInput, Slider, Button, Hint, cn, valueClass } from '../../../components/ui';
import { CameraIcon, MaterialIcon } from '../sectionIcons';
import { useCleoEngine } from '../../EngineContext';
import { getScreenMaterialIds, applyScreenMaterials, isScreenMaterialAsset } from '../../../utils/screenMaterials';

export default function CameraEditor(props: { node: CameraNode }) {
  const [cameraState, setCameraState] = useState({
    type: props.node.camera.type,
    fov: props.node.camera.fov,
    near: props.node.camera.near,
    far: props.node.camera.far,
    left: props.node.camera.left,
    right: props.node.camera.right,
    bottom: props.node.camera.bottom,
    top: props.node.camera.top,
  });

  useEffect(() => {
    setCameraState({
      type: props.node.camera.type,
      fov: props.node.camera.fov,
      near: props.node.camera.near,
      far: props.node.camera.far,
      left: props.node.camera.left,
      right: props.node.camera.right,
      bottom: props.node.camera.bottom,
      top: props.node.camera.top,
    });
  }, [props.node]);

  useEffect(() => {
    props.node.camera.type = cameraState.type;
    props.node.camera.fov = cameraState.fov;
    props.node.camera.near = cameraState.near;
    props.node.camera.far = cameraState.far;
    props.node.camera.left = cameraState.left;
    props.node.camera.right = cameraState.right;
    props.node.camera.bottom = cameraState.bottom;
    props.node.camera.top = cameraState.top;
  }, [cameraState, props.node]);

  const set = (patch: Partial<typeof cameraState>) => setCameraState((prev) => ({ ...prev, ...patch }));

  return (
    <>
      <Collapsable title='Camera' icon={<CameraIcon />} persistKey='camera'>
        <div className='w-full p-2'>
          <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Type'>
              <Select value={cameraState.type} onChange={(e) => set({ type: e.target.value as 'perspective' | 'orthographic' })}>
                <option value='perspective'>Perspective</option>
                <option value='orthographic'>Orthographic</option>
              </Select>
            </PropertyRow>
            {cameraState.type === 'perspective' && (
              <PropertyRow label='Field of View'>
                <Slider min={1} max={179} step={1} value={cameraState.fov} onChange={(v) => set({ fov: v })} />
              </PropertyRow>
            )}
            <PropertyRow label='Near'>
              <NumberInput value={cameraState.near} onChange={(v) => set({ near: v })} />
            </PropertyRow>
            <PropertyRow label='Far' divider={cameraState.type === 'orthographic'}>
              <NumberInput value={cameraState.far} onChange={(v) => set({ far: v })} />
            </PropertyRow>
            {cameraState.type === 'orthographic' && (
              <>
                <PropertyRow label='Left'><NumberInput value={cameraState.left} onChange={(v) => set({ left: v })} /></PropertyRow>
                <PropertyRow label='Right'><NumberInput value={cameraState.right} onChange={(v) => set({ right: v })} /></PropertyRow>
                <PropertyRow label='Bottom'><NumberInput value={cameraState.bottom} onChange={(v) => set({ bottom: v })} /></PropertyRow>
                <PropertyRow label='Top' divider={false}><NumberInput value={cameraState.top} onChange={(v) => set({ top: v })} /></PropertyRow>
              </>
            )}
          </PropertyTable>
        </div>
      </Collapsable>
      <ScreenMaterialsList node={props.node} />
    </>
  );
}

// Ordered list of screen-space (post-process) custom-material passes run by this camera. Each row
// references a material asset by id; the live materials are rebuilt from the assets on every edit.
function ScreenMaterialsList(props: { node: CameraNode }) {
  const { materials, enterMaterialEditor, eventEmitter } = useCleoEngine();
  const [dragOver, setDragOver] = useState(false);
  const [, force] = useState(0); // node mutations don't trigger React; bump to re-read the list

  const ids = getScreenMaterialIds(props.node);
  const screenAssets = materials.filter(isScreenMaterialAsset);

  const commit = (nextIds: string[]) => {
    const assets = nextIds
      .map((id) => materials.find((m) => m.id === id))
      .filter((a): a is NonNullable<typeof a> => !!a);
    applyScreenMaterials(props.node, assets);
    eventEmitter.emit('SCENE_CHANGED');
    force((x) => x + 1);
  };

  const add = (id: string) => { if (id && !ids.includes(id)) commit([...ids, id]); };
  const remove = (index: number) => commit(ids.filter((_, i) => i !== index));
  const move = (index: number, dir: -1 | 1) => {
    const next = [...ids];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    commit(next);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const id = e.dataTransfer.getData('text/cleo-material');
    if (id && materials.find((m) => m.id === id && isScreenMaterialAsset(m))) add(id);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('text/cleo-material')) { e.preventDefault(); setDragOver(true); }
  };

  return (
    <Collapsable title='Screen-Space Materials' icon={<MaterialIcon />} persistKey='cameraScreenMaterials'>
      <div className={`w-full p-2 flex flex-col gap-2 ${dragOver ? 'bg-border/30' : ''}`}
        onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        {ids.map((id, i) => {
          const asset = materials.find((m) => m.id === id);
          return (
            <div key={`${id}-${i}`} className='flex items-center gap-2 p-2 bg-control border border-border rounded'>
              {asset ? (
                <>
                  <div className='w-[32px] h-[32px] rounded overflow-hidden bg-surface-raised flex items-center justify-center shrink-0'>
                    {asset.thumbnail
                      ? <img src={asset.thumbnail} className='w-full h-full object-cover' alt={asset.name} draggable={false} />
                      : <span className='text-sm'>🎨</span>}
                  </div>
                  <span className={cn(valueClass, 'truncate flex-1')} title={asset.name}>{asset.name}</span>
                  <Button variant='ghost' size='icon' className='text-highlight' title='Edit this material' onClick={() => enterMaterialEditor(asset.id)}>✎</Button>
                </>
              ) : (
                <span className={cn(valueClass, 'truncate flex-1 text-warning')} title={id}>Missing material asset</span>
              )}
              <Button variant='ghost' size='icon' title='Move up (runs earlier)' disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
              <Button variant='ghost' size='icon' title='Move down (runs later)' disabled={i === ids.length - 1} onClick={() => move(i, 1)}>↓</Button>
              <Button variant='ghost' size='icon' className='text-danger' title='Remove pass' onClick={() => remove(i)}>✕</Button>
            </div>
          );
        })}
        {screenAssets.length > 0 ? (
          <Select value='' onChange={(e) => { if (e.target.value) add(e.target.value) }}>
            <option value=''>Add screen material…</option>
            {screenAssets.filter((a) => !ids.includes(a.id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        ) : (
          <Hint>No screen-space materials in the library yet — create a material and set its custom shader Mode to <b>Screen (post-process)</b>.</Hint>
        )}
        {ids.length > 0 && <Hint>Passes run top to bottom after the built-in post-processing, before tonemapping.</Hint>}
      </div>
    </Collapsable>
  );
}

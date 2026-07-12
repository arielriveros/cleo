import { CameraNode } from 'cleo';
import { useState, useEffect } from 'react';
import Collapsable from '../../../components/Collapsable';
import { PropertyTable, PropertyRow, Select, NumberInput, Slider } from '../../../components/ui';
import { CameraIcon } from '../sectionIcons';

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
  );
}

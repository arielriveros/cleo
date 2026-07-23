import { LightProbeNode } from 'cleo';
import { useState, useEffect } from 'react';
import Collapsable from '../../../components/Collapsable';
import { PropertyTable, PropertyRow, Select, NumberInput, Slider, Button, Hint } from '../../../components/ui';
import { ProbeIcon } from '../sectionIcons';
import { useEventBus } from '../../EventBusContext';

export default function LightProbeEditor(props: { node: LightProbeNode }) {
  const [state, setState] = useState({
    resolution: props.node.resolution,
    mode: props.node.mode,
    updateFrequency: props.node.updateFrequency,
    intensity: props.node.intensity,
    sizeX: props.node.size[0],
    sizeY: props.node.size[1],
    sizeZ: props.node.size[2],
    blendDistance: props.node.blendDistance,
  });

  useEffect(() => {
    setState({
      resolution: props.node.resolution,
      mode: props.node.mode,
      updateFrequency: props.node.updateFrequency,
      intensity: props.node.intensity,
      sizeX: props.node.size[0],
      sizeY: props.node.size[1],
      sizeZ: props.node.size[2],
      blendDistance: props.node.blendDistance,
    });
  }, [props.node]);

  useEffect(() => {
    props.node.resolution = state.resolution;
    props.node.mode = state.mode;
    props.node.updateFrequency = state.updateFrequency;
    props.node.intensity = state.intensity;
    props.node.size = [state.sizeX, state.sizeY, state.sizeZ];
    props.node.blendDistance = state.blendDistance;
  }, [state, props.node]);

  const eventEmitter = useEventBus();
  // Emit from the user handlers (not the apply-effect above, which also runs on mount/node-select and would
  // false-dirty on selection). 'environment' kind marks the tab unsaved without triggering a tree rebuild.
  const update = (patch: Partial<typeof state>) => {
    setState((prev) => ({ ...prev, ...patch }));
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node });
  };

  const bounded = state.sizeX > 0 && state.sizeY > 0 && state.sizeZ > 0;

  return (
    <Collapsable title='Light Probe' icon={<ProbeIcon />} persistKey='lightProbe'>
      <div className='w-full p-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Resolution'>
            <Select value={state.resolution} onChange={(e) => update({ resolution: parseInt(e.target.value) })}>
              <option value={64}>64</option>
              <option value={128}>128</option>
              <option value={256}>256</option>
              <option value={512}>512</option>
            </Select>
          </PropertyRow>
          <PropertyRow label='Mode'>
            <Select value={state.mode} onChange={(e) => update({ mode: e.target.value as 'baked' | 'realtime' })}>
              <option value='baked'>Baked</option>
              <option value='realtime'>Real-time</option>
            </Select>
          </PropertyRow>
          {state.mode === 'realtime' && (
            <PropertyRow label='Update every (s)'>
              <NumberInput min={0} step={0.1} value={state.updateFrequency} onChange={(v) => update({ updateFrequency: v })} />
            </PropertyRow>
          )}
          <PropertyRow label='Intensity'>
            <Slider min={0} max={3} step={0.05} value={state.intensity} onChange={(v) => update({ intensity: v })} />
          </PropertyRow>
          <PropertyRow label='Size X'>
            <NumberInput min={0} step={0.5} value={state.sizeX} onChange={(v) => update({ sizeX: Math.max(0, v) })} />
          </PropertyRow>
          <PropertyRow label='Size Y'>
            <NumberInput min={0} step={0.5} value={state.sizeY} onChange={(v) => update({ sizeY: Math.max(0, v) })} />
          </PropertyRow>
          <PropertyRow label='Size Z'>
            <NumberInput min={0} step={0.5} value={state.sizeZ} onChange={(v) => update({ sizeZ: Math.max(0, v) })} />
          </PropertyRow>
          <PropertyRow label='Blend Distance' divider={false}>
            <NumberInput min={0} step={0.1} value={state.blendDistance} onChange={(v) => update({ blendDistance: Math.max(0, v) })} />
          </PropertyRow>
        </PropertyTable>
        <Hint className='mt-2'>
          {bounded
            ? 'This probe only lights meshes/pixels inside its box volume (moves and rotates with the node); the IBL feathers out over the blend distance. Set any size to 0 for an unbounded probe.'
            : 'Size 0 = unbounded: the probe affects the whole scene (legacy behavior). Set all three sizes to bound it to a box volume.'}
        </Hint>
        <Button variant='primary' size='sm' className='mt-2 w-full' onClick={() => props.node.bake()}>Bake Probe</Button>
      </div>
    </Collapsable>
  );
}

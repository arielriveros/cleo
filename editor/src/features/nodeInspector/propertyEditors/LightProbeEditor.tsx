import { LightProbeNode } from 'cleo';
import { useState, useEffect } from 'react';
import Collapsable from '../../../components/Collapsable';
import { PropertyTable, PropertyRow, Select, NumberInput, Slider, Button } from '../../../components/ui';
import { ProbeIcon } from '../sectionIcons';

export default function LightProbeEditor(props: { node: LightProbeNode }) {
  const [state, setState] = useState({
    resolution: props.node.resolution,
    mode: props.node.mode,
    updateFrequency: props.node.updateFrequency,
    intensity: props.node.intensity,
  });

  useEffect(() => {
    setState({
      resolution: props.node.resolution,
      mode: props.node.mode,
      updateFrequency: props.node.updateFrequency,
      intensity: props.node.intensity,
    });
  }, [props.node]);

  useEffect(() => {
    props.node.resolution = state.resolution;
    props.node.mode = state.mode;
    props.node.updateFrequency = state.updateFrequency;
    props.node.intensity = state.intensity;
  }, [state, props.node]);

  return (
    <Collapsable title='Light Probe' icon={<ProbeIcon />} persistKey='lightProbe'>
      <div className='w-full p-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Resolution'>
            <Select value={state.resolution} onChange={(e) => setState((prev) => ({ ...prev, resolution: parseInt(e.target.value) }))}>
              <option value={64}>64</option>
              <option value={128}>128</option>
              <option value={256}>256</option>
              <option value={512}>512</option>
            </Select>
          </PropertyRow>
          <PropertyRow label='Mode'>
            <Select value={state.mode} onChange={(e) => setState((prev) => ({ ...prev, mode: e.target.value as 'baked' | 'realtime' }))}>
              <option value='baked'>Baked</option>
              <option value='realtime'>Real-time</option>
            </Select>
          </PropertyRow>
          {state.mode === 'realtime' && (
            <PropertyRow label='Update every (s)'>
              <NumberInput min={0} step={0.1} value={state.updateFrequency} onChange={(v) => setState((prev) => ({ ...prev, updateFrequency: v }))} />
            </PropertyRow>
          )}
          <PropertyRow label='Intensity' divider={false}>
            <Slider min={0} max={3} step={0.05} value={state.intensity} onChange={(v) => setState((prev) => ({ ...prev, intensity: v }))} />
          </PropertyRow>
        </PropertyTable>
        <Button variant='primary' size='sm' className='mt-2 w-full' onClick={() => props.node.bake()}>Bake Probe</Button>
      </div>
    </Collapsable>
  );
}

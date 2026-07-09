import { LightProbeNode } from 'cleo';
import { useState, useEffect } from 'react';
import Collapsable from '../../../components/Collapsable';

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

  const number = 'bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1 w-[120px]';
  const select = 'bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1';

  return (
    <Collapsable title="Light Probe">
      <div className="w-full p-2">
        <table className='w-full border-collapse'>
          <colgroup>
            <col span={1} style={{ width: '50%' }} />
            <col span={1} style={{ width: '50%' }} />
          </colgroup>
          <tbody>
            <tr>
              <td>Resolution</td>
              <td>
                <select className={select}
                  value={state.resolution}
                  onChange={(e) => setState((prev) => ({ ...prev, resolution: parseInt(e.target.value) }))}
                >
                  <option value={64}>64</option>
                  <option value={128}>128</option>
                  <option value={256}>256</option>
                  <option value={512}>512</option>
                </select>
              </td>
            </tr>
            <tr>
              <td>Mode</td>
              <td>
                <select className={select}
                  value={state.mode}
                  onChange={(e) => setState((prev) => ({ ...prev, mode: e.target.value as 'baked' | 'realtime' }))}
                >
                  <option value="baked">Baked</option>
                  <option value="realtime">Real-time</option>
                </select>
              </td>
            </tr>
            {state.mode === 'realtime' && (
              <tr>
                <td>Update every (s)</td>
                <td>
                  <input
                    className={number}
                    type="number"
                    min="0"
                    step="0.1"
                    value={state.updateFrequency}
                    onChange={(e) => setState((prev) => ({ ...prev, updateFrequency: parseFloat(e.target.value) }))}
                  />
                </td>
              </tr>
            )}
            <tr>
              <td>Intensity</td>
              <td>
                <input
                  className='w-[160px]'
                  type="range"
                  min="0"
                  max="3"
                  step="0.05"
                  value={state.intensity}
                  onChange={(e) => setState((prev) => ({ ...prev, intensity: parseFloat(e.target.value) }))}
                />
                {state.intensity.toFixed(2)}
              </td>
            </tr>
          </tbody>
        </table>
        <button
          className='mt-2 w-full bg-[#2d2d77] hover:bg-[#3f3fb4] text-white rounded px-2 py-1 cursor-pointer'
          onClick={() => props.node.bake()}
        >
          Bake Probe
        </button>
      </div>
    </Collapsable>
  );
}

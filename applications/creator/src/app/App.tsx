import { useState } from 'react';
import Topbar from '@cleo/app-kit/ui/Topbar';
import { SegmentedControl } from '@cleo/app-kit/ui';
import { CreatorEngineProvider, useCreatorEngine } from './CreatorEngine';
import { WorldWorkspace } from '../world/ui/WorldWorkspace';
import { FxWorkspace } from '../fx/ui/FxWorkspace';

type Tool = 'world' | 'fx';
const TOOL_KEY = 'cleo_creator_tool';

function Shell() {
  const { instance, error, hasCompute } = useCreatorEngine();
  const [tool, setTool] = useState<Tool>(() => (localStorage.getItem(TOOL_KEY) as Tool) || 'world');
  const choose = (t: Tool) => { setTool(t); localStorage.setItem(TOOL_KEY, t); };

  return (
    <div className='flex flex-col h-screen w-screen overflow-hidden'>
      <Topbar>
        <span className='px-3 font-semibold tracking-[0.25em] text-ui'>CLEO CREATOR</span>
        <SegmentedControl<Tool> size='sm' value={tool} onChange={choose} options={[
          { value: 'world', label: 'World Creator', title: 'Landscape heightmaps from landforms and erosion' },
          { value: 'fx', label: 'FX Creator', title: 'Fire and smoke flipbooks from a volumetric fluid simulation' },
        ]} />
        <span className='px-3 text-ui-xs text-muted'>
          {error ? 'Engine failed' : instance ? `${instance.renderer.backend ?? ''}${hasCompute ? ' · compute' : ''}` : 'Starting engine…'}
        </span>
      </Topbar>
      <div className='flex-1 min-h-0'>
        {error && <div className='p-4 text-danger-fg'>The engine could not start: {error}</div>}
        {!error && !instance && <div className='p-4 text-dim'>Starting the engine…</div>}
        {instance && (tool === 'world' ? <WorldWorkspace /> : <FxWorkspace />)}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <CreatorEngineProvider>
      <Shell />
    </CreatorEngineProvider>
  );
}

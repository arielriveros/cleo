import { useEffect, useState, type ComponentType } from 'react';
import Topbar from '@cleo/app-kit/ui/Topbar';
import LoadingScreen from '@cleo/app-kit/feedback/LoadingScreen';
import { beginLoad } from '@cleo/app-kit/feedback/loadingStore';
import { SegmentedControl } from '@cleo/app-kit/ui';
import { webgpuAvailableInBrowser, type BackendKind } from 'cleo';
import { readBackendPreference, writeBackendPreference } from '@cleo/app-kit/renderer/backendPreference';
import { CreatorEngineProvider, useCreatorEngine } from './CreatorEngine';
import { bootLoad, booting, finishIfSettled } from './bootLoad';

type Tool = 'world' | 'fx' | 'foliage';
const TOOL_KEY = 'cleo_creator_tool';

// Each sub-application is its own code chunk, fetched the first time it is selected: World Creator's
// landform and erosion code never loads for someone who only makes FX, and the reverse.
const TOOLS: Record<Tool, { label: string; load: () => Promise<ComponentType> }> = {
  world: { label: 'World Creator', load: () => import('../world/ui/WorldWorkspace').then(m => m.WorldWorkspace) },
  fx: { label: 'FX Creator', load: () => import('../fx/ui/FxWorkspace').then(m => m.FxWorkspace) },
  foliage: { label: 'Foliage Creator', load: () => import('../foliage/ui/FoliageWorkspace').then(m => m.FoliageWorkspace) },
};

/** The stored tool, or World when nothing (or something no longer offered) is stored. */
function storedTool(): Tool {
  const v = localStorage.getItem(TOOL_KEY);
  return v && v in TOOLS ? v as Tool : 'world';
}
const loaded = new Map<Tool, ComponentType>();
const pending = new Map<Tool, Promise<ComponentType>>();

/**
 * The selected tool's component, fetched on demand. At startup the fetch reports into the boot load
 * (it runs alongside the engine's own startup); afterwards it is a short overlay over the workspace.
 */
function useToolComponent(tool: Tool): { Component: ComponentType | null; error: string | null } {
  const [, rerender] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (loaded.has(tool)) return;
    setError(null);
    const label = TOOLS[tool].label;
    const atBoot = booting();
    const load = atBoot ? bootLoad() : beginLoad(`Opening ${label}`, [{ id: 'workspace', label }], 'overlay', { showAfterMs: 120 });
    const step = load.step('workspace').start(label);
    let promise = pending.get(tool);
    if (!promise) { promise = TOOLS[tool].load(); pending.set(tool, promise); }
    promise.then(C => {
      loaded.set(tool, C);
      step.done(label);
      if (atBoot) finishIfSettled(load); else load.finish();
      rerender(x => x + 1);
    }, e => {
      pending.delete(tool);
      const message = String((e as Error)?.message ?? e);
      step.fail(message);
      load.finish();
      setError(message);
    });
  }, [tool]);
  return { Component: loaded.get(tool) ?? null, error };
}

// The graphics API is fixed when the engine builds its device, so switching stores the preference and
// reloads. Every workspace keeps its document in localStorage, so nothing is lost across the reload.
function BackendSwitch() {
  const { instance, error, hasCompute } = useCreatorEngine();
  const preference = readBackendPreference();
  const renderer = instance?.renderer as { backend?: BackendKind; backendFallbackReason?: string | null } | undefined;
  const fallback = renderer?.backendFallbackReason ?? null;
  const gpuReason = webgpuAvailableInBrowser() ? null : 'This browser does not expose navigator.gpu.';
  const choose = (b: BackendKind) => {
    if (b === preference) return;
    writeBackendPreference(b);
    location.reload();
  };

  return (
    <div className='flex items-center gap-2 px-3'>
      <SegmentedControl<BackendKind> size='sm' value={preference} onChange={choose} options={[
        { value: 'webgl2', label: 'WebGL 2', title: 'Render with WebGL 2. No compute: erosion and fluid run on the CPU. Reloads.' },
        { value: 'webgpu', label: 'WebGPU', disabled: !!gpuReason,
          title: gpuReason ?? 'Render with WebGPU. Enables GPU compute for pipe erosion and the fluid solver. Reloads.' },
      ]} />
      <span className='text-ui-xs text-muted' title={fallback ?? undefined}>
        {error ? 'Engine failed'
          : instance ? `${renderer?.backend ?? ''}${hasCompute ? ' · compute' : ''}${fallback && preference === 'webgpu' ? ' (WebGPU fell back)' : ''}`
          : 'Starting engine…'}
      </span>
    </div>
  );
}

function Shell() {
  const { instance, error } = useCreatorEngine();
  const [tool, setTool] = useState<Tool>(storedTool);
  const { Component, error: toolError } = useToolComponent(tool);
  const choose = (t: Tool) => { setTool(t); localStorage.setItem(TOOL_KEY, t); };

  return (
    <div className='flex flex-col h-screen w-screen overflow-hidden'>
      <Topbar>
        <span className='px-3 font-semibold tracking-[0.25em] text-ui'>CLEO CREATOR</span>
        <SegmentedControl<Tool> size='sm' value={tool} onChange={choose} options={[
          { value: 'world', label: 'World Creator', title: 'Landscape heightmaps from landforms and erosion' },
          { value: 'fx', label: 'FX Creator', title: 'Fire and smoke flipbooks from a volumetric fluid simulation' },
          { value: 'foliage', label: 'Foliage Creator', title: 'Grass, rocks and trees with LODs, exported as glTF' },
        ]} />
        <BackendSwitch />
      </Topbar>
      <div className='relative flex-1 min-h-0'>
        {error && <div className='p-4 text-danger-fg'>The engine could not start: {error}</div>}
        {toolError && <div className='p-4 text-danger-fg'>{TOOLS[tool].label} could not load: {toolError}</div>}
        {instance && Component && <Component key={tool} />}
        <LoadingScreen variant='overlay' subtitle='Creator' />
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

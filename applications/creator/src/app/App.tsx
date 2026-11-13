import { useEffect, useMemo, useState, type ComponentType } from 'react';
import Topbar from '@cleo/app-kit/ui/Topbar';
import LoadingScreen from '@cleo/app-kit/feedback/LoadingScreen';
import { beginLoad } from '@cleo/app-kit/feedback/loadingStore';
import { Button, SegmentedControl } from '@cleo/app-kit/ui';
import { webgpuAvailableInBrowser, type BackendKind } from 'cleo';
import { readBackendPreference, writeBackendPreference } from '@cleo/app-kit/renderer/backendPreference';
import { CreatorEngineProvider, useCreatorEngine } from './CreatorEngine';
import { bootLoad, booting, finishIfSettled, LOGO, LOGO_PIXELS } from './bootLoad';

import { APPS, CreatorShellContext, appLabel, type AppId, type Tool } from './shell';
import { Home } from './Home';
const TOOL_KEY = 'cleo_creator_tool';

// Each sub-application is its own code chunk, fetched the first time it is selected: World Creator's
// landform and erosion code never loads for someone who only makes FX, and the reverse.
const TOOLS: Record<AppId, () => Promise<ComponentType>> = {
  world: () => import('../world/ui/WorldWorkspace').then(m => m.WorldWorkspace),
  fx: () => import('../fx/ui/FxWorkspace').then(m => m.FxWorkspace),
  foliage: () => import('../foliage/ui/FoliageWorkspace').then(m => m.FoliageWorkspace),
  motion: () => import('../motion/ui/MotionWorkspace').then(m => m.MotionWorkspace),
};

/**
 * Where the Creator opens: the app it was showing when the page reloads (a backend switch reloads), the
 * home page otherwise. Kept per tab (sessionStorage), so a new window always starts at home.
 */
function storedTool(): Tool {
  const v = sessionStorage.getItem(TOOL_KEY);
  return v && v in TOOLS ? v as Tool : 'home';
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
    if (tool === 'home') {
      // No app to fetch: the startup load has nothing more to wait for from the Shell.
      if (booting()) { const load = bootLoad(); load.step('workspace').skip('Home'); finishIfSettled(load); }
      return;
    }
    if (loaded.has(tool)) return;
    setError(null);
    const label = appLabel(tool);
    const atBoot = booting();
    const load = atBoot ? bootLoad() : beginLoad(`Opening ${label}`, [{ id: 'workspace', label }], 'overlay', { showAfterMs: 120 });
    const step = load.step('workspace').start(label);
    let promise = pending.get(tool);
    if (!promise) { promise = TOOLS[tool](); pending.set(tool, promise); }
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
  return { Component: tool === 'home' ? null : loaded.get(tool) ?? null, error };
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

/** The editor that opened this window, or a new one: both share this origin's Creator library. */
function openEditor() {
  const opener = window.opener as Window | null;
  if (opener && !opener.closed) { opener.focus(); return; }
  window.open(`${location.origin}/`, 'cleo-editor');
}

function Shell() {
  const { instance, error } = useCreatorEngine();
  const [tool, setTool] = useState<Tool>(storedTool);
  const { Component, error: toolError } = useToolComponent(tool);
  const choose = (t: Tool) => { setTool(t); sessionStorage.setItem(TOOL_KEY, t); };
  const shell = useMemo(() => ({ tool, choose }), [tool]);  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <CreatorShellContext.Provider value={shell}>
    <div className='flex flex-col h-screen w-screen overflow-hidden'>
      <Topbar>
        <span className='px-3 font-semibold tracking-[0.25em] text-ui'>CLEO CREATOR</span>
        {tool !== 'home' && <>
          <Button size='sm' variant='ghost' className='gap-1' onClick={() => choose('home')}
                  title='Back to the home page, to open another app'>
            <svg className='w-3.5 h-3.5' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'
                 strokeLinecap='round' strokeLinejoin='round'><path d='M3 11l9-8 9 8' /><path d='M5 10v10h14V10' /></svg>
            Home
          </Button>
          <span className='px-2 text-ui text-fg' title={APPS.find(a => a.id === tool)?.description}>{appLabel(tool)}</span>
        </>}
        <BackendSwitch />
        <div className='flex-1' />
        <Button size='sm' variant='ghost' className='mr-2' onClick={openEditor}
                title='Switch to the Cleo Editor. Assets saved here appear there under /Creator, in every project.'>Cleo Editor</Button>
      </Topbar>
      <div className='relative flex-1 min-h-0'>
        {error && <div className='p-4 text-danger-fg'>The engine could not start: {error}</div>}
        {toolError && <div className='p-4 text-danger-fg'>{appLabel(tool)} could not load: {toolError}</div>}
        {tool === 'home' ? <Home /> : instance && Component && <Component key={tool} />}
        <LoadingScreen variant='overlay' subtitle='Creator' logo={LOGO} logoPixels={LOGO_PIXELS} />
      </div>
    </div>
    </CreatorShellContext.Provider>
  );
}

export default function App() {
  return (
    <CreatorEngineProvider>
      <Shell />
    </CreatorEngineProvider>
  );
}

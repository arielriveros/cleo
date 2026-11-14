import { useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from 'react';
import Topbar from '@cleo/app-kit/ui/Topbar';
import LoadingScreen from '@cleo/app-kit/feedback/LoadingScreen';
import { beginLoad } from '@cleo/app-kit/feedback/loadingStore';
import { AboutDialog, AppMenuBar, LogoButton, ShortcutsDialog, type MenuSpec } from '@cleo/app-kit/ui';
import { webgpuAvailableInBrowser, type BackendKind } from 'cleo';
import { readBackendPreference, writeBackendPreference } from '@cleo/app-kit/renderer/backendPreference';
import { CreatorEngineProvider, useCreatorEngine } from './CreatorEngine';
import { bootLoad, booting, finishIfSettled, LOGO, LOGO_PIXELS } from './bootLoad';

import { APPS, CreatorShellContext, appLabel, type AppId, type Tool } from './shell';
import { Home } from './Home';
import { creatorMenu } from './menuStore';
import { VERSION_LABEL } from '../version';
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
function useBackendChoice() {
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
  // What is running: the backend, compute, and a WebGPU request that fell back.
  const status = error ? 'Engine failed'
    : instance ? `${renderer?.backend ?? ''}${hasCompute ? ' · compute' : ''}${fallback && preference === 'webgpu' ? ' (WebGPU fell back)' : ''}`
    : 'Starting engine…';
  return { preference, gpuReason, fallback, choose, status };
}

/** The editor that opened this window, or a new one: both share this origin's Creator library. */
function openEditor() {
  const opener = window.opener as Window | null;
  if (opener && !opener.closed) { opener.focus(); return; }
  window.open(`${location.origin}/`, 'cleo-editor');
}

const glyph = (d: string) => (
  <svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round'
       strokeLinejoin='round'><path d={d} /></svg>
);

/**
 * The Creator's menu bar, laid out like the editor's (File, Edit, View, Project, Help). Its own component,
 * subscribed to what the open app offers (menuStore), so the app re-publishing every render redraws only
 * this and never the app itself.
 */
function CreatorMenus({ tool }: { tool: Tool }) {
  const source = useSyncExternalStore(creatorMenu.subscribe, creatorMenu.getSnapshot);
  const backend = useBackendChoice();
  const [dialog, setDialog] = useState<'shortcuts' | 'about' | null>(null);
  const asset = tool === 'home' ? undefined : source?.asset;
  const action = tool === 'home' ? undefined : source?.primaryAction;
  const noApp = tool === 'home' || !source;

  const menus: MenuSpec[] = [
    {
      id: 'file', label: 'File', items: [
        asset?.active
          ? { kind: 'item', label: 'Rename Asset…', icon: glyph('M4 20h4L19 9l-4-4L4 16Z M13.5 6.5l4 4'),
              title: 'The files it writes, and its copy in the editor, take the new name', onSelect: () => void asset.rename() }
          : { kind: 'item', label: 'Save as Asset…', icon: glyph('M4 4h11l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z M8 4v5h7'),
              disabled: !asset, title: 'Name this as an asset: it appears in the editor under /Creator and follows every change',
              onSelect: () => void asset?.saveAs() },
        { kind: 'item', label: 'Close Asset', icon: glyph('M6 6l12 12M18 6 6 18'), disabled: !asset?.active,
          title: 'Back to Scratch: stop editing this asset (it stays in the library, in Assets)', onSelect: () => void asset?.open(null) },
        { kind: 'separator' },
        { kind: 'item', label: action?.label ?? 'Export', icon: glyph('M12 14V4 M8 7.5l4-4 4 4 M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3'),
          disabled: !action || action.disabled, title: action?.title, onSelect: () => action?.onClick() },
      ],
    },
    {
      id: 'edit', label: 'Edit', items: [
        { kind: 'item', label: 'Undo', icon: glyph('M9 14 4 9l5-5 M4 9h9a7 7 0 0 1 0 14h-3'), shortcut: 'Ctrl+Z', disabled: true,
          title: 'Cleo Creator keeps no undo history yet', onSelect: () => {} },
        { kind: 'item', label: 'Redo', icon: glyph('m15 14 5-5-5-5 M20 9h-9a7 7 0 0 0 0 14h3'), shortcut: 'Ctrl+Shift+Z', disabled: true,
          title: 'Cleo Creator keeps no undo history yet', onSelect: () => {} },
      ],
    },
    {
      id: 'view', label: 'View', items: [
        { kind: 'item', label: 'Frame', icon: glyph('M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4'),
          shortcut: 'F', disabled: noApp || !source?.onFrame, title: 'Frame what this app is building', onSelect: () => source?.onFrame?.() },
        { kind: 'item', label: 'Reset Layout', icon: glyph('M3 4h18v16H3Z M9 4v16 M9 12h12'), disabled: noApp || !source?.resetLayout,
          title: "Restore this app's default panel layout", onSelect: () => source?.resetLayout?.() },
        { kind: 'separator' },
        { kind: 'item', label: 'WebGL 2', checked: backend.preference === 'webgl2',
          title: 'Render with WebGL 2. No compute: erosion and fluid run on the CPU. Reloads.', onSelect: () => backend.choose('webgl2') },
        { kind: 'item', label: 'WebGPU', checked: backend.preference === 'webgpu', disabled: !!backend.gpuReason,
          title: backend.gpuReason ?? 'Render with WebGPU. Enables GPU compute for pipe erosion and the fluid solver. Reloads.',
          onSelect: () => backend.choose('webgpu') },
      ],
    },
    {
      id: 'project', label: 'Project', items: [
        { kind: 'item', label: 'Open Cleo Editor', icon: glyph('M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'),
          title: 'Switch to the Cleo Editor. Assets saved here appear there under /Creator, in every project.', onSelect: openEditor },
      ],
    },
    {
      id: 'help', label: 'Help', items: [
        { kind: 'item', label: 'Keyboard Shortcuts…', icon: glyph('M2.5 6h19v12h-19Z M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9'),
          onSelect: () => setDialog('shortcuts') },
        { kind: 'item', label: 'About Cleo Creator…', icon: glyph('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M12 11v5 M12 8h.01'),
          onSelect: () => setDialog('about') },
      ],
    },
  ];

  return <>
    <AppMenuBar menus={menus} />
    <span className='px-2 text-ui-xs text-muted' title={backend.fallback ?? undefined}>{backend.status}</span>
    {dialog === 'shortcuts' && <ShortcutsDialog page='creator/index' anchor='keyboard-shortcuts' onClose={() => setDialog(null)} />}
    {dialog === 'about' && (
      <AboutDialog appName='Cleo Creator' version={VERSION_LABEL} logo={LOGO}
                   lines={['World, FX, foliage and motion assets for the Cleo Engine.']} onClose={() => setDialog(null)} />
    )}
  </>;
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
        <div className='flex items-center gap-1 h-full px-1.5 min-w-0'>
          {/* The Creator's home: the apps to choose from. */}
          <LogoButton src={LOGO} title='Cleo Creator: home, to open another app' onClick={() => choose('home')} />
          <CreatorMenus tool={tool} />
        </div>
        {tool !== 'home' && (
          <span className='px-2 text-ui text-fg' title={APPS.find(a => a.id === tool)?.description}>{appLabel(tool)}</span>
        )}
        <div className='w-[120px]' />
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

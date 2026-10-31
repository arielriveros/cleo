import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import type { DockviewApi, IDockviewPanelProps } from 'dockview-react';
import { DockShell } from '@cleo/app-kit/layout/DockShell';
import ConsolePanel from '@cleo/app-kit/feedback/ConsolePanel';
import { ViewportHost } from '@cleo/app-kit/engine/ViewportHost';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import { Button, Collapsable, DocScope, PresetMenu, VisibilityMenu, cn, type PresetMenuEntry, type VisibilityItem } from '@cleo/app-kit/ui';
import type { GenerationStatus } from '../core/useGeneration';
import { GenerationBar } from './StatusBar';

// The one layout every Creator mode is built from, so World, FX and Foliage read the same:
//
//   toolbar      mode tools on the left · the saved asset · status text · the primary output action on the right
//   left dock    what is being built (layers, scene, variants), 280 px
//   viewport     the live 3D preview: a stats readout top-left; visibility, mode controls and Frame top-right
//   right dock   Parameters first, then the mode's other tabs (Materials, LOD, Bake, Export), 340 px
//   bottom       Console (and any mode extras as tabs beside it)
//   status bar   the running job's progress, or the last result's summary
//
// Panels draw through `PanelHeader` (kind · preset name, Reset, Presets ▾), `SchemaSections` (one
// collapsable per schema group) and `PanelBody`, so headers, sections and padding match across modes.
// F frames the asset in every mode; a mode adds its own keys through `hotkeys`.

export interface WorkspacePanel {
  id: string;
  title: string;
  render: () => ReactNode;
}

export interface PrimaryAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

export interface CreatorWorkspaceProps {
  /** Storage prefix: the dock layout is kept under `cleo_creator_<id>_layout`. */
  id: string;
  /** Docs page the workspace's titles resolve against. */
  page: string;
  toolbar: ReactNode;
  /** The saved-asset controls (core/useCreatorAsset AssetBar), right of the mode's tools. */
  asset?: ReactNode;
  /** Dim text before the primary action (what is running, which backend). */
  toolbarStatus?: ReactNode;
  primaryAction?: PrimaryAction;
  left: WorkspacePanel;
  /** The first is active; the Parameters panel by convention. */
  right: WorkspacePanel[];
  /** Tabs beside the Console. */
  bottom?: WorkspacePanel[];
  /** Overlay drawn over the viewport (a `ViewportOverlay`, gizmos). */
  viewport: ReactNode;
  viewportRef?: RefObject<HTMLDivElement>;
  generation: { status: GenerationStatus; onCancel: () => void; idle?: string };
  /** F: frame the asset. */
  onFrame?: () => void;
  /** Extra single-key shortcuts (lower case), not while typing into a field. */
  hotkeys?: Record<string, () => void>;
}

/** Bumped when the default layout changes, so stored layouts are rebuilt. */
const LAYOUT_VERSION = 10;
const LEFT_WIDTH = 280;
const RIGHT_WIDTH = 340;

const Renderers = createContext<Record<string, () => ReactNode>>({});

function PanelSlot({ id }: { id: string }) {
  const render = useContext(Renderers)[id];
  return <>{render?.()}</>;
}

export function CreatorWorkspace(props: CreatorWorkspaceProps) {
  const { id, page, toolbar, asset, toolbarStatus, primaryAction, left, right, bottom = [], viewport, viewportRef, generation } = props;

  const renderers: Record<string, () => ReactNode> = {
    viewport: () => <ViewportHost viewportRef={viewportRef}>{viewport}</ViewportHost>,
    console: () => <ConsolePanel />,
  };
  for (const p of [left, ...right, ...bottom]) renderers[p.id] = p.render;

  // Dockview wants a stable component map and layout builder; both follow only the panel ids and titles.
  const shape = JSON.stringify([left, right, bottom].map(g => (Array.isArray(g) ? g : [g]).map(p => [p.id, p.title])));
  const components = useMemo(() => {
    const ids = ['viewport', 'console', left.id, ...right.map(p => p.id), ...bottom.map(p => p.id)];
    return Object.fromEntries(ids.map(pid => [pid, (_: IDockviewPanelProps) => <PanelSlot id={pid} />]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);
  const buildDefault = useMemo(() => (api: DockviewApi) => {
    api.addPanel({ id: 'viewport', component: 'viewport', title: 'Viewport' });
    api.addPanel({ id: left.id, component: left.id, title: left.title, position: { referencePanel: 'viewport', direction: 'left' }, initialWidth: LEFT_WIDTH });
    right.forEach((p, i) => api.addPanel({
      id: p.id, component: p.id, title: p.title, initialWidth: RIGHT_WIDTH,
      position: i === 0 ? { referencePanel: 'viewport', direction: 'right' } : { referencePanel: right[0].id, direction: 'within' },
    }));
    const below = [...bottom, { id: 'console', title: 'Console' }];
    below.forEach((p, i) => api.addPanel({
      id: p.id, component: p.id, title: p.title, initialHeight: bottom.length ? 300 : 160,
      position: i === 0 ? { referencePanel: 'viewport', direction: 'below' } : { referencePanel: below[0].id, direction: 'within' },
    }));
    if (right[0]) api.getPanel(right[0].id)?.api.setActive();
    if (below[0]) api.getPanel(below[0].id)?.api.setActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  // F frames, plus the mode's own keys. Not while typing into a field.
  const keys = useRef<Record<string, () => void>>({});
  keys.current = { ...(props.hotkeys ?? {}), ...(props.onFrame ? { f: props.onFrame } : {}) };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || t?.closest?.('input, textarea, select, [contenteditable]')) return;
      const run = keys.current[e.key.toLowerCase()];
      if (!run) return;
      run();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Renderers.Provider value={renderers}>
      <DocScope page={page}>
        <div className='flex flex-col h-full'>
          <div className='toolbar'>
            {toolbar}
            {asset && <div className='border-l border-border pl-2 ml-1'>{asset}</div>}
            <div className='flex-1' />
            {toolbarStatus && <span className='text-dim'>{toolbarStatus}</span>}
            {primaryAction && (
              <Button size='sm' variant='primary' title={primaryAction.title} disabled={primaryAction.disabled} onClick={primaryAction.onClick}>
                {primaryAction.label}
              </Button>
            )}
          </div>
          <div className='flex-1 min-h-0'>
            <DockShell components={components} storageKey={`cleo_creator_${id}_layout`} version={LAYOUT_VERSION} buildDefault={buildDefault} anchorPanel='viewport' />
          </div>
          <GenerationBar status={generation.status} onCancel={generation.onCancel} idle={generation.idle} />
        </div>
      </DocScope>
    </Renderers.Provider>
  );
}

/** A dock panel's scrolling body, the same padding in every mode. */
export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('p-2 overflow-auto h-full flex flex-col gap-1', className)}>{children}</div>;
}

export interface PanelHeaderProps<P extends PresetMenuEntry> {
  /** What is being edited ("Tree", "Effect", "World"). */
  kind: string;
  /** Its preset or file name, shown brighter. */
  name?: string;
  onReset?: () => void;
  presets?: readonly P[];
  onPreset?: (preset: P) => void;
  presetLabel?: string;
  /** Anything else for the right side. */
  right?: ReactNode;
}

/** The row at the top of a panel: kind · name on the left, Reset and Presets ▾ on the right. */
export function PanelHeader<P extends PresetMenuEntry>({ kind, name, onReset, presets, onPreset, presetLabel, right }: PanelHeaderProps<P>) {
  return (
    <div className='flex items-center gap-2 pb-1'>
      <span className='flex-1 min-w-0 truncate text-ui-sm text-muted'>
        {kind}{name !== undefined && <> · <span className='text-fg'>{name}</span></>}
      </span>
      {right}
      {onReset && <Button size='sm' variant='ghost' onClick={onReset}>Reset</Button>}
      {presets && onPreset && <PresetMenu label={presetLabel ?? 'Presets'} presets={presets} onApply={onPreset} />}
    </div>
  );
}

export interface SchemaGroup { title: string; specs: GenericParamSpec[] }

/** One collapsable per schema group, each a ParamForm over the same values. */
export function SchemaSections({ groups, values, onChange, persist, right }: {
  groups: readonly SchemaGroup[];
  values: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  /** Persist-key prefix, unique per panel. */
  persist: string;
  /** A section's header extra (a section Presets ▾). */
  right?: (title: string) => ReactNode;
}) {
  return (<>
    {groups.map(group => (
      <Collapsable key={group.title} title={group.title} persistKey={`${persist}_${group.title}`} right={right?.(group.title)}>
        <ParamForm schema={group.specs} values={values} onChange={onChange} />
      </Collapsable>
    ))}
  </>);
}

/** The viewport's floating chrome, the same in every mode. */
export function ViewportOverlay({ readout, visibility, controls, onFrame, frameTitle = 'Frame the asset (F)' }: {
  /** Top-left numbers. */
  readout?: ReactNode;
  visibility?: VisibilityItem[];
  /** Mode controls between the visibility menu and Frame (gizmo modes, a LOD picker). */
  controls?: ReactNode;
  onFrame?: () => void;
  frameTitle?: string;
}) {
  return (<>
    {readout && (
      <div data-cleo-overlay className='absolute left-2 top-2 rounded bg-surface/80 px-2 py-1 text-ui-xs text-muted tabular-nums pointer-events-none'>
        {readout}
      </div>
    )}
    <div data-cleo-overlay className='absolute top-2 right-2 z-20 flex items-center gap-2'>
      {visibility && visibility.length > 0 && <VisibilityMenu items={visibility} />}
      {controls}
      {onFrame && <Button size='sm' variant='ghost' className='bg-surface-raised/80' title={frameTitle} onClick={onFrame}>Frame</Button>}
    </div>
  </>);
}

/** A selectable row in a left-dock list (layers, scene outliner, presets, variants). */
export function ListRow({ selected, onClick, children, leading, actions, title, caption }: {
  selected?: boolean;
  /** Before the label (a toggle); clicks there do not select the row. */
  leading?: ReactNode;
  onClick?: () => void;
  children: ReactNode;
  /** Shown at the right; clicks there do not select the row. */
  actions?: ReactNode;
  title?: string;
  /** A second, dimmer line. */
  caption?: ReactNode;
}) {
  return (
    <div title={title} onClick={onClick}
         className={cn('group flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer text-ui-sm',
                       selected ? 'bg-primary/25 text-fg' : 'text-muted hover:bg-surface-raised hover:text-fg')}>
      {leading && <span className='flex items-center' onClick={e => e.stopPropagation()}>{leading}</span>}
      <div className='flex-1 min-w-0'>
        <div className='truncate'>{children}</div>
        {caption && <div className='text-ui-xs text-dim truncate'>{caption}</div>}
      </div>
      {actions && <span className='flex items-center' onClick={e => e.stopPropagation()}>{actions}</span>}
    </div>
  );
}

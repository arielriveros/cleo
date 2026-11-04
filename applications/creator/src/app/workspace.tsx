import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import type { DockviewApi, IDockviewPanelProps } from 'dockview-react';
import { isTextEntryEvent } from 'cleo';
import { DockShell } from '@cleo/app-kit/layout/DockShell';
import ConsolePanel from '@cleo/app-kit/feedback/ConsolePanel';
import { ViewportHost } from '@cleo/app-kit/engine/ViewportHost';
import { ParamForm } from '@cleo/app-kit/params/ParamForm';
import type { GenericParamSpec } from '@cleo/app-kit/params/ParamField';
import {
  Button, Collapsable, DocHover, DocScope, EyeIcon, PauseIcon, PlayIcon, Popover, PresetMenu, RestartIcon, Slider, Toggle, cn, useDocEntry,
  type PresetMenuEntry, type VisibilityItem,
} from '@cleo/app-kit/ui';
import type { GenerationStatus } from '../core/useGeneration';
import { GenerationBar } from './StatusBar';
import { AssetsPanel } from './AssetsPanel';

// The one layout every Creator mode is built from, so World, FX and Foliage read the same:
//
//   toolbar      mode tools on the left · the saved asset's chip · status text · the primary output action on the right
//   left dock    what is being built (layers, scene, poses), 280 px; a mode with nothing to list has none
//   viewport     the live 3D preview: a stats readout top-left; the Stage menu, mode controls and Frame top-right;
//                a playback bar bottom-centre for a mode that simulates
//   right dock   Parameters first, then the mode's other tabs (Materials, LOD, Bake, Export), 340 px
//   bottom       Assets (the shared library, app/AssetsPanel.tsx) and Console, and any mode extras beside them
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
  left?: WorkspacePanel;
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
const LAYOUT_VERSION = 13;
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
    assets: () => <AssetsPanel />,
  };
  const lefts = left ? [left] : [];
  for (const p of [...lefts, ...right, ...bottom]) renderers[p.id] = p.render;

  // Dockview wants a stable component map and layout builder; both follow only the panel ids and titles.
  const shape = JSON.stringify([lefts, right, bottom].map(g => g.map(p => [p.id, p.title])));
  const components = useMemo(() => {
    const ids = ['viewport', 'console', 'assets', ...lefts.map(p => p.id), ...right.map(p => p.id), ...bottom.map(p => p.id)];
    return Object.fromEntries(ids.map(pid => [pid, (_: IDockviewPanelProps) => <PanelSlot id={pid} />]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);
  const buildDefault = useMemo(() => (api: DockviewApi) => {
    api.addPanel({ id: 'viewport', component: 'viewport', title: 'Viewport' });
    if (left) api.addPanel({ id: left.id, component: left.id, title: left.title, position: { referencePanel: 'viewport', direction: 'left' }, initialWidth: LEFT_WIDTH });
    right.forEach((p, i) => api.addPanel({
      id: p.id, component: p.id, title: p.title, initialWidth: RIGHT_WIDTH,
      position: i === 0 ? { referencePanel: 'viewport', direction: 'right' } : { referencePanel: right[0].id, direction: 'within' },
    }));
    const below = [...bottom, { id: 'assets', title: 'Assets' }, { id: 'console', title: 'Console' }];
    below.forEach((p, i) => api.addPanel({
      id: p.id, component: p.id, title: p.title, initialHeight: bottom.length ? 300 : 220,
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
      if (e.ctrlKey || e.metaKey || e.altKey || isTextEntryEvent(e)) return;
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

/** The groups with at least one field showing for these values: a group whose every field is hidden
 *  (Twigs on a two-level tree) is left out rather than drawn as an empty header. */
export function visibleGroups<G extends SchemaGroup>(groups: readonly G[], values: Record<string, unknown>): G[] {
  return groups.filter(g => g.specs.some(spec => !spec.when || spec.when(values)));
}

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
    {visibleGroups(groups, values).map(group => (
      <Collapsable key={group.title} title={group.title} persistKey={`${persist}_${group.title}`} right={right?.(group.title)}>
        <ParamForm schema={group.specs} values={values} onChange={onChange} />
      </Collapsable>
    ))}
  </>);
}

/** What the viewport's Stage menu holds (see `ViewportOverlay`). */
export interface StageMenuProps {
  /** Show / hide switches: the grid, the floor, and the mode's own (the skeleton, wind, wireframe). */
  toggles?: VisibilityItem[];
  /** The sun over the stage, in degrees. */
  sun?: { yaw: number; elevation: number; onChange: (yaw: number, elevation: number) => void };
  /** The mode's own sections below (`StageSection`s: light, wind, weather). */
  extra?: ReactNode;
  /** Whole-stage presets (a `PresetMenu`), at the top of the menu. */
  presets?: ReactNode;
}

/** A titled section of the Stage menu; the title has its docs card. `right`: beside it (the section's presets). */
export function StageSection({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  const entry = useDocEntry(title);
  return (
    <div className='flex flex-col'>
      <div className='flex items-center justify-between gap-2'>
        <DocHover as='div' entry={entry} className='pb-0.5 text-ui-xs font-semibold uppercase tracking-wide text-muted'>{title}</DocHover>
        {right}
      </div>
      {children}
    </div>
  );
}

/** A Show row: the label (with its docs card) and its switch. */
function StageToggle({ item }: { item: VisibilityItem }) {
  const entry = useDocEntry(item.label, item.doc);
  return (<>
    <DocHover as='div' entry={entry} className='py-0.5 text-ui text-fg'>{item.label}</DocHover>
    <div className='flex justify-center'><Toggle checked={item.checked} onChange={item.onChange} /></div>
  </>);
}

const STAGE_TRIGGER = 'flex items-center gap-1 h-[25px] px-2 rounded border border-control-hover bg-surface-raised/80 hover:bg-surface-raised text-fg text-ui-sm cursor-pointer';

/** The viewport's Stage menu: what the preview shows, the sun over it, and the mode's own stage settings. */
function StageMenu({ toggles = [], sun, extra, presets }: StageMenuProps) {
  return (
    <Popover align='right' title='The preview stage: what it shows, and the light on it' triggerClassName={STAGE_TRIGGER}
             trigger={<><EyeIcon /><span>Stage</span></>} className='w-[290px]'>
      <div data-cleo-overlay className='flex max-h-[70vh] flex-col gap-3 overflow-auto p-2'>
        {presets && <div className='flex justify-end'>{presets}</div>}
        {toggles.length > 0 && (
          <StageSection title='Show'>
            <div className='grid grid-cols-[1fr_auto] items-center gap-x-3'>
              {toggles.map(item => <StageToggle key={item.key} item={item} />)}
            </div>
          </StageSection>
        )}
        {sun && (
          <StageSection title='Sun'>
            <Slider label='Direction (°)' min={-180} max={180} step={1} readout value={sun.yaw} onChange={v => sun.onChange(v, sun.elevation)} />
            <Slider label='Elevation (°)' min={-10} max={90} step={1} readout value={sun.elevation} onChange={v => sun.onChange(sun.yaw, v)} />
          </StageSection>
        )}
        {extra}
      </div>
    </Popover>
  );
}

/** What the viewport's playback bar drives: a live simulation that plays through and, a one-shot, replays. */
export interface PlaybackBarProps {
  playing: boolean;
  onPlayPause: () => void;
  onRestart: () => void;
  speed: number;
  onSpeed: (speed: number) => void;
  /**
   * Where the play-through is, read every frame: simulated seconds since it started, and how long one
   * play-through lasts before it replays (Infinity for one that never ends). Null before it starts.
   */
  clock: () => { time: number; cycle: number } | null;
}

const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2];
const BAR_BUTTON = 'flex h-[22px] w-[22px] items-center justify-center rounded text-fg hover:bg-surface cursor-pointer';

/**
 * The viewport's playback bar: play / pause, start over, the play-through's progress (it wraps as a
 * one-shot replays; a steady effect shows a dimmed full track) with its time, and the speed.
 */
export function PlaybackBar({ playing, onPlayPause, onRestart, speed, onSpeed, clock }: PlaybackBarProps) {
  const fill = useRef<HTMLDivElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const read = useRef(clock);
  read.current = clock;
  // Drawn straight into the DOM every frame: the simulation runs at its own rate, and a React render per
  // frame would re-render nothing but this.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const c = read.current();
      const f = fill.current, t = time.current;
      if (!f || !t) return;
      if (!c) { f.style.width = '0%'; t.textContent = '–'; return; }
      const once = Number.isFinite(c.cycle) && c.cycle > 0;
      f.style.width = once ? `${Math.min(100, (c.time / c.cycle) * 100).toFixed(2)}%` : '100%';
      f.style.opacity = once ? '1' : '0.3';
      t.textContent = once ? `${c.time.toFixed(1)} / ${c.cycle.toFixed(1)} s` : `${c.time.toFixed(1)} s · steady`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div data-cleo-overlay onMouseDown={e => e.stopPropagation()}
         className='absolute bottom-3 left-1/2 z-20 flex w-[min(460px,calc(100%-24px))] -translate-x-1/2 items-center gap-2 rounded border border-control-hover bg-surface-raised/90 px-2 py-1 shadow-lg'>
      <button type='button' className={BAR_BUTTON} title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={onPlayPause}>
        <span className='h-3.5 w-3.5'>{playing ? <PauseIcon /> : <PlayIcon />}</span>
      </button>
      <button type='button' className={BAR_BUTTON} title='Start over' onClick={onRestart}>
        <span className='h-3.5 w-3.5'><RestartIcon /></span>
      </button>
      <div className='relative h-1.5 flex-1 overflow-hidden rounded bg-surface' title='The play-through: a one-shot replays from the start once it has played out'>
        <div ref={fill} className='absolute inset-y-0 left-0 bg-primary' style={{ width: '0%' }} />
      </div>
      <span ref={time} className='min-w-[86px] text-right text-ui-xs text-muted tabular-nums' />
      <Popover align='right' side='above' title='Simulation speed' triggerClassName='h-[22px] rounded px-1.5 text-ui-xs text-fg hover:bg-surface cursor-pointer tabular-nums'
               trigger={<span>{speed}×</span>} className='w-[96px]'>
        {close => (
          <div data-cleo-overlay className='flex flex-col p-1'>
            {PLAYBACK_SPEEDS.map(s => (
              <button key={s} type='button' onClick={() => { onSpeed(s); close(); }}
                      className={cn('rounded px-2 py-0.5 text-left text-ui-sm hover:bg-surface', s === speed ? 'text-highlight' : 'text-fg')}>
                {s}× speed
              </button>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}

/** The viewport's floating chrome, the same in every mode. */
export function ViewportOverlay({ readout, stage, controls, onFrame, frameTitle = 'Frame the asset (F)', playback }: {
  /** Top-left numbers. */
  readout?: ReactNode;
  /** The Stage menu (top-right): what the preview shows and the light on it. */
  stage?: StageMenuProps;
  /** Mode controls between the Stage menu and Frame (gizmo modes, a LOD picker). */
  controls?: ReactNode;
  onFrame?: () => void;
  frameTitle?: string;
  /** The playback bar (bottom-centre), for a mode whose preview is a running simulation. */
  playback?: PlaybackBarProps;
}) {
  return (<>
    {readout && (
      <div data-cleo-overlay className='absolute left-2 top-2 rounded bg-surface/80 px-2 py-1 text-ui-xs text-muted tabular-nums pointer-events-none'>
        {readout}
      </div>
    )}
    <div data-cleo-overlay className='absolute top-2 right-2 z-20 flex items-center gap-2'>
      {stage && <StageMenu {...stage} />}
      {controls}
      {onFrame && <Button size='sm' variant='ghost' className='bg-surface-raised/80' title={frameTitle} onClick={onFrame}>Frame</Button>}
    </div>
    {playback && <PlaybackBar {...playback} />}
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

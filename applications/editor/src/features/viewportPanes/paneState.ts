// The split viewport's saved state: how the viewport is divided, which pane is being edited, what each
// pane looks through, and where each pane's camera was left (per scene). Plain data and pure functions, so
// it loads, sanitizes and round-trips without an engine. The cameras themselves are paneCameras.ts; the
// wiring is useViewportPanes.ts.

import { LS_KEYS, lsKey } from '../../utils/lsScope';

/** How the viewport is divided. Every pane is the same size (the renderer draws all of them at one size). */
export type PaneLayout = 'single' | 'columns' | 'rows' | 'grid';

/** What a pane looks through: a free perspective camera, or an orthographic one along an axis. */
export type PanePreset = 'perspective' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

export const PANE_LAYOUTS: readonly { id: PaneLayout; label: string }[] = [
  { id: 'single', label: 'Single view' },
  { id: 'columns', label: 'Two side by side' },
  { id: 'rows', label: 'Two stacked' },
  { id: 'grid', label: 'Four, 2 x 2' },
];

export const PANE_PRESETS: readonly { id: PanePreset; label: string }[] = [
  { id: 'perspective', label: 'Perspective' },
  { id: 'top', label: 'Top' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'front', label: 'Front' },
  { id: 'back', label: 'Back' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
];

/** The most panes any layout has. */
export const MAX_PANES = 4;

/** Columns and rows of a layout. */
export function layoutGrid(layout: PaneLayout): { cols: 1 | 2; rows: 1 | 2 } {
  switch (layout) {
    case 'columns': return { cols: 2, rows: 1 };
    case 'rows': return { cols: 1, rows: 2 };
    case 'grid': return { cols: 2, rows: 2 };
    default: return { cols: 1, rows: 1 };
  }
}

/** How many panes a layout has. */
export function paneCount(layout: PaneLayout): number {
  const { cols, rows } = layoutGrid(layout);
  return cols * rows;
}

/**
 * What of the editing pane's culling a preview pane shows (the renderer's `PaneCulling`): with a switch on,
 * the pane leaves out what the edited camera culled that way and draws it as a tinted ghost instead.
 */
export interface PaneCulling {
  frustum: boolean;
  occlusion: boolean;
  foliage: boolean;
  lights: boolean;
}

export type PaneCullingKey = keyof PaneCulling;

/** The culling view's switches, in menu order. */
export const PANE_CULLING_KEYS: readonly PaneCullingKey[] = ['frustum', 'occlusion', 'foliage', 'lights'];

/** Each switch's row in the culling menu; also its term under "Culling view" in docs/editor/scene-authoring.md. */
export const PANE_CULLING_LABELS: Record<PaneCullingKey, string> = {
  frustum: 'Frustum',
  occlusion: 'Occlusion',
  foliage: 'Foliage',
  lights: 'Lights',
};

/** The docs entry a culling switch's row shows on hover. */
export const paneCullingDoc = (key: PaneCullingKey): string => `editor/scene-authoring#culling-view::${PANE_CULLING_LABELS[key]}`;

export const noPaneCulling = (): PaneCulling => ({ frustum: false, occlusion: false, foliage: false, lights: false });

/** Whether any of a pane's culling switches is on. */
export const anyCulling = (c: PaneCulling): boolean => PANE_CULLING_KEYS.some(k => c[k]);

/** One pane's settings. */
export interface PaneSettings {
  preset: PanePreset;
  /** Redraw every frame while not the editing pane; otherwise only when something changes. */
  realtime: boolean;
  /** The editing pane's culling, shown here while this pane is a preview. */
  culling: PaneCulling;
}

/** Where a pane's camera was left. `ortho` is the half-height of an orthographic view. */
export interface PanePose {
  position: [number, number, number];
  rotation: [number, number, number];
  ortho?: number;
}

export interface PaneState {
  version: 1;
  layout: PaneLayout;
  /** The pane being edited: its camera is the scene's active camera. */
  focused: number;
  /** Always `MAX_PANES` long, so switching layouts keeps every pane's choice. Pane 0 is the main camera. */
  panes: PaneSettings[];
  /** Per scene (its id), each pane's camera pose; index 0 unused (the main camera keeps its own). */
  poses: Record<string, (PanePose | null)[]>;
}

/** Pane 0 is the editor's main camera, always a perspective one; the others default to three ortho views. */
export const DEFAULT_PANE_PRESETS: readonly PanePreset[] = ['perspective', 'top', 'front', 'right'];

export function defaultPaneState(): PaneState {
  return {
    version: 1,
    layout: 'single',
    focused: 0,
    panes: DEFAULT_PANE_PRESETS.map(preset => ({ preset, realtime: false, culling: noPaneCulling() })),
    poses: {},
  };
}

const isLayout = (v: unknown): v is PaneLayout => PANE_LAYOUTS.some(l => l.id === v);
const isPreset = (v: unknown): v is PanePreset => PANE_PRESETS.some(p => p.id === v);
const isVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));

function sanitizePose(raw: unknown): PanePose | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!isVec3(p.position) || !isVec3(p.rotation)) return null;
  const pose: PanePose = { position: [...p.position] as PanePose['position'], rotation: [...p.rotation] as PanePose['rotation'] };
  if (typeof p.ortho === 'number' && Number.isFinite(p.ortho) && p.ortho > 0) pose.ortho = p.ortho;
  return pose;
}

/** A stored blob as a usable state: anything missing or malformed falls back to the default for it. */
export function sanitizePaneState(raw: unknown): PaneState {
  const out = defaultPaneState();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (isLayout(r.layout)) out.layout = r.layout;
  if (Array.isArray(r.panes)) {
    for (let i = 0; i < MAX_PANES; i++) {
      const p = r.panes[i] as Record<string, unknown> | undefined;
      if (!p || typeof p !== 'object') continue;
      // Pane 0 is the main camera, which the 2D/3D switch rigs: it stays perspective.
      if (i > 0 && isPreset(p.preset)) out.panes[i].preset = p.preset;
      if (typeof p.realtime === 'boolean') out.panes[i].realtime = p.realtime;
      const culling = p.culling as Record<string, unknown> | undefined;
      if (culling && typeof culling === 'object') {
        for (const key of PANE_CULLING_KEYS) if (typeof culling[key] === 'boolean') out.panes[i].culling[key] = culling[key] as boolean;
      }
    }
  }
  const count = paneCount(out.layout);
  out.focused = typeof r.focused === 'number' && Number.isInteger(r.focused) && r.focused >= 0 && r.focused < count
    ? r.focused : 0;
  if (r.poses && typeof r.poses === 'object') {
    for (const [scene, list] of Object.entries(r.poses as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      out.poses[scene] = Array.from({ length: MAX_PANES }, (_, i) => (i === 0 ? null : sanitizePose(list[i])));
    }
  }
  return out;
}

export function loadPaneState(): PaneState {
  try {
    const raw = localStorage.getItem(lsKey(LS_KEYS.viewportPanes));
    return sanitizePaneState(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultPaneState();
  }
}

export function savePaneState(state: PaneState): void {
  try {
    localStorage.setItem(lsKey(LS_KEYS.viewportPanes), JSON.stringify(state));
  } catch { /* quota, or no project open: a lost layout is not worth breaking the editor */ }
}

/**
 * Whether the viewport may split right now: the scene tab, in its scene mode, viewed in 3D, outside Play
 * and Simulate, with the scene loaded. Everywhere else it is one view, and the saved layout waits.
 */
export function panesAllowed(opts: { editorMode: string; isPlayMode: boolean; viewDimension: '2D' | '3D'; isSceneReady: boolean }): boolean {
  return opts.editorMode === 'scene' && !opts.isPlayMode && opts.viewDimension === '3D' && opts.isSceneReady;
}

// The split viewport's chrome: the layout switch in the viewport's top-right cluster, and over each pane a
// frame (accented on the pane being edited) and a header with what the pane looks through and whether it
// redraws every frame. The panes themselves are drawn by the renderer (useViewportPanes).

import { Select } from '@cleo/app-kit/ui';
import { PANE_LAYOUTS, PANE_PRESETS, type PaneLayout, type PanePreset } from './paneState';
import { usePaneView } from './paneView';
import type { ViewportPanes } from './useViewportPanes';

const CHROME = 'bg-surface-raised/80 hover:bg-surface-raised text-ui px-1.5 border-border-subtle cursor-pointer';

/** How the viewport is divided: one view, two side by side, two stacked, or four. */
export function PaneLayoutSelect({ panes }: { panes: ViewportPanes }) {
  return (
    <Select
      data-cleo-overlay
      value={panes.state.layout}
      onChange={e => panes.setLayout(e.target.value as PaneLayout)}
      title='Split the viewport: the pane you click is the one you edit; the others preview the scene from their own camera'
      className={CHROME}
    >
      {PANE_LAYOUTS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
    </Select>
  );
}

/** A frame and a header over every pane while the viewport is split. */
export function PaneFrames({ panes }: { panes: ViewportPanes }) {
  const view = usePaneView();
  if (!view.active) return null;
  return <>
    {view.boxes.map((box, i) => {
      const editing = i === view.focused;
      const settings = panes.state.panes[i];
      // The viewport's own controls sit in its top-right corner: a pane there takes its header below them.
      const underCluster = box.top === 0 && box.left > 0;
      return (
        <div key={i} className='pointer-events-none absolute z-10'
             style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
          <div className={`absolute inset-0 border ${editing ? 'border-primary' : 'border-border-subtle'}`} />
          <div data-cleo-overlay className={`pointer-events-auto absolute left-2 flex items-center gap-1 ${underCluster ? 'top-11' : 'top-2'}`}
               onMouseDown={e => e.stopPropagation()}>
            {i === 0
              ? <span className='rounded border border-border-subtle bg-surface-raised/80 px-1.5 text-ui'
                      title='The editor camera: the 2D/3D switch, Simulate and the Sequencer use this one'>Perspective</span>
              : <Select
                  data-cleo-overlay
                  value={settings.preset}
                  onChange={e => panes.setPreset(i, e.target.value as PanePreset)}
                  title='What this pane looks through: a free perspective camera, or an orthographic view along an axis'
                  className={CHROME}
                >
                  {PANE_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </Select>}
            <button
              type='button'
              data-cleo-overlay
              aria-pressed={settings.realtime}
              onClick={() => panes.setRealtime(i, !settings.realtime)}
              title={settings.realtime
                ? 'Realtime: this pane redraws every frame, even while another pane is being edited'
                : 'This pane redraws when the scene or its camera changes; turn on to redraw every frame'}
              className={`rounded border px-1.5 text-ui ${settings.realtime
                ? 'border-primary bg-primary/20 text-fg'
                : 'border-border-subtle bg-surface-raised/80 text-muted hover:bg-surface-raised'}`}
            >
              Realtime
            </button>
          </div>
        </div>
      );
    })}
  </>;
}

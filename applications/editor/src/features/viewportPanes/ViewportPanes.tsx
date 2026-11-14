// The split viewport's chrome: the layout menu in the viewport's top-right cluster, and over each pane a
// frame (accented on the pane being edited) and a header strip with what the pane looks through, whether
// it redraws every frame, and what of the editing pane's culling it shows. Icons only, each with a
// tooltip that names it; buttons that belong together are one joined strip. The panes themselves are
// drawn by the renderer (useViewportPanes).

import {
  EYE_TRIGGER_CLASS, JOINED_DIVIDER_CLASS, JOINED_GROUP_CLASS, Popover, SegmentedControl, VisibilityMenu, cn,
} from '@cleo/app-kit/ui';
import {
  PANE_CULLING_KEYS, PANE_CULLING_LABELS, PANE_LAYOUTS, PANE_PRESETS, anyCulling, paneCullingDoc,
  type PaneLayout, type PanePreset,
} from './paneState';
import { CullingIcon, LAYOUT_ICONS, PRESET_ICONS, PaneGlyph, RealtimeIcon } from './paneIcons';
import { usePaneView } from './paneView';
import type { ViewportPanes } from './useViewportPanes';

/** One item of a pane's header strip: the chrome's 26 x 25 icon button, framed by the strip. */
const ITEM = 'flex items-center justify-center w-[26px] h-[25px] text-fg hover:bg-surface-raised cursor-pointer disabled:cursor-default disabled:opacity-50';

const layoutLabel = (id: PaneLayout) => PANE_LAYOUTS.find(l => l.id === id)?.label ?? id;
const presetLabel = (id: PanePreset) => PANE_PRESETS.find(p => p.id === id)?.label ?? id;
const presetTitle = (id: PanePreset) => (id === 'perspective' ? 'Perspective' : `${presetLabel(id)} (orthographic)`);

/** How the viewport is divided: one view, two side by side, two stacked, or four. */
export function PaneLayoutSelect({ panes }: { panes: ViewportPanes }) {
  const current = panes.state.layout;
  return (
    <Popover
      align='right'
      title={`Split the viewport (${layoutLabel(current)}): the pane you click is the one you edit; the others preview the scene from their own camera`}
      triggerClassName={EYE_TRIGGER_CLASS}
      trigger={<PaneGlyph icon={LAYOUT_ICONS[current]} />}
    >
      {close => (
        <div data-cleo-overlay>
          <SegmentedControl<PaneLayout>
            joined size='sm'
            options={PANE_LAYOUTS.map(l => ({ value: l.id, title: l.label, label: <PaneGlyph icon={LAYOUT_ICONS[l.id]} /> }))}
            value={current}
            onChange={layout => { panes.setLayout(layout); close(); }}
          />
        </div>
      )}
    </Popover>
  );
}

/** The ghosts' colours, as the culling menu's legend shows them (render/cullGhosts.ts tints, in sRGB). */
const GHOST_SWATCHES = [
  { color: 'rgb(255, 207, 109)', label: 'Outside its view' },
  { color: 'rgb(221, 180, 255)', label: 'Occluded' },
];

/** A frame and a header strip over every pane while the viewport is split. */
export function PaneFrames({ panes }: { panes: ViewportPanes }) {
  const view = usePaneView();
  if (!view.active) return null;
  return <>
    {view.boxes.map((box, i) => {
      const editing = i === view.focused;
      const settings = panes.state.panes[i];
      // The viewport's own controls sit in its top-right corner: a pane there takes its header below them.
      const underCluster = box.top === 0 && box.left > 0;
      const culling = settings.culling;
      const cullingOn = anyCulling(culling);
      return (
        <div key={i} className='pointer-events-none absolute z-10'
             style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
          <div className={`absolute inset-0 border ${editing ? 'border-primary' : 'border-border-subtle'}`} />
          <div data-cleo-overlay className={cn('pointer-events-auto absolute left-2', underCluster ? 'top-11' : 'top-2', JOINED_GROUP_CLASS)}
               onMouseDown={e => e.stopPropagation()}>
            {i === 0
              ? <span className={cn(ITEM, 'cursor-default hover:bg-transparent')}
                      title='Perspective: the editor camera. The 2D/3D switch, Simulate and the Sequencer use this one'>
                  <PaneGlyph icon={PRESET_ICONS.perspective} />
                </span>
              : <Popover
                  align='left'
                  title={`${presetTitle(settings.preset)}: click to change what this pane looks through`}
                  triggerClassName={ITEM}
                  trigger={<PaneGlyph icon={PRESET_ICONS[settings.preset]} />}
                >
                  {close => (
                    <div data-cleo-overlay>
                      <SegmentedControl<PanePreset>
                        joined size='sm'
                        options={PANE_PRESETS.map(p => ({ value: p.id, title: presetTitle(p.id), label: <PaneGlyph icon={PRESET_ICONS[p.id]} /> }))}
                        value={settings.preset}
                        onChange={preset => { panes.setPreset(i, preset); close(); }}
                      />
                    </div>
                  )}
                </Popover>}
            <button
              type='button'
              data-cleo-overlay
              aria-pressed={settings.realtime}
              onClick={() => panes.setRealtime(i, !settings.realtime)}
              title={settings.realtime
                ? 'Realtime: this pane redraws every frame, even while another pane is being edited'
                : 'Realtime is off: this pane redraws when the scene or its camera changes; click to redraw it every frame'}
              className={cn(ITEM, JOINED_DIVIDER_CLASS, settings.realtime ? 'bg-primary/20' : 'text-muted')}
            >
              <PaneGlyph icon={RealtimeIcon} />
            </button>
            <div className={cn('flex', JOINED_DIVIDER_CLASS)}>
              <VisibilityMenu
                align='left'
                title={editing
                  ? 'Culling view: the pane being edited is the one the other panes show the culling of'
                  : 'Culling view: show what the pane being edited culls. It is left out here and drawn as a tinted wireframe'}
                trigger={<PaneGlyph icon={CullingIcon} />}
                triggerClassName={cn(ITEM, cullingOn && !editing ? 'bg-primary/20' : !cullingOn && 'text-muted')}
                disabled={editing}
                items={PANE_CULLING_KEYS.map(key => ({
                  key,
                  label: PANE_CULLING_LABELS[key],
                  checked: culling[key],
                  onChange: (on: boolean) => panes.setCulling(i, key, on),
                  doc: paneCullingDoc(key),
                }))}
                footer={
                  <div className='mt-1.5 flex flex-col gap-0.5 border-t border-border-subtle px-1 pt-1.5'>
                    {GHOST_SWATCHES.map(s => (
                      <div key={s.label} className='flex items-center gap-1.5 text-ui-xs text-muted'>
                        <span className='inline-block h-2 w-2 rounded-sm' style={{ background: s.color }} />
                        {s.label}
                      </div>
                    ))}
                  </div>
                }
              />
            </div>
          </div>
        </div>
      );
    })}
  </>;
}

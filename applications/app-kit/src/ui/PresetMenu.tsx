import { Popover } from './Popover';
import { MenuItem } from './MenuItem';

/** The part of an engine `Preset` the menu shows. */
export interface PresetMenuEntry {
  id: string;
  label: string;
  description: string;
}

export interface PresetMenuProps<P extends PresetMenuEntry> {
  presets: readonly P[];
  onApply: (preset: P) => void;
  /** Trigger text, shown with a ▾. */
  label?: string;
  /** The trigger's tooltip. */
  title?: string;
}

/**
 * The "Presets ▾" dropdown that sits in an inspector header (a Collapsable's or Section's `right`): one row
 * per preset with its description as the caption. Applying is the caller's — write the preset, re-read the
 * inspector state, emit the change.
 */
export function PresetMenu<P extends PresetMenuEntry>({ presets, onApply, label = 'Presets', title }: PresetMenuProps<P>) {
  return (
    <Popover title={title ?? `${label} — one-click settings`} align='right'
             className='p-1 w-[260px] max-h-[420px] overflow-y-auto'
             trigger={<span className='px-1 text-ui text-muted hover:text-fg'>{label} ▾</span>}>
      {close => (
        <div className='flex flex-col'>
          {presets.map(p => (
            <MenuItem key={p.id} hint={p.description} onClick={() => { onApply(p); close(); }}>
              {p.label}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

export default PresetMenu;

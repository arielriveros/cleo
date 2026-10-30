import { Popover } from './Popover';
import { DocHover } from './DocTooltip';
import { Toggle } from './Toggle';
import { useDocEntry } from '../docs/DocScope';

// The viewport's "eye" menu: a button top-right over a viewport that drops a list of show / hide
// switches for what the viewport draws. The editor's debug-overlay menu uses the same eye and trigger.

/** Eye glyph matching the inline-SVG style of the viewport's gizmo icons (stroke currentColor). */
export const EyeIcon = () => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z' />
    <circle cx='12' cy='12' r='3' />
  </svg>
);

/** The eye menu's trigger: the same size and frame as the viewport's gizmo buttons. */
export const EYE_TRIGGER_CLASS =
  'flex items-center justify-center w-[26px] h-[25px] rounded border border-control-hover bg-surface-raised/80 hover:bg-surface-raised text-fg cursor-pointer';

export interface VisibilityItem {
  key: string;
  label: string;
  checked: boolean;
  onChange: (visible: boolean) => void;
  /** Where the docs describe the row, when its label alone does not find it (SectionTitle's `doc`). */
  doc?: string | false;
}

export interface VisibilityMenuProps {
  items: VisibilityItem[];
  /** The popover's title. */
  title?: string;
}

export function VisibilityMenu({ items, title = 'Show in viewport' }: VisibilityMenuProps) {
  return (
    <Popover align='right' title={title} triggerClassName={EYE_TRIGGER_CLASS} trigger={<EyeIcon />} className='min-w-[200px]'>
      <div data-cleo-overlay className='p-1'>
        <div className='grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1'>
          {items.map(item => (
            <div key={item.key} className='contents'>
              <RowLabel label={item.label} doc={item.doc} />
              <div className='flex justify-center'>
                <Toggle checked={item.checked} onChange={item.onChange} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Popover>
  );
}

/** A row's label, with its docs hover card (looked up by the label in the page's docs scope). */
function RowLabel({ label, doc }: { label: string; doc?: string | false }) {
  const entry = useDocEntry(label, doc);
  return <DocHover as='div' entry={entry} className='px-1 py-0.5 text-ui text-fg'>{label}</DocHover>;
}

export default VisibilityMenu;

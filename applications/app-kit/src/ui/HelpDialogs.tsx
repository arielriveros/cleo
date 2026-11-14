import { Modal, ModalHeader } from './Modal';
import { Button } from './Button';
import { renderInline } from './DocTooltip';
import { getDocIndex } from '../docs/docIndex';
import { sectionRows } from '../docs/parseDocs';

// The Help menu's two dialogs, shared by the editor and Cleo Creator.

/**
 * Help ▸ Keyboard Shortcuts: the rows of a docs page's shortcuts table (`page`, section `anchor`), read
 * from the bundled docs rather than written here, so the dialog and the docs never disagree.
 */
export function ShortcutsDialog({ title = 'Keyboard shortcuts', page, anchor, onClose }: {
  title?: string;
  page: string;
  anchor: string;
  onClose: () => void;
}) {
  const rows = sectionRows(getDocIndex(), page, anchor);
  return (
    <Modal onClose={onClose} className='w-[520px]'>
      <ModalHeader title={title} doc={false} />
      <div className='px-4 py-3'>
        {rows.length === 0
          ? <p className='text-ui text-muted'>The docs list no shortcuts here.</p>
          : (
            <table className='w-full text-ui'>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className='border-b border-border-subtle last:border-0'>
                    <td className='py-1.5 pr-4 align-top font-semibold whitespace-nowrap'>{row.label}</td>
                    <td className='py-1.5 align-top text-muted'>{renderInline(row.body)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      <div className='flex justify-end px-4 pb-3'>
        <Button size='sm' onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

/** Help ▸ About: the logo, the app's name and its version. */
export function AboutDialog({ appName, version, logo, lines = [], onClose }: {
  appName: string;
  /** The version label (`v1.2.4`, `v1.2.4-dev`). */
  version: string;
  logo: string;
  /** Further lines under the version. */
  lines?: string[];
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} className='w-[360px]'>
      <div className='flex flex-col items-center gap-2 px-6 pt-6 pb-4 text-center'>
        <img src={logo} alt='' draggable={false} className='w-[96px]' />
        <div className='text-ui-lg font-semibold tracking-[0.2em]'>{appName.toUpperCase()}</div>
        <div className='text-ui text-muted'>{version}</div>
        {lines.map((line, i) => <div key={i} className='text-ui-sm text-dim'>{line}</div>)}
      </div>
      <div className='flex justify-center px-4 pb-4'>
        <Button size='sm' onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

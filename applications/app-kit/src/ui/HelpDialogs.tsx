import type React from 'react';
import { Modal, ModalHeader } from './Modal';
import { Button } from './Button';
import { cn } from './cn';
import { renderInline } from './DocTooltip';
import { getDocIndex } from '../docs/docIndex';
import { sectionRows } from '../docs/parseDocs';
import { ChangelogView, type ChangelogSection } from '../docs/viewer/ChangelogView';

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

/**
 * Help ▸ About: the logo, the app's name and its version, then what changed in it (the build's CHANGELOG.md
 * section, see buildVersion.js) when there is a changelog to show.
 */
export function AboutDialog({ appName, version, logo, lines = [], changelog = [], footer, onClose }: {
  appName: string;
  /** The version label (`v1.2.4`, `v1.2.4-dev`). */
  version: string;
  logo: string;
  /** Further lines under the version. */
  lines?: string[];
  /** What changed in this version (for a -dev build: what is unreleased, then the release it is built on). */
  changelog?: ChangelogSection[];
  /** Under the version: live state, such as whether an update is waiting. */
  footer?: React.ReactNode;
  onClose: () => void;
}) {
  const notes = changelog.length > 0;
  return (
    <Modal onClose={onClose} className={notes ? 'w-[560px] flex flex-col overflow-hidden' : 'w-[360px]'}>
      <div className='flex flex-col items-center gap-2 px-6 pt-6 pb-4 text-center shrink-0'>
        <img src={logo} alt='' draggable={false} className='w-[96px]' />
        <div className='text-ui-lg font-semibold tracking-[0.2em]'>{appName.toUpperCase()}</div>
        <div className='text-ui text-muted'>{version}</div>
        {lines.map((line, i) => <div key={i} className='text-ui-sm text-dim'>{line}</div>)}
        {footer}
      </div>
      {notes && (
        <div className='min-h-0 flex flex-col border-t border-control'>
          <div className='px-5 pt-3 pb-1 text-ui-sm font-semibold uppercase tracking-wider text-muted shrink-0'>What's new</div>
          <div className='min-h-0 max-h-[45vh] overflow-y-auto px-5 pb-3'>
            <ChangelogView sections={changelog} />
          </div>
        </div>
      )}
      <div className={cn('flex justify-center px-4 pb-4 shrink-0', notes && 'pt-3 border-t border-control')}>
        <Button size='sm' onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

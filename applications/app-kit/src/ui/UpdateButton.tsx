import { useState } from 'react';
import { cn } from './cn';
import { Button, buttonVariants } from './Button';
import { Popover } from './Popover';
import { UpdateIcon, RestartUpdateIcon } from './icons';
import { ChangelogView } from '../docs/viewer/ChangelogView';
import {
  checkForUpdates, getUpdaterBridge, productVersion, setUpdatePanelOpen, updateButtonVisible, useUpdatePanelOpen,
  useUpdaterState, type UpdateState,
} from '../platform/desktopUpdater';

/** The tooltip for each state: the button itself is only a glyph. */
function describe(appName: string, s: UpdateState): string {
  const v = s.version ? `${appName} v${productVersion(s.version)}` : `A new ${appName}`;
  switch (s.status) {
    case 'downloading': return `Downloading ${v} (${Math.round(s.percent ?? 0)}%)`;
    case 'ready': return `${v} is ready: restart to update`;
    case 'available': return `${v} is available`;
    case 'error': return `The update failed${s.error ? `: ${s.error}` : ''}`;
    default: return '';
  }
}

/**
 * The menu bar's Update button, at its right end (desktop only): nothing until a newer version is found, then a
 * download glyph with a progress line while it downloads in the background, then a restart glyph and the new
 * version once it is ready. Its panel shows that version's release notes and what to do: restart now, or later
 * (quitting installs it too). A macOS build cannot install itself, so there the panel offers the download page.
 *
 * `onInstall` is the app's own way of getting ready for the restart (save, let go of the project) before it asks
 * the shell to install; the editor's is features/updates/restartToUpdate.ts.
 */
export function UpdateButton({ appName, onInstall }: { appName: string; onInstall: () => Promise<void> | void }) {
  const state = useUpdaterState();
  const open = useUpdatePanelOpen();
  const [busy, setBusy] = useState(false);
  const bridge = getUpdaterBridge();
  if (!bridge || !updateButtonVisible(state)) return null;

  const ready = state.status === 'ready';
  const downloading = state.status === 'downloading';
  const failed = state.status === 'error';
  const label = describe(appName, state);
  const versionLabel = state.version ? `v${productVersion(state.version)}` : '';

  const restart = async () => {
    setBusy(true);
    try { await onInstall(); } finally { setBusy(false); }
  };

  return (
    <Popover
      align='right'
      open={open}
      onOpenChange={setUpdatePanelOpen}
      title={label}
      rootClassName='h-[25px]'
      triggerClassName={cn(
        buttonVariants({ variant: 'subtle', size: 'sm' }),
        'relative h-[25px] overflow-hidden',
        ready && 'border-success text-success-fg',
        failed && 'border-warning text-warning',
        (state.status === 'available' || downloading) && 'text-highlight',
      )}
      className='w-[440px] p-0'
      trigger={<>
        <span className='block w-3.5 h-3.5'>{ready ? <RestartUpdateIcon /> : <UpdateIcon />}</span>
        {ready && versionLabel && <span className='text-ui-sm tabular-nums'>{versionLabel}</span>}
        {downloading && (
          <span aria-hidden className='absolute left-0 bottom-0 h-[2px] bg-highlight transition-[width]'
                style={{ width: `${Math.max(4, state.percent ?? 0)}%` }} />
        )}
      </>}
    >
      {(close) => (
        <div className='flex flex-col max-h-[70vh]'>
          <div className='px-3 pt-2.5 pb-2 border-b border-control shrink-0'>
            <div className='text-ui font-semibold text-fg'>{label}</div>
            <div className='text-ui-sm text-dim'>
              You have v{productVersion(state.current)}.
              {ready && ' Quitting installs it too.'}
              {state.manual && state.status === 'available' && ' This build cannot install updates itself: download it from its release page.'}
            </div>
            {downloading && (
              <div className='mt-2 h-1 rounded bg-control overflow-hidden'>
                <div className='h-full bg-highlight transition-[width]' style={{ width: `${state.percent ?? 0}%` }} />
              </div>
            )}
          </div>
          {state.notes
            ? (
              <div className='min-h-0 overflow-y-auto px-3 py-2'>
                <ChangelogView sections={[{ title: `What's new in ${versionLabel}`, markdown: state.notes }]} />
              </div>
            )
            : !failed && <div className='px-3 py-2 text-ui-sm text-dim'>No release notes came with this version.</div>}
          <div className='flex justify-end gap-1.5 px-3 py-2 border-t border-control shrink-0'>
            {ready && <>
              <Button size='sm' variant='ghost' onClick={close}>Later</Button>
              <Button size='sm' variant='primary' disabled={busy} onClick={() => { void restart(); }}>Restart now</Button>
            </>}
            {state.status === 'available' && (
              <Button size='sm' variant='primary' onClick={() => { void bridge.openRelease(); close(); }}>Download from GitHub</Button>
            )}
            {downloading && <Button size='sm' variant='ghost' onClick={close}>Close</Button>}
            {failed && <>
              <Button size='sm' variant='ghost' onClick={() => { void bridge.openRelease(); }}>Release page</Button>
              <Button size='sm' variant='primary' onClick={() => { void checkForUpdates(); }}>Retry</Button>
            </>}
          </div>
        </div>
      )}
    </Popover>
  );
}

/**
 * One line about updates for Help ▸ About: the version waiting for a restart, the one downloading, or nothing.
 * Nothing in a browser or a build that does not update.
 */
export function UpdateStatusLine({ appName }: { appName: string }) {
  const state = useUpdaterState();
  if (!updateButtonVisible(state)) return null;
  return <div className='text-ui-sm text-highlight'>{describe(appName, state)}</div>;
}

export default UpdateButton;

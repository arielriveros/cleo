import React, { useRef } from 'react';
import { buttonVariants } from '../ui/Button';
import { MenuItem } from '../ui/MenuItem';
import { Popover } from '../ui/Popover';
import { cn } from '../ui/cn';

// The two buttons that open an asset explorer's toolbar, in the editor and in Cleo Creator alike:
// "+ Add ▾" creates things, the upload button imports files. The explorer sits in a bottom panel, so the
// Add menu opens UPWARD (it flips down only when there is no room above).

export interface AddMenuItem {
  label: string;
  icon?: React.ReactNode;
  title?: string;
  run: () => void;
}

export function AddMenu({ items, title = 'Add a new asset or folder' }: { items: AddMenuItem[]; title?: string }) {
  return (
    <Popover
      side='above'
      title={title}
      rootClassName='shrink-0'
      triggerClassName={cn(buttonVariants({ variant: 'success', size: 'sm' }),
        'shrink-0 gap-0 h-[20px] text-ui-sm font-semibold leading-none whitespace-nowrap')}
      className='min-w-[160px] max-h-[70vh] overflow-y-auto'
      trigger={<>+ Add <span className='ml-1 text-ui-2xs'>▾</span></>}
    >
      {close => items.map(item => (
        <MenuItem key={item.label}
          className='items-center text-ui-sm whitespace-nowrap'
          icon={item.icon}
          title={item.title}
          onClick={() => { close(); item.run(); }}>
          {item.label}
        </MenuItem>
      ))}
    </Popover>
  );
}

export const UploadIcon = ({ className = 'w-3.5 h-3.5' }: { className?: string }) => (
  <svg className={className} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' /><path d='M17 8l-5-5-5 5M12 3v12' />
  </svg>
);

export interface ImportButtonProps {
  /** The file input's `accept` list. */
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  /** An import is running: the button is disabled and reads "Importing…". */
  busy?: boolean;
  title?: string;
}

/** "Import": picks files from disk and hands them over. Owns its hidden file input. */
export function ImportButton({ accept, multiple = true, onFiles, busy, title = 'Import files' }: ImportButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type='button' disabled={busy} title={title}
        className={cn(buttonVariants({ variant: 'default', size: 'sm' }),
          'shrink-0 gap-1 h-[20px] text-ui-sm leading-none whitespace-nowrap')}
        onClick={() => input.current?.click()}>
        <UploadIcon className='w-3 h-3' />{busy ? 'Importing…' : 'Import'}
      </button>
      <input ref={input} className='hidden' type='file' multiple={multiple} accept={accept}
        onChange={e => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = ''; // picking the same file twice fires no change event otherwise
          if (files.length) onFiles(files);
        }} />
    </>
  );
}

import React from 'react';
import { cn } from './cn';
import { DocHover } from './DocTooltip';
import { useDocEntry } from '../docs/DocScope';

export interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  /** Classes for the card (typically its width, e.g. `w-[420px]`). */
  className?: string;
  /** Classes for the full-screen backdrop. A dialog raised over another modal lifts its `z` here. */
  overlayClassName?: string;
}

/** Centered modal over a dimmed backdrop; backdrop click closes, card clicks don't propagate. */
export function Modal({ onClose, children, className, overlayClassName }: ModalProps) {
  return (
    <div
      className={cn('fixed inset-0 z-50 flex items-center justify-center bg-scrim/50', overlayClassName)}
      onClick={onClose}
    >
      <div
        className={cn(
          'max-h-[85vh] overflow-y-auto bg-surface-raised border border-control rounded-md shadow-lg text-fg select-none',
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export interface ModalHeaderProps {
  className?: string;
  /** The modal's title. Its hover card is the docs' entry for it, so the header needs no explanatory line. */
  title?: React.ReactNode;
  /** Docs key when the title alone does not find the entry (see resolveDocKey); `false` opts out. */
  doc?: string | false;
  /** Beside the title: live state ("Currently open: …"), never a description of the modal. */
  aside?: React.ReactNode;
  /** Anything else the header holds, under the title row. */
  children?: React.ReactNode;
}

export function ModalHeader({ className, title, doc, aside, children }: ModalHeaderProps) {
  const entry = useDocEntry(title, title === undefined ? false : doc);
  return (
    <div className={cn('px-4 py-3 border-b border-control', className)}>
      {title !== undefined && (
        <div className='flex items-baseline gap-2 min-w-0'>
          <DocHover entry={entry} className='text-ui-lg font-semibold truncate'>{title}</DocHover>
          {aside !== undefined && <span className='text-ui text-muted truncate'>{aside}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

export function ModalFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('px-4 py-3 border-t border-control flex justify-end gap-2', className)}>{children}</div>;
}

export default Modal;

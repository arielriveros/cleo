import React from 'react';
import { cn } from './cn';

export interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  /** Classes for the card (typically its width, e.g. `w-[420px]`). */
  className?: string;
}

/** Centered modal over a dimmed backdrop; backdrop click closes, card clicks don't propagate. */
export function Modal({ onClose, children, className }: ModalProps) {
  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50' onClick={onClose}>
      <div
        className={cn(
          'max-h-[85vh] overflow-y-auto bg-surface-raised border border-control rounded-md shadow-lg text-white select-none',
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('px-4 py-3 border-b border-control', className)}>{children}</div>;
}

export function ModalFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('px-4 py-3 border-t border-control flex justify-end gap-2', className)}>{children}</div>;
}

export default Modal;

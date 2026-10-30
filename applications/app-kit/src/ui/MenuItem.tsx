import React from 'react';
import { cn } from './cn';

export interface MenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Destructive entries ("Delete layer") read in the danger colour. */
  danger?: boolean;
  /** A secondary line under the label (what the entry does). */
  hint?: React.ReactNode;
  /** A leading glyph or icon. */
  icon?: React.ReactNode;
  active?: boolean;
}

/**
 * One row of a dropdown or context menu — the Add menu, a layer's actions, the Publish dropdown. Menus
 * were each hand-rolled (or borrowed a ghost Button and re-shaped it); this is the shared row: full
 * width, left-aligned, highlight on hover, optional icon and caption.
 */
export function MenuItem({ danger, hint, icon, active, className, children, type = 'button', ...rest }: MenuItemProps) {
  return (
    <button
      type={type}
      className={cn(
        'flex w-full items-start gap-2 rounded px-2 py-1 text-left text-ui transition-colors',
        'text-fg hover:bg-control disabled:cursor-not-allowed disabled:opacity-50',
        active && 'bg-control',
        danger && 'text-danger-fg',
        className,
      )}
      {...rest}
    >
      {icon !== undefined && <span className='shrink-0 leading-4'>{icon}</span>}
      <span className='min-w-0 flex-1'>
        <span className='block truncate'>{children}</span>
        {hint !== undefined && <span className='block text-ui-xs text-dim whitespace-normal'>{hint}</span>}
      </span>
    </button>
  );
}

export default MenuItem;

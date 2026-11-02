import React from 'react';
import { cn } from '../ui/cn';

// The full-screen start page every Cleo app opens on -- the editor's project launcher, Cleo Creator's
// home -- and the card its grids are made of. One look for both, so the apps read as one product.

export interface LauncherPageProps {
  /** The wordmark, e.g. "CLEO ENGINE". */
  title: string;
  /** The app's name under it, e.g. "Editor". */
  subtitle: string;
  version?: string;
  /** One line above the framed area. */
  prompt?: React.ReactNode;
  /** Classes for the framed area (its height, say). */
  frameClassName?: string;
  /** Classes for the page (`h-screen w-screen` when it is the whole window). */
  className?: string;
  children: React.ReactNode;
}

export function LauncherPage({ title, subtitle, version, prompt, frameClassName, className, children }: LauncherPageProps) {
  return (
    <div className={cn('h-full w-full min-h-0 flex flex-col items-center justify-center bg-bg text-fg select-none overflow-auto', className)}>
      <div className='w-[720px] max-w-[92vw] flex flex-col gap-6'>
        <div className='flex flex-col items-center gap-2'>
          <h1 className='text-2xl font-semibold tracking-[0.3em] text-fg'>{title}</h1>
          <span className='text-ui-xs uppercase tracking-[0.3em] text-dim'>{subtitle}</span>
          {version && <span className='text-ui-xs tabular-nums tracking-[0.2em] text-dim'>{version}</span>}
        </div>
        <div className='flex flex-col gap-2'>
          {prompt !== undefined && <div className='text-ui text-muted'>{prompt}</div>}
          <div className={cn('rounded-md border border-control overflow-hidden bg-surface-raised', frameClassName)}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The auto-filling grid launcher cards sit in. */
export function LauncherGrid({ children, className, minCard = 180 }: {
  children: React.ReactNode; className?: string;
  /** The narrowest a card may get (px): the grid fits as many columns as this allows. */
  minCard?: number;
}) {
  return (
    <div className={cn('grid gap-3', className)} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${minCard}px, 1fr))` }}>
      {children}
    </div>
  );
}

export interface LauncherCardProps {
  name: string;
  description?: string;
  /** A small line under the description (size, scene count). */
  meta?: React.ReactNode;
  /** The 16:9 picture: an image, or a glyph on the sunken surface. */
  thumbnail: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Highlighted, e.g. while it is being opened. */
  active?: boolean;
  title?: string;
}

export function LauncherCard({ name, description, meta, thumbnail, onClick, disabled, active, title }: LauncherCardProps) {
  return (
    <button
      type='button'
      disabled={disabled}
      onClick={onClick}
      title={title ?? description ?? name}
      className={cn(
        'group flex flex-col text-left rounded-md border border-control bg-surface-raised overflow-hidden',
        'cursor-pointer hover:border-highlight focus:outline-none focus:border-highlight',
        'disabled:cursor-default disabled:opacity-50',
        active && 'border-highlight',
      )}>
      <div className='aspect-video w-full overflow-hidden bg-surface-sunken'>{thumbnail}</div>
      <div className='flex flex-col gap-0.5 p-2 min-w-0'>
        <span className='truncate text-ui font-semibold text-fg'>{name}</span>
        {description && <span className='line-clamp-2 text-ui-sm leading-snug text-muted'>{description}</span>}
        {meta !== undefined && <span className='mt-0.5 text-ui-xs text-dim'>{meta}</span>}
      </div>
    </button>
  );
}

/** A thumbnail with no picture: a glyph centred on the sunken surface. */
export function LauncherGlyph({ children }: { children: React.ReactNode }) {
  return (
    <div className='w-full h-full flex items-center justify-center bg-surface-sunken text-muted group-hover:text-highlight transition-colors'>
      {children}
    </div>
  );
}

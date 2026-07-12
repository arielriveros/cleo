import React from 'react';
import { cn } from './cn';

export interface AssetCardProps {
  name: string;
  thumbnail?: string | null;
  /** Emoji/glyph shown when there is no thumbnail. */
  fallback?: React.ReactNode;
  selected?: boolean;
  badge?: React.ReactNode;
  /** Action buttons rendered in a row beneath the name. */
  actions?: React.ReactNode;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  title?: string;
  className?: string;
}

/** The 96px thumbnail card used by every asset explorer (materials/meshes/templates/terrain). */
export function AssetCard({
  name,
  thumbnail,
  fallback = '📦',
  selected,
  badge,
  actions,
  draggable,
  onDragStart,
  onClick,
  title,
  className,
}: AssetCardProps) {
  return (
    <div
      className={cn(
        'w-[96px] flex flex-col items-center bg-control border border-border rounded p-1',
        draggable && 'cursor-grab',
        selected && 'ring-2 ring-selected',
        className
      )}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onClick}
      title={title}
    >
      <div className='relative w-[80px] h-[80px] rounded overflow-hidden bg-surface-raised flex items-center justify-center'>
        {badge}
        {thumbnail ? (
          <img src={thumbnail} className='w-full h-full object-cover' alt={name} draggable={false} />
        ) : (
          <span className='text-2xl'>{fallback}</span>
        )}
      </div>
      <span className='truncate w-full text-center text-xs mt-1' title={name}>
        {name}
      </span>
      {actions && <div className='flex gap-3 mt-1'>{actions}</div>}
    </div>
  );
}

export default AssetCard;

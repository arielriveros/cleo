import React from 'react';
import { cn } from './cn';

export interface OverlayPanelProps extends React.HTMLAttributes<HTMLDivElement> {}

/**
 * Floating panel anchored over the viewport (renderer options, tool settings…). Keeps the
 * `data-cleo-overlay` marker the engine uses to route pointer events away from the canvas.
 */
export function OverlayPanel({ className, children, ...rest }: OverlayPanelProps) {
  return (
    <div
      data-cleo-overlay
      className={cn(
        'absolute top-2 left-2 z-20 bg-surface-raised/95 border border-control rounded-md p-3 text-white shadow-lg select-none',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export default OverlayPanel;

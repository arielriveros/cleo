import { useRef, type ReactNode } from 'react';
import { useEngineHost } from './EngineHost';
import { useEngineViewport } from './useEngineViewport';

/**
 * A panel body that shows the host's engine. Children render over the canvas -- mark overlay roots with
 * `data-cleo-overlay` so an app's viewport pointer handlers can tell them apart from the scene.
 */
export function ViewportHost({ children, className, viewportRef }: {
  children?: ReactNode;
  className?: string;
  /** The element the viewport's pointer input lands on, for hosts that attach their own (gizmos, picking). */
  viewportRef?: React.RefObject<HTMLDivElement>;
}) {
  const { instance } = useEngineHost();
  const ref = useRef<HTMLDivElement>(null);
  useEngineViewport(ref, instance);
  return (
    <div ref={viewportRef} className={className ?? 'relative h-full w-full overflow-hidden'}>
      <div ref={ref} className='absolute inset-0' />
      {children}
    </div>
  );
}

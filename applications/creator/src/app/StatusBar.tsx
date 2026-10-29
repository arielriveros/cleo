import type { GenerationStatus } from '../core/useGeneration';
import { Button } from '@cleo/app-kit/ui';

/** Progress of the running generation, with a Cancel, or the last result's summary when idle. */
export function GenerationBar({ status, onCancel, idle }: { status: GenerationStatus; onCancel: () => void; idle?: string }) {
  return (
    <div className='status-bar justify-between'>
      {status.running ? (
        <>
          <div className='flex items-center gap-2 min-w-0'>
            <div className='w-40 h-1.5 rounded-full bg-control overflow-hidden shrink-0'>
              <div className='h-full bg-primary' style={{ width: `${Math.round(status.fraction * 100)}%` }} />
            </div>
            <span className='truncate'>{status.label}</span>
          </div>
          <Button size='sm' variant='ghost' onClick={onCancel}>Cancel</Button>
        </>
      ) : (
        <span className='truncate'>{idle ?? 'Ready'}</span>
      )}
    </div>
  );
}

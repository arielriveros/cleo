import { useCallback, useRef, useState } from 'react';
import { toast } from '@cleo/app-kit/feedback/toastStore';
import { GenerationCancelled, type GenerateContext } from './generator';

export interface GenerationStatus {
  running: boolean;
  fraction: number;
  label: string;
}

/**
 * Run one generation at a time with progress and cancellation. Starting a new run cancels the one in
 * flight (the live preview restarts on every parameter change); a cancelled run's result is dropped.
 */
export function useGeneration() {
  const [status, setStatus] = useState<GenerationStatus>({ running: false, fraction: 0, label: '' });
  const current = useRef<{ cancelled: boolean } | null>(null);

  const run = useCallback(async <T>(work: (ctx: GenerateContext) => Promise<T>): Promise<T | null> => {
    if (current.current) current.current.cancelled = true;
    const token = { cancelled: false };
    current.current = token;
    setStatus({ running: true, fraction: 0, label: 'Starting' });
    const ctx: GenerateContext = {
      progress: (fraction, label) => { if (!token.cancelled) setStatus({ running: true, fraction, label: label ?? '' }); },
      get cancelled() { return token.cancelled; },
    };
    try {
      const out = await work(ctx);
      return token.cancelled ? null : out;
    } catch (e) {
      if (!(e instanceof GenerationCancelled)) {
        console.error(e);
        toast.error(String((e as Error)?.message ?? e), { title: 'Generation failed' });
      }
      return null;
    } finally {
      if (current.current === token) {
        current.current = null;
        setStatus({ running: false, fraction: 1, label: '' });
      }
    }
  }, []);

  const cancel = useCallback(() => {
    if (current.current) current.current.cancelled = true;
  }, []);

  return { status, run, cancel };
}

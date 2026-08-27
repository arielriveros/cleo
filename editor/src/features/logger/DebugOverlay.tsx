// On-screen debug toast stack for the editor viewport: every `Logger.debug(...)` emit shows as a line
// over the 3D view and self-expires. Subscribes to the same 'LOG' stream as the console store but keeps
// only `debug` entries and drives its own expiry. Editor-only; published games disable the Logger.
import { useEffect, useRef, useState } from 'react';
import { CleoEngine } from 'cleo';
import type { LogEntry } from 'cleo';

/** How long a debug line stays on screen before it is removed. */
const TTL_MS = 10_000;
/** A short fade at the tail of the lifetime; the pill animates to 0 opacity over this window. */
const FADE_MS = 600;
/** Hard cap on visible lines — older ones are dropped immediately so the stack can't run off-screen. */
const MAX_LINES = 8;

interface Toast { id: string; text: string; born: number }

// Engine objects are large and often circular, so the on-screen text stays a shallow one-liner.
// Mirrors logStore's preview().
function format(data: any[]): string {
  return data.map((value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value === null || typeof value !== 'object') return String(value);
    try {
      const name = value.constructor?.name ?? 'Object';
      return `${name} ${Object.keys(value).slice(0, 8).join(' ')}`;
    } catch {
      return '';
    }
  }).join(' ').slice(0, 300);
}

export default function DebugOverlay() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Forces a re-render as lines approach expiry, so the CSS fade tracks real elapsed time.
  const [, setTick] = useState(0);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const onLog = (entry: LogEntry) => {
      if (entry.method !== 'debug') return;
      const toast: Toast = { id: entry.id, text: format(entry.data), born: performance.now() };
      setToasts((prev) => [...prev, toast].slice(-MAX_LINES));
      const timer = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
        timers.current.delete(timer);
      }, TTL_MS);
      timers.current.add(timer);
    };

    CleoEngine.eventEmitter.on('LOG', onLog);
    const interval = setInterval(() => setTick((t) => t + 1), 200);

    return () => {
      CleoEngine.eventEmitter.off('LOG', onLog);
      clearInterval(interval);
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    };
  }, []);

  if (toasts.length === 0) return null;

  const now = performance.now();

  return (
    <div
      data-cleo-overlay
      className='absolute bottom-2 left-2 z-20 flex flex-col gap-1 pointer-events-none select-none max-w-[60%]'
    >
      {toasts.map((t) => {
        const remaining = TTL_MS - (now - t.born);
        const opacity = remaining < FADE_MS ? Math.max(0, remaining / FADE_MS) : 1;
        return (
          <div
            key={t.id}
            style={{ opacity, transition: 'opacity 120ms linear' }}
            className='self-start rounded bg-black/70 border border-white/10 px-2 py-1 font-mono text-[11px] leading-4 text-emerald-300 shadow-md whitespace-pre-wrap break-words'
          >
            {t.text}
          </div>
        );
      })}
    </div>
  );
}

// On-screen debug toast stack for the editor viewport. Every `Logger.debug(...)` emit shows up here as
// a line over the 3D view and self-expires after 10s — a heads-up channel for values you want to watch
// while looking at the scene, without diverting your eyes to the Console panel.
//
// Editor-only by design: published games disable the Logger wholesale (player/index.tsx), so this never
// renders there. It subscribes to the same CleoEngine.eventEmitter 'LOG' stream the console store uses,
// but keeps only `debug` entries and drives its own expiry, independent of the console's ring buffer.
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

// Engine objects are large and often circular, so the on-screen text stays a shallow one-liner — the
// Console panel's inspector is where you expand anything structured. Mirrors logStore's preview().
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
  // A monotonic tick that forces a re-render as lines approach expiry, so the CSS fade reflects real
  // elapsed time rather than only firing when a new toast arrives.
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
    // Repaint a few times a second so the fade tracks wall-clock time; cheap next to the render loop.
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

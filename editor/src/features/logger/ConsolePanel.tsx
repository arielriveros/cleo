// DevTools-style console panel. Rendering is console-feed's (rich object inspection, format
// specifiers, error panels); the row chrome, filtering and scrolling are ours.
import React, { useDeferredValue, useMemo, useRef, useState, useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { Console } from 'console-feed';
import type { ComponentOverrides } from 'console-feed';
import type { LogMethod } from 'cleo';
import { Button, Toggle, Popover, TextInput, cn } from '../../components/ui';
import { logStore, MAX_LOGS, ConsoleEntry } from './logStore';
import { getConsoleStyles } from './consoleTheme';

// `debug` rides along with `log` — scripts rarely use it and it doesn't deserve its own chip.
const LEVELS: { key: 'log' | 'info' | 'warn' | 'error'; label: string; methods: LogMethod[]; tone: string }[] = [
  { key: 'log', label: 'Logs', methods: ['log', 'debug'], tone: 'text-fg' },
  { key: 'info', label: 'Info', methods: ['info'], tone: 'text-highlight' },
  { key: 'warn', label: 'Warnings', methods: ['warn'], tone: 'text-warning' },
  { key: 'error', label: 'Errors', methods: ['error'], tone: 'text-danger' },
];

const ROW_TONE: Record<LogMethod, string> = {
  log: 'text-fg',
  debug: 'text-muted',
  info: 'text-highlight',
  warn: 'bg-warning/[0.07] text-warning',
  error: 'bg-danger/[0.09] text-danger',
};

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function formatTime(epoch: number) {
  const ms = String(epoch % 1000).padStart(3, '0');
  return `${timeFormat.format(epoch)}.${ms}`;
}

/** Scopes are free-form strings, so their chip colour is derived rather than mapped. */
function scopeHue(scope: string) {
  let hash = 0;
  for (let i = 0; i < scope.length; i++) hash = (hash * 31 + scope.charCodeAt(i)) % 360;
  return hash;
}

// console-feed's own <Message> wrapper is replaced wholesale: we render the parsed content (`node`)
// inside our own row so the timestamp and scope chip sit in a gutter, and so row colours come from
// the editor's tokens. `content-visibility` lets the browser skip offscreen rows entirely — that,
// the 500-entry cap and the store's per-frame batching are what keep per-frame logging cheap.
const Row: NonNullable<ComponentOverrides['Message']> = ({ log, node, children: _content, ...rest }) => {
  const entry = log as unknown as ConsoleEntry; // console-feed's Message type doesn't know about scope/search
  const hue = scopeHue(entry.scope);
  return (
    <div
      {...rest} // console-feed passes data-method
      className={cn(
        'flex items-start gap-2 px-2 py-[3px] border-b border-border-subtle/60 font-mono text-xs leading-4',
        '[&_*]:font-mono [&_*]:whitespace-pre-wrap',
        ROW_TONE[entry.method]
      )}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '0 20px' } as React.CSSProperties}
    >
      <span className='shrink-0 tabular-nums text-dim select-text'>{formatTime(entry.timestamp)}</span>
      <span
        className='shrink-0 rounded px-1 border'
        style={{ color: `hsl(${hue} 60% 75%)`, borderColor: `hsl(${hue} 45% 40% / 0.5)`, backgroundColor: `hsl(${hue} 45% 40% / 0.15)` }}
      >
        {entry.scope}
      </span>
      <div className='flex-1 min-w-0'>{node}</div>
    </div>
  );
};

// Stable identity: <Console> is a PureComponent, so a fresh object here would re-render every row.
const COMPONENTS: ComponentOverrides = { Message: Row };

export default function ConsolePanel() {
  const { entries, counts, scopes } = useSyncExternalStore(logStore.subscribe, logStore.getSnapshot);

  const [levels, setLevels] = useState<Record<string, boolean>>({ log: true, info: true, warn: true, error: true });
  const [hiddenScopes, setHiddenScopes] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const search = useDeferredValue(query).trim().toLowerCase();

  const methodFilter = useMemo(() => {
    const enabled = new Set<LogMethod>();
    for (const level of LEVELS) if (levels[level.key]) level.methods.forEach((m) => enabled.add(m));
    return enabled;
  }, [levels]);

  const filtered = useMemo(() => entries.filter((entry) =>
    methodFilter.has(entry.method) &&
    !hiddenScopes.has(entry.scope) &&
    (!search || entry.search.includes(search) || entry.scope.toLowerCase().includes(search))
  ), [entries, methodFilter, hiddenScopes, search]);

  // Stick to the bottom while the user is there, like devtools; scrolling up detaches.
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    if (atBottom !== follow.current) {
      follow.current = atBottom;
      setFollowing(atBottom);
    }
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [filtered]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    follow.current = true;
    setFollowing(true);
    el.scrollTop = el.scrollHeight;
  };

  const toggleScope = (scope: string, visible: boolean) => setHiddenScopes((prev) => {
    const next = new Set(prev);
    if (visible) next.delete(scope); else next.add(scope);
    return next;
  });

  const visibleScopes = scopes.length - hiddenScopes.size;

  return (
    <div className='flex flex-col h-full w-full bg-surface-raised text-fg'>
      <div className='flex items-center gap-1 shrink-0 px-1 py-1 border-b border-border bg-surface-sunken'>
        {LEVELS.map(({ key, label, methods, tone }) => {
          const count = methods.reduce((sum, m) => sum + counts[m], 0);
          return (
            <Button
              key={key}
              size='sm'
              variant='ghost'
              active={levels[key]}
              title={`${levels[key] ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
              onClick={() => setLevels((prev) => ({ ...prev, [key]: !prev[key] }))}
              className={cn('gap-1', levels[key] && tone)}
            >
              {label}
              <span className='tabular-nums text-dim'>{count}</span>
            </Button>
          );
        })}

        <Popover
          align='left'
          title='Filter by scope'
          triggerClassName='px-2 py-0.5 text-xs rounded border border-transparent text-muted hover:text-white hover:bg-control'
          trigger={<>Scopes <span className='tabular-nums text-dim'>{visibleScopes}/{scopes.length}</span></>}
          className='min-w-[160px] max-h-64 overflow-y-auto'
        >
          {scopes.length === 0
            ? <div className='px-2 py-1 text-xs text-dim'>Nothing logged yet</div>
            : scopes.map((scope) => (
                <Toggle
                  key={scope}
                  label={scope}
                  checked={!hiddenScopes.has(scope)}
                  onChange={(checked) => toggleScope(scope, checked)}
                  className='px-2 py-1 rounded hover:bg-control'
                />
              ))}
        </Popover>

        <TextInput
          value={query}
          onChange={setQuery}
          placeholder='Filter'
          className='h-6 py-0 text-xs w-40 ml-auto'
        />
        <Button size='sm' variant='ghost' active={following} title='Scroll to the newest entry' onClick={scrollToBottom}>
          Follow
        </Button>
        <Button size='sm' variant='ghost' title='Clear the console' onClick={() => logStore.clear()}>
          Clear
        </Button>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className='flex-1 min-h-0 overflow-y-auto overflow-x-hidden'>
        {filtered.length === 0
          ? <div className='h-full flex items-center justify-center text-xs text-dim select-none'>
              {entries.length === 0 ? 'No logs yet' : 'No logs match the current filters'}
            </div>
          : <Console logs={filtered as any} variant='dark' styles={getConsoleStyles()} components={COMPONENTS} />}
      </div>

      <div className='shrink-0 flex items-center gap-2 px-2 h-5 border-t border-border bg-surface-sunken text-[10px] text-dim'>
        <span className='tabular-nums'>{filtered.length} shown · {entries.length}/{MAX_LOGS} kept</span>
        <span className='ml-auto'>console.flush(...) rewrites its own row</span>
      </div>
    </div>
  );
}

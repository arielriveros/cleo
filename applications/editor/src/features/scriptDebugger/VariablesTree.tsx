import { useEffect, useState } from 'react';
import { cn } from '@cleo/app-kit/ui/cn';
import { describeRemote, isExpandable, type CdpPropertyDescriptor, type CdpRemoteObject } from './cdp';
import { scriptDebugger } from './debugSession';

/** Engine bookkeeping (`_name`, `__scriptId`) sorts after a script's own fields, folded away. */
const isInternal = (name: string) => name.startsWith('_');

function ValueText({ object }: { object: CdpRemoteObject | undefined }) {
  const tone = !object ? 'text-dim'
    : object.type === 'string' ? 'text-success-fg'
    : object.type === 'number' || object.type === 'boolean' || object.type === 'bigint' ? 'text-highlight'
    : object.type === 'undefined' || object.subtype === 'null' ? 'text-dim'
    : 'text-muted';
  return <span className={cn('truncate', tone)}>{describeRemote(object)}</span>;
}

/** One name = value row, expandable when the value is an object (its properties load on first open). */
export function VariableRow({ name, object, depth = 0, defaultOpen = false }: {
  name: string; object: CdpRemoteObject | undefined; depth?: number; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = isExpandable(object) && depth < 12;
  return (
    <div>
      <button
        type='button'
        className={cn('flex w-full min-w-0 items-baseline gap-1 px-1 text-left font-mono text-ui leading-5 hover:bg-control/60', !expandable && 'cursor-default')}
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => expandable && setOpen(o => !o)}
        title={object?.description}
      >
        <span className='w-3 shrink-0 text-dim'>{expandable ? (open ? '▾' : '▸') : ''}</span>
        <span className='shrink-0 text-fg'>{name}</span>
        <span className='shrink-0 text-dim'>:</span>
        <ValueText object={object} />
      </button>
      {open && expandable && object?.objectId && <Properties objectId={object.objectId} depth={depth + 1} />}
    </div>
  );
}

/** An object's own properties: the script's fields first, engine internals folded. */
export function Properties({ objectId, depth }: { objectId: string; depth: number }) {
  const [state, setState] = useState<{ id: string; props: CdpPropertyDescriptor[] | null; error?: string }>({ id: '', props: null });
  const [showInternal, setShowInternal] = useState(false);
  useEffect(() => {
    let live = true;
    setState({ id: objectId, props: null });
    scriptDebugger().properties(objectId).then(
      props => { if (live) setState({ id: objectId, props }); },
      e => { if (live) setState({ id: objectId, props: [], error: String(e?.message ?? e) }); },
    );
    return () => { live = false; };
  }, [objectId]);
  if (!state.props || state.id !== objectId) return <div className='px-2 text-ui-sm text-dim' style={{ paddingLeft: 16 + depth * 12 }}>Loading…</div>;
  if (state.error) return <div className='px-2 text-ui-sm text-dim' style={{ paddingLeft: 16 + depth * 12 }}>{state.error}</div>;
  const rows = state.props.filter(p => p.value || p.get);
  const own = rows.filter(p => !isInternal(p.name));
  const internal = rows.filter(p => isInternal(p.name));
  return (
    <div>
      {own.map(p => <VariableRow key={p.name} name={p.name} object={p.value ?? { type: 'function', description: '(getter)' } as CdpRemoteObject} depth={depth} />)}
      {internal.length > 0 && (
        showInternal
          ? internal.map(p => <VariableRow key={p.name} name={p.name} object={p.value} depth={depth} />)
          : (
            <button type='button' className='px-1 text-left text-ui-sm text-dim hover:text-fg' style={{ paddingLeft: 16 + depth * 12 }}
              onClick={() => setShowInternal(true)}>
              {internal.length} internal {internal.length === 1 ? 'field' : 'fields'}…
            </button>
          )
      )}
      {!rows.length && <div className='px-2 text-ui-sm text-dim' style={{ paddingLeft: 16 + depth * 12 }}>(empty)</div>}
    </div>
  );
}

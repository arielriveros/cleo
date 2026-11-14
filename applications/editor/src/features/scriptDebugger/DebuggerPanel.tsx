import { useState, type ReactNode } from 'react';
import { scriptLocationLabel, scriptSourceUrl } from 'cleo';
import { Button } from '@cleo/app-kit/ui/Button';
import { Toggle } from '@cleo/app-kit/ui/Toggle';
import { TextInput } from '@cleo/app-kit/ui/inputs';
import { cn } from '@cleo/app-kit/ui/cn';
import { canDebugScripts, scriptDebugger, scriptSourceAssetId, useScriptDebugger } from './debugSession';
import { setDebugPrefs, useDebugPrefs } from './debugPrefs';
import { updateBreakpoints, useBreakpoints, type ScriptBreakpoint } from './breakpoints';
import { usePlayTarget, writePlayTarget } from '../playWindow/playTarget';
import { openScriptAt } from '../nodeInspector/scriptEditor/scriptReveal';
import type { DebugFrame, DebugSnapshot, PauseReason } from './debugController';
import type { CdpRemoteObject, CdpScope } from './cdp';
import { VariableRow } from './VariablesTree';
import { BreakpointIcon, BreakpointsOffIcon, ContinueIcon, PauseIcon, StepIntoIcon, StepOutIcon, StepOverIcon } from './debugIcons';

const REASON: Record<PauseReason, string> = {
  breakpoint: 'on a breakpoint', exception: 'on an exception', step: 'after a step', pause: 'on Pause', other: '',
};

function locationOf(moduleId: string, line: number): string {
  return scriptLocationLabel({ url: scriptSourceUrl(moduleId), line });
}

function openAt(moduleId: string, line: number) {
  const assetId = scriptSourceAssetId(moduleId);
  if (assetId) openScriptAt(assetId, line, { inEditor: true });
}

function Section({ title, right, children, className }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-col border-r border-border-subtle last:border-r-0', className)}>
      <div className='flex h-[22px] shrink-0 items-center gap-2 border-b border-border-subtle px-2'>
        <span className='text-ui-sm font-semibold text-muted'>{title}</span>
        <span className='ml-auto flex items-center gap-1'>{right}</span>
      </div>
      <div className='min-h-0 flex-1 overflow-auto py-0.5'>{children}</div>
    </div>
  );
}

/** What the debugger is doing, or why it is not, in one line. */
function StatusLine({ snapshot }: { snapshot: DebugSnapshot }) {
  const target = usePlayTarget();
  if (!canDebugScripts()) {
    return <span className='text-dim'>The debugger runs in the desktop app. In the browser, play in a window and press F12 in it to debug its scripts.</span>;
  }
  switch (snapshot.phase) {
    case 'off':
      return target === 'editor'
        ? (
          <span className='flex items-center gap-2 text-dim'>
            Breakpoints stop the game only when it plays in a window.
            <Button size='sm' variant='subtle' className='h-[20px]' onClick={() => writePlayTarget('window')}>Play in window</Button>
          </span>
        )
        : <span className='text-dim'>Press Play: the game plays in a window and stops at your breakpoints.</span>;
    case 'attaching':
      return <span className='text-dim'>Attaching to the game window…</span>;
    case 'detached':
      return (
        <span className='flex items-center gap-2 text-warning'>
          The debugger lost the game window{snapshot.detachReason ? ` (${snapshot.detachReason})` : ''}.
          <Button size='sm' variant='subtle' className='h-[20px]' onClick={() => void scriptDebugger().reattach()}>Reattach</Button>
        </span>
      );
    case 'running':
      return <span className='text-muted'>{snapshot.pauseRequested ? 'Waiting for a script line to run…' : 'Running'}</span>;
    case 'paused': {
      const pause = snapshot.paused!;
      const frame = pause.frames[snapshot.selectedFrame];
      const where = frame?.moduleId ? locationOf(frame.moduleId, frame.line) : 'engine code';
      return <span className='text-warning'>Stopped at {where}{REASON[pause.reason] ? ` ${REASON[pause.reason]}` : ''}</span>;
    }
  }
}

function TransportButton({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button size='sm' variant='ghost' className='h-[22px] w-[24px] px-0' title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

/** The call stack: script frames by name and line (and the node they run on), engine code folded. */
function CallStack({ snapshot }: { snapshot: DebugSnapshot }) {
  const pause = snapshot.paused;
  if (!pause) return <div className='px-2 text-ui-sm text-dim'>Not stopped.</div>;
  const rows: ReactNode[] = [];
  let engine = 0;
  const flushEngine = (key: string) => {
    if (!engine) return;
    rows.push(<div key={key} className='px-2 font-mono text-ui-sm leading-5 text-dim'>engine code{engine > 1 ? ` (${engine} frames)` : ''}</div>);
    engine = 0;
  };
  pause.frames.forEach((frame: DebugFrame, i) => {
    if (!frame.user) { engine++; return; }
    flushEngine(`e${i}`);
    const node = snapshot.frameNodes[frame.callFrameId];
    rows.push(
      <button
        key={frame.callFrameId}
        type='button'
        className={cn('flex w-full min-w-0 items-baseline gap-2 px-2 text-left font-mono text-ui leading-5 hover:bg-control/60', i === snapshot.selectedFrame && 'bg-control text-fg')}
        onClick={() => scriptDebugger().selectFrame(i)}
      >
        <span className='truncate text-fg'>{frame.functionName || '(anonymous)'}</span>
        <span className='shrink-0 text-dim'>{frame.moduleId ? locationOf(frame.moduleId, frame.line) : `inline:${frame.line}`}</span>
        {node && <span className='truncate text-muted'>node '{node}'</span>}
      </button>,
    );
  });
  flushEngine('end');
  return <>{rows}</>;
}

const SCOPE_LABEL: Partial<Record<CdpScope['type'], string>> = {
  local: 'Local', closure: 'Closure', block: 'Block', catch: 'Catch', script: 'Script', module: 'Module', global: 'Global',
};

/** The selected frame's scopes and `this`; Global stays closed (it is the whole page). */
function Variables({ snapshot }: { snapshot: DebugSnapshot }) {
  const frame = snapshot.paused?.frames[snapshot.selectedFrame];
  if (!frame) return <div className='px-2 text-ui-sm text-dim'>Not stopped.</div>;
  const exception = snapshot.paused?.reason === 'exception' ? snapshot.paused.exception : undefined;
  return (
    <div key={frame.callFrameId}>
      {exception?.object && <VariableRow name='exception' object={exception.object} />}
      {frame.scopes.filter(s => s.type !== 'global' && s.type !== 'script').map((scope, i) => (
        <VariableRow key={`${scope.type}${i}`} name={SCOPE_LABEL[scope.type] ?? scope.type} object={scope.object} defaultOpen={i === 0} />
      ))}
      <VariableRow name='this' object={frame.thisObject} />
      {frame.scopes.filter(s => s.type === 'global').map((scope, i) => (
        <VariableRow key={`g${i}`} name='Global' object={scope.object} />
      ))}
    </div>
  );
}

/** Evaluate an expression in the selected frame; results stay listed (newest first) until the next stop. */
function Evaluate({ snapshot }: { snapshot: DebugSnapshot }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<{ id: number; expression: string; object?: CdpRemoteObject; error?: string; pause: unknown }[]>([]);
  const paused = snapshot.phase === 'paused';
  const shown = results.filter(r => r.pause === snapshot.paused);
  const run = async () => {
    const expression = text.trim();
    if (!expression || !paused) return;
    const pause = snapshot.paused;
    try {
      const r = await scriptDebugger().evaluate(expression);
      if (!r) return;
      setResults(list => [{ id: Date.now(), expression, pause, ...(r.exceptionDetails
        ? { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
        : { object: r.result }) }, ...list].slice(0, 20));
    } catch (e: any) {
      setResults(list => [{ id: Date.now(), expression, pause, error: String(e?.message ?? e) }, ...list].slice(0, 20));
    }
  };
  return (
    <div className='flex flex-col gap-0.5 border-t border-border-subtle p-1'>
      <TextInput
        value={text}
        onChange={setText}
        disabled={!paused}
        placeholder={paused ? 'Evaluate in this frame, Enter to run' : 'Evaluate (while stopped)'}
        className='h-[22px] font-mono'
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void run(); } }}
      />
      {shown.map(r => r.error
        ? <div key={r.id} className='px-1 font-mono text-ui-sm text-danger-fg'>{r.expression}: {r.error}</div>
        : <VariableRow key={r.id} name={r.expression} object={r.object} />)}
    </div>
  );
}

function BreakpointRow({ b, state }: { b: ScriptBreakpoint; state?: string }) {
  const detail = b.logMessage ? `log: ${b.logMessage}` : b.condition ? `when ${b.condition}` : '';
  const note = state === 'stale' ? 'after Restart' : state === 'pending' ? 'not run yet' : '';
  return (
    <div className='group flex min-w-0 items-center gap-1.5 px-2 leading-5'>
      <input
        type='checkbox'
        checked={b.enabled}
        aria-label={b.enabled ? 'Disable' : 'Enable'}
        onChange={() => updateBreakpoints(list => list.map(x => (x.id === b.id ? { ...x, enabled: !x.enabled } : x)))}
      />
      <button type='button' className='min-w-0 truncate text-left font-mono text-ui text-fg hover:underline' onClick={() => openAt(b.moduleId, b.line)}>
        {locationOf(b.moduleId, b.line)}
      </button>
      {detail && <span className='min-w-0 truncate font-mono text-ui-sm text-muted'>{detail}</span>}
      {note && <span className='shrink-0 text-ui-xs text-dim'>{note}</span>}
      <Button variant='remove' size='sm' className='ml-auto h-[18px] opacity-0 group-hover:opacity-100' title='Remove'
        onClick={() => updateBreakpoints(list => list.filter(x => x.id !== b.id))}>
        {'✕'}
      </Button>
    </div>
  );
}

/**
 * The Debugger panel: stop, step and continue a game playing in a window; where it stopped (the call
 * stack), what the variables hold, and every breakpoint in the project.
 */
export default function DebuggerPanel() {
  const snapshot = useScriptDebugger();
  const prefs = useDebugPrefs();
  const breakpoints = useBreakpoints();
  const debug = scriptDebugger();
  const paused = snapshot.phase === 'paused';
  const running = snapshot.phase === 'running';
  const exception = paused && snapshot.paused?.reason === 'exception' ? snapshot.paused.exception : undefined;
  const sorted = [...breakpoints].sort((a, b) => a.moduleId.localeCompare(b.moduleId) || a.line - b.line);

  return (
    <div className='flex h-full min-h-0 flex-col bg-surface text-ui text-fg'>
      <div className='flex h-[28px] shrink-0 items-center gap-1 border-b border-border px-1'>
        {paused
          ? <TransportButton title='Continue (F8)' onClick={() => debug.resume()}><ContinueIcon /></TransportButton>
          : <TransportButton title='Pause at the next script line (F8)' disabled={!running} onClick={() => debug.pause()}><PauseIcon /></TransportButton>}
        <TransportButton title='Step over (F10)' disabled={!paused} onClick={() => debug.stepOver()}><StepOverIcon /></TransportButton>
        <TransportButton title='Step into (F11)' disabled={!paused} onClick={() => debug.stepInto()}><StepIntoIcon /></TransportButton>
        <TransportButton title='Step out (Shift+F11)' disabled={!paused} onClick={() => debug.stepOut()}><StepOutIcon /></TransportButton>
        <span className='mx-1 h-4 w-px bg-border' />
        <span className='min-w-0 flex-1 truncate text-ui'><StatusLine snapshot={snapshot} /></span>
        <Toggle label='Stop on exceptions' checked={prefs.pauseOnExceptions} onChange={on => setDebugPrefs({ pauseOnExceptions: on })} />
        <TransportButton
          title={prefs.breakpointsActive ? 'Breakpoints on: click to let the game run past them' : 'Breakpoints off: click to stop at them again'}
          onClick={() => setDebugPrefs({ breakpointsActive: !prefs.breakpointsActive })}
        >
          {prefs.breakpointsActive ? <BreakpointIcon /> : <BreakpointsOffIcon />}
        </TransportButton>
      </div>
      {exception && (
        <div className='flex shrink-0 items-center gap-2 border-b border-border bg-danger/[0.09] px-2 py-0.5'>
          <span className='min-w-0 flex-1 truncate font-mono text-ui text-danger-fg' title={exception.text}>{exception.text.split('\n')[0]}</span>
          <Button size='sm' variant='subtle' className='h-[20px] shrink-0' onClick={() => debug.ignoreCurrentException()}>Don't stop here again</Button>
        </div>
      )}
      <div className='grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]'>
        <Section title='Call stack'><CallStack snapshot={snapshot} /></Section>
        <Section title='Variables' className='flex flex-col'>
          <div className='flex min-h-0 flex-1 flex-col'>
            <div className='min-h-0 flex-1 overflow-auto'><Variables snapshot={snapshot} /></div>
            <Evaluate snapshot={snapshot} />
          </div>
        </Section>
        <Section
          title='Breakpoints'
          right={breakpoints.length > 0 && (
            <Button size='sm' variant='ghost' className='h-[18px] text-ui-sm text-dim' onClick={() => updateBreakpoints(() => [])}>Remove all</Button>
          )}
        >
          {sorted.length
            ? sorted.map(b => <BreakpointRow key={b.id} b={b} state={snapshot.states[b.id]} />)
            : <div className='px-2 text-ui-sm text-dim'>Click left of a line number in a script to stop there.</div>}
        </Section>
      </div>
    </div>
  );
}

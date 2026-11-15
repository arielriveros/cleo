import { useState, type ReactNode } from 'react';
import { Button } from '@cleo/app-kit/ui/Button';
import { cn } from '@cleo/app-kit/ui/cn';
import { editorPrefsStore, useEditorPrefs } from '../options/editorPrefs';
import { usePlayTarget, writePlayTarget } from '../playWindow/playTarget';
import { useWindowPlay } from '../playWindow/windowPlay';
import { useScriptWorkspace } from '../scriptWorkspace/ScriptWorkspaceContext';
import { launchConfiguration } from '../scriptWorkspace/scaffold';
import { useVsCodeDebug } from './vscodeAttach';
import { BugIcon } from './debugIcons';

// What the Debugger panel shows when Cleo's own debugger is not the one: in a browser (which cannot drive
// another page's debugger), and with VS Code chosen as the debugger.

const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className='rounded border border-border bg-control px-1 font-mono text-ui-sm text-fg'>{children}</kbd>
);

function Card({ title, tone = 'info', children }: { title: ReactNode; tone?: 'info' | 'warning'; children: ReactNode }) {
  return (
    <div className='flex h-full min-h-0 overflow-auto bg-surface p-3'>
      <div className={cn('m-auto w-full max-w-[760px] rounded-md border p-4 text-ui text-fg',
        tone === 'info' ? 'border-highlight/40 bg-highlight/[0.07]' : 'border-warning/40 bg-warning/[0.07]')}>
        <div className='flex items-center gap-2 text-ui-lg font-semibold text-fg'>
          <span className={tone === 'info' ? 'text-highlight' : 'text-warning'}><BugIcon /></span>
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

/** In the browser: the game window's own developer tools are the debugger. */
export function BrowserDebugging() {
  const target = usePlayTarget();
  return (
    <Card title='Debugging scripts in the browser'>
      <ol className='mt-3 list-decimal space-y-2 pl-5 leading-5'>
        <li>
          Play the game in a window: <b>Play ▸ Play in window</b>.
          {target === 'editor' && (
            <Button size='sm' variant='primary' className='ml-2 h-[20px]' onClick={() => writePlayTarget('window')}>Play in window</Button>
          )}
        </li>
        <li>
          In the game window, press <Kbd>F12</Kbd> (<Kbd>Cmd</Kbd>+<Kbd>Option</Kbd>+<Kbd>I</Kbd> on a Mac) to open the
          browser's developer tools.
        </li>
        <li>
          Open <b>Sources</b>, then <b>cleo-script://</b>. Your scripts are listed by their path, with your own line
          numbers: set breakpoints, step through them and read their variables there.
        </li>
      </ol>
      <p className='mt-3 text-ui-sm text-muted'>
        Script errors in the Console here still link to their line. Breakpoints set in Cleo's script editor, and
        attaching VS Code, work in the Cleo desktop app.
      </p>
    </Card>
  );
}

/** With VS Code as the debugger: how to attach it, and whether it is. */
export function VsCodeDebugging() {
  const prefs = useEditorPrefs();
  const status = useVsCodeDebug();
  const session = useWindowPlay();
  const ws = useScriptWorkspace();
  const [copied, setCopied] = useState(false);
  const stopped = !!session.sessionId && status.stopped.includes(session.sessionId);
  const state = status.error ? `The debug port could not open: ${status.error}`
    : !status.listening ? 'Opening the debug port…'
    : stopped ? 'The game is stopped in VS Code'
    : status.clients > 0 ? `VS Code is attached on port ${status.port}`
    : `Waiting for VS Code on port ${status.port}`;
  const dot = status.error ? 'bg-warning' : stopped ? 'bg-warning' : status.clients > 0 ? 'bg-success' : 'bg-muted animate-pulse';
  const copy = () => {
    void navigator.clipboard?.writeText(JSON.stringify(launchConfiguration(prefs.vscodeDebugPort), null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Card title='Debugging in VS Code' tone={status.error ? 'warning' : 'info'}>
      <div className='mt-2 flex items-center gap-2 text-ui'>
        <span className={cn('h-2 w-2 rounded-full', dot)} />
        <span className={status.error ? 'text-warning' : 'text-fg'}>{state}</span>
      </div>
      <ol className='mt-3 list-decimal space-y-2 pl-5 leading-5'>
        <li>
          Open the script workspace in VS Code.
          {ws.rootPath
            ? <Button size='sm' className='ml-2 h-[20px]' onClick={() => void ws.openInEditor()}>Open in VS Code</Button>
            : <Button size='sm' variant='primary' className='ml-2 h-[20px]' onClick={() => void ws.setup()}>Set up the workspace…</Button>}
        </li>
        <li>
          In VS Code, set breakpoints in your scripts and press <Kbd>F5</Kbd> (<b>Attach to the Cleo game</b>).
        </li>
        <li>Press Play: the game plays in a window and stops at VS Code's breakpoints.</li>
      </ol>
      <p className='mt-3 text-ui-sm text-muted'>
        Cleo's own debugger is off while VS Code is chosen: a game window takes one debugger. To stop at script
        errors, tick <b>Caught Exceptions</b> in VS Code's Breakpoints view (the engine catches every script's
        errors, so they are never "uncaught"). A workspace that already had a launch.json keeps it: add this
        configuration to it.
      </p>
      <div className='mt-3 flex flex-wrap gap-1.5'>
        <Button size='sm' onClick={copy}>{copied ? 'Copied' : 'Copy launch configuration'}</Button>
        <Button size='sm' variant='ghost' onClick={() => editorPrefsStore.set({ scriptDebugWith: 'cleo' })}>Use Cleo's debugger</Button>
      </div>
    </Card>
  );
}

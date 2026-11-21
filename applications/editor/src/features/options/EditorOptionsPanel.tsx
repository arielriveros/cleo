import { useEffect, useState } from 'react'
import { Button, Field, Hint, NumberInput, SegmentedControl, Section, Select, Slider, TextInput, cn } from '@cleo/app-kit/ui'
import { KEY_CODES, sourceLabel } from 'cleo'
import { useRebindCapture } from '../input/useRebindCapture'
import { isDesktop } from '../publish/publishClient'
import { useScriptWorkspace } from '../scriptWorkspace/ScriptWorkspaceContext'
import { codeThemeStore, useCodeTheme, type CodeThemeName } from '@cleo/app-kit/code/codeThemeStore'
import { DEFAULT_EDITOR_PREFS, editorPrefsStore, useEditorPrefs, type ScriptDebugger, type ScriptOpener } from './editorPrefs'
import { desktopDebugPort } from '../playWindow/desktopPlay'
import { useVsCodeDebug } from '../scriptDebugger/vscodeAttach'
import { launchConfiguration } from '../projectFolder/scaffold'
import { showProjectFolder } from '../projectFolder/folderActions'
import { OptionsPageBody, OptionsShell, OPTION_LABEL, useOptionsPage } from '@cleo/app-kit/ui/OptionsShell'

// Options ▸ Editor: how the editor behaves for YOU, on this machine, in every project. Nothing here
// travels with a project or reaches a published game.

type Page = 'scripts' | 'viewport'

export default function EditorOptionsPanel() {
  const [page, setPage] = useOptionsPage<Page>('editor', 'scripts')
  return (
    <OptionsShell
      page={page}
      onPage={setPage}
      pages={[
        { value: 'scripts', label: 'Scripts', doc: 'editor/options#scripts' },
        { value: 'viewport', label: 'Viewport', doc: 'editor/options#viewport' },
      ]}
    >
      {page === 'scripts' && <ScriptOptions />}
      {page === 'viewport' && <ViewportOptions />}
    </OptionsShell>
  )
}

const DESKTOP_ONLY = 'Opening scripts in VSCode works in the Cleo desktop app, which can reach your files. '
  + 'In the browser, scripts open in the built-in code editor.'

function ScriptOptions() {
  const prefs = useEditorPrefs()
  const theme = useCodeTheme()
  const ws = useScriptWorkspace()
  const desktop = isDesktop() && ws.available

  // The command is validated on commit (a bare program name), so it is typed into a draft.
  const [command, setCommand] = useState(prefs.externalEditorCommand)
  useEffect(() => setCommand(prefs.externalEditorCommand), [prefs.externalEditorCommand])
  const commandValid = /^[\w.+-]+$/.test(command)
  const commitCommand = () => {
    if (commandValid) editorPrefsStore.set({ externalEditorCommand: command })
    else setCommand(prefs.externalEditorCommand)
  }

  const openWith: ScriptOpener = desktop ? prefs.scriptOpenWith : 'builtin'

  return (
    <OptionsPageBody>
      <Section title='Opening scripts'>
        <Field label='Open scripts with' labelClassName={OPTION_LABEL}>
          <SegmentedControl<ScriptOpener>
            grow
            className='flex-1'
            value={openWith}
            onChange={v => editorPrefsStore.set({ scriptOpenWith: v })}
            options={[
              { value: 'builtin', label: 'Cleo code editor' },
              { value: 'vscode', label: 'VSCode', disabled: !desktop, title: desktop ? 'Open the script\'s file in the external editor' : DESKTOP_ONLY },
            ]}
          />
        </Field>
        {!desktop && <Hint className={cn('mb-1', 'ml-[158px]')}>{DESKTOP_ONLY}</Hint>}
        {desktop && openWith === 'vscode' && (
          <Hint className='mb-1 ml-[158px]'>
            The first script you open sets up the workspace folder if there isn't one yet. Edits sync back
            live; the built-in editor stays one click away in the script's tab menu.
          </Hint>
        )}

        <Field label='External editor' labelClassName={OPTION_LABEL}>
          <TextInput
            value={command}
            disabled={!desktop}
            onChange={setCommand}
            onBlur={commitCommand}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            className={cn(!commandValid && 'border-danger')}
            spellCheck={false}
          />
        </Field>
      </Section>

      <WorkspaceSection desktop={desktop} />

      <DebuggingSection desktop={isDesktop() && !!desktopDebugPort()} />

      <Section title='Code editor'>
        <Field label='Theme' labelClassName={OPTION_LABEL}>
          <SegmentedControl<CodeThemeName>
            grow
            className='flex-1'
            value={theme}
            onChange={v => codeThemeStore.set(v)}
            options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
          />
        </Field>
      </Section>
    </OptionsPageBody>
  )
}

/** The project's folder (desktop): where its scripts are files an external editor opens. */
function WorkspaceSection({ desktop }: { desktop: boolean }) {
  const ws = useScriptWorkspace()
  const { externalEditorCommand: cmd } = useEditorPrefs()

  return (
    <Section title='Project folder'>
      {!desktop || !ws.rootPath ? (
        <Hint>In the Cleo desktop app a project is a folder, and its scripts are files under its Assets folder.</Hint>
      ) : (
        <>
          <Field label='Folder' labelClassName={OPTION_LABEL}>
            <span className='flex-1 break-all text-ui-sm text-dim' title={ws.rootPath}>{ws.rootPath}</span>
          </Field>
          <Hint className='ml-[158px]'>Scripts are the .ts files under Assets. An edit saved in another editor is taken in at once.</Hint>
          <div className='mt-2 flex flex-wrap gap-1.5'>
            <Button size='sm' onClick={() => void ws.openInEditor()}>Open in {cmd === 'code' ? 'VS Code' : cmd}</Button>
            <Button size='sm' variant='ghost' onClick={() => void showProjectFolder()}>Show folder</Button>
          </div>
        </>
      )}
    </Section>
  )
}

const DEBUG_DESKTOP_ONLY = 'Both debuggers drive a game playing in a window from the Cleo desktop app. '
  + 'In the browser, press F12 in the game window instead.'

/**
 * Which debugger stops a game playing in a window: Cleo's own (the Debugger panel, breakpoints in the
 * script editor), or VS Code attached to the desktop app's debug port. One at a time — a game window has one
 * debugger connection.
 */
function DebuggingSection({ desktop }: { desktop: boolean }) {
  const prefs = useEditorPrefs()
  const vscode = useVsCodeDebug()
  const debugWith: ScriptDebugger = desktop ? prefs.scriptDebugWith : 'cleo'
  // Committed on blur / Enter: every keystroke would move the port.
  const [port, setPort] = useState(String(prefs.vscodeDebugPort))
  useEffect(() => setPort(String(prefs.vscodeDebugPort)), [prefs.vscodeDebugPort])
  const portNumber = Number(port)
  const portValid = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535
  const commitPort = () => {
    if (portValid) editorPrefsStore.set({ vscodeDebugPort: portNumber })
    else setPort(String(prefs.vscodeDebugPort))
  }
  const [copied, setCopied] = useState(false)
  const copyLaunch = () => {
    void navigator.clipboard?.writeText(JSON.stringify(launchConfiguration(prefs.vscodeDebugPort), null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Section title='Debugging'>
      <Field label='Debug scripts with' labelClassName={OPTION_LABEL}>
        <SegmentedControl<ScriptDebugger>
          grow
          className='flex-1'
          value={debugWith}
          onChange={v => editorPrefsStore.set({ scriptDebugWith: v })}
          options={[
            { value: 'cleo', label: 'Cleo', disabled: !desktop, title: desktop ? 'Breakpoints in the script editor, the Debugger panel' : DEBUG_DESKTOP_ONLY },
            { value: 'vscode', label: 'VS Code', disabled: !desktop, title: desktop ? 'VS Code attaches to the game window (F5, "Attach to the Cleo game")' : DEBUG_DESKTOP_ONLY },
          ]}
        />
      </Field>
      {!desktop && <Hint className='mb-1 ml-[158px]'>{DEBUG_DESKTOP_ONLY}</Hint>}
      {desktop && debugWith === 'vscode' && (
        <>
          <Field label='VS Code debug port' labelClassName={OPTION_LABEL}>
            <TextInput
              value={port}
              onChange={setPort}
              onBlur={commitPort}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              className={cn('w-[90px] flex-none tabular-nums', !portValid && 'border-danger')}
              spellCheck={false}
            />
            <span className={cn('ml-2 flex items-center gap-1.5 text-ui-sm', vscode.error ? 'text-warning' : 'text-dim')}>
              <span className={cn('h-1.5 w-1.5 rounded-full', vscode.error ? 'bg-warning' : vscode.clients > 0 ? 'bg-success' : vscode.listening ? 'bg-muted' : 'bg-danger')} />
              {vscode.error ?? (vscode.clients > 0 ? 'VS Code attached' : vscode.listening ? 'Waiting for VS Code' : 'Not listening')}
            </span>
          </Field>
          <Hint className='mb-1 ml-[158px]'>
            Cleo's own debugger is off. In the script workspace, press F5 ("Attach to the Cleo game"), then Play in
            window. The workspace gets that launch configuration when it is set up and has none; the port only
            reaches game windows, and only from this computer.
          </Hint>
          <div className='ml-[158px] mb-1'>
            <Button size='sm' onClick={copyLaunch} title='The launch.json configuration, for a workspace that already has its own launch.json'>
              {copied ? 'Copied' : 'Copy launch configuration'}
            </Button>
          </div>
        </>
      )}
    </Section>
  )
}

const ListenIcon = () => (
  <svg viewBox='0 0 16 16' width='12' height='12' fill='none' stroke='currentColor' strokeWidth='1.5' aria-hidden>
    <circle cx='8' cy='8' r='5.5' /><circle cx='8' cy='8' r='2' fill='currentColor' />
  </svg>
)

/**
 * Play ▸ Release mouse: the key that lets the mouse go while the game has it. Picked from the list (the only way to
 * pick Esc, which cancels a Listen) or by pressing it. Esc lets the mouse go in any case outside fullscreen: the
 * browser does that itself.
 */
function ReleaseMouseKeyField() {
  const prefs = useEditorPrefs()
  const capture = useRebindCapture()
  const listening = capture.listeningFor === 'releaseMouseKey'
  const code = prefs.releaseMouseKey
  const listen = async () => {
    const source = await capture.start('releaseMouseKey', { device: 'key' })
    if (source && source.device === 'key') editorPrefsStore.set({ releaseMouseKey: source.code })
  }
  return (
    <Field label='Release mouse' labelClassName={OPTION_LABEL}>
      <div className='flex items-center gap-1 min-w-0'
        title='The key that lets the mouse go in Play. Outside fullscreen the browser lets it go on Esc as well; in fullscreen Play the game holds every key, so this one alone does.'>
        <Select className='flex-1 min-w-0' value={code} onChange={e => editorPrefsStore.set({ releaseMouseKey: e.target.value })}>
          {!(KEY_CODES as readonly string[]).includes(code) && <option value={code}>{code}</option>}
          {KEY_CODES.map(k => <option key={k} value={k}>{sourceLabel({ device: 'key', code: k })}</option>)}
        </Select>
        <Button size='icon' variant={listening ? 'primary' : 'ghost'} onClick={listening ? capture.cancel : listen}
          title={listening ? 'Press the key (Escape cancels)' : 'Press a key to use it'}>
          <ListenIcon />
        </Button>
      </div>
    </Field>
  )
}

function ViewportOptions() {
  const prefs = useEditorPrefs()
  const d = DEFAULT_EDITOR_PREFS
  const multiplier = (v: number) => `${v.toFixed(2)}×`

  return (
    <OptionsPageBody>
      <Section title='Editor camera'>
        <Slider label='Fly speed' labelClassName={OPTION_LABEL} min={0.1} max={10} step={0.05}
          title='Multiplies how fast the editor camera flies, pans and lifts (WASD/QE, right-drag).'
          value={prefs.cameraFlySpeed} onChange={v => editorPrefsStore.set({ cameraFlySpeed: v })}
          readout={multiplier} />
        <Slider label='Look sensitivity' labelClassName={OPTION_LABEL} min={0.1} max={4} step={0.05}
          title='Multiplies how fast the camera turns with the mouse.'
          value={prefs.cameraLookSensitivity} onChange={v => editorPrefsStore.set({ cameraLookSensitivity: v })}
          readout={multiplier} />
      </Section>

      <Section title='Gizmo snapping'>
        <Field label='Move step (m)' labelClassName={OPTION_LABEL}>
          <NumberInput value={prefs.snapTranslate} min={0.001} step={0.25}
            onChange={v => editorPrefsStore.set({ snapTranslate: v })} />
        </Field>
        <Field label='Rotate step (°)' labelClassName={OPTION_LABEL}>
          <NumberInput value={prefs.snapRotateDeg} min={0.1} max={180} step={5}
            onChange={v => editorPrefsStore.set({ snapRotateDeg: v })} />
        </Field>
        <Field label='Scale step' labelClassName={OPTION_LABEL}>
          <NumberInput value={prefs.snapScale} min={0.001} step={0.05}
            onChange={v => editorPrefsStore.set({ snapScale: v })} />
        </Field>
      </Section>

      <Section title='Play'>
        <ReleaseMouseKeyField />
      </Section>

      <Button size='sm' variant='ghost' onClick={() => editorPrefsStore.set({
        cameraFlySpeed: d.cameraFlySpeed, cameraLookSensitivity: d.cameraLookSensitivity,
        snapTranslate: d.snapTranslate, snapRotateDeg: d.snapRotateDeg, snapScale: d.snapScale,
        releaseMouseKey: d.releaseMouseKey,
      })}>
        Reset viewport options
      </Button>
    </OptionsPageBody>
  )
}

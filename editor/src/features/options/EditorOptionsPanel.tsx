import { useEffect, useState } from 'react'
import { Button, Field, Hint, NumberInput, SegmentedControl, Section, Slider, TextInput, cn } from '../../components/ui'
import { isDesktop } from '../publish/publishClient'
import { useScriptWorkspace } from '../scriptWorkspace/ScriptWorkspaceContext'
import { codeThemeStore, useCodeTheme, type CodeThemeName } from '../nodeInspector/scriptEditor/codeThemeStore'
import { DEFAULT_EDITOR_PREFS, editorPrefsStore, useEditorPrefs, type ScriptOpener } from './editorPrefs'
import { OptionsPageBody, OptionsShell, OPTION_LABEL, useOptionsPage } from './OptionsShell'

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
        { value: 'scripts', label: 'Scripts', title: 'Where scripts open, the external editor, the code theme' },
        { value: 'viewport', label: 'Viewport', title: 'Editor camera speed and gizmo snapping' },
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
        <Field label='Open scripts with' labelClassName={OPTION_LABEL}
          hint='Where a script opens when you double-click it, press ✎ on a script slot, or create a new one.'>
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

        <Field label='External editor' labelClassName={OPTION_LABEL}
          hint={'The command the desktop app runs to open the workspace: code (VSCode), cursor, codium… '
            + 'A program name on your PATH, no arguments.'}>
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

const STATUS_LABEL: Record<string, string> = {
  off: 'Not set up',
  connecting: 'Connecting…',
  live: 'Synced',
  paused: 'Sync paused',
  error: 'Sync error',
}
const STATUS_DOT: Record<string, string> = {
  off: 'bg-muted',
  connecting: 'bg-muted animate-pulse',
  live: 'bg-success',
  paused: 'bg-warning',
  error: 'bg-danger',
}

/** The project's script folder on disk: the mirror VSCode edits. Replaces the old menu-bar button. */
function WorkspaceSection({ desktop }: { desktop: boolean }) {
  const ws = useScriptWorkspace()
  const { externalEditorCommand: cmd } = useEditorPrefs()
  const attention = ws.status === 'paused' || ws.status === 'error'

  return (
    <Section title='Script workspace folder'
      hint={'Every script of this project, mirrored to a real folder with typings, so an external editor gets '
        + 'autocomplete. Saved files sync back into the editor.'}>
      {!desktop ? (
        <Hint>Available in the Cleo desktop app.</Hint>
      ) : (
        <>
          <Field label='Status' labelClassName={OPTION_LABEL}>
            <span className='flex flex-1 items-center gap-1.5 text-ui text-fg'>
              <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[ws.status] ?? 'bg-muted')} />
              {STATUS_LABEL[ws.status] ?? ws.status}
            </span>
          </Field>
          {ws.rootPath && (
            <Field label='Folder' labelClassName={OPTION_LABEL}>
              <span className='flex-1 break-all text-ui-sm text-dim' title={ws.rootPath}>{ws.rootPath}</span>
            </Field>
          )}
          {ws.message && <Hint className={cn('ml-[158px]', attention && 'text-warning')}>{ws.message}</Hint>}

          <div className='mt-2 flex flex-wrap gap-1.5'>
            {!ws.rootPath ? (
              <Button size='sm' variant='primary' onClick={() => void ws.setup()}>Choose folder…</Button>
            ) : (
              <>
                <Button size='sm' onClick={() => void ws.openInEditor()}>Open in {cmd === 'code' ? 'VSCode' : cmd}</Button>
                {attention && (
                  <>
                    <Button size='sm' variant='primary' title='Restores the folder from the script library.'
                      onClick={() => void ws.resync()}>
                      Rewrite from editor
                    </Button>
                    <Button size='sm' variant='danger' title='Removes the scripts pending deletion from every node that uses them.'
                      onClick={() => void ws.applyPendingDeletions()}>
                      Apply deletions
                    </Button>
                  </>
                )}
                <Button size='sm' variant='ghost' title='Stop syncing. The files on disk are left alone.'
                  onClick={() => void ws.disconnect()}>
                  Disconnect
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </Section>
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

      <Section title='Gizmo snapping' hint='Hold Ctrl while dragging a gizmo to snap to these steps.'>
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

      <Button size='sm' variant='ghost' onClick={() => editorPrefsStore.set({
        cameraFlySpeed: d.cameraFlySpeed, cameraLookSensitivity: d.cameraLookSensitivity,
        snapTranslate: d.snapTranslate, snapRotateDeg: d.snapRotateDeg, snapScale: d.snapScale,
      })}>
        Reset viewport options
      </Button>
    </OptionsPageBody>
  )
}

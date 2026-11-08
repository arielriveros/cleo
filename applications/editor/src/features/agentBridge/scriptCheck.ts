import type { ScriptAsset } from '../../utils/scripts'

// TypeScript diagnostics for a script, from the SAME checker the script tab uses: Monaco's TS worker with the
// engine's .d.ts tree and the editor's compiler options (app-kit code/monacoSetup.ts). So what the agent is
// told is exactly what the user would see as squiggles. Monaco is loaded on first use only (the first check
// pays for the worker, a few seconds), keeping it out of the editor's startup.

export interface ScriptDiagnostic { line: number; column: number; code: number; severity: 'error' | 'warning'; message: string }

/**
 * Monaco's TS mode registers on the first 'typescript' model, asynchronously: until then
 * getTypeScriptWorker rejects with "TypeScript not registered!". Wait it out (first check only); the getter
 * it returns is kept for every later check.
 */
let workerGetter: ((...uris: any[]) => Promise<any>) | null = null
async function tsWorker(monaco: any): Promise<(...uris: any[]) => Promise<any>> {
  if (workerGetter) return workerGetter
  for (let i = 0; ; i++) {
    try { return (workerGetter = await monaco.languages.typescript.getTypeScriptWorker()) } catch (err) {
      if (i >= 100 || !String(err).includes('not registered')) throw err
      await new Promise(r => setTimeout(r, 100))
    }
  }
}

let warming: Promise<void> | null = null

/**
 * Load the checker before an agent needs it: Monaco, the TS worker and the engine's .d.ts tree, which make
 * the first check take seconds. Runs one check of a throwaway script and disposes it. Idempotent; never throws.
 */
export function warmTypecheck(assets: readonly ScriptAsset[], pathOf: (assetId: string) => string | undefined): Promise<void> {
  warming ??= typecheckScript("import { Node } from 'cleo'\nexport default class AgentWarmup extends Node {}\n", '/__agent_warmup__', assets, pathOf, { dispose: true })
    .then(() => {}, () => { warming = null })
  return warming
}

/** What the editor's diagnostics options already hide (monacoSetup.ts setDiagnosticsOptions). */
const IGNORED = new Set([2531, 2532, 18047, 18048])

function flatten(text: unknown): string {
  if (typeof text === 'string') return text
  const chain = text as { messageText?: string; next?: unknown[] } | undefined
  if (!chain) return ''
  return [chain.messageText ?? '', ...(chain.next ?? []).map(flatten)].filter(Boolean).join(' ')
}

/**
 * Type-check `source` as the script at `moduleId` ("/Player/Hero"), so its relative and `@/` imports resolve
 * against the project's other scripts. A model the user has open in a tab is never written to: the check
 * then runs on a scratch copy beside it. `dispose` drops the model afterwards (a throwaway check).
 */
export async function typecheckScript(
  source: string,
  moduleId: string,
  assets: readonly ScriptAsset[],
  pathOf: (assetId: string) => string | undefined,
  opts: { dispose?: boolean } = {},
): Promise<ScriptDiagnostic[]> {
  const { ensureMonaco } = await import('@cleo/app-kit/code/monacoSetup')
  const { syncScriptModels, scriptModelUri } = await import('../nodeInspector/scriptEditor/scriptModels')
  const monaco = ensureMonaco()
  syncScriptModels(monaco, assets, pathOf)

  let uri = scriptModelUri(monaco, moduleId)
  let model = monaco.editor.getModel(uri)
  let scratch = false
  if (model?.isAttachedToEditor()) {
    const slash = moduleId.lastIndexOf('/')
    uri = scriptModelUri(monaco, `${moduleId.slice(0, slash + 1)}__agent_check_${moduleId.slice(slash + 1)}`)
    model = monaco.editor.getModel(uri)
    scratch = true
  }
  if (!model) model = monaco.editor.createModel(source, 'typescript', uri)
  else if (model.getValue() !== source) model.setValue(source)

  const m = model
  try {
    const getWorker = await tsWorker(monaco)
    const worker = await getWorker(uri)
    const file = uri.toString()
    const [syntactic, semantic] = await Promise.all([worker.getSyntacticDiagnostics(file), worker.getSemanticDiagnostics(file)])
    return [...syntactic, ...semantic]
      .filter(d => !IGNORED.has(d.code))
      .map(d => {
        const pos = m.getPositionAt(d.start ?? 0)
        return {
          line: pos.lineNumber, column: pos.column, code: d.code,
          severity: d.category === 1 ? 'error' as const : 'warning' as const,
          message: flatten(d.messageText),
        }
      })
  } finally {
    if (scratch || opts.dispose) m.dispose()
  }
}

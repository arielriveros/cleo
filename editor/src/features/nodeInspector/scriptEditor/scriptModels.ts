import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api'
import type { ScriptAsset } from '../../../utils/scripts'

// One Monaco model per script asset, at the path other scripts import it by:
//
//     /Shared/Math.script  ->  file:///project/Shared/Math.ts  <-  import … from '@/Shared/Math'
//                                                              <-  import … from '../Shared/Math'
//
// The TypeScript worker resolves imports against the models that exist, so for `./Util` to type-check
// in the script being edited, Util must have a model too — even though no tab shows it. These models are
// owned HERE and outlive any editor; the script tab only borrows the one for its script.
//
// `@/*` is mapped to `project/*` in the compiler options (monacoSetup.ts), the same alias the VS Code
// workspace tsconfig declares, so one import resolves identically in both editors and at runtime.

const PROJECT_ROOT = '/project'
/** asset id -> the model URI it currently owns. */
const owned = new Map<string, string>()

/** The URI a script at module id `/Shared/Math` gets. */
export function scriptModelUri(monaco: typeof Monaco, moduleId: string): Monaco.Uri {
  return monaco.Uri.from({ scheme: 'file', path: `${PROJECT_ROOT}${moduleId}.ts` })
}

/**
 * Bring the project models in line with the library. `pathOf` gives each asset's module id (scripts the
 * explorer has not indexed yet get no model). A model with an editor attached is the user's working copy
 * and is never overwritten; once the tab closes, the next sync resets it to the saved source.
 */
export function syncScriptModels(
  monaco: typeof Monaco,
  assets: readonly ScriptAsset[],
  pathOf: (assetId: string) => string | undefined,
): void {
  const live = new Set<string>()
  for (const asset of assets) {
    const moduleId = pathOf(asset.id)
    if (!moduleId) continue
    const uri = scriptModelUri(monaco, moduleId)
    const key = uri.toString()
    live.add(asset.id)

    // Moved or renamed in the explorer: the old model goes (unless a tab still shows it).
    const previous = owned.get(asset.id)
    if (previous && previous !== key) disposeIfIdle(monaco, previous)
    owned.set(asset.id, key)

    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(asset.source, 'typescript', uri)
    if (!model.isAttachedToEditor() && model.getValue() !== asset.source) model.setValue(asset.source)
  }
  for (const [id, key] of [...owned]) {
    if (live.has(id)) continue
    disposeIfIdle(monaco, key)
    owned.delete(id)
  }
}

/** The project model for a script, if it has one — what the script tab edits. */
export function scriptModelFor(monaco: typeof Monaco, assetId: string): Monaco.editor.ITextModel | null {
  const key = owned.get(assetId)
  return key ? monaco.editor.getModel(monaco.Uri.parse(key)) : null
}

function disposeIfIdle(monaco: typeof Monaco, key: string): void {
  const model = monaco.editor.getModel(monaco.Uri.parse(key))
  if (model && !model.isAttachedToEditor()) model.dispose()
}

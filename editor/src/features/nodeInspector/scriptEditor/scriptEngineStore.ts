// Which component renders the script editor: CodeMirror (the proven default) or Monaco (full TypeScript
// IntelliSense — hover, signatures, real type errors on the imported `cleo` API — new and less battle-
// tested). Follows codeThemeStore.ts's pattern: a persisted, module-level store read via
// useSyncExternalStore, since ScriptEditor.tsx has no state of its own worth lifting this into.
//
// This is a rollback lever, not a permanent preference: CodeEditor.tsx (CodeMirror) is kept fully intact
// specifically so flipping this back requires no code changes if Monaco misbehaves for someone.
import { useSyncExternalStore } from 'react'

export type ScriptEngine = 'codemirror' | 'monaco'

const KEY = 'cleo.scriptEditor.engine'

function load(): ScriptEngine {
  try {
    return localStorage.getItem(KEY) === 'monaco' ? 'monaco' : 'codemirror'
  } catch {
    return 'codemirror'
  }
}

let current: ScriptEngine = load()
const listeners = new Set<() => void>()

export const scriptEngineStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getSnapshot(): ScriptEngine {
    return current
  },
  set(name: ScriptEngine): void {
    if (name === current) return
    current = name
    try { localStorage.setItem(KEY, name) } catch { /* ignore */ }
    listeners.forEach((listener) => listener())
  },
}

export function useScriptEngine(): ScriptEngine {
  return useSyncExternalStore(scriptEngineStore.subscribe, scriptEngineStore.getSnapshot)
}

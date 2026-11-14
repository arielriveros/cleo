import { useMemo, type ReactNode } from 'react';
import { moduleIdOfScriptUrl, scriptLocationLabel, type ScriptSourceLocation } from 'cleo';
import { ConsoleSourceContext, type ConsoleSourceLinks } from '@cleo/app-kit/feedback/ConsolePanel';
import { useAssetLibrary } from '../AssetLibraryContext';
import { useEditorSessions } from '../EditorSessionsContext';
import { buildScriptGraphCtx } from '../../utils/scriptGraph';
import { openScriptAt } from '../nodeInspector/scriptEditor/scriptReveal';

/** The script asset a location is in, by its module id — through the same lookup imports use. */
export function useScriptAtLocation(): (source: ScriptSourceLocation) => string | undefined {
  const { scriptAssets } = useAssetLibrary();
  const { scriptPaths } = useEditorSessions();
  return useMemo(() => {
    const ctx = buildScriptGraphCtx(scriptPaths, scriptAssets);
    return (source: ScriptSourceLocation) => {
      const moduleId = moduleIdOfScriptUrl(source.url);
      return moduleId ? ctx.assetAt(moduleId)?.id : undefined;
    };
  }, [scriptAssets, scriptPaths]);
}

/**
 * The editor's answer to the Console's script links: `Hero.ts:42` on a row whose script is in this
 * project, opening it at that line. A row from a script the project no longer has (renamed since the game
 * was built, an inline legacy script) shows no link.
 */
export function ScriptSourceLinksProvider({ children }: { children: ReactNode }) {
  const scriptAt = useScriptAtLocation();
  const links = useMemo<ConsoleSourceLinks>(() => ({
    label: source => (scriptAt(source) ? scriptLocationLabel(source) : null),
    open: source => {
      const scriptId = scriptAt(source);
      if (scriptId) openScriptAt(scriptId, source.line);
    },
  }), [scriptAt]);
  return <ConsoleSourceContext.Provider value={links}>{children}</ConsoleSourceContext.Provider>;
}

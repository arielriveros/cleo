import { Logger, attachScriptFactory } from 'cleo';
import type { ScriptFactory } from 'cleo';

// Attaches the published scripts (real functions from game.scripts.js, on window.CLEO_GAME_SCRIPTS) to
// the parsed scene's nodes — the no-eval counterpart of the engine's Node._parseScript. The factories are
// emitted by extractScripts.ts and bound by the engine's own attachScriptFactory, so the published game
// and editor play share one calling convention instead of two copies of it.
// Must run AFTER Scene.parse and BEFORE scene.start(), so handlers only fire on start (engine parity).

/** Returns the number of nodes a script was attached to (for the player's startup diagnostics). */
export function attachScripts(scene: any): number {
  const registry: Record<string, ScriptFactory> = (window as any).CLEO_GAME_SCRIPTS || {};
  if (Object.keys(registry).length === 0) return 0;

  const seen = new Set<string>();
  const nodes: any[] = [scene.root, ...scene.nodes];
  let attached = 0;

  for (const node of nodes) {
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    const factory = registry[node.id];
    if (typeof factory !== 'function') continue;
    try {
      attachScriptFactory(node, factory);
      attached++;
    } catch (e) {
      Logger.error(`Failed to attach script for node ${node.name}: ${e}`, 'Player');
    }
  }
  return attached;
}

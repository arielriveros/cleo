import { Logger, InputManager, bindDataAccessors } from 'cleo';

// Attaches the published scripts (real functions from game.scripts.js, on window.CLEO_GAME_SCRIPTS) to
// the parsed scene's nodes — the no-eval replacement for the engine's Node._parseScript. The factory
// bodies come from extractScripts.ts; the arity adapters below mirror Node._parseScript
// (src/core/scene/node.ts:330-374) — keep them in sync if the engine's script contract changes.
// Must run AFTER Scene.parse and BEFORE scene.start(), so handlers only fire on start (engine parity).

type AnyNode = any;

const adaptStartLike = (fn: any) => {
  if (typeof fn !== 'function') return () => {};
  const ar = fn.length;
  return (n: AnyNode, g: any) => {
    try {
      if (ar >= 2) fn(n, g);
      else if (ar === 1) fn(n);
      else fn();
    } catch (e) { Logger.error(`Error in script onStart/onSpawn for node ${n.name}: ${e}`); }
  };
};

const adaptUpdate = (fn: any) => {
  if (typeof fn !== 'function') return () => {};
  const ar = fn.length;
  return (n: AnyNode, d: number, t: number, g: any) => {
    try {
      if (ar >= 4) fn(n, d, t, g);
      else if (ar === 3) fn(n, d, t);
      else if (ar === 2) fn(d, t);
      else if (ar === 1) fn(d);
      else fn();
    } catch (e) { Logger.error(`Error in script onUpdate for node ${n.name}: ${e}`); }
  };
};

const adaptOther = (fn: any) => {
  if (typeof fn !== 'function') return () => {};
  const ar = fn.length;
  return (n: AnyNode, other: AnyNode, g: any) => {
    try {
      if (ar >= 3) fn(n, other, g);
      else if (ar === 2) fn(other, g);
      else if (ar === 1) fn(other);
      else fn();
    } catch (e) { Logger.error(`Error in script event for node ${n.name}: ${e}`); }
  };
};

// Returns the number of nodes a script was attached to (for the player's startup diagnostics).
export function attachScripts(scene: any): number {
  const registry: Record<string, Function> = (window as any).CLEO_GAME_SCRIPTS || {};
  if (Object.keys(registry).length === 0) return 0;

  // Mirror the engine's GlobalState (node.ts:51) exactly — scripts read `global.input`.
  const global = { input: InputManager.instance, logger: (t: string) => Logger.log(t, 'Script') };
  const findNode = (name: string) => scene.getNodesByName(name)?.[0];

  const seen = new Set<string>();
  const nodes: AnyNode[] = [scene.root, ...scene.nodes];
  let attached = 0;

  for (const node of nodes) {
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    const factory = registry[node.id];
    if (typeof factory !== 'function') continue;
    try {
      // Bind getData/setData to this node so cross-node access respects public/private/protected.
      const acc = bindDataAccessors(node);
      const handlers = factory(node, global, Logger, InputManager, acc.getData, acc.setData, scene, findNode) || {};
      node.onStart = adaptStartLike(handlers.onStart);
      node.onSpawn = adaptStartLike(handlers.onSpawn);
      node.onUpdate = adaptUpdate(handlers.onUpdate);
      node.onCollision = adaptOther(handlers.onCollision);
      node.onTrigger = adaptOther(handlers.onTrigger);
      node.onDespawn = adaptStartLike(handlers.onDespawn);
      attached++;
    } catch (e) {
      Logger.error(`Failed to attach script for node ${node.name}: ${e}`, 'Player');
    }
  }
  return attached;
}

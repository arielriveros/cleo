// What a packed Cleo game (game.bin) puts into the engine before a scene runs, with no renderer, audio or DOM in
// it: the templates scripts can instantiate, the script modules, and each scene built as a Scene ready to start.
//
// Shared by the browser player (boot.tsx, which adds textures, sounds, the renderer and the page around it) and
// the NetSync dedicated host (applications/host), which runs the same game headless. One implementation, so the
// host simulates exactly the scene the players see.

import { Scene, Logger, GiBakeRegistry, registerTemplates, addScriptModuleSources, parseRuntimeScene } from 'cleo';
import type { PackManifest } from '../features/publish/pack';
import type { GameSource } from './gameSource';
import { inflateSceneGeometry, inflateTerrainData, inflateTilemapData, readChunkSet, collectSceneRefs, type GameHeader, type SceneRefs } from './unpack';
import { attachSharedAnimations, attachTemplateAnimations } from './animations';

/** Where a game's bytes are, and which geometry chunks have already been handed to the engine (see readChunkSet). */
export interface GameContentSource {
  source: GameSource;
  header: GameHeader;
  /** Shared across reads, so a buffer-backed source copies a geometry the engine already holds a view of. */
  claimed: Set<string>;
}

/**
 * Templates once, globally: the registry backs scene.instantiate and must survive a Game.loadScene switch.
 * Geometry is inflated eagerly — a script may instantiate one at any moment — and the game's shared clips are
 * baked into each subtree BEFORE it is registered: the registry entry is the master `Scene.instantiate`
 * deep-copies, and nothing revisits it after a spawn. Also registers the script module sources a pack that kept
 * its scripts (Play in window) carries.
 *
 * Returns the ids of the GI bakes the templates use, which stay registered for the whole session.
 */
export async function installGameContent(at: GameContentSource): Promise<Set<string>> {
  const data = at.header.manifest as PackManifest & Record<string, any>;
  const templateRefs: SceneRefs = { chunks: [], giBakeIds: [] };
  for (const t of (data.templates ?? [])) {
    const refs = collectSceneRefs(t.node, data, { data: false });
    templateRefs.chunks.push(...refs.chunks);
    templateRefs.giBakeIds.push(...refs.giBakeIds);
  }
  const templateChunks = await readChunkSet(at.source, at.header, templateRefs, at.claimed);
  for (const t of (data.templates ?? [])) inflateSceneGeometry(t.node, templateChunks);
  const permanentBakes = new Set<string>();
  for (const b of templateChunks.giBakes) { GiBakeRegistry.set(b.id, b.bytes); permanentBakes.add(b.id); }
  attachTemplateAnimations(data.templates, data);
  registerTemplates(data.templates);
  // A pack whose scripts were NOT extracted (Play in window) keeps each node's `script` source, which the
  // engine compiles at parse, and carries the module SOURCES here, which it compiles on first import.
  addScriptModuleSources(data.modules);
  return permanentBakes;
}

/** A stage of {@link buildGameScene}, for a loading screen: resolve when it may go on. */
export type SceneBuildStage = (fraction: number, name: string) => Promise<void>;

/**
 * Build scene `id` as a Scene, parsed but not started: its JSON copied fresh (the manifest's stays refs only),
 * its geometry, terrain and tilemap chunks read and inflated, its GI captures registered, parsed through the save
 * session (a scene the player comes back to has its Saved nodes put back), and the shared clips retargeted onto
 * its characters. Returns null when the game has no such scene.
 */
export async function buildGameScene(at: GameContentSource, id: string, stage?: SceneBuildStage): Promise<{ scene: Scene; giBakeIds: string[] } | null> {
  const data = at.header.manifest as PackManifest & Record<string, any>;
  const entry = data.scenes?.[id];
  if (!entry) return null;
  await stage?.(0.1, 'Loading scene data');
  const json = structuredClone(entry.scene);
  const chunks = await readChunkSet(at.source, at.header, collectSceneRefs(json, data), at.claimed);
  await stage?.(0.3, 'Unpacking models');
  inflateSceneGeometry(json, chunks);
  await stage?.(0.45, 'Unpacking terrain');
  await inflateTerrainData(json, chunks);
  await inflateTilemapData(json, chunks);
  // This scene's GI captures, before its volumes parse: a volume loads its capture instead of capturing again.
  for (const b of chunks.giBakes) GiBakeRegistry.set(b.id, b.bytes);
  await stage?.(0.6, 'Building the scene');
  const scene = new Scene();
  // Through the save session: a scene the player comes back to (or a loaded save's) has its Saved nodes
  // and @save fields put back as it is built. Textures are already registered.
  parseRuntimeScene(scene, { scene: json, textures: [] }, id, true);
  // Shared clips are not in the serialized scene by design; retarget after parse, before start.
  attachSharedAnimations(scene, data);
  Logger.info(`scene "${entry.name}" nodes=${[...scene.nodes].length}`, 'Player');
  return { scene, giBakeIds: chunks.giBakes.map(b => b.id) };
}

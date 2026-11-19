import { CleoEngine, TextureManager, AudioManager, GiBakeRegistry, InputSystem, Logger, clearTemplates, resetScriptModules } from 'cleo';
import type { RenderSettings } from 'cleo';
import NullImage from '../images/null.png';
import { installPhysicsWorker } from '../workers/physicsWorkerHost';
import { readBackendPreference } from '@cleo/app-kit/renderer/backendPreference';
import { buildProbeIconDataURL, buildLightIconDataURL, buildSoundIconDataURL, buildDecalIconDataURL, buildParticleIconDataURL, buildForceFieldIconDataURL } from './editorIcons';
import { EDITOR_CLEAR_COLOR } from './engineContextTypes';

// The editor's one engine, for the whole session: the window, the graphics device and every compiled shader
// stay while projects come and go (features/projects/projectSwitch.ts). EngineContext acquires it when it
// mounts, the first time building it; a project closing gives its scene back and its assets are dropped, and
// the next project's EngineContext acquires the same engine.

let engine: CleoEngine | null = null;
let building: Promise<CleoEngine> | null = null;
/** What the engine holds before any project: the built-in textures and the editor's own icons. */
let baselineTextures = new Set<string>();
/** The renderer's settings before any project applied its own. */
let pristineRenderSettings: RenderSettings | null = null;

export interface AcquireOptions {
  /** The physics backend the project asks for (its setting, or the URL's). */
  physicsBackend: string;
  /** The first build's progress: the device, then the shaders. Not called when the engine already exists. */
  onProgress?: (phase: string, done: number, total: number) => void;
}

/**
 * The editor's engine, built the first time (device, shaders, the physics worker, the editor's icons) and the
 * same one after that, its physics on `physicsBackend` (a world cannot change engines, so another backend
 * means a new physics system). `fresh` says whether it was built just now: only then does its loop need starting.
 */
export async function acquireEditorEngine(options: AcquireOptions): Promise<{ engine: CleoEngine; fresh: boolean }> {
  if (engine) {
    if (engine.physics.requestedBackend !== options.physicsBackend) await engine.replacePhysics({ backend: options.physicsBackend });
    return { engine, fresh: false };
  }
  if (!building) building = build(options).finally(() => { building = null; });
  const built = await building;
  return { engine: built, fresh: true };
}

async function build(options: AcquireOptions): Promise<CleoEngine> {
  const next = new CleoEngine({
    graphics: {
      clearColor: EDITOR_CLEAR_COLOR,
      // A request, resolved against what this build and browser can provide — the renderer reports the
      // outcome through `backendFallbackReason`, which Renderer Settings shows. Read here because a context's
      // API cannot change once resources exist on it.
      backend: readBackendPreference(),
    },
    // The project's choice, or the URL's; Options ▸ Engine ▸ Runtime says when the running one differs.
    physics: { backend: options.physicsBackend },
  });
  // Before anything builds GPU resources: device acquisition is asynchronous. Reported step by step: shader
  // compilation is the longest part of a cold start, and with a listener it yields so the splash can show it.
  await next.initialize({ onProgress: options.onProgress });
  // Before the runtime options: the project's Physics thread setting needs a way to make the worker.
  installPhysicsWorker();
  pristineRenderSettings = next.renderer.getRenderSettings();
  registerEditorTextures();
  baselineTextures = new Set(TextureManager.Instance.textures.keys());
  engine = next;
  return next;
}

/** The textures the editor itself draws with: the placeholder and the viewport's billboard icons. */
function registerEditorTextures(): void {
  const tm = TextureManager.Instance;
  tm.addTextureFromBase64(NullImage, {}, 'Null');
  // The viewport icons: mipmapped, since they are drawn small far away and at most 64 CSS px up close
  // (editorIcons' ICON_RASTER_SCALE, editorHelpers' ICON_MAX_PX).
  tm.addTextureFromBase64(buildLightIconDataURL(), { mipMap: true }, '__editor__light_icon');
  // Light-probe viewport billboard icon, rasterised to a PNG so it can be a sprite texture.
  tm.addTextureFromBase64(buildProbeIconDataURL(), { mipMap: true }, '__editor__probe_icon');
  // Sound-emitter viewport billboard icon, same arrangement as the two above.
  tm.addTextureFromBase64(buildSoundIconDataURL(), { mipMap: true }, '__editor__sound_icon');
  // Decal viewport billboard icon (editorHelpers' ensureDecalIcon).
  tm.addTextureFromBase64(buildDecalIconDataURL(), { mipMap: true }, '__editor__decal_icon');
  // Particle system and force field billboards (editorHelpers' ensureEffectIcon).
  tm.addTextureFromBase64(buildParticleIconDataURL(), { mipMap: true }, '__editor__particle_icon');
  tm.addTextureFromBase64(buildForceFieldIconDataURL(), { mipMap: true }, '__editor__forcefield_icon');
}

/** The engine, if it has been built (null before the first project opened). */
export function editorEngine(): CleoEngine | null {
  return engine;
}

/**
 * The project's EngineContext is unmounting: hand its scene back. The loop runs on, drawing nothing, until the
 * next project sets its scene.
 */
export function releaseEngineProject(): void {
  if (!engine) return;
  engine.isPaused = true;
  try { engine.renderer.setViewLayout(null); } catch { /* not split */ }
  engine.releaseScene();
  try { InputSystem.instance.resetState?.(); } catch { /* nothing held */ }
}

/**
 * Forget what the closed project put in the engine (after its writes are drained, so nothing still reads it):
 * its textures (GPU memory freed), its sounds, its GI bakes, its templates and script modules, and the render
 * settings its scenes applied.
 */
export async function resetEngineProjectState(): Promise<void> {
  if (!engine) return;
  // An image still decoding would land in a texture the reset is about to drop.
  try { await TextureManager.Instance.whenLoaded(); } catch { /* a failed decode settles too */ }
  // Before the textures go: the settings hold some of them (environment, LUT, lens dirt).
  if (pristineRenderSettings) {
    try { engine.renderer.applyRenderSettings(pristineRenderSettings); } catch (e) { Logger.warn(`Resetting the render settings failed: ${e}`, 'Editor'); }
  }
  TextureManager.Instance.clearExcept(baselineTextures);
  AudioManager.Instance.clear();
  GiBakeRegistry.clear();
  clearTemplates();
  resetScriptModules();
}

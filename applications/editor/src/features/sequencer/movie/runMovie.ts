// Render a sequence to a movie: the controller behind the Render Movie dialog.
//
//   1. Play's session, built and installed but not started (EngineContext.startMovieSession), with the open
//      Sequencer tabs' working copies, so unsaved keys are filmed.
//   2. The Sequence node to film: the tab's own node in the scene, else the first that links the asset, else a
//      host carrying the working copy (no director script then). Game.movieRender names it before the scene
//      starts, so a game that starts its cinematic from a menu (the Valley) plays it at once.
//   3. The movie's render settings (the project's look, cinematic quality), the engine handed to the driver
//      (cleo's renderMovie + beginMovieEngine), and every frame read back, the game UI painted over it
//      (gameUi/uiPaint.ts) and written: MP4 through WebCodecs, or numbered PNGs.
//   4. The sound, mixed offline window by window as the frames pass each window's end, so the MP4 muxes the
//      two side by side and nothing waits for the end.
//   5. Whatever happens, the session stopped and the editor given back.

import {
  SequenceNode, setMovieRender, renderMovie, beginMovieEngine, movieRenderSettings, shutterFromAngle, AudioMixdown,
  Logger,
} from 'cleo'
import type { CleoEngine, Scene, SequenceData, MovieProgress, MovieResult, UIRootNode } from 'cleo'
import { paintUI } from '../../gameUi/uiPaint'
import { createMp4Writer, createPngWriter, type MovieSettings, type MovieWriter } from './movieOutput'
import { setBackgroundThrottling, type MovieFile, type MovieFolder } from './movieFiles'

/** The host a movie films when no node in the scene links the asset: editor-owned, like the preview's. */
const MOVIE_HOST_NAME = '__editor__SequenceMovie'

/** What to film. */
export interface MovieSequenceRef {
  /** The `.sequence` asset, and its name for the file and the progress line. */
  assetId: string
  name: string
  /** The node the Sequencer tab was opened from, if any. */
  contextNodeId: string | null
  /** The tab's working copy, for a host when no node in the scene links the asset. */
  workingCopy: SequenceData
}

export type MovieTarget = { kind: 'file'; file: MovieFile } | { kind: 'folder'; folder: MovieFolder; base: string }

export interface MovieJobProgress extends MovieProgress {
  /** Wall-clock milliseconds since the render began. */
  elapsedMs: number
  /** Bytes written so far. */
  bytes: number
  /** A small picture of the latest frame, now and then. */
  preview?: ImageBitmap
}

export interface MovieJobResult extends MovieResult {
  elapsedMs: number
  bytes: number
  /** Where it went: the file's or the folder's name. */
  output: string
  hasAudio: boolean
}

export interface MovieJobDeps {
  instance: CleoEngine
  startMovieSession: () => Promise<Scene | null>
  stopPlay: () => void
}

/** The Sequence node a movie films in the play scene. */
export function movieNodeFor(scene: Scene, ref: MovieSequenceRef): { node: SequenceNode; host: boolean } {
  const sequences = [...(scene.sequences ?? [])].filter(n => !n.isEditorOwned)
  const byContext = ref.contextNodeId ? sequences.find(n => n.id === ref.contextNodeId && n.sequenceId === ref.assetId) : undefined
  const linked = byContext ?? sequences.find(n => n.sequenceId === ref.assetId)
  if (linked) return { node: linked, host: false }
  // Nothing in the scene links it: a host with the working copy, hidden from the tree like the preview's.
  const host = new SequenceNode(MOVIE_HOST_NAME, { sequence: structuredClone(ref.workingCopy) })
  scene.addNode(host)
  return { node: host, host: true }
}

/** The font a UI node without a family inherits: the overlay's, as the DOM layer would. */
function inheritedFont(): { family: string; size: number } {
  const el = document.querySelector('[data-cleo-overlay]') ?? document.body
  const cs = getComputedStyle(el)
  return { family: cs.fontFamily || 'sans-serif', size: parseFloat(cs.fontSize) || 16 }
}

/** Seconds of sound mixed per window: how far the sound may trail the frames in the MP4 muxer. */
const AUDIO_WINDOW = 5

export async function runMovieJob(deps: MovieJobDeps, ref: MovieSequenceRef, settings: MovieSettings, target: MovieTarget,
                                  controls: { signal: AbortSignal; onProgress: (p: MovieJobProgress) => void }): Promise<MovieJobResult> {
  const { instance } = deps
  const started = performance.now()
  const scene = await deps.startMovieSession()
  if (!scene) throw new Error('Stop Play first: a movie films a session of its own.')
  let writer: MovieWriter | null = null
  let handle: ReturnType<typeof beginMovieEngine> | null = null
  let framesWritten = 0
  await setBackgroundThrottling(false)
  try {
    const { node } = movieNodeFor(scene, ref)
    setMovieRender({ sequenceNodeId: node.id, sequenceName: ref.name, width: settings.width, height: settings.height, fps: settings.fps })
    const shutter = shutterFromAngle(settings.shutterAngle)
    instance.renderer.applyRenderSettings(movieRenderSettings(instance.renderer.getRenderSettings(), {
      samples: settings.samples, shutter, cinematic: settings.cinematic,
    }))
    // Text must not be measured in a fallback face and drawn in the real one a frame later.
    await document.fonts?.ready
    const font = inheritedFont()

    writer = target.kind === 'file'
      ? await createMp4Writer(target.file, settings, settings.audio)
      : await createPngWriter(target.folder, target.base, settings.audio)
    const recordAudio = settings.audio && writer.hasAudio
    // The scene starts once the movie owns the clock and the sound, so what starts with it is filmed and heard.
    handle = beginMovieEngine(instance, node, {
      width: settings.width, height: settings.height, from: settings.from, audio: recordAudio, start: () => scene.start(),
    })

    const canvas = new OffscreenCanvas(settings.width, settings.height)
    const ctx = canvas.getContext('2d', { alpha: false })!
    const mixdown = recordAudio ? new AudioMixdown({ preRoll: 3 }) : null
    let audioDone = 0
    let lastPreview = 0
    let preview: ImageBitmap | undefined
    const skipped = new Set<string>()
    const out = writer
    const h = handle

    const result = await renderMovie(h.engine, {
      width: settings.width, height: settings.height, fps: settings.fps, samples: settings.samples, shutter,
      from: settings.from, to: settings.to, preRoll: settings.preRoll,
    }, {
      async frame(f) {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(f.rgba.buffer as ArrayBuffer, f.rgba.byteOffset, f.rgba.byteLength), f.width, f.height), 0, 0)
        // The scene playing now: a game can load another mid-movie.
        const live = instance.scene
        paintUI(ctx, (live?.uiRoots ?? []) as Iterable<UIRootNode>, {
          defaultFamily: font.family, defaultFontSize: font.size,
          onSkipped: (root, why) => {
            if (skipped.has(root.id)) return
            skipped.add(root.id)
            Logger.warn(`"${root.name}" is not in the movie: ${why}.`, 'Editor')
          },
        })
        await out.addFrame(canvas, f.timestampUs, f.durationUs, f.index)
        framesWritten++
        // The sound up to where the frames have reached, a window at a time.
        if (mixdown) {
          while (h.movieTime - audioDone >= AUDIO_WINDOW) {
            const log = h.audioSoFar()
            if (!log) break
            await out.addAudio(await mixdown.mix(log, audioDone, audioDone + AUDIO_WINDOW))
            audioDone += AUDIO_WINDOW
          }
        }
        const now = performance.now()
        if (now - lastPreview > 400) {
          lastPreview = now
          // Not closed here: the dialog draws it after this has moved on, and closes it once drawn.
          const scale = Math.min(1, 360 / f.width)
          preview = await createImageBitmap(canvas, { resizeWidth: Math.max(1, Math.round(f.width * scale)), resizeHeight: Math.max(1, Math.round(f.height * scale)), resizeQuality: 'medium' })
        }
      },
    }, {
      signal: controls.signal,
      onProgress: p => controls.onProgress({ ...p, elapsedMs: performance.now() - started, bytes: out.bytes, preview }),
    })

    // The rest of the sound, to the last frame's end.
    const log = handle.end(result.seconds)
    handle = null
    if (mixdown && log && result.seconds > audioDone + 1e-6)
      await out.addAudio(await mixdown.mix(log, audioDone, result.seconds))
    await out.finish()
    return {
      ...result, elapsedMs: performance.now() - started, bytes: out.bytes, hasAudio: recordAudio,
      output: target.kind === 'file' ? target.file.name : target.folder.name,
    }
  } catch (e) {
    // A movie with frames in it is still worth keeping: close it properly; one with none is removed.
    if (writer) {
      if (framesWritten > 0) await writer.finish().catch(() => writer?.discard())
      else await writer.discard()
    } else if (target.kind === 'file') await target.file.discard().catch(() => undefined)
    throw e
  } finally {
    handle?.end()
    setMovieRender(null)
    await setBackgroundThrottling(true)
    deps.stopPlay()
  }
}

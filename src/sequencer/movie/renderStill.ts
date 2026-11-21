import type { CleoEngine } from '../../core/engine';
import type { CameraNode } from '../../core/scene/nodes/cameraNode';
import { setRenderClock } from '../../graphics/render/renderClock';
import { movieRenderSettings } from './movieSettings';
import { sampleJitter } from './movieTiming';
import type { MovieEngine } from './renderMovie';

/**
 * One frame, captured the way a movie frame is (renderMovie.ts): what the scene looks like through a camera at
 * full detail, with nothing of the editor in it. A project's cover image is one (the editor's Options ▸ Project ▸
 * Published game ▸ Cover).
 *
 * Clean because it is the movie path. A movie frame is drawn into a target of its own, and the renderer's present
 * returns it before the debug view and the selection outline, and never composites the editor overlay — the grid,
 * the helpers (collider and trigger wireframes, light and camera icons, navmesh previews), the gizmos, the GI
 * probes, the culling ghosts — nor draws the preview panes. The one debug view that tints inside the lighting
 * itself (`cascades`) is set back to `final` for the capture.
 *
 * Full detail because it is a movie's settings (movieSettings.ts, cinematic): the Ultra tier, every resolution
 * scale at 1, raised sample counts and shadow maps, and with two samples or more the frame averaged over jittered
 * samples instead of TAA. The look (exposure, grading, fog, which effects are on) stays the project's.
 *
 *   const rgba = await captureStill(engine, { width: 1920, height: 1080, camera });
 */

/** What renderStill needs of an engine: a movie's, without the sequence or the clock. */
export type StillEngine = Pick<MovieEngine,
    'render' | 'setSample' | 'framePresented' | 'readFrame' | 'whenAssetsReady' | 'lightingSettled' | 'snapExposure' | 'yield'>;

export interface StillProgress {
    /** 'warmup' while the light settles; 'sampling' while the frame is averaged. */
    phase: 'warmup' | 'sampling';
    /** Renders so far. */
    renders: number;
    /** Samples drawn so far, of `samples`. */
    sample: number;
    samples: number;
}

export interface StillOptions {
    /** Renders averaged into the frame (default 16). 1 = the picture Play shows, its own TAA included. */
    samples?: number;
    /** Most renders the warm-up spends settling the light (default 600). */
    settleCap?: number;
    signal?: AbortSignal;
    onProgress?: (progress: StillProgress) => void;
}

/** The capture was cancelled through its signal. */
export class StillCancelledError extends Error {
    constructor() { super('Capture cancelled'); this.name = 'StillCancelledError'; }
}

/**
 * Render one still: wait for what it shows, settle the light (three renders at least: the exposure meter's first
 * reading has to be taken, read back and applied), snap the exposure, then draw its samples and read it back.
 * The engine is not stepped: every render is the same moment. Resolves with tightly packed RGBA, top row first.
 */
export async function renderStill(engine: StillEngine, options: StillOptions = {}): Promise<Uint8Array> {
    const samples = Math.max(1, Math.floor(options.samples ?? 16));
    const cap = Math.max(3, Math.floor(options.settleCap ?? 600));
    const { signal, onProgress } = options;
    const check = () => { if (signal?.aborted) throw new StillCancelledError(); };
    let renders = 0;

    check();
    await engine.whenAssetsReady();
    engine.setSample(0, 1, null);
    while (renders < 3 || (!engine.lightingSettled && renders < cap)) {
        check();
        engine.render();
        renders++;
        if (renders % 8 === 0) {
            onProgress?.({ phase: 'warmup', renders, sample: 0, samples });
            await engine.yield();
        }
    }
    await engine.whenAssetsReady();
    engine.snapExposure();

    for (let k = 0; k < samples; k++) {
        check();
        engine.setSample(k, samples, sampleJitter(k, samples));
        engine.render();
        renders++;
        if ((k + 1) % 4 === 0 || k === samples - 1) {
            onProgress?.({ phase: 'sampling', renders, sample: k + 1, samples });
            await engine.yield();
        }
    }
    if (!engine.framePresented)
        throw new Error('The capture was not drawn (no camera, or the renderer refused the frame)');
    return engine.readFrame();
}

export interface CaptureStillOptions extends StillOptions {
    width: number;
    height: number;
    /** The camera to look through. The scene's active one when omitted. */
    camera?: CameraNode | null;
    /** Raise every cost-only quality setting for the capture (movieRenderSettings' cinematic). Default true. */
    cinematic?: boolean;
}

/** A yield to the event loop that a hidden page does not throttle (timers there wait a second). */
function nextTask(): Promise<void> {
    return new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
        channel.port2.postMessage(0);
    });
}

/**
 * Capture the engine's scene through `camera` at `width` x `height` (renderStill), with the frame loop detached,
 * the render clock stopped (wind, water and particles do not move between samples), the debug view on `final`,
 * metering and post-processing allowed and the movie's settings applied — every one of them put back afterwards,
 * and the camera the scene had pinned too. The canvas is left alone; the live view re-converges after (its
 * temporal history starts over when the movie's targets go).
 */
export async function captureStill(engine: CleoEngine, options: CaptureStillOptions): Promise<Uint8Array> {
    const renderer = engine.renderer;
    const scene = engine.scene;
    if (!scene) throw new Error('There is no scene to capture');
    if (renderer.movieActive) throw new Error('A movie is rendering');
    const camera = options.camera ?? scene.activeCamera ?? null;
    if (!camera) throw new Error('There is no camera to capture through');
    const samples = Math.max(1, Math.floor(options.samples ?? 16));

    const pinned = scene.pinnedCamera;
    const settings = renderer.getRenderSettings();
    const debugView = renderer.debugView;
    const metering = renderer.exposureMeteringAllowed;
    const post = renderer.postProcessingAllowed;
    const detached = engine.loopDetached;
    const frozen = performance.now();

    // First, since it is what can refuse (a frame larger than the GPU draws): nothing else is changed yet.
    renderer.beginMovie(options.width, options.height);
    try {
        if (!detached) engine.detachLoop();
        setRenderClock(() => frozen);
        renderer.debugView = 'final';
        renderer.setExposureMeteringAllowed(true);
        renderer.setPostProcessingAllowed(true);
        renderer.applyRenderSettings(movieRenderSettings(settings, { samples, shutter: 0, cinematic: options.cinematic !== false }));
        // A camera that is not the active one has not been updated by the frame loop: its matrices are stale.
        scene.root.updateTransforms();
        camera.update(0, 0);
        const still: StillEngine = {
            render() {
                // Pinned before every render: a host may hand the view to another camera between them (the
                // editor's split viewport does, each frame, when it is not showing).
                if (scene.activeCamera !== camera) scene.setActiveCamera(camera);
                engine.renderFrame();
            },
            setSample: (sample, count, jitter) => renderer.setMovieSample(sample, count, jitter),
            get framePresented() { return renderer.movieFramePresented; },
            readFrame: () => renderer.readMovieFrame(),
            whenAssetsReady: () => renderer.whenAssetsReady(),
            get lightingSettled() { return renderer.lightingSettled; },
            snapExposure: () => renderer.snapExposure(),
            yield: nextTask,
        };
        return await renderStill(still, { ...options, samples });
    } finally {
        renderer.applyRenderSettings(settings);
        renderer.debugView = debugView;
        renderer.setExposureMeteringAllowed(metering);
        renderer.setPostProcessingAllowed(post);
        renderer.endMovie();
        setRenderClock(null);
        scene.setActiveCamera(pinned);
        if (!detached) engine.attachLoop();
    }
}

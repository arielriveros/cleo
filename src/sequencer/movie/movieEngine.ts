import type { CleoEngine } from '../../core/engine';
import type { SequenceNode } from '../../core/scene/nodes/sequenceNode';
import { setRenderClock } from '../../graphics/render/renderClock';
import { AudioManager } from '../../audio/audioManager';
import { InputSystem } from '../../input/inputSystem';
import { audioRecorder, type AudioLog } from '../../audio/movieAudio';
import type { MovieEngine } from './renderMovie';

/**
 * A real engine as a MovieEngine (renderMovie.ts): the frame loop detached, the render clock and the audio
 * recording on the movie's own time, the renderer drawing at the movie's size.
 *
 *   const movie = beginMovieEngine(engine, node, { width: 1920, height: 1080, audio: true });
 *   try { await renderMovie(movie.engine, options, sink); }
 *   finally { const audio = movie.end(); }
 *
 * `begin` expects the Sequence node in the scene, and starts the scene through `start` (or finds it started).
 * It plays the node from `from` unless something already started it (a game script reading
 * Game.movieRender, the Valley's menu among them).
 */

export interface MovieEngineOptions {
    width: number;
    height: number;
    /** Sequence seconds to start from. */
    from: number;
    /** Record the movie's sound (movieAudio.ts). */
    audio: boolean;
    /**
     * Start the scene (`scene.start()`), called once the movie owns the clock, the input and the sound and
     * before the sequence is looked at: what starts with the scene — a sound that plays on start, a menu
     * that plays the sequence itself — is filmed and recorded. Omit for a scene already started.
     */
    start?: () => void;
}

export interface MovieEngineHandle {
    readonly engine: MovieEngine;
    /** Movie seconds stepped so far. */
    readonly movieTime: number;
    /**
     * The sound recorded so far, timed from frame 0 and closed at now (null when not recording): mixable up
     * to its end while the movie goes on (AudioMixdown).
     */
    audioSoFar(): AudioLog | null;
    /** Back to the frame loop and the wall clock; the recorded sound, when asked for. Idempotent. */
    end(movieSeconds?: number): AudioLog | null;
}

/** A yield to the event loop that a hidden page does not throttle (timers there wait a second). */
function nextTask(): Promise<void> {
    return new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
        channel.port2.postMessage(0);
    });
}

export function beginMovieEngine(engine: CleoEngine, node: SequenceNode, options: MovieEngineOptions): MovieEngineHandle {
    const renderer = engine.renderer;
    let movieTime = 0;
    /** Movie time at frame 0: the warm-up's pre-roll comes before it. */
    let origin = 0;
    // First, since it is what can refuse (a frame larger than the GPU draws): nothing else is changed yet.
    renderer.beginMovie(options.width, options.height);
    // On from the wall clock's present, so throttles timed against it before the movie carry on in order.
    const base = performance.now();
    engine.detachLoop();
    setRenderClock(() => base + movieTime * 1000);
    // Physics in this thread: the worker draws bodies on a clock of its own, estimated from wall time.
    const workerMode = engine.physics.workerMode;
    if (workerMode !== 'off') engine.physics.setWorkerMode('off');
    // Filmed, not played: a key pressed meanwhile must not reach the game.
    InputSystem.instance.muted = true;
    const recording = options.audio;
    if (recording) AudioManager.Instance.beginRecording(() => movieTime);
    let done = false;
    /** Everything above, undone: the frame loop, the wall clock, the input, physics and sound as they were. */
    const teardown = (movieSeconds: number): AudioLog | null => {
        if (done) return null;
        done = true;
        renderer.endMovie();
        setRenderClock(null);
        InputSystem.instance.muted = false;
        if (workerMode !== 'off') engine.physics.setWorkerMode(workerMode);
        const log = recording ? AudioManager.Instance.endRecording(movieSeconds, origin) : null;
        engine.attachLoop();
        return log;
    };
    try {
        engine.scene?.setUIViewport(options.width, options.height, 1);
        options.start?.();
        // Whatever started the sequence (a script, or us), from here its time is the movie's.
        if (!node.isPlaying) node.play({ from: options.from });
        else if (options.from > 0) node.seek(options.from);
        // One step of no time, so the first frame's UI is already laid out at the movie's size.
        engine.stepFrame(0, { render: false });
    } catch (e) {
        teardown(0);
        throw e;
    }
    let lastTime = node.time;
    let elapsed = 0;
    let ended = false;
    let pausedByUs = false;

    const track = () => {
        if (ended) return;
        if (!node.isPlaying || !node.scene) { ended = true; return; }
        const t = node.time;
        // A looping sequence wraps: count the way round as time played.
        elapsed += t >= lastTime ? t - lastTime : (node.duration - lastTime) + t;
        lastTime = t;
    };

    const movie: MovieEngine = {
        advance(seconds: number) {
            movieTime += seconds;
            // The game UI lays out for the movie's frame, whatever the editor's viewport says meanwhile.
            engine.scene?.setUIViewport(options.width, options.height, 1);
            engine.stepFrame(seconds, { render: false });
            track();
        },
        render() { engine.renderFrame(); },
        setSample(sample, samples, jitter) { renderer.setMovieSample(sample, samples, jitter); },
        get framePresented() { return renderer.movieFramePresented; },
        readFrame() { return renderer.readMovieFrame(); },
        whenAssetsReady() { return renderer.whenAssetsReady(); },
        get lightingSettled() { return renderer.lightingSettled; },
        snapExposure() { renderer.snapExposure(); },
        sequenceElapsed() { return elapsed; },
        sequenceEnded() { track(); return ended; },
        get sequenceHolding() { return node.isHolding; },
        setSequencePaused(paused: boolean) {
            if (paused && node.isPlaying && !node.isPaused) { node.pause(); pausedByUs = true; }
            else if (!paused && pausedByUs) { node.resume(); pausedByUs = false; lastTime = node.time; }
        },
        yield: nextTask,
        beginFrames() { origin = movieTime; },
    };

    return {
        engine: movie,
        get movieTime() { return movieTime - origin; },
        audioSoFar(): AudioLog | null {
            if (!recording || done) return null;
            return audioRecorder()?.finish(movieTime - origin, origin) ?? null;
        },
        end(movieSeconds?: number): AudioLog | null {
            return teardown(movieSeconds ?? movieTime - origin);
        },
    };
}

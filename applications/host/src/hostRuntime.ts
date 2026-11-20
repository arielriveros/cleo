// The game a dedicated host runs (docs/design/netsync.md §7): a published game (game.bin), loaded the way the
// browser player loads it (applications/editor/src/player/gameContent.ts) onto a headless engine — no renderer,
// no audio, no DOM — and stepped at a fixed tick rate.
//
// What the player does and the host leaves out: textures, sounds, the renderer and its settings, the UI layer,
// touch controls, the window title, the shader library. What the host does that the player does not: it owns
// time (FixedTicker, deadline-driven), keeps per-tick timings, and never waits on a frame.

import { CleoEngine, GiBakeRegistry, Logger, InputSystem, restrictFeatures, setAbsentFeatureNames, setGameHost, setSaveStore, createMemorySaveStore, setScriptProvider, setScriptModuleProvider, resetScriptModules } from 'cleo';
import type { Scene } from 'cleo';
import { FixedTicker, realScheduler, type Scheduler } from '../../../src/netsync';
import { bufferSource } from '../../editor/src/player/gameSource';
import { readGameHeader } from '../../editor/src/player/unpack';
import { buildGameScene, installGameContent, type GameContentSource } from '../../editor/src/player/gameContent';
import { PLAYER_CONTRACT } from '../../editor/src/features/publish/pack';

/** A published game, as files: game.bin and, when its scripts were extracted at publish, game.scripts.js. */
export interface HostGameFiles {
    bin: ArrayBuffer | Uint8Array;
    /** The text of game.scripts.js. Absent for a pack that kept its scripts in the scenes (Play in window). */
    scripts?: string;
}

export interface HostRuntimeOptions {
    /** Simulation rate, Hz. Default 30. */
    tickRate?: number;
    /** Overrides the game's physics backend ('jolt', 'rapier', 'cannon'). */
    physicsBackend?: string;
    /** Keep the engine's Logger on. Default off, as a shipped game runs. */
    logging?: boolean;
    scheduler?: Scheduler;
}

/** Per-tick timings, ms of host CPU for one tick (input, physics, scripts, animation). */
export interface TickStats {
    ticks: number;
    /** Ticks dropped because the host fell more than a few ticks behind. */
    skipped: number;
    lastMs: number;
    meanMs: number;
    p95Ms: number;
    maxMs: number;
}

const STATS_WINDOW = 300;

export class HostRuntime {
    /** Called before every tick, with the tick number (remote players' commands are applied here). */
    public onBeforeTick: ((tick: number) => void) | null = null;
    /** Called after every tick, with the tick number (the NetSync sync layer hooks in here). */
    public onTick: ((tick: number) => void) | null = null;
    /** Called after each scene has started (the entry scene and every Game.loadScene). */
    public onSceneStarted: ((name: string) => void) | null = null;

    private readonly _ticker: FixedTicker;
    private readonly _durations: number[] = [];
    private _ticks = 0;
    private _currentId = '';
    private _permanentBakes = new Set<string>();

    private constructor(
        public readonly engine: CleoEngine,
        private readonly _content: GameContentSource,
        public readonly tickRate: number,
        scheduler: Scheduler,
    ) {
        this._ticker = new FixedTicker(tickRate, (tick) => this._tick(tick), scheduler);
    }

    /** Load a published game onto a headless engine and start its entry scene (not ticking yet: see {@link start}). */
    public static async open(files: HostGameFiles, options: HostRuntimeOptions = {}): Promise<HostRuntime> {
        Logger.setEnabled(!!options.logging);
        const bytes = files.bin instanceof Uint8Array ? files.bin : new Uint8Array(files.bin);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const source = bufferSource(buffer);
        const header = await readGameHeader(source);
        const data = header.manifest as any;
        if (typeof data.contract === 'number' && data.contract > PLAYER_CONTRACT) {
            throw new Error(`This game was published for game format v${data.contract}; this host understands v${PLAYER_CONTRACT}.`);
        }

        // The engine's optional features the game was built with, and the names of the ones it went without.
        if (Array.isArray(data.config?.features)) restrictFeatures(data.config.features);
        setAbsentFeatureNames(data.config?.absentApi ?? null);

        const tickRate = options.tickRate ?? 30;
        const physics = { ...(data.config?.physics ?? {}) };
        if (options.physicsBackend) physics.backend = options.physicsBackend;
        // Main thread: the host has no other work for that thread, and a worker would add a tick of latency.
        delete physics.worker;
        const engine = new CleoEngine({ headless: true, physics, runtime: data.config?.runtime ?? {} });
        // Freezing far bodies is measured from the camera, and a host has no one camera: everything simulates.
        engine.physics.simulationRange = 0;
        // Saves made on the host stay in memory (a host's game state is the session, not a save slot).
        setSaveStore(createMemorySaveStore(), { gameVersion: typeof data.config?.saves?.version === 'number' ? data.config.saves.version : 0 });
        await engine.initialize();
        // Scripts may read actions; on the host nothing is ever pressed (remote players' input arrives in phase 4).
        InputSystem.instance.setMap(data.config?.input);

        // A new game: no script module evaluated for a game this process ran before may carry over.
        resetScriptModules();
        const content: GameContentSource = { source, header, claimed: new Set() };
        const runtime = new HostRuntime(engine, content, tickRate, options.scheduler ?? realScheduler);
        runtime._permanentBakes = await installGameContent(content);
        runtime._installScripts(files.scripts);

        const table = data.scenes ?? {};
        setGameHost({
            loadScene: (nameOrId: string) => {
                const id = runtime._resolve(nameOrId);
                if (!id) { Logger.warn(`loadScene: unknown scene "${nameOrId}"`, 'Host'); return; }
                engine.physics.clear();
                return runtime._startScene(id);
            },
            currentSceneName: () => table[runtime._currentId]?.name ?? '',
            sceneNames: () => Object.values(table).map((s: any) => s.name),
        });
        await runtime._startScene(data.entry in table ? data.entry : Object.keys(table)[0]);
        return runtime;
    }

    public get scene(): Scene { return this.engine.scene; }
    public get sceneName(): string { return (this._content.header.manifest as any).scenes?.[this._currentId]?.name ?? ''; }
    public get running(): boolean { return this._ticker.running; }

    /**
     * Start ticking in real time. `originMs` is the scheduler time tick 0 was due — pass the NetSync session's
     * start, so tick numbers here and on the session clock (HostSession.tick()) are the same ticks.
     */
    public start(originMs?: number): void {
        if (!this._ticker.running) this._ticker.start(originMs, this._ticks);
    }

    public stop(): void { this._ticker.stop(); }

    /** Run `count` ticks now, as fast as possible (tests, benchmarks, fast-forward). */
    public step(count: number = 1): void {
        for (let i = 0; i < count; i++) this._tick(this._ticks);
    }

    public stats(): TickStats {
        const d = [...this._durations].sort((a, b) => a - b);
        const n = d.length;
        const round = (v: number) => Math.round(v * 1000) / 1000;
        return {
            ticks: this._ticks,
            skipped: this._ticker.skipped,
            lastMs: round(this._durations[n - 1] ?? 0),
            meanMs: round(n ? d.reduce((a, b) => a + b, 0) / n : 0),
            p95Ms: round(n ? d[Math.min(n - 1, Math.floor(n * 0.95))] : 0),
            maxMs: round(n ? d[n - 1] : 0),
        };
    }

    /** Stop and let go of the scene and the physics world. */
    public dispose(): void {
        this.stop();
        setGameHost(null);
        try { this.engine.scene?.stop(); } catch { /* already stopped */ }
        this.engine.physics.dispose();
    }

    private _tick(tick: number): void {
        this.onBeforeTick?.(tick);
        const t0 = performance.now();
        this.engine.stepFrame(1 / this.tickRate, { render: false });
        const ms = performance.now() - t0;
        this._durations.push(ms);
        if (this._durations.length > STATS_WINDOW) this._durations.shift();
        this._ticks = tick + 1;
        this.onTick?.(tick);
    }

    private _resolve(nameOrId: string): string | undefined {
        const table = (this._content.header.manifest as any).scenes ?? {};
        if (table[nameOrId]) return nameOrId;
        return Object.keys(table).find((id) => table[id].name === nameOrId);
    }

    private _sceneBakes: string[] = [];

    private async _startScene(id: string): Promise<void> {
        const built = await buildGameScene(this._content, id);
        if (!built) throw new Error(`The game has no scene "${id}".`);
        this._currentId = id;
        const outgoing = this.engine.scene;
        this.engine.setScene(built.scene);
        if (outgoing && outgoing !== built.scene) outgoing.dispose();
        // The GI captures of the scene just left go with it, unless the new one or a template uses them too.
        for (const bakeId of this._sceneBakes) if (!this._permanentBakes.has(bakeId) && !built.giBakeIds.includes(bakeId)) GiBakeRegistry.delete(bakeId);
        this._sceneBakes = built.giBakeIds;
        this.engine.isPaused = false;
        built.scene.start();
        this.onSceneStarted?.(this.sceneName);
    }

    /**
     * game.scripts.js assigns each node's compiled script to `window.CLEO_GAME_SCRIPTS[id]` (and each module to
     * `window.CLEO_GAME_MODULES[id]`). Run here with `window` bound to a plain object rather than a global one:
     * engine code reads `typeof window` to tell a browser from Node, and a global would lie to it. Run in this
     * realm (not node:vm), so what a script builds is the same Array and Float32Array the engine checks for.
     */
    private _installScripts(code: string | undefined): void {
        const holder: { CLEO_GAME_SCRIPTS: Record<string, unknown>; CLEO_GAME_MODULES: Record<string, unknown> } = {
            CLEO_GAME_SCRIPTS: {}, CLEO_GAME_MODULES: {},
        };
        if (code) new Function('window', code)(holder);
        setScriptProvider((id: string) => holder.CLEO_GAME_SCRIPTS[id] as any);
        setScriptModuleProvider((id: string) => holder.CLEO_GAME_MODULES[id] as any);
    }
}

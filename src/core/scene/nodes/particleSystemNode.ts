import { mat4, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { authoring } from "../../eventBus";
import {
    cloneParticleSystem, defaultParticleSystem, parseParticleSystem, type ParticleSystemDef,
} from "../../../particles/particleSystemAsset";
import { ParticleSystemRuntime } from "../../../particles/particleRuntime";

export interface ParticleSystemNodeOptions {
    /** The system definition. Embedded, so a scene plays without its asset library. */
    system?: unknown;
    /** The `.vfx` asset this node was created from, or null for an unlinked copy. */
    particleSystemId?: string | null;
    playOnStart?: boolean;
    /** Multiplies simulation time: 0.5 is slow motion. */
    simulationSpeed?: number;
    /** Multiplies every emitter's continuous spawn rate. Bursts are not scaled. */
    spawnRateScale?: number;
    /** Multiplies every particle's colour. */
    tint?: [number, number, number, number];
}

const num = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

/**
 * Plays a particle system in the scene.
 *
 * THE SPLIT. This node owns the CPU half — the clock, play state and the spawn ring, in
 * {@link ParticleSystemRuntime} — and queues one simulation step per update. The renderer owns the GPU
 * half (state textures, dispatches, the draw) and drains that queue each frame. Nothing ever comes back
 * from the GPU, so a system's live particle count is unknown on the CPU by design; `isAlive` is
 * answered from the clock instead.
 *
 * Like a decal's material, the definition is EMBEDDED: the node serializes its own copy, and
 * `particleSystemId` only records which library asset it mirrors so the editor can push edits into it.
 * A published game therefore needs no particle library at all.
 *
 * In the editor (authoring mode) a system simulates only while `scene.particlePreview` is on — the
 * viewport's "preview particles" toggle — so an open level does not burn GPU time on effects nobody is
 * looking at unless asked to.
 */
export class ParticleSystemNode extends Node {
    private _system: ParticleSystemDef;
    private _particleSystemId: string | null;
    private _playOnStart: boolean;
    private _simulationSpeed: number;
    private _spawnRateScale: number;
    private _tint: [number, number, number, number];

    private _runtime: ParticleSystemRuntime;
    /** Bumped whenever the GPU state must be rebuilt: a new pool layout. */
    private _version = 0;
    /** Bumped when parameters change but the pools survive: the GPU repacks uniforms and the LUT only. */
    private _paramsVersion = 0;
    private _playing = false;
    private _paused = false;

    constructor(name: string, options: ParticleSystemNodeOptions = {}, id: string = uuidv4()) {
        super(name, 'particleSystem', id);
        this._system = options.system ? parseParticleSystem(options.system) : defaultParticleSystem();
        this._particleSystemId = typeof options.particleSystemId === 'string' ? options.particleSystemId : null;
        this._playOnStart = options.playOnStart !== false;
        this._simulationSpeed = Math.max(0, num(options.simulationSpeed, 1));
        this._spawnRateScale = Math.max(0, num(options.spawnRateScale, 1));
        const t = options.tint;
        this._tint = Array.isArray(t) ? [num(t[0], 1), num(t[1], 1), num(t[2], 1), num(t[3], 1)] : [1, 1, 1, 1];
        this._runtime = new ParticleSystemRuntime(this._system.emitters);
    }

    // -----------------------------------------------------------------------------------------------
    // Definition
    // -----------------------------------------------------------------------------------------------

    /** The embedded definition. Treat as read-only; replace it through {@link setSystem}. */
    public get system(): ParticleSystemDef { return this._system; }

    /**
     * Replace the definition.
     *
     * When the pools keep their shape (same emitters, capacities and space) the new parameters are
     * swapped in under the running simulation, so an artist tweaking a value watches the effect change
     * rather than restart. Anything structural rebuilds: live particles are discarded, and a playing
     * system starts over. `restart` forces the rebuild either way.
     */
    public setSystem(system: unknown, restart: boolean = false): void {
        this._system = parseParticleSystem(cloneParticleSystem(system as ParticleSystemDef));
        if (!restart && this._runtime.canAdopt(this._system.emitters)) {
            this._runtime.adopt(this._system.emitters);
            this._paramsVersion++;
        } else {
            this._runtime = new ParticleSystemRuntime(this._system.emitters);
            this._version++;
            if (this._playing) this._startRuntime();
        }
        this._notifyChange('component', 'system');
    }

    public get particleSystemId(): string | null { return this._particleSystemId; }
    public set particleSystemId(value: string | null) {
        if (value === this._particleSystemId) return;
        const prev = this._particleSystemId;
        this._particleSystemId = value;
        this._notifyChange('component', 'particleSystemId', prev, value);
    }

    /** The CPU runtime the renderer drains. */
    public get runtime(): ParticleSystemRuntime { return this._runtime; }
    /** Changes whenever the renderer must drop and rebuild this node's GPU state. */
    public get version(): number { return this._version; }
    /** Changes whenever the renderer must repack parameters (but may keep the particles). */
    public get paramsVersion(): number { return this._paramsVersion; }

    // -----------------------------------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------------------------------

    public get playOnStart(): boolean { return this._playOnStart; }
    public set playOnStart(value: boolean) {
        if (value === this._playOnStart) return;
        this._playOnStart = value;
        this._notifyChange('component', 'playOnStart');
    }

    public get simulationSpeed(): number { return this._simulationSpeed; }
    public set simulationSpeed(value: number) {
        const next = Math.max(0, num(value, 1));
        if (next === this._simulationSpeed) return;
        this._simulationSpeed = next;
        this._notifyChange('component', 'simulationSpeed');
    }

    public get spawnRateScale(): number { return this._spawnRateScale; }
    public set spawnRateScale(value: number) {
        const next = Math.max(0, num(value, 1));
        if (next === this._spawnRateScale) return;
        this._spawnRateScale = next;
        this._notifyChange('component', 'spawnRateScale');
    }

    public get tint(): [number, number, number, number] { return this._tint; }
    public set tint(value: [number, number, number, number]) {
        this._tint = [num(value?.[0], 1), num(value?.[1], 1), num(value?.[2], 1), num(value?.[3], 1)];
        this._notifyChange('component', 'tint');
    }

    // -----------------------------------------------------------------------------------------------
    // Playback — the script API
    // -----------------------------------------------------------------------------------------------

    public get isPlaying(): boolean { return this._playing && !this._paused; }
    public get isPaused(): boolean { return this._paused; }
    /** Still emitting, or still holding particles that have not finished their lives. */
    public get isAlive(): boolean { return this._playing && this._runtime.isAlive; }

    /** Start emitting from the beginning of the cycle. Already-live particles are kept. */
    public play(): void {
        this._paused = false;
        if (this._playing && this._runtime.emitters.every(e => e.state === 'playing')) return;
        this._playing = true;
        this._startRuntime();
    }

    /** Stop emitting. `clear` also removes every live particle at once; otherwise they finish their lives. */
    public stop(clear: boolean = false): void {
        for (const emitter of this._runtime.emitters) {
            emitter.stop();
            if (clear) emitter.clear();
        }
        if (clear) {
            // The clear has to reach the GPU as a step, so push one even though no time passes.
            this._runtime.advance(1e-6, this.worldTransform, 0);
        }
    }

    /** Freeze the simulation in place. */
    public pause(): void { this._paused = true; }
    public resume(): void { this._paused = false; }

    /** Clear and play from the start. */
    public restart(): void {
        this.stop(true);
        this._playing = false;
        this.play();
    }

    /** Emit `count` particles at once, from every emitter or only the one named. */
    public burst(count: number, emitterName?: string): void {
        if (!this._playing) { this._playing = true; this._paused = false; }
        for (const emitter of this._runtime.emitters)
            if (!emitterName || emitter.def.name === emitterName) emitter.burst(count);
    }

    private _startRuntime(): void {
        for (const emitter of this._runtime.emitters) emitter.play();
        this._runtime.prewarm(this.worldTransform);
    }

    // -----------------------------------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------------------------------

    /**
     * True while the editor is authoring a scene whose particle preview is switched off. Such a system
     * neither simulates nor draws — frozen mid-flight particles would read as a bug, not a pause.
     */
    public get previewSuppressed(): boolean {
        return authoring.enabled && this.scene?.particlePreview === false;
    }

    /** Whether the clock may advance right now. */
    public get simulating(): boolean {
        return !this.previewSuppressed && this._playing && !this._paused;
    }

    public onStart(): void {
        if (this._playOnStart) this.play();
    }

    public onDespawn(): void {
        this.stop(true);
        this._playing = false;
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        if (!this.simulating) return;
        this._runtime.advance(delta * this._simulationSpeed, this.worldTransform, this._spawnRateScale);
    }

    // -----------------------------------------------------------------------------------------------
    // Serialization
    // -----------------------------------------------------------------------------------------------

    protected _serializePayload(): any {
        return {
            particleSystem: {
                system: cloneParticleSystem(this._system),
                particleSystemId: this._particleSystemId,
                playOnStart: this._playOnStart,
                simulationSpeed: this._simulationSpeed,
                spawnRateScale: this._spawnRateScale,
                tint: [...this._tint],
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new ParticleSystemNode(json.name, json.particleSystem ?? {}, json.id);
        // finishParse ATTACHES the node. Never call parent.addChild after it — see tests/nodeParse.test.ts.
        Node.finishParse(node, parent, json);
    }

    /**
     * What a viewport click selects the particle system by: a small box at its origin, where its editor icon
     * sits. Its bounds would enclose the ground and everything else the effect plays over, and swallow
     * every click aimed at them — the reason DecalNode has one too.
     */
    public pickBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        const r = 0.3;
        return { min: vec3.fromValues(p[0] - r, p[1] - r, p[2] - r), max: vec3.fromValues(p[0] + r, p[1] + r, p[2] + r) };
    }

    /** The system's authored bounds, through this node's transform — what selection and culling use. */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const { center, extents } = this._system.bounds;
        const m = this.worldTransform;
        const min = vec3.fromValues(Infinity, Infinity, Infinity);
        const max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
        const corner = vec3.create();
        for (let i = 0; i < 8; i++) {
            vec3.set(corner,
                center[0] + (i & 1 ? extents[0] : -extents[0]),
                center[1] + (i & 2 ? extents[1] : -extents[1]),
                center[2] + (i & 4 ? extents[2] : -extents[2]));
            vec3.transformMat4(corner, corner, m as mat4);
            vec3.min(min, min, corner);
            vec3.max(max, max, corner);
        }
        return { min, max };
    }
}

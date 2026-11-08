import { vec3 } from 'gl-matrix';
import type { Scene } from './scene';
import { ParticleSystemNode } from './nodes/particleSystemNode';
import type { WeatherNode } from './nodes/weatherNode';
import { gatherWeather, WEATHER_CLOCK_WRAP } from '../../graphics/render/weatherPack';
import {
    precipitationColumn, precipitationFallTime, precipitationSystem, type FallingKind, type PrecipitationStyle,
} from '../../particles/precipitation';

/** Air speed, m/s, of a WindNode at strength 1: what every wind-bent material is authored for. */
const WIND_AIR_SPEED = 7;
/** The most the column leads the camera, or leans upwind, as a fraction of its width. */
const MAX_OFFSET = 0.3;
const KINDS: readonly FallingKind[] = ['rain', 'snow'];
/** Metres the camera may move in one update and still be moving rather than cut away. */
const JUMP = 15;

interface Slot {
    node: ParticleSystemNode;
    key: string;
    /** Emitting (false once its volumes stopped asking for it: the last drops still land). */
    falling: boolean;
}

/**
 * The scene's falling rain and snow (WeatherNode `precipitation`): at most two particle systems, one per
 * kind, kept round the camera. Owned by the Scene and run once per update, after everything else has
 * moved (the camera above all), so they fall where the frame is drawn from.
 *
 * ONE PER KIND, NOT ONE PER VOLUME. Each spawns at the highest rate any volume in reach asks for; its
 * `weather` module keeps a particle only where the volumes make that kind fall (composited in priority
 * order, feathered at their side faces, their tops open), as thinly as they do there, and kills it under
 * shelter. Overlapping volumes never double the rain, and a dry box nested in a wet one carves it out.
 * Its look (sprite, size, speed, wind) is the highest-priority such volume's.
 *
 * The systems are NOT in the scene tree: never saved, never listed, never picked. Their nodes carry the
 * scene (so the editor's particle preview toggle governs them, as it does every effect) and are
 * editor-owned (their per-frame moves are not edits). The renderer draws `systems` beside the scene's own.
 */
export class PrecipitationRig {
    private readonly _slots: Record<FallingKind, Slot | null> = { rain: null, snow: null };
    private readonly _systems: ParticleSystemNode[] = [];
    private readonly _camera = vec3.create();
    private readonly _last = vec3.create();
    private readonly _velocity = vec3.create();
    private _hasLast = false;
    private _clock = 0;

    /**
     * The renderer's precipitation density, 0..1 (RenderSettings.precipitationDensity): a multiplier on
     * how much falls. 0 stops it.
     */
    public density = 1;

    constructor(private readonly _scene: Scene) {}

    /** The weather clock: seconds of scene time, wrapped at WEATHER_CLOCK_WRAP. What the ground's raindrops animate by. */
    public get clock(): number { return this._clock; }

    /** The particle systems falling now (stopped ones included, while their last drops land). */
    public get systems(): readonly ParticleSystemNode[] { return this._systems; }

    /** The system of one kind, or null while that kind has never fallen. */
    public systemOf(kind: FallingKind): ParticleSystemNode | null { return this._slots[kind]?.node ?? null; }

    /** Advance by `delta` seconds of scene time. Called by Scene.update while the scene runs. */
    public update(delta: number, time: number): void {
        this._clock = (this._clock + Math.max(0, delta)) % WEATHER_CLOCK_WRAP;
        const scene = this._scene;
        const volumes = scene.weatherVolumes;
        if (volumes.size === 0 && this._systems.length === 0) return;

        const cameraNode = scene.activeCamera;
        const orthographic = cameraNode?.camera.type === 'orthographic';
        if (cameraNode) vec3.copy(this._camera, cameraNode.worldPosition);
        const camera = this._camera;

        // A smoothed camera velocity, for leading the column: rain spawned where the camera is going.
        if (this._hasLast && delta > 0) {
            const k = Math.min(1, delta * 4);
            for (let a = 0; a < 3; a++) this._velocity[a] += ((camera[a] - this._last[a]) / delta - this._velocity[a]) * k;
        }
        const jump = this._hasLast ? Math.hypot(camera[0] - this._last[0], camera[2] - this._last[2]) : 0;
        // A cut is not a velocity: lead from rest after it.
        if (jump > JUMP) vec3.zero(this._velocity);
        vec3.copy(this._last, camera);
        this._hasLast = true;

        const gathered = cameraNode && !orthographic ? gatherWeather(volumes, camera) : [];
        for (const kind of KINDS) this._updateKind(kind, gathered, camera, delta, time, jump);
    }

    private _updateKind(kind: FallingKind, gathered: readonly WeatherNode[], camera: vec3, delta: number, time: number, jump: number): void {
        const column = precipitationColumn(kind);
        const halfX = column.box[0] / 2, halfZ = column.box[2] / 2;
        let maxRate = 0;
        let style: WeatherNode | null = null;
        for (const v of gathered) {
            const rate = kind === 'rain' ? v.rainRate : v.snowfallRate;
            if (!(rate > 0)) continue;
            if (v.bounded) {
                const b = v.getBoundingBox();
                if (b.max[0] < camera[0] - halfX || b.min[0] > camera[0] + halfX
                    || b.max[2] < camera[2] - halfZ || b.min[2] > camera[2] + halfZ
                    || b.min[1] > camera[1] + column.height + 1) continue;
            }
            maxRate = Math.max(maxRate, rate);
            // Composite order is ascending priority, nearer last: the last one is the one on top.
            style = v;
        }

        let slot = this._slots[kind];
        if (!style || maxRate <= 0) {
            if (slot?.falling) { slot.node.stop(false); slot.falling = false; }
            if (slot) this._step(slot.node, delta, time);
            return;
        }

        const rate = Math.min(1, Math.ceil(maxRate * 64) / 64);
        const wind = this._windOf(style);
        const look: PrecipitationStyle = {
            rate, size: style.precipitationSize, speed: style.precipitationSpeed, sprite: style.precipitationSprite,
            trail: [style.precipitationTrailMin, style.precipitationTrailMax],
        };
        const key = JSON.stringify([rate, look.size, look.speed, wind, look.sprite, look.trail]);
        if (!slot) {
            const def = precipitationSystem(kind, look, { wind, density: 1, prewarm: true });
            const node = new ParticleSystemNode(kind === 'rain' ? 'Rain' : 'Snow', {
                system: def, playOnStart: false, cullingMode: 'simulate', lodEnabled: false,
            }, `__precipitation__/${kind}`);
            node.editorOwned = true;
            node.scene = this._scene;
            slot = { node, key, falling: false };
            this._slots[kind] = slot;
            this._systems.push(node);
        } else if (slot.key !== key) {
            slot.node.setSystem(precipitationSystem(kind, look, { wind, density: 1, prewarm: true }));
            slot.key = key;
        }

        const node = slot.node;
        node.spawnRateScale = this.density;
        // The column: over the camera, led along its motion and leaning upwind, by how long a particle
        // takes to fall to eye level, each at most a third of the column's width.
        const fall = precipitationFallTime(kind, look.speed);
        const cap = Math.min(halfX, halfZ) * 2 * MAX_OFFSET;
        const clampLen = (x: number, z: number): [number, number] => {
            const l = Math.hypot(x, z);
            return l > cap ? [x / l * cap, z / l * cap] : [x, z];
        };
        const lead = clampLen(this._velocity[0] * fall, this._velocity[2] * fall);
        const upwind = clampLen(-wind[0] * fall, -wind[1] * fall);
        node.setPosition(vec3.fromValues(camera[0] + lead[0] + upwind[0], camera[1], camera[2] + lead[1] + upwind[1]));
        node.updateTransforms();

        // A cut or a teleport: start the column full where the camera now is, not trailing from where it
        // was. Otherwise (re)start it if it is not falling; `play` is free while it already is.
        if (slot.falling && jump > JUMP) node.restart();
        else node.play();
        slot.falling = true;
        this._step(node, delta, time);
    }

    private _step(node: ParticleSystemNode, delta: number, time: number): void {
        node.update(delta, time);
    }

    /** The wind a volume's precipitation drifts with: the scene's WindNode, steady part, times its `precipitationWind`. */
    private _windOf(v: WeatherNode): [number, number] {
        const wind = this._scene.wind;
        if (!wind || !wind.visible || !(v.precipitationWind > 0)) return [0, 0];
        const [dx, dz] = wind.directionXZ;
        const speed = wind.strength * WIND_AIR_SPEED * v.precipitationWind;
        // Rounded, so a wind tweaked by a slider does not repack the system every frame.
        const r = (x: number) => Math.round(x * 4) / 4;
        return [r(dx * speed), r(dz * speed)];
    }

    /** Let go of the systems (the scene is going away). */
    public dispose(): void {
        for (const node of this._systems) {
            node.stop(true);
            node.scene = null;
        }
        this._systems.length = 0;
        this._slots.rain = null;
        this._slots.snow = null;
        this._hasLast = false;
    }
}

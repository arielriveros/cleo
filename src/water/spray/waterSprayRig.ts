import type { Scene } from '../../core/scene/scene';
import type { ParticleSystemNode, ParticleSystemNodeOptions } from '../../core/scene/nodes/particleSystemNode';
import type { WaterVolumeNode } from '../../core/scene/nodes/waterVolumeNode';
import type { WaterInfo } from '../waterInfo';
import { featureFactory } from '../../core/features/registry';
import { obstacleFootprint, sceneObstacles, type WaterObstacleFootprint } from '../bake/obstacles';
import { bodySpray, flowSprayField, obstacleSpray, sampleFlow, type FlowSample, type SprayPoint } from './sprayField';
import {
    SPRAY_LOOK, SPRAY_LOOKS, SprayAccumulator, chooseSpray, sprayLookSystem, sprayRates, spraySource,
    type SprayCandidate, type SprayLook,
} from './sprayParticles';
import { valueNoise1 } from '../../core/math';
import { seedSalt } from '../../particles/particleRuntime';

/** Metres round the camera the static colliders standing in the water are gathered from. */
const OBSTACLE_REACH = 60;
/** Milliseconds a water's obstacles stand before they are gathered again (they move when the game moves them). */
const OBSTACLE_REFRESH_MS = 250;
/** Milliseconds an unbaked water's spray points stand while it is being edited (a gizmo drag). */
const FIELD_REBUILD_MS = 500;
/** Milliseconds a water's list of bodies crossing it stays news (a paused game's goes stale). */
const BODIES_FRESH_MS = 250;

/** What the rig keeps per Water node: its flow's spray points and the obstacles' round the camera. */
interface WaterSpray {
    key: string;
    at: number;
    salt: number;
    points: SprayPoint[];
    obstacles: { at: number; points: SprayPoint[] } | null;
}

/**
 * The spray FLOWING WATER throws (water/spray/): droplets, mist and foam from every Water node's rapids and falls,
 * from the faces of what stands in its fast current, and from bodies its current hits. Three particle systems
 * (sprayParticles.ts), one per look, kept at the camera; each frame the most important spray points near it
 * (at most 32 a look, within a budget of particles a second) are fed to them as spawn points
 * (particles/particleSources.ts). Owned by the Scene and run once per update, editing too: water runs while it
 * is edited, and its spray with it. Bodies throw spray only while the game runs (WaterVolumeNode.disturbances).
 *
 * The systems are NOT in the scene tree (never saved, listed or picked), as the rain's are not
 * (core/scene/precipitationRig.ts): they carry the scene (the editor's particle preview toggle governs them) and
 * are editor-owned. The renderer draws `systems` beside the scene's own. Without the Particles feature there are
 * none: the factory that makes them is that feature's.
 */
export class WaterSprayRig {
    private readonly _systems: Record<SprayLook, ParticleSystemNode | null> = { droplets: null, mist: null, foam: null };
    private readonly _list: ParticleSystemNode[] = [];
    private readonly _accumulators: Record<SprayLook, SprayAccumulator> = {
        droplets: new SprayAccumulator(), mist: new SprayAccumulator(), foam: new SprayAccumulator(),
    };
    private readonly _previous: Record<SprayLook, Set<number>> = { droplets: new Set(), mist: new Set(), foam: new Set() };
    private readonly _waters = new WeakMap<WaterVolumeNode, WaterSpray>();
    private _clock = 0;
    private readonly _sample: FlowSample = { surface: 0, u: 0, v: 0, depth: 0, wet: false };

    /** A multiplier on how much spray every water throws (a quality setting); 0 throws none. */
    public density = 1;

    constructor(private readonly _scene: Scene) {}

    /** The particle systems spraying now. */
    public get systems(): readonly ParticleSystemNode[] { return this._list; }

    /** Advance by `delta` seconds of scene time. Called by Scene.update. */
    public update(delta: number, time: number): void {
        const scene = this._scene;
        const waters: WaterVolumeNode[] = [];
        for (const w of scene.waterVolumes as Set<WaterVolumeNode>)
            if (w.enabled && w.visible && w.spray > 0 && !w.surfaceNodeId) waters.push(w);
        if (!waters.length && !this._list.length) return;
        const dt = Math.max(0, delta);
        this._clock += dt;
        const cameraNode = scene.activeCamera;
        const camera = cameraNode ? [...cameraNode.worldPosition] as [number, number, number] : null;
        let forward = [0, 0, -1];
        if (cameraNode) { const v = cameraNode.camera.viewMatrix; forward = [-v[2], -v[6], -v[10]]; }

        const candidates: Record<SprayLook, SprayCandidate[]> = { droplets: [], mist: [], foam: [] };
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now(); // wall-clock: cache ages only
        if (camera && this.density > 0) {
            for (const w of waters) {
                for (const p of this._pointsOf(w, camera, now)) {
                    const rates = sprayRates(p);
                    for (const look of SPRAY_LOOKS)
                        if (rates[look] > 0) candidates[look].push({ point: p, rate: rates[look] * w.spray * this.density });
                }
            }
        }

        for (const look of SPRAY_LOOKS) {
            const acc = this._accumulators[look];
            acc.advance(dt);
            const d = SPRAY_LOOK[look];
            const chosen = camera ? chooseSpray(candidates[look], camera, forward, d.radius, d.budget, this._previous[look]) : [];
            const previous = this._previous[look];
            previous.clear();
            const sources = [];
            for (const c of chosen) {
                previous.add(c.point.id);
                // Water bursts and eases, never a steady hiss: each point's rate swells and drops on its own.
                const pulse = 0.7 + 0.3 * valueNoise1(this._clock * 1.7, c.point.id % 9973);
                const n = acc.take(c.point.id, c.rate * pulse, dt);
                if (n > 0) sources.push(spraySource(c.point, look, n));
            }
            let node = this._systems[look];
            if (!node && sources.length) node = this._make(look);
            if (!node) continue;
            if (camera) { node.setPosition(camera); node.updateTransforms(); }
            if (sources.length) node.spawnFrom(sources);
            node.update(dt, time);
        }
    }

    /** A look's system, made the first time it sprays (null without the Particles feature). */
    private _make(look: SprayLook): ParticleSystemNode | null {
        const make = featureFactory<(name: string, options: ParticleSystemNodeOptions, id: string) => ParticleSystemNode>('particleSystem');
        if (!make) return null;
        const node = make(`Water ${look}`, { system: sprayLookSystem(look), playOnStart: false, cullingMode: 'simulate', lodEnabled: false },
                          `__waterSpray__/${look}`);
        node.editorOwned = true;
        node.scene = this._scene;
        node.play();
        this._systems[look] = node;
        this._list.push(node);
        return node;
    }

    /** Every spray point of a Water node near the camera: its flow's, its obstacles', the bodies crossing it. */
    private _pointsOf(w: WaterVolumeNode, camera: ArrayLike<number>, now: number): SprayPoint[] {
        const drawn = w.drawnWater();
        if (!drawn || drawn.info.source === 'shore') return [];
        const info = drawn.info;
        let st = this._waters.get(w);
        if (!st || (st.key !== drawn.key && now - st.at > FIELD_REBUILD_MS)) {
            const salt = seedSalt(w.id) & 0xff;
            const points = flowSprayField(info).map(p => ({ ...p, id: (p.id ^ (salt << 24)) >>> 0 }));
            st = { key: drawn.key, at: now, salt, points, obstacles: null };
            this._waters.set(w, st);
        }
        if (!st.obstacles || now - st.obstacles.at > OBSTACLE_REFRESH_MS) {
            const R = OBSTACLE_REACH;
            const nodes = (this._scene as any).nodes ?? [];
            const footprints: WaterObstacleFootprint[] = [];
            for (const o of sceneObstacles(nodes, [camera[0] - R, camera[2] - R, camera[0] + R, camera[2] + R], w.reactsTo)) {
                const cx = (o.min[0] + o.max[0]) / 2, cz = (o.min[2] + o.max[2]) / 2;
                const surface = this._surfaceNear(info, cx, cz, Math.max(o.max[0] - o.min[0], o.max[2] - o.min[2]) / 2 + 1.5 * info.cell);
                if (surface === null) continue;
                const f = obstacleFootprint(o, surface);
                if (f) footprints.push(f);
            }
            const points = obstacleSpray(footprints, (x, z, out) => sampleFlow(info, x, z, out), info.cell)
                .map(p => ({ ...p, id: (p.id ^ (st!.salt << 24)) >>> 0 }));
            st.obstacles = { at: now, points };
        }
        // Read every frame: reading is what keeps the node gathering the bodies crossing it.
        const crossing = w.disturbances;
        const fresh = now - w.disturbancesAt < BODIES_FRESH_MS;
        const bodies = fresh && crossing.length
            ? bodySpray(crossing, (x, z) => (sampleFlow(info, x, z, this._sample).wet ? this._sample.surface : w.columnAt(x, z)?.surface ?? null), st.salt)
            : [];
        return [...st.points, ...st.obstacles.points, ...bodies];
    }

    /** The water's surface at (x, z), or at the first of four points `reach` round it that has water (a post's middle has none). */
    private _surfaceNear(info: WaterInfo, x: number, z: number, reach: number): number | null {
        const s = this._sample;
        if (sampleFlow(info, x, z, s).wet) return s.surface;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
            if (sampleFlow(info, x + dx * reach, z + dz * reach, s).wet) return s.surface;
        return null;
    }

    /** Let go of the systems (the scene is going away). */
    public dispose(): void {
        for (const node of this._list) {
            node.stop(true);
            node.scene = null;
        }
        this._list.length = 0;
        this._systems.droplets = null; this._systems.mist = null; this._systems.foam = null;
    }
}

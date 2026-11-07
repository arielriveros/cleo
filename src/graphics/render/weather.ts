import { mat4 } from 'gl-matrix';
import type { Scene } from '../../core/scene/scene';
import type { WeatherNode } from '../../core/scene/nodes/weatherNode';
import { ShaderManager } from '../systems/shaderManager';
import type { ShaderProgram } from '../rhi/shaderProgram';
import type { FrameView } from './frameView';
import type { ViewProjection } from './viewProjection';
import type { ShadowPasses } from './shadows';
import type { FoliagePasses } from './foliage';
import { emptyWeatherPack, gatherWeather, packWeather, shelterClearanceDepth, shelterFootprint, type ShelterFootprint, type WeatherPack } from './weatherPack';

/** Flat snow: what the weather draws without a snow material (linear albedo, roughness). */
const FLAT_SNOW: readonly number[] = [0.9, 0.9, 0.9, 0.85];

/**
 * The frame's weather volumes (WeatherNode), handed to everything that draws weather:
 * - the landscape, through its fragment-only block (chunks/terrainWeather.wgsl);
 * - instanced foliage, per plant, through the instanced vertex blocks (chunks/instancedVertex.wgsl and
 *   chunks/instancedDepthVertex.wgsl, the shadows bowing the same way);
 * - the shelter map, drawn by the shadow subsystem over the volumes' footprint round the camera.
 *
 * Written straight into every program that declares the members, once a frame: block members are CPU
 * memory until a draw flushes them, so no program has to be bound (and none is built on demand). A
 * preview frame (thumbnail, offscreen capture) writes an empty pack: the ShaderManager is shared, and a
 * thumbnail must not inherit the scene's rain.
 */
export class WeatherPasses {
    /** This frame's packed volumes. */
    public readonly pack: WeatherPack = emptyWeatherPack();
    /** The snow's linear colour and roughness: the highest-priority snowing volume's material, or flat white. */
    public readonly snowColor: number[] = [...FLAT_SNOW];
    private _footprint: ShelterFootprint | null = null;
    private _programs: ShaderProgram[] = [];
    private _programsGeneration = -1;
    private readonly _info: number[] = [0, 0, 0, 0];
    private readonly _shelterParams: number[] = [0, 0, 0, 0];
    private readonly _shelterUv: mat4 = mat4.create();

    constructor(private readonly _view: FrameView,
                private readonly _projection: ViewProjection,
                private readonly _shadows: ShadowPasses,
                private readonly _foliage: FoliagePasses) {}

    /** The shelter map's footprint this frame, or null (no volume keeps shelter, or it is switched off). */
    public get footprint(): ShelterFootprint | null { return this._footprint; }

    /**
     * Gather and pack the frame's volumes and write them into every program. Before the shadow passes:
     * the foliage shadows bow by them.
     */
    public prepare(scene: Scene, preview: boolean): void {
        const camera = this._view.camera.position;
        const volumes = preview ? [] : gatherWeather(scene.weatherVolumes, camera);
        packWeather(volumes, this.pack);
        this._snowColorOf(volumes);
        this._foliage.weatherHash = this.pack.count > 0 ? (this.pack.hash || 1) : 0;
        this._foliage.snowColor.splice(0, 4, ...this.snowColor);
        this._footprint = !preview && this._shadows.shelterEnabled && this.pack.count > 0
            ? shelterFootprint(volumes, camera, this._shadows.shelterResolution, this._footprint)
            : null;
        this._info[0] = this.pack.count;
        this._shelterParams[0] = 0;
        this._upload(false);
    }

    /** Draw the shelter map (after the punctual shadows) and hand its matrix to every program. */
    public renderShelter(scene: Scene, preview: boolean): void {
        if (preview) return;
        this._shadows.renderShelter(scene, this._footprint);
        const f = this._shadows.shelterValid ? this._shadows.shelterFootprint : null;
        if (f) {
            mat4.copy(this._shelterUv, this._projection.uvProducing(this._shadows.shelterMatrix));
            this._shelterParams[0] = 1;
            this._shelterParams[1] = shelterClearanceDepth(f);
            this._shelterParams[2] = 1 / Math.max(1, this._shadows.shelterResolution);
        } else {
            this._shelterParams[0] = 0;
        }
        this._upload(true);
    }

    /** The snow colour: linear albedo and roughness of the highest-priority snowing volume's material. */
    private _snowColorOf(volumes: readonly WeatherNode[]): void {
        let best: WeatherNode | null = null;
        for (const v of volumes) if (v.snow > 0 && v.snowMaterial && (!best || v.priority >= best.priority)) best = v;
        const out = this.snowColor;
        if (!best?.snowMaterial) { out.splice(0, 4, ...FLAT_SNOW); return; }
        const p = best.snowMaterial.properties;
        const c = (p.get('baseColor') ?? p.get('diffuse') ?? p.get('color') ?? [0.9, 0.9, 0.9]) as number[];
        const lin = (x: number) => Math.pow(Math.max(0, Math.min(1, +x || 0)), 2.2);
        out[0] = lin(c[0]); out[1] = lin(c[1]); out[2] = lin(c[2]);
        const r = Number(p.get('roughness'));
        out[3] = Number.isFinite(r) ? Math.max(0.05, Math.min(1, r)) : 0.85;
    }

    /** Every registered program that declares the weather members, kept until the program set changes. */
    private _targets(): ShaderProgram[] {
        const sm = ShaderManager.Instance;
        if (this._programsGeneration === sm.generation) return this._programs;
        const seen = new Set<ShaderProgram>();
        const out: ShaderProgram[] = [];
        for (const name of sm.registeredShaders) {
            const program = sm.find(name);
            if (!program || seen.has(program)) continue;
            seen.add(program);
            if (program.hasUniform('u_weatherInfo')) out.push(program);
        }
        this._programs = out;
        this._programsGeneration = sm.generation;
        return out;
    }

    private _upload(shelterOnly: boolean): void {
        for (const program of this._targets()) {
            if (!shelterOnly) {
                program.setUniform('u_weatherInv', this.pack.inv);
                program.setUniform('u_weatherBlend', this.pack.blend);
                program.setUniform('u_weatherAmount', this.pack.amount);
                program.setUniform('u_weatherShape', this.pack.shape);
                program.setUniform('u_weatherInfo', this._info);
                program.setUniform('u_snowColor', this.snowColor);
            }
            program.setUniform('u_shelterMatrix', this._shelterUv);
            program.setUniform('u_shelterParams', this._shelterParams);
        }
    }
}

import type { Scene } from "../scene";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { nightFactor } from "../../../graphics/skyNight";

/**
 * Scene-wide indirect light taken from whatever is in the sky — the baked `SkyAtmosphereNode` cubemap
 * or a `SkyboxNode`'s, whichever the scene has. Scene singleton.
 *
 * Holds no texture: the renderer projects the sky into nine spherical-harmonic coefficients and uploads
 * those as uniforms. Only the user's settings are serialized; the coefficients are re-derived on load.
 */

export interface SkyLightOptions {
    /** Multiplier on the sky's own radiance. 1 = physically what the sky bake says. */
    intensity?: number;
    /** Artistic tint, multiplied into the coefficients. Neutral by default. */
    tint?: [number, number, number];
    /**
     * How strongly the scene's clouds grade the lighting, 0..1. 1 = full physical response (an overcast
     * sky takes the sun's strength and warm cast); 0 = clouds are drawn but light nothing differently.
     */
    cloudResponse?: number;
    /** Let the scene's volumetric clouds shade the ground: the sun is dimmed under each cloud. */
    cloudShadows?: boolean;
    /** How dark a cloud's shadow gets, 0..1. 1 = what the cloud's density says. */
    cloudShadowStrength?: number;
    /**
     * Multiplier on the scene's flat ambient fill (Scene settings -> Ambient) while this sky light is in
     * the scene. 1 = as authored there; 0 = the sky light (and any probes) alone light the shade.
     */
    ambient?: number;
    /**
     * Share of that fill kept once the sun is down, 0..1. It fades on the sky's own dusk curve
     * (`nightFactor`), so the day keeps its fill and a moonless night can go almost black.
     * 1 = the night keeps the full fill, as it always did. A new sky light defaults to
     * DEFAULT_NIGHT_AMBIENT, the share a scene with no sky light gets, so adding or deleting one does not
     * change the night; a saved one without the field keeps 1.
     */
    nightAmbient?: number;
}

/**
 * The share of the scene's flat ambient kept at full night when nothing says otherwise: a scene with a sky
 * but no sky light, and a new sky light. The flat ambient is a DAYLIGHT fill (thousands of lux in a sunny
 * scene); kept at night it lit the dark as brightly as the shade at noon, and no torch could show against
 * it. 1e-4 leaves a ~7,600 lx fill at under a lux.
 */
export const DEFAULT_NIGHT_AMBIENT = 0.0001;

/** The flat-ambient multiplier for a night share at a sun elevation (sine), on the sky's dusk curve. */
export function nightAmbientScale(nightShare: number, sunElevationSin: number | null): number {
    if (sunElevationSin === null || nightShare >= 1) return 1;
    return 1 + (nightShare - 1) * nightFactor(sunElevationSin);
}

export class SkyLightNode extends Node {
    private _intensity: number;
    private _tint: [number, number, number];
    private _cloudResponse: number;
    private _cloudShadows: boolean;
    private _cloudShadowStrength: number;
    private _ambient: number;
    private _nightAmbient: number;

    /**
     * Set whenever something the projection depends on changes, cleared by the renderer once it has
     * re-derived the coefficients. The sun moving is NOT tracked here — the sky re-bake drives that.
     */
    private _needsProjection: boolean = true;

    constructor(name: string, options: SkyLightOptions = {}, id: string = uuidv4()) {
        super(name, 'skyLight', id);
        this._intensity = Math.max(0, options.intensity ?? 1);
        this._tint = options.tint ? [options.tint[0], options.tint[1], options.tint[2]] : [1, 1, 1];
        this._cloudResponse = Math.min(1, Math.max(0, options.cloudResponse ?? 1));
        this._cloudShadows = options.cloudShadows ?? false;
        this._cloudShadowStrength = Math.min(1, Math.max(0, options.cloudShadowStrength ?? 0.85));
        this._ambient = Math.max(0, options.ambient ?? 1);
        this._nightAmbient = Math.min(1, Math.max(0, options.nightAmbient ?? DEFAULT_NIGHT_AMBIENT));
    }

    public get intensity(): number { return this._intensity; }
    public set intensity(v: number) { this._intensity = Math.max(0, v); }
    public get tint(): [number, number, number] { return this._tint; }
    public set tint(v: [number, number, number]) {
        this._tint = [v[0], v[1], v[2]];
        // The tint multiplies the coefficients, so changing it must re-derive them. Intensity does not:
        // the shader applies it at evaluation time.
        this._needsProjection = true;
    }

    public get cloudResponse(): number { return this._cloudResponse; }
    // No re-projection: the cloud grade is applied to the coefficients at upload time, not baked in.
    public set cloudResponse(v: number) { this._cloudResponse = Math.min(1, Math.max(0, v)); }

    public get cloudShadows(): boolean { return this._cloudShadows; }
    public set cloudShadows(v: boolean) { this._cloudShadows = v; }
    public get cloudShadowStrength(): number { return this._cloudShadowStrength; }
    public set cloudShadowStrength(v: number) { this._cloudShadowStrength = Math.min(1, Math.max(0, v)); }

    // Neither re-projects: the scene ambient is a separate uniform, scaled at upload time.
    public get ambient(): number { return this._ambient; }
    public set ambient(v: number) { this._ambient = Math.max(0, v); }
    public get nightAmbient(): number { return this._nightAmbient; }
    public set nightAmbient(v: number) { this._nightAmbient = Math.min(1, Math.max(0, v)); }

    /**
     * What the renderer multiplies the scene's flat ambient by. `sunElevationSin` is the sine of the
     * sun's elevation, or null for a scene with no sun to tell day from night — the night share then
     * never applies.
     */
    public ambientScale(sunElevationSin: number | null): number {
        return this._ambient * nightAmbientScale(this._nightAmbient, sunElevationSin);
    }

    public get needsProjection(): boolean { return this._needsProjection; }
    /** Force a re-projection on the next frame (the sky changed, or the editor asked). */
    public markDirty(): void { this._needsProjection = true; }
    public markProjected(): void { this._needsProjection = false; }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        // Scene-wide and unplaceable, so the box exists only to give the editor something to frame.
        const position = this.worldPosition;
        const radius = 1;
        return {
            min: vec3.fromValues(position[0] - radius, position[1] - radius, position[2] - radius),
            max: vec3.fromValues(position[0] + radius, position[1] + radius, position[2] + radius),
        };
    }

    protected _serializePayload(): any {
        return {
            skyLight: {
                intensity: this._intensity,
                tint: this._tint,
                cloudResponse: this._cloudResponse,
                cloudShadows: this._cloudShadows,
                cloudShadowStrength: this._cloudShadowStrength,
                ambient: this._ambient,
                nightAmbient: this._nightAmbient,
            },
        };
    }

    public static parse(parent: Node, json: any) {
        // A payload from before `nightAmbient` existed kept the full fill at night; it still does.
        const node = new SkyLightNode(json.name, { nightAmbient: 1, ...(json.skyLight ?? {}) }, json.id);
        Node.finishParse(node, parent, json);
    }
}

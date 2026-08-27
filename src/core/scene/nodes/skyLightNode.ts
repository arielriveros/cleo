import type { Scene } from "../scene";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

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
}

export class SkyLightNode extends Node {
    private _intensity: number;
    private _tint: [number, number, number];
    private _cloudResponse: number;

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
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new SkyLightNode(json.name, json.skyLight ?? {}, json.id);
        Node.finishParse(node, parent, json);
    }
}

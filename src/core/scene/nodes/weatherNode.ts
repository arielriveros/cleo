import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { WEATHER_PRESETS, type WeatherPreset } from "./weatherPresets";
import { applyPreset } from "../../presets";

/**
 * The scene's weather: how wet everything is and how much snow lies. Scene singleton, like WindNode; a
 * scene without one is dry.
 *
 * Today FOLIAGE materials answer it (chunks/foliageSurface.wgsl, Material.Foliage): rain darkens and
 * glosses leaves and blades by their `wetResponse`, snow settles on what faces up by their `snowCover`,
 * and both weigh the plant down by its `weightDroop`. Nothing else reads it yet.
 */
export interface WeatherOptions {
    /** How wet: 0 dry, 1 soaked. */
    wetness?: number;
    /** How much snow lies on things: 0 none, 1 thick. */
    snow?: number;
}

export const WEATHER_DEFAULTS: Required<WeatherOptions> = { wetness: 0, snow: 0 };

const unit = (v: unknown, fallback: number) =>
    Math.min(1, Math.max(0, typeof v === 'number' && Number.isFinite(v) ? v : fallback));

export class WeatherNode extends Node {
    private _wetness: number;
    private _snow: number;

    constructor(name: string, options: WeatherOptions = {}, id: string = uuidv4()) {
        super(name, 'weather', id);
        this._wetness = unit(options.wetness, WEATHER_DEFAULTS.wetness);
        this._snow = unit(options.snow, WEATHER_DEFAULTS.snow);
    }

    public get wetness(): number { return this._wetness; }
    public set wetness(v: number) { this._wetness = unit(v, this._wetness); }
    public get snow(): number { return this._snow; }
    public set snow(v: number) { this._snow = unit(v, this._snow); }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        // Scene-wide and unplaceable; the box only gives the editor something to frame.
        const p = this.worldPosition;
        return { min: vec3.fromValues(p[0] - 1, p[1] - 1, p[2] - 1), max: vec3.fromValues(p[0] + 1, p[1] + 1, p[2] + 1) };
    }

    /** Applies a preset by id (see WEATHER_PRESETS) or a preset object. Returns false for an unknown id. */
    public applyPreset(idOrPreset: string | WeatherPreset): boolean {
        return applyPreset(this, WEATHER_PRESETS, idOrPreset);
    }

    protected _serializePayload(): any {
        return { weather: { wetness: this._wetness, snow: this._snow } };
    }

    public static parse(parent: Node, json: any) {
        const node = new WeatherNode(json.name, json.weather ?? {}, json.id);
        Node.finishParse(node, parent, json);
    }
}

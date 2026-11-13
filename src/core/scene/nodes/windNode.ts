import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { WIND_PRESETS, type WindPreset } from "./windPresets";
import { applyPreset } from "../../presets";
import { WIND_DEFAULT_GUSTINESS, WIND_DEFAULT_VEER, sampleSceneWind, windFieldClock } from "../../wind/windField";
import { clamp01, finiteOr } from "../../math";

/**
 * The scene's wind: a vector field every wind-enabled foliage material, Scene-wind particle and script
 * samples (see core/wind/windField.ts and chunks/windField.wgsl). Scene singleton; a scene without one
 * has no base wind and pays nothing for it — the renderer only picks the wind shader variants while a
 * visible WindNode (or a Force Field that affects the wind) exists.
 *
 * The Ghost of Tsushima recipe: one authored vector (`direction`, `strength`) whose magnitude rides 2D
 * Perlin noise scrolled along it at `gustSpeed`, `gustScale` metres between crests, so gusts visibly
 * travel across a field; `gustiness` is how much of the air the gusts carry. A broader noise turns the
 * direction by up to `veer` degrees either way, so neighbouring meadows lean apart. Force Fields flagged
 * `affectsWind` add local wind on top (whirlwinds, blasts, corridors, shelters).
 *
 * How far a given plant leans is its material's business (`windStrength`, `windStiffness`); strength 1
 * is about 7 m/s of air in a full gust, what those materials are authored for.
 */
export interface WindOptions {
    /** Compass direction the wind blows TOWARD, degrees, counter-clockwise from +X in the XZ plane. */
    direction?: number;
    /** Global multiplier on the air speed and every material's lean. 0 = calm, 1 = authored (~7 m/s gusts), 2 = storm. */
    strength?: number;
    /** Metres between gust crests. */
    gustScale?: number;
    /** How fast gusts travel, metres per second. */
    gustSpeed?: number;
    /** 0..1: how much of the air the gusts carry. 0 = a steady stream, 1 = still air between gusts. */
    gustiness?: number;
    /** Degrees: the most the direction turns either way across the field (typically about a third of it). */
    veer?: number;
    /** Camera distance where the motion starts to fade out, and where it is gone. */
    fadeStart?: number;
    fadeEnd?: number;
}

export const WIND_DEFAULTS: Required<WindOptions> = {
    direction: 30, strength: 1, gustScale: 18, gustSpeed: 4, gustiness: WIND_DEFAULT_GUSTINESS, veer: WIND_DEFAULT_VEER,
    fadeStart: 40, fadeEnd: 70,
};

const clampVeer = (v: number) => Math.min(90, Math.max(0, v));

export class WindNode extends Node {
    public direction: number;
    private _strength: number;
    private _gustScale: number;
    private _gustSpeed: number;
    private _gustiness: number;
    private _veer: number;
    private _fadeStart: number;
    private _fadeEnd: number;

    constructor(name: string, options: WindOptions = {}, id: string = uuidv4()) {
        super(name, 'wind', id);
        this.direction = finiteOr(options.direction, WIND_DEFAULTS.direction);
        this._strength = Math.max(0, finiteOr(options.strength, WIND_DEFAULTS.strength));
        this._gustScale = Math.max(0.5, finiteOr(options.gustScale, WIND_DEFAULTS.gustScale));
        this._gustSpeed = Math.max(0, finiteOr(options.gustSpeed, WIND_DEFAULTS.gustSpeed));
        this._gustiness = clamp01(finiteOr(options.gustiness, WIND_DEFAULTS.gustiness));
        this._veer = clampVeer(finiteOr(options.veer, WIND_DEFAULTS.veer));
        this._fadeStart = Math.max(0, finiteOr(options.fadeStart, WIND_DEFAULTS.fadeStart));
        this._fadeEnd = Math.max(this._fadeStart + 1, finiteOr(options.fadeEnd, WIND_DEFAULTS.fadeEnd));
    }

    public get strength(): number { return this._strength; }
    public set strength(v: number) { this._strength = Math.max(0, finiteOr(v, this._strength)); }
    public get gustScale(): number { return this._gustScale; }
    public set gustScale(v: number) { this._gustScale = Math.max(0.5, finiteOr(v, this._gustScale)); }
    public get gustSpeed(): number { return this._gustSpeed; }
    public set gustSpeed(v: number) { this._gustSpeed = Math.max(0, finiteOr(v, this._gustSpeed)); }
    public get gustiness(): number { return this._gustiness; }
    public set gustiness(v: number) { this._gustiness = clamp01(finiteOr(v, this._gustiness)); }
    public get veer(): number { return this._veer; }
    public set veer(v: number) { this._veer = clampVeer(finiteOr(v, this._veer)); }
    public get fadeStart(): number { return this._fadeStart; }
    public set fadeStart(v: number) {
        this._fadeStart = Math.max(0, finiteOr(v, this._fadeStart));
        if (this._fadeEnd <= this._fadeStart) this._fadeEnd = this._fadeStart + 1;
    }
    public get fadeEnd(): number { return this._fadeEnd; }
    public set fadeEnd(v: number) { this._fadeEnd = Math.max(this._fadeStart + 1, finiteOr(v, this._fadeEnd)); }

    /** Unit wind direction in world XZ. */
    public get directionXZ(): [number, number] {
        const a = this.direction * Math.PI / 180;
        return [Math.cos(a), -Math.sin(a)];
    }

    /**
     * The air velocity, in m/s, at world `position`: this wind's gusting, veering field plus every Force
     * Field in the scene that `affectsWind` — the same function the foliage bends to on the GPU. Written
     * into `out` and returned.
     *
     * `time` defaults to the frame's wind clock, so the answer is the gust the plants are showing right
     * now. Cheap enough to call per frame for a handful of objects (a sail, a kite, an arrow's drift).
     *
     * @example
     * const air = this.scene.wind?.sampleAt(this.worldPosition) ?? [0, 0, 0];
     * this.body.applyForce([air[0] * 0.2, 0, air[2] * 0.2]);
     */
    public sampleAt(position: ArrayLike<number>, out: number[] | Float32Array = [0, 0, 0],
                    time: number = windFieldClock.time): number[] | Float32Array {
        const scene = this.scene;
        return sampleSceneWind(scene && scene.wind === this ? scene : { wind: this, forceFields: scene?.forceFields ?? [] },
            position, out, time);
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        // Scene-wide and unplaceable; the box only gives the editor something to frame.
        const p = this.worldPosition;
        return { min: vec3.fromValues(p[0] - 1, p[1] - 1, p[2] - 1), max: vec3.fromValues(p[0] + 1, p[1] + 1, p[2] + 1) };
    }

    /** Applies a preset by id (see WIND_PRESETS) or a preset object. Returns false for an unknown id. */
    public applyPreset(idOrPreset: string | WindPreset): boolean {
        return applyPreset(this, WIND_PRESETS, idOrPreset);
    }

    protected _serializePayload(): any {
        return {
            wind: {
                direction: this.direction, strength: this._strength, gustScale: this._gustScale,
                gustSpeed: this._gustSpeed, gustiness: this._gustiness, veer: this._veer,
                fadeStart: this._fadeStart, fadeEnd: this._fadeEnd,
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new WindNode(json.name, json.wind ?? {}, json.id);
        Node.finishParse(node, parent, json);
    }
}

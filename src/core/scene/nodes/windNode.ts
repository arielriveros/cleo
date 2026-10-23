import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { WIND_PRESETS, type WindPreset } from "./windPresets";
import { applyPreset } from "../../presets";

/**
 * The scene's wind: one global field every wind-enabled foliage material responds to (see
 * chunks/foliageWind.wgsl). Scene singleton; a scene without one has no wind and pays nothing for it —
 * the renderer only picks the wind shader variants while a visible WindNode exists.
 *
 * Gusts are a noise field scrolled along `direction` at `gustSpeed`, `gustScale` metres between
 * crests, so they visibly travel across a field. How far a given plant leans is its material's
 * business (`windStrength`, `windStiffness`); this node scales all of them at once.
 */
export interface WindOptions {
    /** Compass direction the wind blows TOWARD, degrees, counter-clockwise from +X in the XZ plane. */
    direction?: number;
    /** Global multiplier on every material's lean. 0 = calm, 1 = authored, 2 = storm. */
    strength?: number;
    /** Metres between gust crests. */
    gustScale?: number;
    /** How fast gusts travel, metres per second. */
    gustSpeed?: number;
    /** Camera distance where the motion starts to fade out, and where it is gone. */
    fadeStart?: number;
    fadeEnd?: number;
}

export const WIND_DEFAULTS: Required<WindOptions> = {
    direction: 30, strength: 1, gustScale: 18, gustSpeed: 4, fadeStart: 40, fadeEnd: 70,
};

const finite = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export class WindNode extends Node {
    public direction: number;
    private _strength: number;
    private _gustScale: number;
    private _gustSpeed: number;
    private _fadeStart: number;
    private _fadeEnd: number;

    constructor(name: string, options: WindOptions = {}, id: string = uuidv4()) {
        super(name, 'wind', id);
        this.direction = finite(options.direction, WIND_DEFAULTS.direction);
        this._strength = Math.max(0, finite(options.strength, WIND_DEFAULTS.strength));
        this._gustScale = Math.max(0.5, finite(options.gustScale, WIND_DEFAULTS.gustScale));
        this._gustSpeed = Math.max(0, finite(options.gustSpeed, WIND_DEFAULTS.gustSpeed));
        this._fadeStart = Math.max(0, finite(options.fadeStart, WIND_DEFAULTS.fadeStart));
        this._fadeEnd = Math.max(this._fadeStart + 1, finite(options.fadeEnd, WIND_DEFAULTS.fadeEnd));
    }

    public get strength(): number { return this._strength; }
    public set strength(v: number) { this._strength = Math.max(0, finite(v, this._strength)); }
    public get gustScale(): number { return this._gustScale; }
    public set gustScale(v: number) { this._gustScale = Math.max(0.5, finite(v, this._gustScale)); }
    public get gustSpeed(): number { return this._gustSpeed; }
    public set gustSpeed(v: number) { this._gustSpeed = Math.max(0, finite(v, this._gustSpeed)); }
    public get fadeStart(): number { return this._fadeStart; }
    public set fadeStart(v: number) {
        this._fadeStart = Math.max(0, finite(v, this._fadeStart));
        if (this._fadeEnd <= this._fadeStart) this._fadeEnd = this._fadeStart + 1;
    }
    public get fadeEnd(): number { return this._fadeEnd; }
    public set fadeEnd(v: number) { this._fadeEnd = Math.max(this._fadeStart + 1, finite(v, this._fadeEnd)); }

    /** Unit wind direction in world XZ. */
    public get directionXZ(): [number, number] {
        const a = this.direction * Math.PI / 180;
        return [Math.cos(a), -Math.sin(a)];
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
                gustSpeed: this._gustSpeed, fadeStart: this._fadeStart, fadeEnd: this._fadeEnd,
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new WindNode(json.name, json.wind ?? {}, json.id);
        Node.finishParse(node, parent, json);
    }
}

import { DirectionalLight, Light, LIGHT_UNIT, PointLight, Spotlight } from "../../../graphics/lighting";
import { flickerFactor, flickerSeed, followFlicker, lightFlickerClock } from "../../../graphics/lightFlicker";
import { Logger } from "../../logger";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/**
 * Directional, point and spot lights.
 */

export class LightNode extends Node {
    private readonly _light: Light
    private readonly _type: 'directional' | 'point' | 'spotlight';
    private _index: number;
    private _castShadows: boolean;

    constructor(name: string, light: Light, castShadows: boolean = false, id: string = uuidv4()) {
        super(name, 'light', id);
        this._light = light;
        this._index = -1;
        this._castShadows = castShadows;

        if (light instanceof DirectionalLight)
            this._type = 'directional';
        else if (light instanceof PointLight)
            this._type = 'point';
        else if (light instanceof Spotlight)
            this._type = 'spotlight';
        else {
            const errMsg = "Light type not supported";
            Logger.error(errMsg)
            throw new Error(errMsg);
        }
    }

    protected _serializePayload(): any {
        const light = this._light;
        const colour = [light.color[0], light.color[1], light.color[2]];
        // `unit` is what makes the migration idempotent: a payload carrying it is already photometric
        // and the constructors leave it alone. Mirrors FOLIAGE_DENSITY_UNIT — see graphics/lighting.ts.
        let lightData: any = { unit: LIGHT_UNIT, color: colour };

        switch (this._type) {
            case 'directional': {
                const d = light as DirectionalLight;
                lightData.intensity = d.intensity;           // lux
                lightData.angularRadius = d.angularRadius;
                break;
            }
            case 'point': {
                const p = light as PointLight;
                lightData.intensity = p.intensity;           // lumens
                lightData.range = p.range;
                lightData.sourceRadius = p.sourceRadius;
                lightData.legacyFalloff = p.legacyFalloff;
                if (p.flickerAmount > 0) lightData.flicker = { amount: p.flickerAmount, speed: p.flickerSpeed };
                break;
            }
            case 'spotlight': {
                const s = light as Spotlight;
                lightData.intensity = s.intensity;           // lumens
                lightData.range = s.range;
                lightData.sourceRadius = s.sourceRadius;
                lightData.cutOff = s.cutOff;
                lightData.outerCutOff = s.outerCutOff;
                lightData.legacyFalloff = s.legacyFalloff;
                if (s.flickerAmount > 0) lightData.flicker = { amount: s.flickerAmount, speed: s.flickerSpeed };
                break;
            }
        }

        return {
            lightType: this._type,
            light: lightData,
            castShadows: this._castShadows,
        };
    }

    public static parse(parent: Node, json: any) {
        let light;
        // The payload is forwarded WHOLE rather than field by field, which is what lets the light
        // constructors own the legacy conversion: a pre-photometric save still carries
        // diffuse/constant/linear/quadratic, and they migrate on the way in. Naming the fields here
        // instead would mean this function had to know both schemas.
        switch (json.lightType) {
            case 'directional': light = new DirectionalLight(json.light); break;
            case 'point': light = new PointLight(json.light); break;
            case 'spotlight': light = new Spotlight(json.light); break;
            default:
                const errMsg = `Light ${json} of type ${json.type} not supported`;
                Logger.error(errMsg);
                throw new Error(errMsg);
        }
        light.legacyFalloff = json.light?.legacyFalloff ?? light.legacyFalloff;
        // Saves predating the serialized flag carry no key; for those, directional lights cast and
        // nothing else does.
        const castShadows = json.castShadows ?? (json.lightType === 'directional');
        const node = new LightNode(json.name, light, castShadows, json.id);
        Node.finishParse(node, parent, json);
    }

    public get light(): Light { return this._light; }

    private _flickerSeed: number = -1;

    /**
     * This frame's flicker multiplier (graphics/lightFlicker.ts): 1 for a steady light or a directional
     * one. What the light grid multiplies the intensity by, and what a follower's brightness tracks.
     */
    public get flickerFactor(): number {
        const l = this._light as PointLight | Spotlight;
        if (this._type === 'directional' || !(l.flickerAmount > 0)) return 1;
        if (this._flickerSeed < 0) this._flickerSeed = flickerSeed(this.id);
        return flickerFactor(lightFlickerClock.time, l.flickerAmount, l.flickerSpeed, this._flickerSeed);
    }
    public get type(): 'directional' | 'point' | 'spotlight' { return this._type; }
    public get index(): number { return this._index; }
    public set index(value: number) { this._index = value; }
    /**
     * Whether this light casts shadows. Honoured for all three types, by three different mechanisms:
     * the FIRST flagged directional light in the scene gets the camera-fitted cascades; a SPOT light
     * gets one perspective map matching its cone; a POINT light gets six, an unwrapped cube map.
     *
     * The last two are capped (see the renderer's MAX_SPOT_SHADOWS / MAX_POINT_SHADOWS) because each
     * caster is a whole extra depth rasterization — six of them, for a point light. Casters past the
     * cap go unshadowed rather than stealing a map from another light.
     */
    public get castShadows(): boolean { return this._castShadows; }
    public set castShadows(value: boolean) { this._castShadows = value; }

    /** Selection bounds: a small box around the light's origin. */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const scale = this.worldScale;
        
        const radius = Math.max(scale[0], scale[1], scale[2]) * 0.5;
        
        const min = vec3.fromValues(
            position[0] - radius,
            position[1] - radius,
            position[2] - radius
        );
        const max = vec3.fromValues(
            position[0] + radius,
            position[1] + radius,
            position[2] + radius
        );
        
        return { min, max };
    }
}

/**
 * The point or spot light named `name` that `from` follows (Sprite.followLight, ParticleSystemNode
 * .followLight): searched under `from`'s parent, then under each ancestor up to `MAX_FOLLOW_LEVELS` above
 * it, nearest first, a few levels deep. By NAME so a template's instances each find their own light.
 */
export function findFollowedLight(from: Node, name: string): LightNode | null {
    let scope: Node | null = from.parent;
    for (let level = 0; scope && level < MAX_FOLLOW_LEVELS; level++, scope = scope.parent) {
        const found = searchLight(scope, name, 3);
        if (found) return found;
    }
    return null;
}

const MAX_FOLLOW_LEVELS = 3;

function searchLight(node: Node, name: string, depth: number): LightNode | null {
    for (const child of node.children) {
        if (child instanceof LightNode && child.name === name && child.type !== 'directional') return child;
    }
    if (depth <= 1) return null;
    for (const child of node.children) {
        const found = searchLight(child, name, depth - 1);
        if (found) return found;
    }
    return null;
}

/** A small per-follower cache, so resolving a followed light is a lookup most frames rather than a search. */
export class FollowedLight {
    private _name: string | null = null;
    private _node: LightNode | null = null;
    private _owner: Node | null = null;

    /** The flicker multiplier `owner` takes from the light named `name`, at `amount` (1 = steady). */
    public factor(owner: Node, name: string | null, amount: number): number {
        if (!(amount > 0)) return 1;
        const node = this.resolve(owner, name);
        return node ? followFlicker(node.flickerFactor, amount) : 1;
    }

    /** The light named `name` that `owner` follows, or null. */
    public resolve(owner: Node, name: string | null): LightNode | null {
        if (!name) return null;
        if (name !== this._name || this._owner !== owner || !this._node || this._node.scene !== owner.scene || this._node.name !== name) {
            this._name = name;
            this._owner = owner;
            this._node = findFollowedLight(owner, name);
        }
        return this._node;
    }
}

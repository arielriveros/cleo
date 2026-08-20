import { DirectionalLight, Light, PointLight, Spotlight } from "../../../graphics/lighting";
import { Logger } from "../../logger";
import { mat4, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/**
 * Directional, point and spot lights.
 */

export class LightNode extends Node {
    private readonly _light: Light
    private readonly _type: 'directional' | 'point' | 'spotlight';
    private _index: number;
    private _lightSpace: mat4;
    private _castShadows: boolean;
    // Reused scratch to avoid per-frame allocations in the lightSpace getter.
    private readonly _lightView: mat4 = mat4.create();
    private readonly _lightProjection: mat4 = mat4.create();
    private readonly _lightPos: vec3 = vec3.create();

    constructor(name: string, light: Light, castShadows: boolean = false, id: string = uuidv4()) {
        super(name, 'light', id);
        this._light = light;
        this._index = -1;
        this._lightSpace = mat4.create();
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
            let lightData = {};
            switch (this._type) {
                case 'directional':
                    lightData = {
                        diffuse: [this._light.diffuse[0], this._light.diffuse[1], this._light.diffuse[2]],
                        specular: [this._light.specular[0], this._light.specular[1], this._light.specular[2]],
                        ambient: [this._light.ambient[0], this._light.ambient[1], this._light.ambient[2]],
                    };
                    break;
                case 'point':
                    lightData = {
                        diffuse: [this._light.diffuse[0], this._light.diffuse[1], this._light.diffuse[2]],
                        specular: [this._light.specular[0], this._light.specular[1], this._light.specular[2]],
                        ambient: [this._light.ambient[0], this._light.ambient[1], this._light.ambient[2]],
                        constant: (this._light as PointLight).constant,
                        linear: (this._light as PointLight).linear,
                        quadratic: (this._light as PointLight).quadratic
                    };
                    break;
                case 'spotlight':
                    lightData = {
                        diffuse: [this._light.diffuse[0], this._light.diffuse[1], this._light.diffuse[2]],
                        specular: [this._light.specular[0], this._light.specular[1], this._light.specular[2]],
                        ambient: [this._light.ambient[0], this._light.ambient[1], this._light.ambient[2]],
                        constant: (this._light as PointLight).constant,
                        linear: (this._light as Spotlight).linear,
                        quadratic: (this._light as Spotlight).quadratic,
                        cutOff: (this._light as Spotlight).cutOff,
                        outerCutOff: (this._light as Spotlight).outerCutOff
                    };
                    break;
            }
        return {
                    lightType: this._type,
                    light: lightData,
        };
    }

    public static parse(parent: Node, json: any) {
        let light;
        switch (json.lightType) {
            case 'directional':
                light = new DirectionalLight({
                    diffuse: json.light.diffuse,
                    specular: json.light.specular,
                    ambient: json.light.ambient,
                });
                break;
            case 'point':
                light = new PointLight({
                    diffuse: json.light.diffuse,
                    specular: json.light.specular,
                    ambient: json.light.ambient,
                    linear: json.light.linear,
                    quadratic: json.light.quadratic
                });
                break;
            case 'spotlight':
                light = new Spotlight({
                    diffuse: json.light.diffuse,
                    specular: json.light.specular,
                    ambient: json.light.ambient,
                    linear: json.light.linear,
                    quadratic: json.light.quadratic,
                    cutOff: json.light.cutOff,
                    outerCutOff: json.light.outerCutOff
                });
                break;
            default:
                const errMsg = `Light ${json} of type ${json.type} not supported`;
                Logger.error(errMsg);
                throw new Error(errMsg);
        }
        const node = new LightNode(json.name, light, json.lightType === 'directional' ? true : false, json.id);
        Node.finishParse(node, parent, json);
    }

    public get light(): Light { return this._light; }
    public get type(): 'directional' | 'point' | 'spotlight' { return this._type; }
    public get index(): number { return this._index; }
    public set index(value: number) { this._index = value; }
    public get lightSpace(): mat4 {
        const lightPos = vec3.scale(this._lightPos, this.worldForward, -50);
        if (this._type === 'directional') {
            // TODO: Change look at position to be the center of where the camera is looking
            mat4.lookAt(this._lightView, lightPos, [0, 0, 0], [0, 1, 0]);
            mat4.ortho(this._lightProjection, -20, 20, -20, 20, 0.1, 100);
        }
        return mat4.multiply(this._lightSpace, this._lightProjection, this._lightView);
    }
    public get castShadows(): boolean { return this._castShadows; }
    public set castShadows(value: boolean) { this._castShadows = value; }

    /**
     * Get bounding box for LightNode - returns a sphere bounding box
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const scale = this.worldScale;
        
        // For lights, use a sphere bounding box
        // Use the largest scale component as the radius
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
 * A light probe captures the surrounding scene into a cubemap and provides image-based lighting
 * (diffuse irradiance + prefiltered specular) for PBR. The actual capture/convolution is done by the
 * renderer (`Renderer.captureProbe`), which fills this node's baked maps. Two modes:
 *  - 'baked'    : captured once (on add, on load, or via the editor "Bake" button).
 *  - 'realtime' : re-captured every `updateFrequency` seconds for dynamic reflections.
 * The baked GPU cubemaps are not serialized (they'd lose HDR); instead the probe re-bakes on load.
 */

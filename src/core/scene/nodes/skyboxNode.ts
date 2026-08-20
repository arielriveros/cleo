import { Skybox } from "../../../graphics/skybox";
import { ShaderManager } from "../../../graphics/systems/shaderManager";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { VolumetricCloudsNode } from "./volumetricCloudsNode";

/**
 * Cubemap sky. Scene singleton.
 */

export class SkyboxNode extends Node {
    private readonly _skybox: Skybox
    private _initialized: boolean;

    constructor(name: string, skybox: Skybox, id: string = uuidv4()) {
        super(name, 'skybox', id);
        this._skybox = skybox;
        this._initialized = false;
    }

    public initializeSkybox(): void {
        this._skybox.mesh.initializeVAO(ShaderManager.Instance.getShader('skybox').attributes);
        this._skybox.mesh.create(this._skybox.box.getData(['position']), this._skybox.box.indices.length, this._skybox.box.indices);
        this._initialized = true;
    }

    public static parse(parent: Node, json: any) {
        Skybox.fromBase64({
            posX: json.skybox.faces.positiveX,
            negX: json.skybox.faces.negativeX,
            posY: json.skybox.faces.positiveY,
            negY: json.skybox.faces.negativeY,
            posZ: json.skybox.faces.positiveZ,
            negZ: json.skybox.faces.negativeZ
        }).then(skybox => {
            const node = new SkyboxNode(json.name, skybox, json.id);
            Node.finishParse(node, parent, json);
        });
    }

    protected _serializePayload(): any {
            const skybox = this._skybox.serialize()
        return {
                    skybox: skybox,
        };
    }

    public get skybox(): Skybox { return this._skybox; }
    public get initialized(): boolean { return this._initialized; }

    /**
     * Get bounding box for SkyboxNode - returns a large sphere bounding box
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        // Skybox is typically very large, use a large bounding box
        const radius = 1000; // Large radius for skybox
        
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

/** Config for a VolumetricCloudsNode. Every field is optional so freshly-created nodes and old
 *  saves both fall back to the defaults below (a mid-coverage cumulus layer). */

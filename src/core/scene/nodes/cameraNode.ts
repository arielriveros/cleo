import { CustomMaterial, Material } from "../../../graphics/material";
import { Camera } from "../../camera";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/**
 * A `Camera` in the scene graph, plus its ordered screen-space post passes.
 */

export class CameraNode extends Node {
    private readonly _camera: Camera;
    private _active: boolean;
    // Ordered fullscreen post-process passes (screen-mode CustomMaterials) run by the renderer for
    // this camera, in array order. Serialized inline like mesh materials; the editor links them to
    // material assets via the '__screenMaterialIds' node variable.
    private _screenMaterials: CustomMaterial[] = [];

    constructor(name: string, camera: Camera, id: string = uuidv4()) {
        super(name, 'camera', id);
        this._camera = camera;
        this._active = true;
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        this._camera.position = this.worldPosition;
        this._camera.eye = vec3.add(vec3.create(), this.worldPosition, this.worldForward);
    }

    public static parse(parent: Node, json: any) {
        const node = new CameraNode(json.name, new Camera({
            type: json.camera.type,
            fov: json.camera.fov,
            near: json.camera.near,
            far: json.camera.far,
            left: json.camera.left,
            right: json.camera.right,
            bottom: json.camera.bottom,
            top: json.camera.top
        }), json.id);
        Node.finishParse(node, parent, json);
    }

    protected _afterParse(json: any): void {
        this.active = json.active;
        this.screenMaterials = (Array.isArray(json.screenMaterials) ? json.screenMaterials : [])
            .map((m: any) => Material.parse(m))
            .filter((m: Material): m is CustomMaterial => m instanceof CustomMaterial && m.renderMode === 'screen');
    }

    protected _serializePayload(): any {
        return {
                    camera: {
                        type: this._camera.type,
                        fov: this._camera.fov,
                        near: this._camera.near,
                        far: this._camera.far,
                        left: this._camera.left,
                        right: this._camera.right,
                        bottom: this._camera.bottom,
                        top: this._camera.top
                    },
                    active: this._active,
                    screenMaterials: this._screenMaterials.map(m => m.serialize()),
        };
    }

    public get camera(): Camera { return this._camera; }
    public get active(): boolean { return this._active; }
    public set active(value: boolean) { this._active = value; }
    public get screenMaterials(): CustomMaterial[] { return this._screenMaterials; }
    public set screenMaterials(mats: CustomMaterial[]) { this._screenMaterials = mats; }

    /**
     * Get bounding box for CameraNode - returns a small sphere bounding box
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const position = this.worldPosition;
        const scale = this.worldScale;
        
        // Camera has a larger bounding box for easier selection
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

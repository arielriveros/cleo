import { CustomMaterial, Material } from "../../../graphics/material";
import { isDefaultChain } from "../../../graphics/renderGraph/chain";
import type { PostChainEntry } from "../../../graphics/renderGraph/chain";
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
    // Fullscreen post passes, run by the renderer in array order. The editor links them to material
    // assets via the '__screenMaterialIds' node variable.
    private _screenMaterials: CustomMaterial[] = [];
    /**
     * This camera's post-process order, or null for "whatever the renderer runs by default".
     *
     * Null is the ordinary case and the reason nothing had to be migrated: every scene saved before
     * per-camera chains existed has no `postChain` key, reads back as null, and resolves to the order
     * the renderer has always run. See `resolvePostChain`, which also owns the repair when this list
     * and `_screenMaterials` have drifted apart.
     *
     * Held as AUTHORED, not as resolved. Resolving at parse time would bake in the material count the
     * scene happened to be saved with, so adding a material later would stop appending it.
     */
    private _postChain: PostChainEntry[] | null = null;

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
        // Shape only. What an entry MEANS — an effect this build knows, a material that still exists —
        // is `resolvePostChain`'s question, and it is asked every frame rather than once on load.
        this._postChain = Array.isArray(json.postChain)
            ? json.postChain.filter((e: any) => e && typeof e.effect === 'string')
                            .map((e: any) => ({ effect: e.effect, enabled: e.enabled !== false }))
            : null;
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
                    // Omitted when it says nothing the default does not: a camera nobody has reordered
                    // must serialize exactly what it did before this field existed, or every scene in
                    // the project shows up dirty the first time it is opened.
                    ...(this._postChain && !isDefaultChain(this._postChain, this._screenMaterials.length)
                        ? { postChain: this._postChain } : {}),
        };
    }

    public get camera(): Camera { return this._camera; }
    public get active(): boolean { return this._active; }
    public set active(value: boolean) { this._active = value; }
    public get screenMaterials(): CustomMaterial[] { return this._screenMaterials; }
    public set screenMaterials(mats: CustomMaterial[]) { this._screenMaterials = mats; }

    /** The authored post-process order, or null to follow the renderer's default. */
    public get postChain(): readonly PostChainEntry[] | null { return this._postChain; }
    public set postChain(chain: readonly PostChainEntry[] | null) {
        this._postChain = chain ? chain.map(e => ({ effect: e.effect, enabled: e.enabled })) : null;
    }

    /** Selection bounds: a small box around the camera's origin. */
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

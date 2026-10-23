import { mat4, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/**
 * An occluder volume: a box that hides whatever is behind it from the renderer's occlusion culling
 * (graphics/occlusion). Draws nothing and collides with nothing.
 *
 * ## Why an authored box rather than the mesh itself
 *
 * The occlusion test is only safe if every occluder sits INSIDE solid geometry: a box that pokes out of
 * a building's walls would cull things you can see past its corner. A model's own triangles are too many to
 * rasterize on the CPU every frame, its decimated LODs bulge outward as often as inward, and its bounding
 * box is the opposite of what is needed (it encloses the model, so it is everywhere the model is not). So
 * the inner volume is placed by hand, the way Umbra and Unity occluder volumes are: inside the walls of a
 * house, the trunk of a giant tree, the bulk of a cliff.
 *
 * The box is `size` (full extents, local units) centred on the node, under the node's full transform.
 * Landscapes need none — they occlude on their own (graphics/occlusion/terrainOccluder.ts).
 */
export class OccluderNode extends Node {
    private _size: [number, number, number];
    /** Off leaves it in the scene without it hiding anything. */
    public enabled: boolean = true;

    constructor(name: string, size: [number, number, number] = [1, 1, 1], id: string = uuidv4()) {
        super(name, 'occluder', id);
        this._size = [Math.max(0, size[0]), Math.max(0, size[1]), Math.max(0, size[2])];
    }

    public get size(): [number, number, number] { return this._size; }
    public set size(v: [number, number, number]) {
        this._size = [Math.max(0, +v[0] || 0), Math.max(0, +v[1] || 0), Math.max(0, +v[2] || 0)];
    }

    /** The box's local corners, for OcclusionBuffer.rasterizeBox under `worldTransform`. */
    public localBox(min: number[], max: number[]): void {
        for (let a = 0; a < 3; a++) { min[a] = -this._size[a] / 2; max[a] = this._size[a] / 2; }
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const min = vec3.fromValues(Infinity, Infinity, Infinity), max = vec3.fromValues(-Infinity, -Infinity, -Infinity);
        const m = this.worldTransform as mat4, c = vec3.create();
        for (let i = 0; i < 8; i++) {
            vec3.set(c, (i & 1 ? 0.5 : -0.5) * this._size[0], (i & 2 ? 0.5 : -0.5) * this._size[1], (i & 4 ? 0.5 : -0.5) * this._size[2]);
            vec3.transformMat4(c, c, m);
            vec3.min(min, min, c);
            vec3.max(max, max, c);
        }
        return { min, max };
    }

    protected _serializePayload(): any {
        return { occluder: { size: [...this._size], enabled: this.enabled } };
    }

    public static parse(parent: Node, json: any) {
        const o = json.occluder ?? {};
        const size = Array.isArray(o.size) && o.size.length >= 3 ? [+o.size[0], +o.size[1], +o.size[2]] as [number, number, number] : [1, 1, 1] as [number, number, number];
        const node = new OccluderNode(json.name, size, json.id);
        node.enabled = o.enabled !== false;
        Node.finishParse(node, parent, json);
    }
}

import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/**
 * A 2D trigger: a box, centred on the node, that tells scripts what comes into it and goes out of it --
 * 2D character bodies (CharacterBody2DNode) on a layer it looks for (`mask`), and, with `detectAreas`, other
 * areas. Both sides hear `onTriggerEnter(other)` / `onTriggerExit(other)`, as with 3D triggers. A pickup, a
 * checkpoint, a hazard, a hitbox on a sword swing, a hurtbox on an enemy.
 *
 * World-aligned whatever the node's rotation, but it follows the node, so a child of a character moves
 * with it; `offset` shifts it from the node, mirrored when the character faces left.
 */
export class Area2DNode extends Node {
    public size: [number, number] = [1, 1];
    /** Shifts the box from the node: (1, 0) puts it a unit in front of a character facing right. */
    public offset: [number, number] = [0, 0];
    /** The layer the area is on (bits), which another area must look for to see it. */
    public layer: number = 1;
    /** The layers it looks for (bits): bodies and areas on any of them come into it. */
    public mask: number = 1;
    /** Also see other areas (a hitbox seeing hurtboxes), not only bodies. */
    public detectAreas: boolean = false;
    /** Off: sees nothing and is seen by nothing; what was inside leaves. */
    public enabled: boolean = true;

    /** @internal What is inside it now, as the 2D physics last found. */
    public readonly touching: Set<Node> = new Set();

    constructor(name: string, size: [number, number] = [1, 1], id: string = uuidv4()) {
        super(name, 'area2D', id);
        this.size = [Math.max(0, size[0]), Math.max(0, size[1])];
    }

    /** The box in the world: [minX, minY, maxX, maxY]. Its offset mirrors when `mirror` (facing left). */
    public bounds(mirror: boolean = false, out: [number, number, number, number] = [0, 0, 0, 0]): [number, number, number, number] {
        const p = this.worldPosition;
        const cx = p[0] + (mirror ? -this.offset[0] : this.offset[0]), cy = p[1] + this.offset[1];
        out[0] = cx - this.size[0] / 2; out[1] = cy - this.size[1] / 2;
        out[2] = cx + this.size[0] / 2; out[3] = cy + this.size[1] / 2;
        return out;
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const b = this.bounds(), z = this.worldPosition[2];
        return { min: vec3.fromValues(b[0], b[1], z - 0.05), max: vec3.fromValues(b[2], b[3], z + 0.05) };
    }

    protected _serializePayload(): any {
        return {
            area2D: {
                size: [this.size[0], this.size[1]],
                ...(this.offset[0] !== 0 || this.offset[1] !== 0 ? { offset: [this.offset[0], this.offset[1]] } : {}),
                layer: this.layer, mask: this.mask,
                ...(this.detectAreas ? { detectAreas: true } : {}),
                ...(this.enabled ? {} : { enabled: false }),
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const d = json.area2D ?? {};
        const pair = (v: unknown, fallback: [number, number]): [number, number] =>
            Array.isArray(v) && v.length >= 2 ? [+v[0] || 0, +v[1] || 0] : fallback;
        const node = new Area2DNode(json.name, pair(d.size, [1, 1]), json.id);
        node.offset = pair(d.offset, [0, 0]);
        node.layer = (typeof d.layer === 'number' ? d.layer : 1) | 0;
        node.mask = (typeof d.mask === 'number' ? d.mask : 1) | 0;
        node.detectAreas = d.detectAreas === true;
        node.enabled = d.enabled !== false;
        Node.finishParse(node, parent, json);
    }
}

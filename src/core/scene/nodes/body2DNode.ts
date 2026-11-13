import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/** What a 2D collider is to a body: a solid block, or a platform stood on from above only. */
export type Body2DKind = 'solid' | 'oneWay';

/**
 * A box collider of the 2D world: a solid block or a one-way platform, centred on the node, that 2D
 * character bodies (CharacterBody2DNode) collide with like tiles. Move the node -- a script, a sequence --
 * and it is a moving platform: a body standing on it is carried along. World-aligned whatever the node's
 * rotation; `size` is the whole box.
 */
export class Body2DNode extends Node {
    public size: [number, number] = [2, 0.5];
    public kind: Body2DKind = 'solid';
    /** Off: nothing collides with it (a door that has opened). */
    public enabled: boolean = true;

    /** @internal Where it was at the last 2D physics step: its motion since carries what stands on it. */
    public lastX: number = NaN;
    public lastY: number = NaN;

    constructor(name: string, size: [number, number] = [2, 0.5], id: string = uuidv4()) {
        super(name, 'body2D', id);
        this.size = [Math.max(0, size[0]), Math.max(0, size[1])];
    }

    /** The box in the world: [minX, minY, maxX, maxY]. */
    public bounds(out: [number, number, number, number] = [0, 0, 0, 0]): [number, number, number, number] {
        const p = this.worldPosition;
        out[0] = p[0] - this.size[0] / 2; out[1] = p[1] - this.size[1] / 2;
        out[2] = p[0] + this.size[0] / 2; out[3] = p[1] + this.size[1] / 2;
        return out;
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const b = this.bounds(), z = this.worldPosition[2];
        return { min: vec3.fromValues(b[0], b[1], z - 0.05), max: vec3.fromValues(b[2], b[3], z + 0.05) };
    }

    protected _serializePayload(): any {
        return { body2D: { size: [this.size[0], this.size[1]], kind: this.kind, ...(this.enabled ? {} : { enabled: false }) } };
    }

    public static parse(parent: Node, json: any) {
        const d = json.body2D ?? {};
        const size: [number, number] = Array.isArray(d.size) && d.size.length >= 2 ? [+d.size[0] || 0, +d.size[1] || 0] : [2, 0.5];
        const node = new Body2DNode(json.name, size, json.id);
        node.kind = d.kind === 'oneWay' ? 'oneWay' : 'solid';
        node.enabled = d.enabled !== false;
        Node.finishParse(node, parent, json);
    }
}

import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/** What a 2D collider is to a body: a solid block, or a platform stood on from above only. */
export type Body2DKind = 'solid' | 'oneWay';

/**
 * A box collider of the 2D world: a solid block or a one-way platform, centred on the node, that 2D
 * character bodies (CharacterBody2DNode) collide with like tiles. World-aligned whatever the node's
 * rotation; `size` is the whole box. Everything under it moves with it.
 *
 * Mass 0 (the default): it stays where it is put. Move the node -- a script, a sequence -- and it is a
 * moving platform: a body standing on it is carried along.
 * Mass above 0: it falls (`gravityScale` times the 2D world's gravity) and lands on the tilemaps' solid
 * and one-way tiles and on other colliders, pushed by nothing but what a script gives its `velocity2D`.
 *
 * Its `layer` is the collision layer it is on, its `mask` the layers it collides with: two colliders collide
 * when each one's mask holds the other's layer. The layers are the project's, named once for its 2D and 3D
 * physics alike (src/physics/collisionLayers.ts); tilemaps are on Default (layer 1). A Trigger looking for its
 * layer sees it.
 */
export class Body2DNode extends Node {
    public size: [number, number] = [2, 0.5];
    public kind: Body2DKind = 'solid';
    /** Off: nothing collides with it (a door that has opened). */
    public enabled: boolean = true;
    /** 0: static or moved by hand. Above 0: falls and lands (see the class comment). */
    public mass: number = 0;
    /** How strongly the 2D world's gravity pulls it, when it has mass. */
    public gravityScale: number = 1;
    /** The collision layer it is on: one bit (layer 1, Default, is 1). */
    public layer: number = 1;
    /** The layers it collides with (bits); -1 = all. */
    public mask: number = -1;

    /** Its velocity, world units per second, while it has mass. A script may set it (a thrown crate). */
    public velocity2D: [number, number] = [0, 0];
    /** Whether it rested on something at the last 2D physics step. */
    public grounded: boolean = false;

    /** Whether it moves under gravity (it has mass). */
    public get isDynamic(): boolean { return this.mass > 0; }

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
        return { body2D: {
            size: [this.size[0], this.size[1]], kind: this.kind,
            ...(this.enabled ? {} : { enabled: false }),
            ...(this.mass > 0 ? { mass: this.mass } : {}),
            ...(this.gravityScale !== 1 ? { gravityScale: this.gravityScale } : {}),
            ...(this.layer !== 1 ? { layer: this.layer } : {}),
            ...(this.mask !== -1 ? { mask: this.mask } : {}),
        } };
    }

    public static parse(parent: Node, json: any) {
        const d = json.body2D ?? {};
        const size: [number, number] = Array.isArray(d.size) && d.size.length >= 2 ? [+d.size[0] || 0, +d.size[1] || 0] : [2, 0.5];
        const node = new Body2DNode(json.name, size, json.id);
        node.kind = d.kind === 'oneWay' ? 'oneWay' : 'solid';
        node.enabled = d.enabled !== false;
        const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
        node.mass = Math.max(0, num(d.mass, 0));
        node.gravityScale = num(d.gravityScale, 1);
        node.layer = Math.trunc(num(d.layer, 1));
        node.mask = Math.trunc(num(d.mask, -1));
        Node.finishParse(node, parent, json);
    }
}

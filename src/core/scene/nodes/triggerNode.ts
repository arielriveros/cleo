import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { ALL_LAYERS, type ColliderShape } from "./colliderNode";

/**
 * A trigger: a volume that tells scripts what comes into it and goes out of it, without being solid. A
 * pickup, a checkpoint, a hazard, a door's interaction zone, a hitbox on a sword swing, a hurtbox on an
 * enemy. `onTriggerEnter(other)` / `onTriggerExit(other)` fire on this node and on what came in.
 *
 * What it is depends on the scene it is in:
 * - **3D scene:** a sensor made of its `shapes` (as a Collider's, in its local units), seeing colliders
 *   whose layer its `mask` holds, and, with `detectTriggers`, other triggers; `continuous` sweeps it from
 *   last frame's pose so a fast one cannot skip a thin one.
 * - **2D scene:** a box `size` across, centred on the node and shifted by `offset` (mirrored when the 2D
 *   character it belongs to faces left), seeing 2D character bodies and 2D colliders on a layer its `mask`
 *   holds, and, with `detectTriggers`, other triggers. World-aligned whatever the node's rotation.
 *
 * Its own `layer` is what another trigger must look for to see it. Turn it off with `enabled`: what was
 * inside leaves.
 */
export class TriggerNode extends Node {
    /** 3D: the volume's shapes. */
    public shapes: ColliderShape[] = [];
    /** 2D: the box, whole width and height. */
    public size: [number, number] = [1, 1];
    /** 2D: shifts the box from the node: (1, 0) puts it a unit in front of a character facing right. */
    public offset: [number, number] = [0, 0];
    /** The layer it is on (bits), which another trigger must look for to see it. */
    public layer: number = 1;
    /** The layers it looks for (bits); -1 = all. */
    public mask: number = ALL_LAYERS;
    /** Also see other triggers (a hitbox seeing hurtboxes), not only colliders and bodies. */
    public detectTriggers: boolean = false;
    /** 3D: test the volume swept from last frame, so a fast mover cannot skip past a thin trigger. */
    public continuous: boolean = false;
    private _enabled: boolean = true;

    /** @internal 2D: what is inside it now, as the 2D physics last found. */
    public readonly touching: Set<Node> = new Set();

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'trigger', id);
        this.wantsPhysicsBuild = true;
    }

    /** Off: sees nothing and is seen by nothing; what was inside leaves. Switching costs nothing. */
    public get enabled(): boolean { return this._enabled; }
    public set enabled(value: boolean) {
        this._enabled = value;
        if (this._trigger) this._trigger.enabled = value;
    }

    /** 2D: the old Area 2D's name for {@link detectTriggers}. */
    public get detectAreas(): boolean { return this.detectTriggers; }
    public set detectAreas(value: boolean) { this.detectTriggers = value; }

    /** Whether it acts as a 2D trigger: it is in a 2D scene. */
    public get is2D(): boolean { return this.scene?.dimension === '2D'; }

    /** 2D: the box in the world, [minX, minY, maxX, maxY]. Its offset mirrors when `mirror` (facing left). */
    public bounds(mirror: boolean = false, out: [number, number, number, number] = [0, 0, 0, 0]): [number, number, number, number] {
        const p = this.worldPosition;
        const cx = p[0] + (mirror ? -this.offset[0] : this.offset[0]), cy = p[1] + this.offset[1];
        out[0] = cx - this.size[0] / 2; out[1] = cy - this.size[1] / 2;
        out[2] = cx + this.size[0] / 2; out[3] = cy + this.size[1] / 2;
        return out;
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        if (!this.is2D) return super.getBoundingBox();
        const b = this.bounds(), z = this.worldPosition[2];
        return { min: vec3.fromValues(b[0], b[1], z - 0.05), max: vec3.fromValues(b[2], b[3], z + 0.05) };
    }

    /**
     * @internal Build the 3D sensor from the fields, once, in a 3D scene that runs (see ColliderNode
     * .buildPhysics). A 2D scene's trigger is the 2D world's (World2D), and builds nothing here.
     */
    public buildPhysics(): void {
        this.wantsPhysicsBuild = false;
        if (this._trigger || this.is2D) return;
        const sensor = this.setTrigger({
            enabled: this.enabled, group: this.layer, mask: this.mask,
            detectTriggers: this.detectTriggers, continuous: this.continuous,
        });
        Node.attachShapes(this, this.shapes, sensor);
    }

    protected _afterParse(json: any): void {
        super._afterParse(json);
        if (this.scene && this.scene.spawnRulesEnabled !== false) this.buildPhysics();
    }

    protected _serializePayload(): any {
        return {
            sensor: {
                shapes: structuredClone(this.shapes),
                size: [this.size[0], this.size[1]],
                offset: [this.offset[0], this.offset[1]],
                layer: this.layer,
                mask: this.mask,
                detectTriggers: this.detectTriggers,
                continuous: this.continuous,
                enabled: this.enabled,
            },
        };
    }

    /** The trigger's settings from JSON (a Trigger node's `sensor` block, a legacy `trigger` or `area2D`). */
    public static readSettings(node: TriggerNode, d: any): void {
        if (!d || typeof d !== 'object') return;
        const pair = (v: unknown, fallback: [number, number]): [number, number] =>
            Array.isArray(v) && v.length >= 2 ? [+v[0] || 0, +v[1] || 0] : fallback;
        const int = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback);
        node.shapes = Array.isArray(d.shapes) ? structuredClone(d.shapes) : [];
        const size = pair(d.size, [1, 1]);
        node.size = [Math.max(0, size[0]), Math.max(0, size[1])];
        node.offset = pair(d.offset, [0, 0]);
        // `group` in a legacy 3D trigger.
        node.layer = int(d.layer ?? d.group, 1);
        node.mask = int(d.mask, ALL_LAYERS);
        node.detectTriggers = d.detectTriggers === true || d.detectAreas === true;
        node.continuous = d.continuous === true;
        node.enabled = d.enabled !== false;
    }

    public static parse(parent: Node, json: any) {
        const node = new TriggerNode(json.name, json.id);
        TriggerNode.readSettings(node, json.sensor);
        Node.finishParse(node, parent, json);
    }
}

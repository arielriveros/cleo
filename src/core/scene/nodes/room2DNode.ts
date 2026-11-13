import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/**
 * A room of a 2D world: a rectangle on the XY plane, centred on the node, that a 2D camera
 * (Camera2DNode) keeps its view inside while what it follows stands in it. A metroidvania's screens:
 * walk out of one and the camera slides into the next.
 *
 * The rectangle is world-aligned whatever the node's rotation and scale: `size` is the whole of it.
 * Rooms may touch and may overlap; where they overlap, the one the target entered first keeps it until
 * the target leaves it. Scripts hear the change as `onRoomEnter(room)` / `onRoomExit(room)` -- on the
 * followed node and on the room itself (with the followed node).
 */
export class Room2DNode extends Node {
    private _size: [number, number];
    /**
     * A free label for what the room belongs to: an area of the world ("Crypt"), for a map, an ambience or
     * a script to switch on. Not used by the engine.
     */
    public zone: string = '';

    constructor(name: string, size: [number, number] = [30, 17], id: string = uuidv4()) {
        super(name, 'room2D', id);
        this._size = sizeOf(size);
    }

    /** The rectangle's width and height, world units. */
    public get size(): [number, number] { return this._size; }
    public set size(v: [number, number]) { this._size = sizeOf(v); }

    /** The rectangle's world bounds: [minX, minY, maxX, maxY]. */
    public bounds(out: [number, number, number, number] = [0, 0, 0, 0]): [number, number, number, number] {
        const p = this.worldPosition;
        out[0] = p[0] - this._size[0] * 0.5; out[1] = p[1] - this._size[1] * 0.5;
        out[2] = p[0] + this._size[0] * 0.5; out[3] = p[1] + this._size[1] * 0.5;
        return out;
    }

    /** Whether the world point (x, y) is inside the rectangle (its edges included). */
    public contains(x: number, y: number): boolean {
        const p = this.worldPosition;
        return Math.abs(x - p[0]) <= this._size[0] * 0.5 && Math.abs(y - p[1]) <= this._size[1] * 0.5;
    }

    public getBoundingBox(): { min: vec3, max: vec3 } {
        const b = this.bounds();
        const z = this.worldPosition[2];
        return { min: vec3.fromValues(b[0], b[1], z - 0.05), max: vec3.fromValues(b[2], b[3], z + 0.05) };
    }

    /**
     * What a viewport click selects the room by: a small box at its top-left corner, where the editor
     * labels it. Never the whole rectangle, which holds everything the room is made of and would take
     * every click aimed at it. `Raycaster` asks for this hook by name.
     */
    public pickBox(): { min: vec3, max: vec3 } {
        const b = this.bounds();
        const z = this.worldPosition[2], h = Room2DNode.PICK_HALF_EXTENT;
        return { min: vec3.fromValues(b[0] - h, b[3] - h, z - h), max: vec3.fromValues(b[0] + h, b[3] + h, z + h) };
    }
    /** Half the pick box's edge, in world units. */
    public static readonly PICK_HALF_EXTENT = 0.5;

    protected _serializePayload(): any {
        return { room2D: { size: [this._size[0], this._size[1]], ...(this.zone ? { zone: this.zone } : {}) } };
    }

    public static parse(parent: Node, json: any) {
        const r = json.room2D ?? {};
        const node = new Room2DNode(json.name, r.size, json.id);
        node.zone = typeof r.zone === 'string' ? r.zone : '';
        Node.finishParse(node, parent, json);
    }
}

function sizeOf(v: unknown): [number, number] {
    const a = Array.isArray(v) ? v : [];
    const n = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, x) : d);
    return [n(a[0], 30), n(a[1], 17)];
}

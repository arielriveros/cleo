import { Tilemap } from "../../../graphics/tilemap/tilemap";
import type { Scene } from "../scene";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/**
 * 2D tile grid.
 */

export class TilemapNode extends Node {
    private _tilemap: Tilemap;

    constructor(name: string, tilemap: Tilemap, id: string = uuidv4()) {
        super(name, 'tilemap', id);
        this._tilemap = tilemap;
        this._tilemap.setOrigin(this.worldPosition);
    }

    public get tilemap(): Tilemap { return this._tilemap; }

    /** Swap in a different map while keeping this node and its transform. Frees the old one's resources. */
    public setTilemap(tilemap: Tilemap): void {
        this._tilemap.dispose();
        this._tilemap = tilemap;
        this._tilemap.setOrigin(this.worldPosition);
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        // Keep the map's origin on the node so painting, picking and collision all follow it.
        this._tilemap.setOrigin(this.worldPosition);
        this._tilemap.update(delta, time);
    }

    /**
     * World-space extent of everything painted.
     *
     * Syncs the map's origin first, because this is one of the two entry points that read the map in
     * WORLD space outside the per-frame update — and the editor never runs that update (Scene.update only
     * ticks nodes once the scene has started). The other is the tilemap brush's cell picking.
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        const p = this.worldPosition;
        this._tilemap.setOrigin(p);
        const b = this._tilemap.bounds();
        if (!b) {
            const e = Math.max(this._tilemap.grid.cellWidth, this._tilemap.grid.cellHeight);
            return {
                min: vec3.fromValues(p[0] - e, p[1] - e, p[2] - e),
                max: vec3.fromValues(p[0] + e, p[1] + e, p[2] + e),
            };
        }
        // cellToWorld is affine in (col,row) for square and isometric grids, so the four extreme cells
        // bound the whole map; hex adds at most a half-cell parity wobble, covered by the padding below.
        const hw = this._tilemap.grid.cellWidth / 2, hh = this._tilemap.grid.cellHeight / 2;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [c, r] of [[b.minCol, b.minRow], [b.maxCol, b.minRow], [b.minCol, b.maxRow], [b.maxCol, b.maxRow]]) {
            const [x, y] = this._tilemap.cellToWorld(c, r);
            minX = Math.min(minX, x - hw); maxX = Math.max(maxX, x + hw);
            minY = Math.min(minY, y - hh); maxY = Math.max(maxY, y + hh);
        }
        const depth = this._tilemap.collisionDepth;
        return {
            min: vec3.fromValues(minX, minY, p[2] - depth),
            max: vec3.fromValues(maxX, maxY, p[2] + depth),
        };
    }

    protected _serializePayload(): any {
        return { tilemap: this._tilemap.serialize() };
    }

    public static parse(parent: Node, json: any) {
        const node = new TilemapNode(json.name, Tilemap.deserialize(json.tilemap), json.id);
        Node.finishParse(node, parent, json);
    }
}

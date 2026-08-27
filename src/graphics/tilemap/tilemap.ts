// The tilemap data model: an unbounded stack of tile layers on the XY plane, plus the physics bodies
// derived from them. Nothing here touches WebGL — chunk meshes are built lazily by the renderer and
// only flagged stale from here, which keeps the model testable and worker-safe.

// Aliased because `Material` is not imported here but the physics one reads better named for what it is.
import { Body, Box, ConvexPolyhedron, Vec3, World, Material as PhysicsMaterial } from 'cannon-es';
import { vec3 } from 'gl-matrix';
import { Logger } from '../../core/logger';
import {
    GridSpec, cellCorners, cellToWorld, neighbours, normalizeGrid, worldToCell,
} from './cellMath';
import {
    CELL_EMPTY, CHUNK_SIZE, cellFlipX, cellFlipY, cellKey, cellRot90, cellTile, chunkCoord, chunkKey,
    packCell,
} from './chunk';
import { TilemapLayer, TilemapLayerConfig } from './tilemapLayer';
import { Tileset } from './tileset';
import { greedyMerge } from './tilemapCollision';
import { autoTileMask, cellNoise, pickWeightedVariant, resolveAutoTile } from './autotile';

/** One cell write, as recorded for undo. `before`/`after` are packed cell values. */
export interface TileEdit {
    layer: number;
    col: number;
    row: number;
    before: number;
    after: number;
    /** Present only when the write also changed the cell's tint override. */
    tintBefore?: number;
    tintAfter?: number;
}

/** Orientation applied to a placed tile. */
export interface TileOrientation {
    flipX?: boolean;
    flipY?: boolean;
    rot90?: boolean;
}

/** Ceiling on cells a single bucket fill may touch. The map is infinite; a mis-click must not be. */
export const DEFAULT_FILL_LIMIT = 100000;

/** How often the collider set may be rebuilt while painting, in milliseconds. */
const BODY_REBUILD_MS = 200;

export class Tilemap {
    private _grid: Required<GridSpec>;
    private _layers: TilemapLayer[] = [];
    /** Tilesets this map draws from, keyed by asset id. Embedded on serialize — see `serialize`. */
    private _tilesets: Map<string, Tileset> = new Map();

    /**
     * Index of the layer whose draw band SpriteNodes join, so characters Y-sort against that layer's
     * tiles and nothing else.
     */
    public entityLayer: number = 0;
    /** Half-extent along Z given to generated colliders, so a body on the XY plane actually hits them. */
    public collisionDepth: number = 0.5;

    private _origin: vec3 = vec3.create();
    private _world: World | null = null;
    private _physicsMaterial: PhysicsMaterial | null = null;
    private _bodies: Map<number, Body[]> = new Map();
    private _dirtyBodies: Set<number> = new Set();
    private _lastBodyBuild = 0;
    private _registered = false;
    private _disposed = false;

    private _editDepth = 0;
    private _recording: TileEdit[] | null = null;
    private _version = 0;
    private _time = 0;

    constructor(grid: GridSpec) {
        this._grid = normalizeGrid(grid);
    }

    // --- configuration ------------------------------------------------------------------------

    public get grid(): Required<GridSpec> { return this._grid; }

    /** Replace the grid layout. Cell indices are preserved; every mesh and collider is rebuilt. */
    public setGrid(grid: GridSpec): void {
        this._grid = normalizeGrid(grid);
        for (const layer of this._layers) layer.markAllMeshesDirty();
        this._markAllBodiesDirty();
        this._version++;
    }

    public get layers(): readonly TilemapLayer[] { return this._layers; }
    public get tilesets(): ReadonlyMap<string, Tileset> { return this._tilesets; }
    /** Bumped on every cell write. Editor panels poll it rather than diffing chunk contents. */
    public get version(): number { return this._version; }
    /** Seconds of playback, driving animated tiles. Advanced by `update`. */
    public get time(): number { return this._time; }
    public get editing(): boolean { return this._editDepth > 0; }

    public registerTileset(ts: Tileset): void {
        this._tilesets.set(ts.id, ts);
        for (const layer of this._layers) if (layer.cfg.tilesetId === ts.id) layer.markAllMeshesDirty();
        this._markAllBodiesDirty();
        this._version++;
    }

    public tilesetById(id: string | null | undefined): Tileset | null {
        return id ? this._tilesets.get(id) ?? null : null;
    }

    public tilesetOf(layerIndex: number): Tileset | null {
        return this.tilesetById(this._layers[layerIndex]?.cfg.tilesetId);
    }

    public addLayer(cfg?: Partial<TilemapLayerConfig>): TilemapLayer {
        const layer = new TilemapLayer({ name: `Layer ${this._layers.length + 1}`, order: this._layers.length, ...cfg });
        this._layers.push(layer);
        this._version++;
        return layer;
    }

    public removeLayer(index: number): void {
        const layer = this._layers[index];
        if (!layer) return;
        for (const chunk of layer.chunks.values()) {
            chunk.mesh?.dispose();
            chunk.mesh = null;
            this._dirtyBodies.add(chunkKey(chunk.cx, chunk.cy));
        }
        this._layers.splice(index, 1);
        if (this.entityLayer >= this._layers.length) this.entityLayer = Math.max(0, this._layers.length - 1);
        this._version++;
    }

    public moveLayer(from: number, to: number): void {
        if (from === to) return;
        const layer = this._layers[from];
        if (!layer || to < 0 || to >= this._layers.length) return;
        this._layers.splice(from, 1);
        this._layers.splice(to, 0, layer);
        this._version++;
    }

    // --- coordinates --------------------------------------------------------------------------

    /**
     * Move the map's origin. Rotation and scale are IGNORED, as `Terrain` ignores them — the collider
     * and picking math would have to invert an arbitrary transform per cell.
     */
    public setOrigin(p: vec3): void {
        if (p[0] === this._origin[0] && p[1] === this._origin[1] && p[2] === this._origin[2]) return;
        vec3.copy(this._origin, p);
        this._markAllBodiesDirty();
    }

    public get origin(): vec3 { return this._origin; }

    /** World-space centre of a cell. */
    public cellToWorld(col: number, row: number): [number, number] {
        const p = cellToWorld(this._grid, col, row);
        return [p[0] + this._origin[0], p[1] + this._origin[1]];
    }

    /** Cell containing a world-space point. Always succeeds — the grid is infinite. */
    public worldToCell(x: number, y: number): [number, number] {
        return worldToCell(this._grid, x - this._origin[0], y - this._origin[1]);
    }

    // --- reads --------------------------------------------------------------------------------

    /** The tile at a cell, or null when it is empty or the layer does not exist. */
    public getTile(layer: number, col: number, row: number):
        { tileIndex: number; flipX: boolean; flipY: boolean; rot90: boolean } | null {
        const l = this._layers[layer];
        if (!l) return null;
        const packed = l.get(col, row);
        const index = cellTile(packed);
        if (index < 0) return null;
        return { tileIndex: index, flipX: cellFlipX(packed), flipY: cellFlipY(packed), rot90: cellRot90(packed) };
    }

    /** Raw packed cell — the form the undo diff and the mesh builder use. */
    public getPacked(layer: number, col: number, row: number): number {
        return this._layers[layer]?.get(col, row) ?? CELL_EMPTY;
    }

    /**
     * Whether anything at this cell blocks movement: a tile its tileset marks solid, or any tile on a
     * collision layer. Parallaxed layers never count — their art is drawn at a camera-dependent offset.
     */
    public isSolid(col: number, row: number): boolean {
        for (let i = 0; i < this._layers.length; i++) {
            const layer = this._layers[i];
            if (!this._layerCollides(layer)) continue;
            const index = cellTile(layer.get(col, row));
            if (index < 0) continue;
            if (layer.cfg.collision) return true;
            if (this.tilesetOf(i)?.isSolid(index)) return true;
        }
        return false;
    }

    public solidAtWorld(x: number, y: number): boolean {
        const [col, row] = this.worldToCell(x, y);
        return this.isSolid(col, row);
    }

    private _layerCollides(layer: TilemapLayer): boolean {
        return layer.cfg.parallax[0] === 1 && layer.cfg.parallax[1] === 1;
    }

    // --- writes -------------------------------------------------------------------------------

    public setTile(layer: number, col: number, row: number, tileIndex: number, orient?: TileOrientation): void {
        this._write(layer, col, row, packCell(tileIndex, orient?.flipX, orient?.flipY, orient?.rot90));
    }

    public eraseTile(layer: number, col: number, row: number): void {
        this._write(layer, col, row, CELL_EMPTY);
    }

    /** Write a raw packed value. The path undo replays through. */
    public setPacked(layer: number, col: number, row: number, packed: number): void {
        this._write(layer, col, row, packed);
    }

    /** Per-cell colour override as packed RGBA8; 0 restores the tile's own tint. */
    public setTint(layer: number, col: number, row: number, rgba: number): void {
        const l = this._layers[layer];
        if (!l) return;
        const before = l.setTint(col, row, rgba);
        if (before === rgba) return;
        if (this._recording) {
            const packed = l.get(col, row);
            this._recording.push({ layer, col, row, before: packed, after: packed, tintBefore: before, tintAfter: rgba });
        }
        this._version++;
    }

    private _write(layer: number, col: number, row: number, packed: number): void {
        const l = this._layers[layer];
        if (!l) return;
        const before = l.set(col, row, packed);
        if (before === packed) return;
        if (this._recording) this._recording.push({ layer, col, row, before, after: packed });
        if (this._layerCollides(l)) this._dirtyBodies.add(chunkKey(chunkCoord(col), chunkCoord(row)));
        this._version++;
    }

    /** Inclusive rectangle fill. `tileIndex < 0` erases. */
    public fillRect(layer: number, c0: number, r0: number, c1: number, r1: number,
                    tileIndex: number, orient?: TileOrientation): void {
        const minC = Math.min(c0, c1), maxC = Math.max(c0, c1);
        const minR = Math.min(r0, r1), maxR = Math.max(r0, r1);
        const packed = tileIndex < 0 ? CELL_EMPTY : packCell(tileIndex, orient?.flipX, orient?.flipY, orient?.rot90);
        this.beginEdit();
        for (let r = minR; r <= maxR; r++)
            for (let c = minC; c <= maxC; c++) this._write(layer, c, r, packed);
        this.endEdit();
    }

    /**
     * Flood fill the contiguous region matching the cell under (col, row). `limit` is required: the grid
     * has no edges, so filling from an empty cell would allocate chunks outward forever.
     */
    public bucketFill(layer: number, col: number, row: number, tileIndex: number,
                      orient?: TileOrientation, limit: number = DEFAULT_FILL_LIMIT): void {
        const l = this._layers[layer];
        if (!l) return;
        const target = cellTile(l.get(col, row));
        const packed = tileIndex < 0 ? CELL_EMPTY : packCell(tileIndex, orient?.flipX, orient?.flipY, orient?.rot90);
        if (cellTile(packed) === target) return;

        this.beginEdit();
        const seen = new Set<number>();
        const queue: [number, number][] = [[col, row]];
        seen.add(cellKey(col, row));
        let filled = 0;
        let clipped = false;
        while (queue.length > 0) {
            if (filled >= limit) { clipped = true; break; }
            const [c, r] = queue.pop()!;
            if (cellTile(l.get(c, r)) !== target) continue;
            this._write(layer, c, r, packed);
            filled++;
            for (const [nc, nr] of this._edgeNeighbours(c, r)) {
                const key = cellKey(nc, nr);
                if (seen.has(key)) continue;
                seen.add(key);
                if (cellTile(l.get(nc, nr)) === target) queue.push([nc, nr]);
            }
        }
        this.endEdit();
        if (clipped) Logger.warn(`Bucket fill stopped at ${limit} cells.`, 'Tilemap');
    }

    /** Edge-adjacent cells only (4 on square/isometric grids, 6 on hexagonal ones). */
    private _edgeNeighbours(col: number, row: number): [number, number][] {
        const ring = neighbours(this._grid, col, row);
        return ring.length === 6 ? ring : ring.filter((_, i) => i % 2 === 0);
    }

    /**
     * Place a terrain tile and re-resolve it and its neighbours against the terrain set's rules, so the
     * edges and corners join up on their own. A no-op when the layer's tileset has no such set.
     */
    public applyAutoTile(layer: number, col: number, row: number, terrainId: number): void {
        const tileset = this.tilesetOf(layer);
        const set = tileset?.terrainSet(terrainId);
        if (!tileset || !set) return;

        const seed = firstTileOf(set.tiles);
        if (seed < 0) return;

        const belongs = (c: number, r: number): boolean => {
            const index = cellTile(this.getPacked(layer, c, r));
            return index >= 0 && tileset.metaOf(index)?.terrain?.id === terrainId;
        };
        const resolve = (c: number, r: number): void => {
            const same = neighbours(this._grid, c, r).map(([nc, nr]) => belongs(nc, nr));
            const tile = resolveAutoTile(set, autoTileMask(set.kind, same), () => cellNoise(c, r, terrainId));
            if (tile >= 0) this._write(layer, c, r, packCell(tile));
        };

        this.beginEdit();
        this._write(layer, col, row, packCell(seed));
        resolve(col, row);
        for (const [nc, nr] of neighbours(this._grid, col, row)) if (belongs(nc, nr)) resolve(nc, nr);
        this.endEdit();
    }

    /** Paint a cell with a randomly chosen member of a variant set, stable for that cell. */
    public applyVariant(layer: number, col: number, row: number, variantSetId: number, orient?: TileOrientation): void {
        const set = this.tilesetOf(layer)?.variantSet(variantSetId);
        if (!set || set.tiles.length === 0) return;
        const tile = pickWeightedVariant(set, () => cellNoise(col, row, variantSetId));
        if (tile >= 0) this.setTile(layer, col, row, tile, orient);
    }

    // --- batching and undo --------------------------------------------------------------------

    /** Bracket a group of writes. RE-ENTRANT: only the outermost `endEdit` rebuilds colliders. */
    public beginEdit(): void { this._editDepth++; }

    public endEdit(): void {
        if (this._editDepth > 0) this._editDepth--;
        // Colliders are rebuilt from the dirty set on the next physics step, not here: physics only runs
        // in play mode, so an authoring stroke must never pay for it.
    }

    /**
     * Run `fn`, collecting every cell it changes as a replayable diff. Nested calls collect into the
     * innermost recorder only.
     */
    public recordEdits<T>(fn: () => T): { result: T; edits: TileEdit[] } {
        const outer = this._recording;
        const edits: TileEdit[] = [];
        this._recording = edits;
        this.beginEdit();
        try {
            const result = fn();
            return { result, edits };
        } finally {
            this.endEdit();
            this._recording = outer;
        }
    }

    /** Replay a diff. `undo` reverses it. Never records itself. */
    public applyEdits(edits: TileEdit[], undo: boolean): void {
        const outer = this._recording;
        this._recording = null;
        this.beginEdit();
        const ordered = undo ? [...edits].reverse() : edits;
        for (const e of ordered) {
            this._write(e.layer, e.col, e.row, undo ? e.before : e.after);
            if (e.tintBefore !== undefined || e.tintAfter !== undefined) {
                const l = this._layers[e.layer];
                l?.setTint(e.col, e.row, (undo ? e.tintBefore : e.tintAfter) ?? 0);
            }
        }
        this.endEdit();
        this._recording = outer;
    }

    // --- per-frame ----------------------------------------------------------------------------

    /** Advances animation time. The renderer reads `time` to resolve animated tiles' current frames. */
    public update(delta: number, _time: number): void {
        this._time += delta;
    }

    /** Every chunk coordinate any layer has allocated, as chunk keys. */
    public chunkKeys(): Set<number> {
        const keys = new Set<number>();
        for (const layer of this._layers)
            for (const chunk of layer.chunks.values()) keys.add(chunkKey(chunk.cx, chunk.cy));
        return keys;
    }

    /** Cell-space extent of everything painted, or null for an empty map. */
    public bounds(): { minCol: number; minRow: number; maxCol: number; maxRow: number } | null {
        let out: { minCol: number; minRow: number; maxCol: number; maxRow: number } | null = null;
        for (const layer of this._layers) {
            const b = layer.bounds();
            if (!b) continue;
            if (!out) out = { ...b };
            else {
                out.minCol = Math.min(out.minCol, b.minCol);
                out.minRow = Math.min(out.minRow, b.minRow);
                out.maxCol = Math.max(out.maxCol, b.maxCol);
                out.maxRow = Math.max(out.maxRow, b.maxRow);
            }
        }
        return out;
    }

    // --- physics ------------------------------------------------------------------------------

    private _markAllBodiesDirty(): void {
        for (const key of this.chunkKeys()) this._dirtyBodies.add(key);
        for (const key of this._bodies.keys()) this._dirtyBodies.add(key);
    }

    /**
     * Create or refresh the static colliders and keep them registered with the world. `material` is
     * required even with no friction settings: cannon honours a ContactMaterial only when BOTH bodies carry one.
     */
    public ensureRegistered(world: World, material?: PhysicsMaterial): void {
        if (this._disposed) return;
        this._world = world;
        if (material) this._physicsMaterial = material;

        if (!this._registered) {
            this._registered = true;
            this._markAllBodiesDirty();
            this._rebuildDirtyBodies();
            return;
        }
        // Re-add anything a world reset dropped.
        for (const bodies of this._bodies.values())
            for (const body of bodies) if (world.bodies.indexOf(body) === -1) world.addBody(body);

        // Throttled so a continuous paint drag in play mode can't rebuild colliders every frame.
        if (this._dirtyBodies.size > 0 && Date.now() - this._lastBodyBuild > BODY_REBUILD_MS)
            this._rebuildDirtyBodies();
    }

    /** Static bodies currently in the world for this tilemap. Surfaced in the physics HUD. */
    public get colliderCount(): number {
        let n = 0;
        for (const bodies of this._bodies.values()) n += bodies.length;
        return n;
    }

    private _rebuildDirtyBodies(): void {
        const world = this._world;
        if (!world) return;
        for (const key of this._dirtyBodies) {
            const existing = this._bodies.get(key);
            if (existing) { for (const b of existing) world.removeBody(b); this._bodies.delete(key); }
            const built = this._buildChunkBodies(key);
            if (built.length > 0) {
                this._bodies.set(key, built);
                for (const b of built) world.addBody(b);
            }
        }
        this._dirtyBodies.clear();
        this._lastBodyBuild = Date.now();
    }

    /** Solid bitmap for one chunk, plus the cells whose tiles declare a custom outline. */
    private _chunkSolids(cx: number, cy: number): { solid: Uint8Array; shaped: { col: number; row: number; shape: number[] }[] } {
        const solid = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
        const shaped: { col: number; row: number; shape: number[] }[] = [];
        for (let i = 0; i < this._layers.length; i++) {
            const layer = this._layers[i];
            if (!this._layerCollides(layer)) continue;
            const chunk = layer.chunkAt(cx, cy, false);
            if (!chunk || chunk.count === 0) continue;
            const tileset = this.tilesetOf(i);
            if (!tileset && !layer.cfg.collision) continue;

            for (let lr = 0; lr < CHUNK_SIZE; lr++) {
                for (let lc = 0; lc < CHUNK_SIZE; lc++) {
                    const li = lr * CHUNK_SIZE + lc;
                    if (solid[li]) continue;
                    const packed = chunk.cells[li];
                    const index = cellTile(packed);
                    if (index < 0) continue;
                    const meta = tileset?.metaOf(index);
                    if (!layer.cfg.collision && !meta?.solid) continue;
                    if (meta?.shape && meta.shape.length >= 6) {
                        shaped.push({
                            col: cx * CHUNK_SIZE + lc,
                            row: cy * CHUNK_SIZE + lr,
                            shape: orientShape(meta.shape, packed),
                        });
                        continue;
                    }
                    solid[li] = 1;
                }
            }
        }
        return { solid, shaped };
    }

    // Bodies for one chunk. Square grids greedy-merge into boxes; isometric and hexagonal ones emit one
    // convex prism per solid cell, since merging those needs outline extraction and decomposition.
    private _buildChunkBodies(key: number): Body[] {
        const cx = Math.floor(key / 0x10000) - 0x8000;
        const cy = (key % 0x10000) - 0x8000;
        const { solid, shaped } = this._chunkSolids(cx, cy);
        const bodies: Body[] = [];
        const mat = this._physicsMaterial ?? undefined;
        const depth = Math.max(0.01, this.collisionDepth);
        const g = this._grid;

        if (g.kind === 'orthogonal') {
            for (const box of greedyMerge(solid, CHUNK_SIZE, CHUNK_SIZE)) {
                const c0 = cx * CHUNK_SIZE + box.c0, c1 = cx * CHUNK_SIZE + box.c1;
                const r0 = cy * CHUNK_SIZE + box.r0, r1 = cy * CHUNK_SIZE + box.r1;
                const x0 = c0 * g.cellWidth, x1 = (c1 + 1) * g.cellWidth;
                const y0 = -(r1 + 1) * g.cellHeight, y1 = -r0 * g.cellHeight;
                const body = new Body({ mass: 0, material: mat });
                body.addShape(new Box(new Vec3((x1 - x0) / 2, (y1 - y0) / 2, depth)));
                body.position.set(
                    this._origin[0] + (x0 + x1) / 2,
                    this._origin[1] + (y0 + y1) / 2,
                    this._origin[2],
                );
                bodies.push(body);
            }
        } else {
            for (let lr = 0; lr < CHUNK_SIZE; lr++) {
                for (let lc = 0; lc < CHUNK_SIZE; lc++) {
                    if (!solid[lr * CHUNK_SIZE + lc]) continue;
                    const body = this._prismBody(cx * CHUNK_SIZE + lc, cy * CHUNK_SIZE + lr, null, depth, mat);
                    if (body) bodies.push(body);
                }
            }
        }

        for (const s of shaped) {
            const body = this._prismBody(s.col, s.row, s.shape, depth, mat);
            if (body) bodies.push(body);
        }
        return bodies;
    }

    // A static convex prism for one cell, its footprint extruded along Z. Built around the cell's
    // CENTRE with the body carrying the offset — cannon validates face planes against the origin.
    private _prismBody(col: number, row: number, shape: number[] | null, depth: number,
                       mat: PhysicsMaterial | undefined): Body | null {
        const centre = cellToWorld(this._grid, col, row);
        let poly: number[];
        if (shape) {
            // Tile-local 0..1 with the origin at the cell's bottom-left, relative to the cell centre.
            poly = [];
            for (let i = 0; i + 1 < shape.length; i += 2) {
                poly.push((shape[i] - 0.5) * this._grid.cellWidth, (shape[i + 1] - 0.5) * this._grid.cellHeight);
            }
        } else {
            const corners = cellCorners(this._grid, col, row);
            poly = [];
            for (let i = 0; i + 1 < corners.length; i += 2) poly.push(corners[i] - centre[0], corners[i + 1] - centre[1]);
        }
        const n = poly.length / 2;
        if (n < 3) return null;

        const vertices: Vec3[] = [];
        for (let i = 0; i < n; i++) vertices.push(new Vec3(poly[i * 2], poly[i * 2 + 1], depth));
        for (let i = 0; i < n; i++) vertices.push(new Vec3(poly[i * 2], poly[i * 2 + 1], -depth));

        const faces: number[][] = [];
        faces.push(Array.from({ length: n }, (_, i) => i));                  // front, CCW from +Z
        faces.push(Array.from({ length: n }, (_, i) => 2 * n - 1 - i));      // back, CCW from -Z
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            faces.push([i, n + i, n + j, j]);
        }

        try {
            const body = new Body({ mass: 0, material: mat });
            body.addShape(new ConvexPolyhedron({ vertices, faces }));
            body.position.set(this._origin[0] + centre[0], this._origin[1] + centre[1], this._origin[2]);
            return body;
        } catch (e) {
            Logger.error((e as Error).toString(), 'Tilemap');
            return null;
        }
    }

    /** Release every GPU and physics resource. Idempotent — PhysicsSystem may call it repeatedly. */
    public dispose(world?: World): void {
        if (this._disposed) return;
        this._disposed = true;
        const w = world || this._world;
        for (const bodies of this._bodies.values())
            for (const body of bodies) { if (w) w.removeBody(body); }
        this._bodies.clear();
        this._dirtyBodies.clear();
        for (const layer of this._layers)
            for (const chunk of layer.chunks.values()) { chunk.mesh?.dispose(); chunk.mesh = null; }
        this._world = null;
        this._registered = false;
    }

    // --- serialization ------------------------------------------------------------------------

    /**
     * Flatten to JSON, EMBEDDING every referenced tileset in full — `deserialize` then needs no asset
     * library in scope. The editor re-embeds after a tileset is edited.
     */
    public serialize(): any {
        const used = new Set<string>();
        for (const layer of this._layers) if (layer.cfg.tilesetId) used.add(layer.cfg.tilesetId);
        const tilesets: any[] = [];
        for (const id of used) {
            const ts = this._tilesets.get(id);
            if (ts) tilesets.push(ts.serialize());
        }
        return {
            grid: { ...this._grid },
            entityLayer: this.entityLayer,
            collisionDepth: this.collisionDepth,
            layers: this._layers.map(l => l.serialize()),
            tilesets,
        };
    }

    public static deserialize(json: any): Tilemap {
        const tm = new Tilemap(json?.grid ?? { kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
        tm.entityLayer = json?.entityLayer ?? 0;
        tm.collisionDepth = json?.collisionDepth ?? 0.5;
        for (const tj of json?.tilesets ?? []) {
            const ts = Tileset.parse(tj);
            if (ts.id) tm._tilesets.set(ts.id, ts);
        }
        for (const lj of json?.layers ?? []) tm._layers.push(TilemapLayer.parse(lj));
        if (tm._layers.length === 0) tm.addLayer();
        if (tm.entityLayer >= tm._layers.length) tm.entityLayer = tm._layers.length - 1;
        return tm;
    }
}

/** First tile mentioned by any rule of a terrain set, or -1 when it has none. */
function firstTileOf(tiles: Record<number, number[]>): number {
    for (const key of Object.keys(tiles)) {
        const list = tiles[key as unknown as number];
        if (list && list.length > 0) return list[0];
    }
    return -1;
}

// Apply a placed cell's orientation bits to a tile-local collider outline. The order must match the
// tilemap shader's UV transform — diagonal first, then the two mirrors.
function orientShape(shape: number[], packed: number): number[] {
    const rot = cellRot90(packed), fx = cellFlipX(packed), fy = cellFlipY(packed);
    if (!rot && !fx && !fy) return shape;
    const out = new Array<number>(shape.length);
    for (let i = 0; i + 1 < shape.length; i += 2) {
        let x = shape[i], y = shape[i + 1];
        if (rot) { const t = x; x = y; y = t; }
        if (fx) x = 1 - x;
        if (fy) y = 1 - y;
        out[i] = x; out[i + 1] = y;
    }
    return out;
}

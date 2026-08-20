// The runtime half of a tileset: an atlas image sliced into a grid of tiles, plus whatever per-tile
// metadata authoring attached to them (solidity, animation, depth anchoring, tint, auto-tile rules).
//
// The editor's `.tileset` asset is a superset of this — it also carries a name, a thumbnail and the
// bookkeeping the asset explorer needs — and a TilemapNode embeds a full copy of every tileset its
// layers reference when it serializes. That embedding is deliberate: it means `Tilemap.deserialize`
// never needs an asset library in scope, so the published player, templates, bundle import and runtime
// `Scene.instantiate` all work with no extra plumbing.

/** A tile that cycles through other tiles' images. `frames` are tile indices into the same tileset. */
export interface TileAnimation {
    frames: number[];
    fps: number;
}

/** Which family of auto-tiling rules a terrain set uses. */
export type WangKind = 'edge' | 'corner' | 'blob';

/**
 * Everything authoring can attach to one tile of the atlas. Every field is optional: the overwhelmingly
 * common tile is a plain opaque square with no metadata at all, and a sparse record keeps both the
 * asset and the embedded copy small.
 */
export interface TileMeta {
    /** Contributes a collider when placed on a collision-bearing layer. */
    solid?: boolean;
    /**
     * Collider outline in tile-local space (0..1, origin at the cell's bottom-left), as flat xy pairs.
     * Absent means "the whole cell", which is also what lets the merger fold the tile into a big box —
     * a custom shape opts the cell out of merging and gets its own convex prism.
     */
    shape?: number[];
    /** World-space nudge applied to this tile's Y-sort key. The manual override when anchoring is wrong. */
    zBias?: number;
    /**
     * Row offset within the tile's own footprint that the whole tile sorts at. A two-cell-tall tree
     * drawn from its top cell sets 1, so both of its cells sort at the trunk's row.
     */
    anchorRow?: number;
    /** Footprint in cells, for multi-cell props. Defaults to 1x1. */
    spanX?: number;
    spanY?: number;
    /** Multiplied into the tile's colour wherever it is placed, unless a cell overrides it. */
    tint?: [number, number, number];
    opacity?: number;
    animation?: TileAnimation;
    /** Auto-tile membership: which terrain set this tile belongs to and which edge/corner mask it fills. */
    terrain?: { id: number; mask: number };
    /** Relative likelihood when the randomize brush picks from `variantGroup`. */
    weight?: number;
    variantGroup?: number;
}

/** A set of tiles that auto-tile against each other. `tiles` maps an edge/corner mask to candidates. */
export interface TerrainSet {
    id: number;
    name: string;
    kind: WangKind;
    tiles: Record<number, number[]>;
}

/** A bag of interchangeable tiles the randomize brush draws from. */
export interface VariantSet {
    id: number;
    name: string;
    tiles: { index: number; weight: number }[];
}

export interface TilesetConfig {
    id: string;
    /** TextureManager id of the atlas image. Also its filename — texture ids are never renamed. */
    textureId: string;
    imageWidth: number;
    imageHeight: number;
    tileWidth: number;
    tileHeight: number;
    /** Border around the whole atlas, in pixels. */
    margin?: number;
    /** Gap between adjacent tiles, in pixels. */
    spacing?: number;
    /**
     * Grid dimensions. Stored rather than derived: deriving them needs the decoded image, which the
     * published player does not have when it parses a scene. The editor computes them once at import
     * (it has the HTMLImageElement) and bakes them in — the same reason AnimatedSpriteNode stores its
     * own columns/rows instead of measuring the sheet.
     */
    columns: number;
    rows: number;
}

export class Tileset {
    private readonly _id: string;
    private readonly _textureId: string;
    private readonly _imageWidth: number;
    private readonly _imageHeight: number;
    private readonly _tileWidth: number;
    private readonly _tileHeight: number;
    private readonly _margin: number;
    private readonly _spacing: number;
    private readonly _columns: number;
    private readonly _rows: number;
    private _meta: Map<number, TileMeta> = new Map();
    private _terrains: TerrainSet[] = [];
    private _variants: VariantSet[] = [];

    constructor(cfg: TilesetConfig) {
        this._id = cfg.id;
        this._textureId = cfg.textureId;
        this._imageWidth = Math.max(1, cfg.imageWidth);
        this._imageHeight = Math.max(1, cfg.imageHeight);
        this._tileWidth = Math.max(1, cfg.tileWidth);
        this._tileHeight = Math.max(1, cfg.tileHeight);
        this._margin = Math.max(0, cfg.margin ?? 0);
        this._spacing = Math.max(0, cfg.spacing ?? 0);
        this._columns = Math.max(1, cfg.columns);
        this._rows = Math.max(1, cfg.rows);
    }

    public get id(): string { return this._id; }
    public get textureId(): string { return this._textureId; }
    public get columns(): number { return this._columns; }
    public get rows(): number { return this._rows; }
    public get tileWidth(): number { return this._tileWidth; }
    public get tileHeight(): number { return this._tileHeight; }
    public get imageWidth(): number { return this._imageWidth; }
    public get imageHeight(): number { return this._imageHeight; }
    public get margin(): number { return this._margin; }
    public get spacing(): number { return this._spacing; }
    public get tileCount(): number { return this._columns * this._rows; }
    public get terrains(): TerrainSet[] { return this._terrains; }
    public get variantSets(): VariantSet[] { return this._variants; }
    /** Every tile that carries metadata, as [index, meta] pairs. */
    public get metaEntries(): IterableIterator<[number, TileMeta]> { return this._meta.entries(); }

    /**
     * Texture-space rect of `tileIndex` as [u0, v0, u1, v1] = [left, bottom, right, top].
     *
     * Tile 0 is the atlas's TOP-LEFT cell and indices run left-to-right then down, which is what an
     * artist means by "the third tile". The V flip is because textures upload with UNPACK_FLIP_Y set,
     * so texture v = 0 is the image's bottom edge, not its top.
     */
    public uvOf(tileIndex: number, out?: Float32Array): Float32Array {
        const o = out && out.length >= 4 ? out : new Float32Array(4);
        const i = Math.max(0, Math.min(tileIndex, this.tileCount - 1));
        const col = i % this._columns;
        const row = Math.floor(i / this._columns);
        const px = this._margin + col * (this._tileWidth + this._spacing);
        const py = this._margin + row * (this._tileHeight + this._spacing);
        o[0] = px / this._imageWidth;
        o[1] = 1 - (py + this._tileHeight) / this._imageHeight;
        o[2] = (px + this._tileWidth) / this._imageWidth;
        o[3] = 1 - py / this._imageHeight;
        return o;
    }

    public metaOf(tileIndex: number): TileMeta | undefined { return this._meta.get(tileIndex); }

    public setMeta(tileIndex: number, meta: TileMeta | undefined): void {
        if (!meta || Object.keys(meta).length === 0) this._meta.delete(tileIndex);
        else this._meta.set(tileIndex, meta);
    }

    public isAnimated(tileIndex: number): boolean {
        const a = this._meta.get(tileIndex)?.animation;
        return !!a && a.frames.length > 1;
    }

    /** True when ANY tile in this set animates — lets a chunk skip the per-frame scan entirely. */
    public get hasAnimation(): boolean {
        for (const m of this._meta.values()) if (m.animation && m.animation.frames.length > 1) return true;
        return false;
    }

    /** Which tile's image `tileIndex` shows at `time` seconds. Non-animated tiles return themselves. */
    public frameOf(tileIndex: number, time: number): number {
        const a = this._meta.get(tileIndex)?.animation;
        if (!a || a.frames.length === 0) return tileIndex;
        if (a.frames.length === 1) return a.frames[0];
        const fps = a.fps > 0 ? a.fps : 1;
        const n = a.frames.length;
        // Modulo twice: the first can still be negative for a negative time.
        const step = ((Math.floor(time * fps) % n) + n) % n;
        return a.frames[step];
    }

    public isSolid(tileIndex: number): boolean { return this._meta.get(tileIndex)?.solid === true; }

    public terrainSet(id: number): TerrainSet | undefined { return this._terrains.find(t => t.id === id); }
    public variantSet(id: number): VariantSet | undefined { return this._variants.find(v => v.id === id); }

    public serialize(): any {
        const tiles: Record<number, TileMeta> = {};
        for (const [index, meta] of this._meta) tiles[index] = meta;
        return {
            id: this._id,
            textureId: this._textureId,
            imageWidth: this._imageWidth,
            imageHeight: this._imageHeight,
            tileWidth: this._tileWidth,
            tileHeight: this._tileHeight,
            margin: this._margin,
            spacing: this._spacing,
            columns: this._columns,
            rows: this._rows,
            tiles,
            terrains: this._terrains.map(t => ({ ...t, tiles: { ...t.tiles } })),
            variantSets: this._variants.map(v => ({ ...v, tiles: v.tiles.map(t => ({ ...t })) })),
        };
    }

    public static parse(json: any): Tileset {
        const ts = new Tileset({
            id: json?.id ?? '',
            textureId: json?.textureId ?? '',
            imageWidth: json?.imageWidth ?? 1,
            imageHeight: json?.imageHeight ?? 1,
            tileWidth: json?.tileWidth ?? 1,
            tileHeight: json?.tileHeight ?? 1,
            margin: json?.margin ?? 0,
            spacing: json?.spacing ?? 0,
            columns: json?.columns ?? 1,
            rows: json?.rows ?? 1,
        });
        for (const key of Object.keys(json?.tiles ?? {})) {
            const idx = Number(key);
            if (Number.isFinite(idx)) ts._meta.set(idx, json.tiles[key]);
        }
        if (Array.isArray(json?.terrains)) ts._terrains = json.terrains.map((t: any) => ({
            id: t.id ?? 0, name: t.name ?? '', kind: (t.kind ?? 'blob') as WangKind, tiles: { ...(t.tiles ?? {}) },
        }));
        if (Array.isArray(json?.variantSets)) ts._variants = json.variantSets.map((v: any) => ({
            id: v.id ?? 0, name: v.name ?? '', tiles: Array.isArray(v.tiles) ? v.tiles.map((t: any) => ({ ...t })) : [],
        }));
        return ts;
    }
}

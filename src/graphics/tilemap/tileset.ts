// The runtime half of a tileset: an atlas sliced into a grid, plus per-tile metadata. The editor's
// `.tileset` asset is a superset. A TilemapNode EMBEDS a full copy of every tileset it references, so
// `Tilemap.deserialize` never needs an asset library in scope.

/** A tile that cycles through other tiles' images. `frames` are tile indices into the same tileset. */
export interface TileAnimation {
    frames: number[];
    fps: number;
}

/** Which family of auto-tiling rules a terrain set uses. */
export type WangKind = 'edge' | 'corner' | 'blob';

/** Everything authoring can attach to one tile. All optional — the common tile is a plain square. */
export interface TileMeta {
    /** Contributes a collider when placed on a collision-bearing layer. */
    solid?: boolean;
    /**
     * Collider outline in tile-local space (0..1 from the bottom-left), as flat xy pairs. Absent means
     * the whole cell, which is what lets the merger fold it into a box; a shape opts out of merging.
     */
    shape?: number[];
    /** World-space nudge applied to this tile's Y-sort key. The manual override when anchoring is wrong. */
    zBias?: number;
    /** Row offset within the tile's footprint that the whole tile sorts at — a tree's trunk row. */
    anchorRow?: number;
    /** Footprint in cells, for multi-cell props. Defaults to 1x1. */
    spanX?: number;
    spanY?: number;
    /** Multiplied into the tile's colour wherever it is placed, unless a cell overrides it. */
    tint?: [number, number, number];
    opacity?: number;
    /** This tile's overdrive, overriding the tileset's (see {@link TilesetConfig.overdrive}). */
    overdrive?: number;
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
     * Grid dimensions. STORED, not derived: deriving them needs the decoded image, which the published
     * player has not got when it parses a scene.
     */
    columns: number;
    rows: number;
    /**
     * Multiplies every tile's colour in LINEAR light, past what a tint can reach (a tint stops at white).
     * Above 1 a tile is brighter than its texture, which is what lets fire, lava or magic cross the bloom
     * threshold and glow — the sprite and tilemap counterpart of a material's emissive intensity. 1 = the
     * texture as authored. A tile's own `overdrive` overrides it.
     */
    overdrive?: number;
    /**
     * LIGHTING MAPS: atlases cut into the same cells as the tileset's texture, which a LIT sprite
     * (Sprite.lit) shades with instead of drawing the texture as it is. Two kinds, each a pair:
     *
     *  - six-way lightmaps (smoke, steam, dust: anything soft and see-through), the FX Creator's Six-way +
     *    and Six-way − outputs: the positive map's RGB is the effect lit from its right, top and back (away
     *    from the camera), A its coverage; the negative map's RGB lit from its left, bottom and front, A its
     *    emission. A lit sprite blends them by each light's direction (Unity VFX Graph's six-way lighting).
     *  - surface maps (liquids, anything with a surface): a tangent-space normal map (OpenGL: R right,
     *    G up, B toward the viewer) and an optional ORM map (R occlusion, G roughness, B metallic). The
     *    tileset's own texture is then the base colour (the Creator's Surface maps albedo output).
     *
     * Six-way wins when both of its maps are set; a lit sprite with neither kind is shaded flat.
     */
    sixWayPositiveTextureId?: string | null;
    sixWayNegativeTextureId?: string | null;
    normalTextureId?: string | null;
    ormTextureId?: string | null;
    /**
     * Art pixels per world unit: a sprite drawn from this tileset is its tile's pixel size over this, times
     * its node's scale (a 16 px tile at 16 is one unit, a 135 px character frame 8.4), and a tilemap layer
     * takes its cells from it. 0 or absent: the legacy rule, a sprite is a unit quad sized by its scale.
     */
    pixelsPerUnit?: number;
    /**
     * Free-form REGIONS instead of a grid: rectangles [x, y, width, height] in pixels from the image's
     * top-left, one tile each, in order -- for a sheet whose pieces are not on a grid (props, a packed
     * character). Absent or empty: the grid above. Tilemap layers need a grid.
     */
    regions?: ReadonlyArray<readonly [number, number, number, number]> | null;
}

/** How a lit sprite over a tileset shades: see {@link TilesetConfig.sixWayPositiveTextureId}. */
export type TilesetLighting = 'sixWay' | 'surface' | 'flat';

/** A texture id, or null for none (an empty string included). */
const idOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Regions as written: whole, non-negative rectangles of at least one pixel, or null for none. */
function regionsOf(v: unknown): ReadonlyArray<readonly [number, number, number, number]> | null {
    if (!Array.isArray(v) || v.length === 0) return null;
    const out: [number, number, number, number][] = [];
    for (const r of v) {
        if (!Array.isArray(r) || r.length < 4) continue;
        const [x, y, w, h] = r.map(n => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0));
        out.push([Math.max(0, x), Math.max(0, y), Math.max(1, w), Math.max(1, h)]);
    }
    return out.length > 0 ? out : null;
}

/** The overdrive range authoring accepts. */
export const MAX_TILESET_OVERDRIVE = 32;
const clampOverdrive = (v: unknown, fallback = 1): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_TILESET_OVERDRIVE, Math.max(0, v)) : fallback;

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
    private readonly _overdrive: number;
    private readonly _sixWayPositiveTextureId: string | null;
    private readonly _sixWayNegativeTextureId: string | null;
    private readonly _normalTextureId: string | null;
    private readonly _ormTextureId: string | null;
    private readonly _pixelsPerUnit: number;
    private readonly _regions: ReadonlyArray<readonly [number, number, number, number]> | null;
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
        this._overdrive = clampOverdrive(cfg.overdrive);
        this._sixWayPositiveTextureId = idOrNull(cfg.sixWayPositiveTextureId);
        this._sixWayNegativeTextureId = idOrNull(cfg.sixWayNegativeTextureId);
        this._normalTextureId = idOrNull(cfg.normalTextureId);
        this._ormTextureId = idOrNull(cfg.ormTextureId);
        this._pixelsPerUnit = typeof cfg.pixelsPerUnit === 'number' && Number.isFinite(cfg.pixelsPerUnit) && cfg.pixelsPerUnit > 0
            ? cfg.pixelsPerUnit : 0;
        this._regions = regionsOf(cfg.regions);
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
    /** See {@link TilesetConfig.overdrive}. */
    public get overdrive(): number { return this._overdrive; }
    /** The lighting maps: see {@link TilesetConfig.sixWayPositiveTextureId}. */
    public get sixWayPositiveTextureId(): string | null { return this._sixWayPositiveTextureId; }
    public get sixWayNegativeTextureId(): string | null { return this._sixWayNegativeTextureId; }
    public get normalTextureId(): string | null { return this._normalTextureId; }
    public get ormTextureId(): string | null { return this._ormTextureId; }
    /** See {@link TilesetConfig.pixelsPerUnit}: 0 for none. */
    public get pixelsPerUnit(): number { return this._pixelsPerUnit; }
    /** See {@link TilesetConfig.regions}: null for a grid. */
    public get regions(): ReadonlyArray<readonly [number, number, number, number]> | null { return this._regions; }
    /** Whether the tiles are free-form regions rather than a grid. */
    public get hasRegions(): boolean { return this._regions !== null; }

    /** The pixel size of `tileIndex`: its region's, or the grid's tile size. */
    public sizeOf(tileIndex: number, out: [number, number] = [0, 0]): [number, number] {
        const r = this._regions;
        if (r) {
            const rect = r[Math.max(0, Math.min(tileIndex, r.length - 1))];
            out[0] = rect[2]; out[1] = rect[3];
        } else {
            out[0] = this._tileWidth; out[1] = this._tileHeight;
        }
        return out;
    }
    /** How a lit sprite shades over this tileset: six-way with both six-way maps, surface with a normal map, else flat. */
    public get lighting(): TilesetLighting {
        if (this._sixWayPositiveTextureId && this._sixWayNegativeTextureId) return 'sixWay';
        return this._normalTextureId ? 'surface' : 'flat';
    }
    /** Every lighting map that is set, for asset references. */
    public get lightingTextureIds(): string[] {
        return [this._sixWayPositiveTextureId, this._sixWayNegativeTextureId, this._normalTextureId, this._ormTextureId]
            .filter((id): id is string => !!id);
    }

    /** The linear colour multiplier `tileIndex` draws with: its own overdrive, else the tileset's. */
    public overdriveOf(tileIndex: number): number {
        const own = this._meta.get(tileIndex)?.overdrive;
        return own === undefined ? this._overdrive : clampOverdrive(own, this._overdrive);
    }
    public get tileCount(): number { return this._regions ? this._regions.length : this._columns * this._rows; }
    public get terrains(): TerrainSet[] { return this._terrains; }
    public get variantSets(): VariantSet[] { return this._variants; }
    /** Every tile that carries metadata, as [index, meta] pairs. */
    public get metaEntries(): IterableIterator<[number, TileMeta]> { return this._meta.entries(); }

    /**
     * Texture-space rect of `tileIndex` as [left, bottom, right, top]. Tile 0 is the atlas's TOP-LEFT
     * cell, running left-to-right then down; the V flip is because textures upload with UNPACK_FLIP_Y.
     */
    public uvOf(tileIndex: number, out?: Float32Array): Float32Array {
        const o = out && out.length >= 4 ? out : new Float32Array(4);
        const i = Math.max(0, Math.min(tileIndex, this.tileCount - 1));
        const r = this._regions;
        if (r) {
            const [x, y, w, h] = r[i];
            o[0] = x / this._imageWidth;
            o[1] = 1 - (y + h) / this._imageHeight;
            o[2] = (x + w) / this._imageWidth;
            o[3] = 1 - y / this._imageHeight;
            return o;
        }
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

    /**
     * Which tile's image `tileIndex` shows at `time` seconds. Non-animated tiles return themselves.
     * `fps`, when given and positive, plays the tile's frames at that rate instead of the tile's own — a
     * sprite that wants the shared flame faster than the tileset authored it.
     */
    public frameOf(tileIndex: number, time: number, fps?: number): number {
        const a = this._meta.get(tileIndex)?.animation;
        if (!a || a.frames.length === 0) return tileIndex;
        if (a.frames.length === 1) return a.frames[0];
        const rate = fps !== undefined && fps > 0 ? fps : a.fps;
        const fps_ = rate > 0 ? rate : 1;
        const n = a.frames.length;
        // Modulo twice: the first can still be negative for a negative time.
        const step = ((Math.floor(time * fps_) % n) + n) % n;
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
            // Only when set, so every tileset authored before overdrive serializes byte-for-byte as it did.
            ...(this._overdrive !== 1 ? { overdrive: this._overdrive } : {}),
            // Likewise the lighting maps: only those that are set.
            ...(this._sixWayPositiveTextureId ? { sixWayPositiveTextureId: this._sixWayPositiveTextureId } : {}),
            ...(this._sixWayNegativeTextureId ? { sixWayNegativeTextureId: this._sixWayNegativeTextureId } : {}),
            ...(this._normalTextureId ? { normalTextureId: this._normalTextureId } : {}),
            ...(this._ormTextureId ? { ormTextureId: this._ormTextureId } : {}),
            ...(this._pixelsPerUnit > 0 ? { pixelsPerUnit: this._pixelsPerUnit } : {}),
            ...(this._regions ? { regions: this._regions.map(r => [r[0], r[1], r[2], r[3]]) } : {}),
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
            overdrive: json?.overdrive,
            sixWayPositiveTextureId: json?.sixWayPositiveTextureId,
            sixWayNegativeTextureId: json?.sixWayNegativeTextureId,
            normalTextureId: json?.normalTextureId,
            ormTextureId: json?.ormTextureId,
            pixelsPerUnit: json?.pixelsPerUnit,
            regions: json?.regions,
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

import { v4 as uuidv4 } from 'uuid';
import { Texture } from '../graphics/texture';
import { TextureManager } from '../graphics/systems/textureManager';
import { TexturePacker } from '../graphics/systems/texturePacker';
import type { PackSpec } from '../graphics/systems/texturePacker';
import { MAX_TERRAIN_SURFACES } from './terrainLayers';
import type { TerrainSurfaceData } from './terrainLayers';

/** The layer-texture sizes a project may choose, smallest first. */
export const TERRAIN_LAYER_TEXTURE_SIZES = [512, 1024, 2048] as const;
export const DEFAULT_TERRAIN_LAYER_TEXTURE_SIZE = 1024;

/**
 * The albedo pack of one surface: rgb = albedo (white where there is none, so the tint alone shows).
 * Alpha is spare — occlusion moved to the ORM pack. REPEAT, because a surface is sampled at
 * `baseUv * tiling`.
 */
export function albedoPackSpec(s: TerrainSurfaceData): PackSpec {
    return {
        r: s.albedoId ? { textureId: s.albedoId, channel: 0 } : { constant: 1 },
        g: s.albedoId ? { textureId: s.albedoId, channel: 1 } : { constant: 1 },
        b: s.albedoId ? { textureId: s.albedoId, channel: 2 } : { constant: 1 },
        a: { constant: 1 },
        wrapping: 'repeat',
    };
}

/**
 * The ORM pack: r = occlusion, g = roughness, b = metallic — the layout and the channel INFERENCE the
 * mesh PBR path uses (`TexturePacker._syncPBR`): a texture filling several of the three slots is a packed
 * ARM/ORM map and gives each slot its own channel; one in a single slot is grayscale and reads red. A
 * slot without a map packs the surface's scalar, so the shader reads this array alone once it is flagged.
 */
export function ormPackSpec(s: TerrainSurfaceData): PackSpec {
    const ao = s.aoId ?? null, rough = s.roughnessId ?? null, metal = s.metallicId ?? null;
    const uses = new Map<string, number>();
    for (const id of [ao, rough, metal]) if (id) uses.set(id, (uses.get(id) ?? 0) + 1);
    const channelOf = (id: string, orm: 0 | 1 | 2): 0 | 1 | 2 => ((uses.get(id) ?? 0) > 1 ? orm : 0);
    return {
        r: ao ? { textureId: ao, channel: channelOf(ao, 0) } : { constant: 1 },
        g: rough ? { textureId: rough, channel: channelOf(rough, 1) } : { constant: clamp01(s.roughness) },
        b: metal ? { textureId: metal, channel: channelOf(metal, 2) } : { constant: clamp01(s.metallic) },
        a: { constant: 1 },
        wrapping: 'repeat',
    };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/** The normal+height pack: rgb = tangent-space normal (flat where there is none), a = height (0 where none). */
export function normalPackSpec(s: TerrainSurfaceData): PackSpec {
    return {
        r: s.normalId ? { textureId: s.normalId, channel: 0 } : { constant: 0.5 },
        g: s.normalId ? { textureId: s.normalId, channel: 1 } : { constant: 0.5 },
        b: s.normalId ? { textureId: s.normalId, channel: 2 } : { constant: 1.0 },
        a: s.heightId ? { textureId: s.heightId, channel: 0 } : { constant: 0.0 },
        wrapping: 'repeat',
    };
}

/** Identity of a pack's inputs; a layer is re-baked exactly when this changes. */
export function packKey(spec: PackSpec): string {
    const part = (c: PackSpec['r']) => ('constant' in c ? `#${c.constant}` : `${c.textureId}.${c.channel}`);
    return `${part(spec.r)}|${part(spec.g)}|${part(spec.b)}|${part(spec.a)}`;
}

/** Layers to allocate for `count` surfaces: rounded up to a multiple of 4, so adding one slot rarely reallocates. */
export function arrayLayersFor(count: number): number {
    return Math.min(MAX_TERRAIN_SURFACES, Math.max(4, Math.ceil(Math.max(1, count) / 4) * 4));
}

/**
 * The 2D-ARRAY textures a landscape's surfaces are sampled from — albedo, normal+height and occlusion/
 * roughness/metallic, one
 * layer per surface, all at one common size.
 *
 * Why arrays: the old stack gave every layer its own two textures, so layer count was capped by the
 * 16-per-stage sampler budget (four layers took nine bindings). An array layer costs no binding at all.
 * The price is a common size, so every surface is RESAMPLED into its layer by `TexturePacker.bakeInto`
 * — a fullscreen pass that reads the source maps by normalised uv, so maps of any size go in cleanly.
 *
 * Owned by a `Terrain`; `sync` runs once per frame from the renderer's pre-pass hook, where no pass is
 * open. A surface whose maps are still decoding simply stays un-baked and is retried next frame.
 */
export class TerrainSurfaceArrays {
    private _albedo: Texture | null = null;
    private _normal: Texture | null = null;
    private _orm: Texture | null = null;
    private _albedoId: string | null = null;
    private _normalId: string | null = null;
    private _ormId: string | null = null;
    private _size = 0;
    private _layers = 0;
    // What each layer currently holds, by pack key; null = not baked yet.
    private _albedoKeys: (string | null)[] = [];
    private _normalKeys: (string | null)[] = [];
    private _ormKeys: (string | null)[] = [];

    /** TextureManager id of the albedo+AO array, or null before the first sync. */
    public get albedoId(): string | null { return this._albedoId; }
    /** TextureManager id of the normal+height array, or null before the first sync. */
    public get normalId(): string | null { return this._normalId; }
    /** TextureManager id of the occlusion/roughness/metallic array, or null before the first sync. */
    public get ormId(): string | null { return this._ormId; }
    public get size(): number { return this._size; }
    public get layers(): number { return this._layers; }

    /**
     * Bring the arrays in line with `surfaces`. Returns true once every surface is baked.
     *
     * Reallocates (and re-bakes everything) only when the size changes or the surfaces outgrow the
     * layers allocated; otherwise re-bakes just the layers whose inputs changed, and rebuilds the mip
     * chains once for the lot.
     */
    public sync(surfaces: readonly TerrainSurfaceData[], size: number): boolean {
        const layers = arrayLayersFor(surfaces.length);
        if (!this._albedo || size !== this._size || layers > this._layers) this._allocate(size, layers);

        let baked = false, complete = true;
        const packer = TexturePacker.Instance;
        for (let i = 0; i < surfaces.length; i++) {
            const albedo = albedoPackSpec(surfaces[i]);
            const albedoKey = packKey(albedo);
            if (this._albedoKeys[i] !== albedoKey) {
                if (packer.bakeInto(albedo, this._albedo!, i)) { this._albedoKeys[i] = albedoKey; baked = true; }
                else complete = false;
            }
            const normal = normalPackSpec(surfaces[i]);
            const normalKey = packKey(normal);
            if (this._normalKeys[i] !== normalKey) {
                if (packer.bakeInto(normal, this._normal!, i)) { this._normalKeys[i] = normalKey; baked = true; }
                else complete = false;
            }
            const orm = ormPackSpec(surfaces[i]);
            const ormKey = packKey(orm);
            if (this._ormKeys[i] !== ormKey) {
                if (packer.bakeInto(orm, this._orm!, i)) { this._ormKeys[i] = ormKey; baked = true; }
                else complete = false;
            }
        }
        if (baked) {
            // Once per sync, after every layer: the chain is per layer, but regenerating it per bake
            // would redo the unchanged layers each time.
            this._albedo!.generateMipmaps();
            this._normal!.generateMipmaps();
            this._orm!.generateMipmaps();
        }
        return complete;
    }

    /** Forget what every layer holds, so the next sync re-bakes all of them (a source map was replaced in place). */
    public invalidate(): void {
        this._albedoKeys = this._albedoKeys.map(() => null);
        this._normalKeys = this._normalKeys.map(() => null);
        this._ormKeys = this._ormKeys.map(() => null);
    }

    private _allocate(size: number, layers: number): void {
        this.dispose();
        const make = (label: string): { texture: Texture; id: string } => {
            const texture = new Texture({
                target: 'texture2DArray', mipMap: true, precision: 'low', wrapping: 'repeat',
                // Terrain is seen at grazing angles more than anything else in a scene; without this
                // its far half blurs to the mip that fits the narrow axis of every pixel's footprint.
                anisotropy: 8,
            });
            texture.createColorArray(size, size, layers, true);
            const id = `__editor__terrain_${label}_${uuidv4()}`;
            TextureManager.Instance.addTexture(texture, id);
            return { texture, id };
        };
        const albedo = make('surfAlbedo');
        const normal = make('surfNormal');
        const orm = make('surfOrm');
        this._albedo = albedo.texture; this._albedoId = albedo.id;
        this._normal = normal.texture; this._normalId = normal.id;
        this._orm = orm.texture; this._ormId = orm.id;
        this._size = size;
        this._layers = layers;
        this._albedoKeys = new Array(layers).fill(null);
        this._normalKeys = new Array(layers).fill(null);
        this._ormKeys = new Array(layers).fill(null);
    }

    /** Free every array. Safe to call twice. */
    public dispose(): void {
        for (const [texture, id] of [[this._albedo, this._albedoId], [this._normal, this._normalId], [this._orm, this._ormId]] as const) {
            if (texture) texture.delete();
            if (id) TextureManager.Instance.removeTexture(id);
        }
        this._albedo = this._normal = this._orm = null;
        this._albedoId = this._normalId = this._ormId = null;
        this._size = 0;
        this._layers = 0;
        this._albedoKeys = [];
        this._normalKeys = [];
        this._ormKeys = [];
    }
}

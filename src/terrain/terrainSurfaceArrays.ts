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
 * The albedo+AO pack of one surface: rgb = albedo (white where there is none, so the tint alone shows),
 * a = occlusion (1 where there is none). REPEAT, because a surface is sampled at `baseUv * tiling`.
 */
export function albedoPackSpec(s: TerrainSurfaceData): PackSpec {
    return {
        r: s.albedoId ? { textureId: s.albedoId, channel: 0 } : { constant: 1 },
        g: s.albedoId ? { textureId: s.albedoId, channel: 1 } : { constant: 1 },
        b: s.albedoId ? { textureId: s.albedoId, channel: 2 } : { constant: 1 },
        a: s.aoId ? { textureId: s.aoId, channel: 0 } : { constant: 1 },
        wrapping: 'repeat',
    };
}

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
 * The two 2D-ARRAY textures a landscape's surfaces are sampled from — albedo+AO and normal+height, one
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
    private _albedoId: string | null = null;
    private _normalId: string | null = null;
    private _size = 0;
    private _layers = 0;
    // What each layer currently holds, by pack key; null = not baked yet.
    private _albedoKeys: (string | null)[] = [];
    private _normalKeys: (string | null)[] = [];

    /** TextureManager id of the albedo+AO array, or null before the first sync. */
    public get albedoId(): string | null { return this._albedoId; }
    /** TextureManager id of the normal+height array, or null before the first sync. */
    public get normalId(): string | null { return this._normalId; }
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
        }
        if (baked) {
            // Once per sync, after every layer: the chain is per layer, but regenerating it per bake
            // would redo the unchanged layers each time.
            this._albedo!.generateMipmaps();
            this._normal!.generateMipmaps();
        }
        return complete;
    }

    /** Forget what every layer holds, so the next sync re-bakes all of them (a source map was replaced in place). */
    public invalidate(): void {
        this._albedoKeys = this._albedoKeys.map(() => null);
        this._normalKeys = this._normalKeys.map(() => null);
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
        this._albedo = albedo.texture; this._albedoId = albedo.id;
        this._normal = normal.texture; this._normalId = normal.id;
        this._size = size;
        this._layers = layers;
        this._albedoKeys = new Array(layers).fill(null);
        this._normalKeys = new Array(layers).fill(null);
    }

    /** Free both arrays. Safe to call twice. */
    public dispose(): void {
        for (const [texture, id] of [[this._albedo, this._albedoId], [this._normal, this._normalId]] as const) {
            if (texture) texture.delete();
            if (id) TextureManager.Instance.removeTexture(id);
        }
        this._albedo = this._normal = null;
        this._albedoId = this._normalId = null;
        this._size = 0;
        this._layers = 0;
        this._albedoKeys = [];
        this._normalKeys = [];
    }
}

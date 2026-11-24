import { TextureManager } from '../systems/textureManager';
import { Texture } from '../texture';

// -------------------------------------------------------------------------------------------------
// The cubemaps a custom material's `samplerCube` uniforms sample, built from 2:1 equirectangular
// panoramas.
//
// The project's texture library holds 2D images only, and a 2D texture in a `texture_cube` slot is
// not a degraded draw but a refused one: WebGPU rejects the bind group, WebGL2 samples black. So a
// cubemap uniform names a PANORAMA, and this cache turns it into a cube once, the first frame a
// material asks for it, and again only when the image behind the id changes. The cube is linear HDR
// with a full mip chain, so `textureLod(u_sky, R, roughness * n)` gives a blurrier reflection.
//
// Modelled on the texture packer's derived textures (systems/texturePacker.ts): `ensure` bakes where no
// pass is open, `cube` is the draw-time lookup that never bakes, and `sweep` frees what nobody asked for
// in a while. The GPU half is injected (SkyPasses.bakePanoramaCube), so the bookkeeping is testable.
// -------------------------------------------------------------------------------------------------

/** Renders `source`, a panorama, into all six faces of `target` (level 0) and builds its mips. */
export type PanoramaBake = (source: Texture, target: Texture, size: number) => void;

/** A renderable linear-HDR cube `size` texels a face, with a full mip chain to be filled. */
function allocateCube(size: number): Texture {
    const cube = new Texture({ target: 'cubemap', precision: 'high', mipMap: true });
    cube.createCubemapTarget(size, Math.floor(Math.log2(size)) + 1);
    return cube;
}

/** The largest face built. 1024² linear HDR with mips is ~67 MB; a reflection needs no more. */
export const PANORAMA_MAX_FACE = 1024;
const MIN_FACE = 32;

/**
 * The face size for a panorama `width` texels wide: a quarter of it, to the next power of two. A cube
 * face spans 90° of the panorama's 360°, so that matches its texel density at the horizon.
 */
export function panoramaFaceSize(width: number): number {
    const quarter = Math.max(1, Math.round(width / 4));
    const pow2 = 2 ** Math.ceil(Math.log2(quarter));
    return Math.min(PANORAMA_MAX_FACE, Math.max(MIN_FACE, pow2));
}

interface Entry {
    /** The texture the cube was built from, by identity: ids are reused when an image is re-imported. */
    source: Texture;
    width: number;
    height: number;
    /** The cube to bind: built here, or the source itself when it already is a cubemap. */
    cube: Texture;
    /** Built here, so this cache deletes it; a cubemap source is someone else's. */
    owned: boolean;
    lastFrame: number;
}

export class PanoramaCubes {
    /** Cubes no material has asked for in this many frames are freed. ~20 s at 60 fps, like the packer's. */
    public static readonly SWEEP_INTERVAL = 1200;

    private readonly _entries = new Map<string, Entry>();
    private _lastSweep = 0;

    /** `allocate` is the cube's allocation, apart so a test can stand in for the device. */
    constructor(private readonly _bake: PanoramaBake,
                private readonly _allocate: (size: number) => Texture = allocateCube) {}

    /**
     * Have the cube for texture `id` ready. Call where no pass is open: a miss bakes. A missing texture,
     * or one still decoding, is skipped, and the next frame's call is the retry.
     */
    public ensure(id: string, frame: number): void {
        const source = TextureManager.Instance.getTexture(id);
        const entry = this._entries.get(id);
        if (entry && entry.source === source && entry.width === source.width && entry.height === source.height) {
            entry.lastFrame = frame;
            return;
        }
        if (entry) this._drop(id, entry);
        if (!source || !(source.width > 0) || !(source.height > 0)) return;

        if (source.config.target === 'cubemap') {
            this._entries.set(id, { source, width: source.width, height: source.height, cube: source, owned: false, lastFrame: frame });
            return;
        }
        // Only a plain 2D image unwraps: a volume or an array has no one panorama to read.
        if (source.config.target !== 'texture2D') return;

        const size = panoramaFaceSize(source.width);
        const cube = this._allocate(size);
        this._bake(source, cube, size);
        this._entries.set(id, { source, width: source.width, height: source.height, cube, owned: true, lastFrame: frame });
    }

    /** The cube built for texture `id`, or null when there is none yet. Draw time: never bakes. */
    public cube(id: string): Texture | null {
        const entry = this._entries.get(id);
        if (!entry) return null;
        // Replaced since the bake: the old cube is stale, and the next `ensure` rebuilds it.
        return entry.source === TextureManager.Instance.getTexture(id) ? entry.cube : null;
    }

    /** Free the cubes nobody has asked for in {@link SWEEP_INTERVAL} frames. Call once a frame. */
    public sweep(frame: number): void {
        if (frame - this._lastSweep < PanoramaCubes.SWEEP_INTERVAL) return;
        this._lastSweep = frame;
        for (const [id, entry] of this._entries)
            if (frame - entry.lastFrame >= PanoramaCubes.SWEEP_INTERVAL) this._drop(id, entry);
    }

    /** The cubes this cache built, for the memory estimate. */
    public get textures(): Texture[] {
        const out: Texture[] = [];
        for (const entry of this._entries.values()) if (entry.owned) out.push(entry.cube);
        return out;
    }

    /** Free every cube, on a device loss or teardown. */
    public clear(): void {
        for (const [id, entry] of this._entries) this._drop(id, entry);
    }

    private _drop(id: string, entry: Entry): void {
        if (entry.owned) entry.cube.delete();
        this._entries.delete(id);
    }
}

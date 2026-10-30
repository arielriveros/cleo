import { mat4 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { boxInverseMatrix, boxWorldBounds } from "./boxVolume";
import { Texture } from "../../../graphics/texture";
import { device } from "../../../graphics/rhi/deviceHandle";

/** Voxels per side of one occupancy brick. */
export const FLUID_BRICK = 8;

/**
 * A ray-marched smoke-and-fire volume: a box of voxels the renderer draws in the scene, lit by the
 * scene's sun and occluded by opaque geometry. What fills it is up to the caller — a fluid simulation
 * writing it every frame (Cleo Creator's FX preview), or a baked volume uploaded once.
 *
 * The box is `size` (full extents, local units) centred on the node, under its full transform. Its
 * data is an RGBA 3D texture, `resolution` voxels along the box's own axes:
 *
 *   R  smoke density (extinction per voxel is `absorption` x R)
 *   G  temperature; above `ignition` it glows, reaching the top of the fire colour `emissionRange` higher
 *   B  light transmittance toward the sun, 0..1 (self-shadowing, computed by whoever fills the volume)
 *   A  the fire's light on the smoke around it, 0..1 (scaled by `fireGlow`)
 *
 * TWO volumes are kept: {@link swap} makes the current one the previous and hands back the other to be
 * written, and the renderer blends previous to current by {@link blend} -- so a simulation running
 * slower than the display still plays smoothly. An occupancy grid of {@link FLUID_BRICK}^3 bricks lets
 * the march jump over empty space.
 *
 * Runtime-only for now: it is not serialized and not offered in the editor, so nothing about it is
 * persisted in a scene.
 */
export class FluidVolumeNode extends Node {
    /** Full extents of the box at scale 1. */
    public size: [number, number, number] = [1, 1, 1];
    /** Off keeps it in the scene without drawing it. */
    public enabled = true;

    // --- Look ---------------------------------------------------------------------------------------
    /** Smoke albedo, linear RGB. */
    public smokeColor: [number, number, number] = [0.32, 0.31, 0.3];
    /** Extinction per unit density per voxel. */
    public absorption = 2.2;
    /** Fire brightness at the top of the gradient. */
    public emission = 2.2;
    /** Temperature span above `ignition` that the fire colour covers. */
    public emissionRange = 1.2;
    public ignition = 0.25;
    /** Fire's own opacity per unit emission per voxel; fire hides what is behind it a little. */
    public fireOpacity = 0.6;
    /** Fraction of the sun that reaches fully shadowed smoke (the sky's share). */
    public ambient = 0.35;
    /** Henyey-Greenstein anisotropy, -0.9..0.9: > 0 scatters forward (bright rims against the sun). */
    public anisotropy = 0;
    /** Wrenninge multiple-scattering octaves; 1 is single scattering. */
    public scatterOctaves = 1;
    /** Strength of the fire's light on the surrounding smoke (the volume's A channel). */
    public fireGlow = 0;
    /** Sub-voxel detail: procedural noise eroding the density, 0..1. */
    public detailStrength = 0;
    /** Detail noise features per 10 voxels. */
    public detailScale = 6;
    /** Seconds, for the detail noise's drift. The owner advances it. */
    public time = 0;
    /** Scattering albedo, 0..1: 1 bright steam that scatters all it stops, low values dark soot. */
    public albedo = 1;
    /** Beer-Powder dark edges on dense smoke facing the light, 0..1. */
    public powder = 0;
    /** How much the gas above shades the sky light below, 0..1: darker plume undersides. */
    public skyOcclusion = 0;
    /** Fire brightness relative to the smoke; above 1, with `fireExposureWeight`, it drives bloom. */
    public fireIntensity = 1;
    /**
     * How much of the camera's exposure the fire takes, 0..1 — `Sprite.exposureWeight`'s meaning. 1 is
     * physical; the default 0 keeps the fire looking the way its flipbook bakes, at any exposure.
     */
    public fireExposureWeight = 0;
    /** March step, in voxels. Smaller is smoother and slower. */
    public stepScale = 0.75;

    // --- Performance --------------------------------------------------------------------------------
    /** 0..1: how far from the previous volume to the current one the renderer draws. */
    public blend = 1;
    /** Trace resolution as a share of the render resolution: 1, 0.5 or 0.25. */
    public resolutionScale = 1;
    /**
     * Temporal reconstruction: one jittered, longer-stepped ray per pixel each frame, accumulated over
     * frames through reprojection (the volumetric clouds' and TAA's technique). Much cheaper per frame
     * at the same converged quality; a fast change takes a few frames to settle.
     */
    public temporal = false;
    /** While the camera moves or {@link markInteracting} was called recently, steps grow by this. */
    public interactiveStepScale = 2.5;

    private _fireLut: Texture | null = null;
    private _volumes: [Texture | null, Texture | null] = [null, null];
    private _current = 0;
    private _occupancy: Texture | null = null;
    /**
     * Advected detail coordinates (flow noise): two half-resolution RGBA16F volumes whose RGB is where in
     * the noise each point of the gas came from, in full-resolution voxels. Cross-faded by
     * {@link detailBlend} (set A's weight); each set is reset to the rest grid half a period apart.
     */
    private _detail: [Texture | null, Texture | null] = [null, null];
    private _detailHalf: Uint16Array | null = null;
    private _detailFloats: Float32Array | null = null;
    /** Set A's share of the detail cross-fade, 0..1. */
    public detailBlend = 1;
    /** Whether the detail coordinates have been written: until then the detail noise drifts upward. */
    public hasDetail = false;
    private _bricks: [number, number, number] = [0, 0, 0];
    private _resolution: [number, number, number] = [0, 0, 0];
    private _storage = false;
    private _half: Uint16Array | null = null;
    private _interactingUntil = 0;
    private _invScratch: mat4 = mat4.create();
    private _volumeScratch: mat4 = mat4.create();

    constructor(name: string, id: string = uuidv4()) {
        super(name, 'fluidVolume', id);
    }

    /** The voxel data drawn as "now", or null before {@link allocate}. */
    public get volume(): Texture | null { return this._volumes[this._current]; }
    /** The voxel data drawn as "before"; blended toward {@link volume} by {@link blend}. */
    public get previousVolume(): Texture | null { return this._volumes[1 - this._current]; }
    /** The two detail coordinate volumes, or null before {@link allocate}. */
    public get detailA(): Texture | null { return this._detail[0]; }
    public get detailB(): Texture | null { return this._detail[1]; }
    /** Bricks holding anything (R > 0), {@link FLUID_BRICK}^3 voxels each; null draws without skipping. */
    public get occupancy(): Texture | null { return this._occupancy; }
    /** The occupancy grid's size in bricks. */
    public get bricks(): readonly [number, number, number] { return this._bricks; }
    /** Voxels along x, y, z. */
    public get resolution(): readonly [number, number, number] { return this._resolution; }
    /** Whether the volumes can be written by a compute shader (`texture_storage_3d<rgba16float, write>`). */
    public get storage(): boolean { return this._storage; }
    /** The fire colour by temperature, a 256 x 1 RGBA8 strip; null draws white fire. */
    public get fireLut(): Texture | null { return this._fireLut; }

    /**
     * Make the current volume the previous one and return the other, to be written as the new current.
     * The renderer then blends from the old frame to the new one by {@link blend}.
     */
    public swap(): Texture | null {
        this._current = 1 - this._current;
        return this.volume;
    }

    /** Draw cheaply for a moment: the next ~`ms` milliseconds use {@link interactiveStepScale}. */
    public markInteracting(ms = 250): void {
        this._interactingUntil = Math.max(this._interactingUntil, performance.now() + ms);
    }

    /** Whether {@link markInteracting} is still in effect. */
    public get interacting(): boolean { return performance.now() < this._interactingUntil; }

    /**
     * (Re)create the volumes at `nx` x `ny` x `nz`. RGBA16F, clamped, trilinearly filtered.
     *
     * `storage` asks for compute-writable volumes, which only a device with compute can give; without
     * one it is ignored and the volumes are filled through {@link upload}.
     */
    public allocate(nx: number, ny: number, nz: number, options: { storage?: boolean } = {}): Texture {
        const storage = !!options.storage && !!device?.capabilities?.hasCompute;
        if (this._volumes[0] && this._storage === storage
            && this._resolution[0] === nx && this._resolution[1] === ny && this._resolution[2] === nz) return this.volume!;
        this._release();
        const make = () => {
            // `unfiltered` keeps RGBA16F through the float fallback, which is keyed to 32-bit filtering:
            // 16-bit float is filterable in core WebGPU and WebGL2 alike, and 8 bits would band the smoke.
            const volume = new Texture({
                target: 'texture3D', mipMap: false, wrapping: 'clamp', format: 'rgba16float',
                ...(storage ? { storage: true, unfiltered: true } : { loadOnly: true }),
                size: { width: nx, height: ny, depth: nz },
            });
            volume.createVolume(nx, ny, nz, 'clamp');
            return volume;
        };
        this._volumes = [make(), make()];
        this._current = 0;
        this._resolution = [nx, ny, nz];
        this._storage = storage;
        this._half = null;
        const bx = Math.ceil(nx / FLUID_BRICK), by = Math.ceil(ny / FLUID_BRICK), bz = Math.ceil(nz / FLUID_BRICK);
        this._bricks = [bx, by, bz];
        // RGBA8, R used: the one 8-bit format both storage writes and WebGL2 texelFetch agree on.
        const occupancy = new Texture({
            target: 'texture3D', mipMap: false, wrapping: 'clamp', format: 'rgba8unorm',
            minFilter: 'nearest', magFilter: 'nearest', mipMapFilter: 'nearest',
            ...(storage ? { storage: true } : { loadOnly: true }),
            size: { width: bx, height: by, depth: bz },
        });
        occupancy.createVolume(bx, by, bz, 'clamp');
        this._occupancy = occupancy;
        const dx = Math.ceil(nx / 2), dy = Math.ceil(ny / 2), dz = Math.ceil(nz / 2);
        const detail = () => {
            const t = new Texture({
                target: 'texture3D', mipMap: false, wrapping: 'clamp', format: 'rgba16float',
                ...(storage ? { storage: true, unfiltered: true } : { loadOnly: true }),
                size: { width: dx, height: dy, depth: dz },
            });
            t.createVolume(dx, dy, dz, 'clamp');
            return t;
        };
        this._detail = [detail(), detail()];
        this.hasDetail = false;
        return this.volume!;
    }

    /** The half-resolution grid the detail coordinates live on. */
    public get detailResolution(): [number, number, number] {
        return [Math.ceil(this._resolution[0] / 2), Math.ceil(this._resolution[1] / 2), Math.ceil(this._resolution[2] / 2)];
    }

    /**
     * Write both detail coordinate sets from the CPU: xyz per half-resolution cell (x fastest), in
     * full-resolution voxel units.
     */
    public uploadDetail(a: Float32Array, b: Float32Array): void {
        const [dx, dy, dz] = this.detailResolution;
        const cells = dx * dy * dz;
        if (!this._detail[0] || a.length < cells * 3 || b.length < cells * 3) return;
        const half = device.backend === 'webgpu';
        const floats = this._detailFloats && this._detailFloats.length === cells * 4 ? this._detailFloats : (this._detailFloats = new Float32Array(cells * 4));
        if (half && (!this._detailHalf || this._detailHalf.length !== cells * 4)) this._detailHalf = new Uint16Array(cells * 4);
        const slice = dx * dy * 4;
        [a, b].forEach((src, k) => {
            for (let i = 0; i < cells; i++) { floats[i * 4] = src[i * 3]; floats[i * 4 + 1] = src[i * 3 + 1]; floats[i * 4 + 2] = src[i * 3 + 2]; floats[i * 4 + 3] = 1; }
            if (half) floatsToHalves(floats, this._detailHalf!);
            for (let z = 0; z < dz; z++) {
                const view = half ? this._detailHalf!.subarray(z * slice, (z + 1) * slice) : floats.subarray(z * slice, (z + 1) * slice);
                device.writeTexture(this._detail[k]!.rhiTexture, view, dx, dy, 0, z);
            }
        });
        this.hasDetail = true;
    }

    /**
     * Fill the CURRENT volume from the CPU: `nx * ny * nz` RGBA texels, x fastest, then y, then z. One
     * write per z-slice, then the occupancy grid. Pair with {@link swap} for blended playback.
     */
    public upload(data: Float32Array): void {
        const volume = this.volume;
        if (!volume) return;
        const [nx, ny, nz] = this._resolution;
        const slice = nx * ny * 4;
        if (data.length < slice * nz) throw new Error(`FluidVolumeNode.upload: expected ${slice * nz} floats, got ${data.length}`);
        // WebGL2 converts FLOAT to the half-float storage itself; WebGPU takes the texel bytes as stored.
        const half = device.backend === 'webgpu';
        if (half && (!this._half || this._half.length !== slice * nz)) this._half = new Uint16Array(slice * nz);
        if (half) floatsToHalves(data, this._half!);
        for (let z = 0; z < nz; z++) {
            const view = half ? this._half!.subarray(z * slice, (z + 1) * slice) : data.subarray(z * slice, (z + 1) * slice);
            device.writeTexture(volume.rhiTexture, view, nx, ny, 0, z);
        }
        this._uploadOccupancy(data);
    }

    /**
     * The occupancy grid for `data`: a brick is occupied when any voxel within it, or within a margin of
     * {@link OCCUPANCY_MARGIN} voxels around it, holds smoke or fire -- the margin covers trilinear reach
     * and the gas's motion between the two blended frames.
     */
    private _uploadOccupancy(data: Float32Array): void {
        const occ = this._occupancy;
        if (!occ) return;
        const bytes = occupancyFromVolume(data, this._resolution, this.ignition);
        const [bx, by, bz] = this._bricks;
        for (let z = 0; z < bz; z++)
            device.writeTexture(occ.rhiTexture, bytes.subarray(z * bx * by * 4, (z + 1) * bx * by * 4), bx, by, 0, z);
    }

    /** Set the fire colour from 256 linear RGB(A) entries in 0..1 (e.g. a baked gradient). */
    public setFireGradient(lut: Float32Array): void {
        const bytes = new Uint8Array(256 * 4);
        const stride = lut.length >= 256 * 4 ? 4 : 3;
        for (let i = 0; i < 256; i++) {
            for (let c = 0; c < 3; c++) bytes[i * 4 + c] = Math.round(Math.min(1, Math.max(0, lut[i * stride + c])) * 255);
            bytes[i * 4 + 3] = 255;
        }
        if (!this._fireLut) {
            this._fireLut = new Texture({ mipMap: false, wrapping: 'clamp', loadOnly: true });
            this._fireLut.create(null, 256, 1);
        }
        device.writeTexture(this._fireLut.rhiTexture, bytes, 256, 1);
    }

    /** Unit cube -> world: the world transform with the box's size folded in. */
    public get volumeMatrix(): mat4 {
        return mat4.scale(this._volumeScratch, this.worldTransform, [this.size[0], this.size[1], this.size[2]]);
    }

    /** World -> unit cube (inside = |xyz| <= 0.5). */
    public get invVolumeMatrix(): mat4 { return boxInverseMatrix(this._invScratch, this.worldTransform, this.size); }

    public getBoundingBox() { return boxWorldBounds(this.worldTransform, this.size); }

    private _release(): void {
        for (const v of this._volumes) v?.delete();
        for (const d of this._detail) d?.delete();
        this._occupancy?.delete();
        this._volumes = [null, null];
        this._detail = [null, null];
        this._occupancy = null;
        this.hasDetail = false;
    }

    /** Release the GPU volumes and colour. The node stays usable: {@link allocate} again to refill it. */
    public dispose(): void {
        this._release();
        this._fireLut?.delete();
        this._fireLut = null;
        this._resolution = [0, 0, 0];
        this._bricks = [0, 0, 0];
    }
}

/** Voxels around a brick that still mark it occupied. */
export const OCCUPANCY_MARGIN = 2;

/**
 * The occupancy grid of a packed volume (RGBA floats, x fastest): RGBA8 per brick, R = 255 when the
 * brick (plus {@link OCCUPANCY_MARGIN}) holds smoke (R > 1e-4) or fire (G > `ignition`).
 */
export function occupancyFromVolume(data: Float32Array, resolution: readonly [number, number, number], ignition: number): Uint8Array {
    const [nx, ny, nz] = resolution;
    const bx = Math.ceil(nx / FLUID_BRICK), by = Math.ceil(ny / FLUID_BRICK), bz = Math.ceil(nz / FLUID_BRICK);
    // Voxels holding anything, then dilated into bricks.
    const out = new Uint8Array(bx * by * bz * 4);
    const m = OCCUPANCY_MARGIN;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const k = (x + nx * (y + ny * z)) * 4;
        if (!(data[k] > 1e-4 || data[k + 1] > ignition)) continue;
        const x0 = Math.max(0, Math.floor((x - m) / FLUID_BRICK)), x1 = Math.min(bx - 1, Math.floor((x + m) / FLUID_BRICK));
        const y0 = Math.max(0, Math.floor((y - m) / FLUID_BRICK)), y1 = Math.min(by - 1, Math.floor((y + m) / FLUID_BRICK));
        const z0 = Math.max(0, Math.floor((z - m) / FLUID_BRICK)), z1 = Math.min(bz - 1, Math.floor((z + m) / FLUID_BRICK));
        for (let cz = z0; cz <= z1; cz++) for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++)
            out[(cx + bx * (cy + by * cz)) * 4] = 255;
    }
    return out;
}

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

/** IEEE 754 binary16 bits of `v`, rounded to nearest; overflow saturates to infinity. */
export function floatToHalf(v: number): number {
    _f32[0] = v;
    const x = _u32[0];
    const sign = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;
    if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
    let e = exp - 127 + 15;
    if (e >= 0x1f) return sign | 0x7c00;
    if (e <= 0) {
        if (e < -10) return sign;
        mant = (mant | 0x800000) >>> (1 - e);
        return sign | ((mant + 0x1000) >>> 13);
    }
    const h = sign | (e << 10) | (mant >>> 13);
    // Round to nearest: carries into the exponent correctly.
    return (mant & 0x1000) ? h + 1 : h;
}

/** Convert a float array to binary16 bits, element for element. */
export function floatsToHalves(src: Float32Array, dst: Uint16Array): void {
    const n = Math.min(src.length, dst.length);
    for (let i = 0; i < n; i++) dst[i] = floatToHalf(src[i]);
}

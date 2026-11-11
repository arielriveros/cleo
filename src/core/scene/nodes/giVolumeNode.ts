import { mat4, vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";
import { Logger } from "../../logger";
import { boxBlendFractions, boxInverseMatrix, boxWeight, boxWorldBounds } from "./boxVolume";

/**
 * A GI VOLUME: a box filled with a regular grid of irradiance probes that light every surface inside it,
 * per pixel, with the light bounced off the scene around them.
 *
 * Each probe's view of the scene (what its rays hit: albedo, normal, distance, emissive) is captured once by
 * rasterizing the STATIC scene, and only captured again when that geometry changes. The light is then put
 * back on those hits at runtime — the sun with its shadow, the lights set to bake, the sky, the emissives,
 * and the volume's own previous result for the bounces after the first — so a time of day, a torch or a
 * lamp switched off needs no re-bake (the Far Cry 3 "deferred radiance transfer" practice, in the DDGI
 * probe format Overwatch 2 ships: an octahedral irradiance and a visibility map per probe, the visibility
 * keeping a probe on the far side of a wall from lighting this side).
 *
 * The box is `size` (full extents, local units) centred on the node and carried by its world transform.
 * With `probeInset` 0 the grid spans it corner to corner: probe (0, 0, 0) sits at the box's minimum corner
 * and (nx-1, ny-1, nz-1) at its maximum, so every point inside has the whole cage of eight probes round it.
 * An inset pulls the outer probes in from the faces by that fraction of the spacing (0.5: each probe at the
 * centre of its cell), which is what a box drawn to a room's walls wants: probes ON the floor, the walls and
 * the ceiling see through them, to the outside's light or the inside of the slab, and each one that does
 * is a bright or a black cell in the room. Between the outer probes and the faces the lookup holds the
 * outer probes' light.
 * Nested volumes apply the smaller first (the room's before the hamlet's round it), each claiming its
 * feathered weight of what the ones before it left, as light probes do.
 */

/** Rays per probe: an 8x8 or 16x16 octahedral tile of hits. */
export type GiRayCount = 64 | 256;
export const GI_RAY_COUNTS: readonly GiRayCount[] = [64, 256];

/** Side, in texels, of each cube face a probe capture renders. */
export type GiCaptureResolution = 16 | 32;
export const GI_CAPTURE_RESOLUTIONS: readonly GiCaptureResolution[] = [16, 32];

/** Probes along one axis: at least two (the grid spans the box corner to corner). */
export const MIN_GI_PROBES_PER_AXIS = 2;
export const MAX_GI_PROBES_PER_AXIS = 128;
/** No side goes below this, so the box never inverts. */
export const MIN_GI_VOLUME_SIZE = 0.01;
/** The farthest a probe's rays reach, metres. */
export const MIN_GI_RAY_DISTANCE = 1;
/** The largest probe inset: half a spacing puts each probe at the centre of its cell. */
export const MAX_GI_PROBE_INSET = 0.5;
/** The inset a volume added in the editor starts with (a saved volume without one keeps 0). */
export const DEFAULT_NEW_GI_PROBE_INSET = 0.5;
export const MAX_GI_RAY_DISTANCE = 2000;

export interface GiVolumeOptions {
    size?: [number, number, number];
    probeCounts?: [number, number, number];
    probeInset?: number;
    rays?: number;
    maxRayDistance?: number;
    captureResolution?: number;
    includeGrass?: boolean;
    blendDistance?: number;
    intensity?: number;
    normalBias?: number;
    viewBias?: number;
    multiBounce?: boolean;
    additive?: boolean;
    enabled?: boolean;
    bakeId?: string | null;
}

export class GIVolumeNode extends Node {
    private _size: [number, number, number] = [10, 10, 10];
    private _probeCounts: [number, number, number] = [5, 5, 5];
    private _probeInset = 0;
    private _rays: GiRayCount = 64;
    private _maxRayDistance = 50;
    private _captureResolution: GiCaptureResolution = 32;
    private _blendDistance = 1;
    private _intensity = 1;
    private _normalBias = 0.1;
    private _viewBias = 0.4;
    /** Grass cards in the capture. Off: a meadow occludes nothing a probe a metre up cares about. */
    public includeGrass: boolean;
    /** The bounces after the first (the volume lighting what its rays hit). Off: one bounce. */
    public multiBounce: boolean;
    /**
     * The volume's light ADDED to the fill that lights the box without it (the light probes, the scene
     * ambient, the sky light) instead of replacing it: for a scene whose ambient stands for the dark's own
     * faint light (a dungeon's) rather than the open sky's, which a room's walls would shut out.
     */
    public additive: boolean;
    /** Off leaves the volume in the scene without it lighting anything. */
    public enabled: boolean;
    /** The saved capture this volume loads (a node-owned bake asset), or null: captured at runtime. */
    public bakeId: string | null;
    /** True once the static geometry the capture saw has changed (or nothing was captured yet). */
    private _captureRequested = true;
    private readonly _invScratch = mat4.create();
    private readonly _gridScratch = mat4.create();
    private readonly _distScratch = vec3.create();
    private readonly _boxScratch = mat4.create();

    constructor(name: string, options: GiVolumeOptions = {}, id: string = uuidv4()) {
        super(name, 'giVolume', id);
        if (options.size) this.size = options.size;
        if (options.probeCounts) this.probeCounts = options.probeCounts;
        if (options.probeInset !== undefined) this.probeInset = options.probeInset;
        if (options.rays !== undefined) {
            this.rays = options.rays;
            // 128 used to read as "between the two" and silently became 64: say what the volume got.
            if (+options.rays !== this._rays) Logger.warn(`GI volume '${name}': ${options.rays} rays per probe is not a choice; it uses ${this._rays} (64 or 256).`, 'Scene');
        }
        if (options.maxRayDistance !== undefined) this.maxRayDistance = options.maxRayDistance;
        if (options.captureResolution !== undefined) this.captureResolution = options.captureResolution;
        if (options.blendDistance !== undefined) this.blendDistance = options.blendDistance;
        if (options.intensity !== undefined) this.intensity = options.intensity;
        if (options.normalBias !== undefined) this.normalBias = options.normalBias;
        if (options.viewBias !== undefined) this.viewBias = options.viewBias;
        this.includeGrass = options.includeGrass ?? false;
        this.multiBounce = options.multiBounce ?? true;
        this.additive = options.additive ?? false;
        this.enabled = options.enabled ?? true;
        this.bakeId = typeof options.bakeId === 'string' && options.bakeId.length > 0 ? options.bakeId : null;
    }

    // --- The grid (changing it invalidates the capture) ---

    public get size(): [number, number, number] { return this._size; }
    public set size(v: [number, number, number]) {
        const s = (x: number) => Math.max(MIN_GI_VOLUME_SIZE, Number.isFinite(+x) ? +x : 0);
        const next: [number, number, number] = [s(v[0]), s(v[1]), s(v[2])];
        if (next[0] !== this._size[0] || next[1] !== this._size[1] || next[2] !== this._size[2]) this._captureRequested = true;
        this._size = next;
    }

    /** Probes along each local axis. */
    public get probeCounts(): [number, number, number] { return this._probeCounts; }
    public set probeCounts(v: [number, number, number]) {
        const c = (x: number) => Math.min(MAX_GI_PROBES_PER_AXIS, Math.max(MIN_GI_PROBES_PER_AXIS,
            Number.isFinite(+x) ? Math.round(+x) : MIN_GI_PROBES_PER_AXIS));
        const next: [number, number, number] = [c(v[0]), c(v[1]), c(v[2])];
        if (next[0] !== this._probeCounts[0] || next[1] !== this._probeCounts[1] || next[2] !== this._probeCounts[2]) this._captureRequested = true;
        this._probeCounts = next;
    }

    /**
     * How far the outer probes stand in from the box's faces, as a fraction of the probe spacing (0 to 0.5).
     * 0 puts them on the faces; 0.5 at the centres of the cells the box divides into.
     */
    public get probeInset(): number { return this._probeInset; }
    public set probeInset(v: number) {
        const next = Math.min(MAX_GI_PROBE_INSET, Math.max(0, Number.isFinite(+v) ? +v : 0));
        if (next !== this._probeInset) this._captureRequested = true;
        this._probeInset = next;
    }

    /** Every probe in the volume. */
    public get probeCount(): number { return this._probeCounts[0] * this._probeCounts[1] * this._probeCounts[2]; }

    /** Rays per probe (64 or 256). Anything else snaps to the nearer one. */
    public get rays(): GiRayCount { return this._rays; }
    public set rays(v: number) {
        const next: GiRayCount = +v > 128 ? 256 : 64;
        if (next !== this._rays) this._captureRequested = true;
        this._rays = next;
    }

    /** Side of a probe's octahedral hit tile: 8 for 64 rays, 16 for 256. */
    public get raySide(): number { return this._rays === 256 ? 16 : 8; }

    /** How far a probe's rays reach, metres. A ray that hits nothing nearer sees the sky. */
    public get maxRayDistance(): number { return this._maxRayDistance; }
    public set maxRayDistance(v: number) {
        const next = Math.min(MAX_GI_RAY_DISTANCE, Math.max(MIN_GI_RAY_DISTANCE, Number.isFinite(+v) ? +v : 50));
        if (next !== this._maxRayDistance) this._captureRequested = true;
        this._maxRayDistance = next;
    }

    /** Side of the cube faces a capture renders (16 or 32). Anything else snaps to the nearer one. */
    public get captureResolution(): GiCaptureResolution { return this._captureResolution; }
    public set captureResolution(v: number) {
        const next: GiCaptureResolution = +v > 24 ? 32 : 16;
        if (next !== this._captureResolution) this._captureRequested = true;
        this._captureResolution = next;
    }

    // --- How the volume applies (no re-capture) ---

    /** Feather width in world units: the volume's light fades out over this distance inside the faces. */
    public get blendDistance(): number { return this._blendDistance; }
    public set blendDistance(v: number) { this._blendDistance = Math.max(0, Number.isFinite(+v) ? +v : 0); }

    /** Scales the volume's light. */
    public get intensity(): number { return this._intensity; }
    public set intensity(v: number) { this._intensity = Math.max(0, Number.isFinite(+v) ? +v : 1); }

    /**
     * How far a lookup point is pushed off the surface along its normal, as a fraction of the smallest probe
     * spacing — what keeps a surface from being shadowed by itself in the probes' visibility.
     */
    public get normalBias(): number { return this._normalBias; }
    public set normalBias(v: number) { this._normalBias = Math.min(2, Math.max(0, Number.isFinite(+v) ? +v : 0.1)); }

    /** How far a lookup point is pulled toward the camera, as a fraction of the smallest probe spacing. */
    public get viewBias(): number { return this._viewBias; }
    public set viewBias(v: number) { this._viewBias = Math.min(2, Math.max(0, Number.isFinite(+v) ? +v : 0.4)); }

    // --- Capture state (renderer-facing, never saved) ---

    /** Whether the capture must be taken again: nothing captured yet, or the grid or what it sees changed. */
    public get captureRequested(): boolean { return this._captureRequested; }
    /** Ask for a fresh capture (the editor's Bake button, a static-geometry change). */
    public requestCapture(): void { this._captureRequested = true; }
    /** The renderer took the capture. */
    public markCaptured(): void { this._captureRequested = false; }

    // --- Geometry ---

    /** Distance between neighbouring probes along each local axis, in local units. */
    public get localSpacing(): [number, number, number] {
        const s = this._size, n = this._probeCounts, e = 2 * this._probeInset;
        return [s[0] / (n[0] - 1 + e), s[1] / (n[1] - 1 + e), s[2] / (n[2] - 1 + e)];
    }

    /** Distance between neighbouring probes along each axis, in world units. */
    public get worldSpacing(): [number, number, number] {
        const l = this.localSpacing, k = this.worldScale;
        return [Math.abs(l[0] * k[0]), Math.abs(l[1] * k[1]), Math.abs(l[2] * k[2])];
    }

    /** The smallest world spacing: what the biases are fractions of. */
    public get minSpacing(): number {
        const w = this.worldSpacing;
        return Math.min(w[0], w[1], w[2]);
    }

    /**
     * Grid coordinates -> world: (i, j, k) of a probe to its world position. Probe (0, 0, 0) sits at the
     * box's minimum corner, moved in by the inset.
     */
    public gridToWorld(out: mat4): mat4 {
        const s = this._size, sp = this.localSpacing, e = this._probeInset;
        mat4.translate(out, this.worldTransform, [(e * sp[0]) - 0.5 * s[0], (e * sp[1]) - 0.5 * s[1], (e * sp[2]) - 0.5 * s[2]]);
        return mat4.scale(out, out, sp);
    }

    /** World -> grid coordinates (fractional), the inverse of {@link gridToWorld}. */
    public worldToGrid(out: mat4): mat4 {
        this.gridToWorld(this._gridScratch);
        return mat4.invert(out, this._gridScratch) ?? mat4.identity(out);
    }

    /** World position of probe (i, j, k). */
    public probeWorldPosition(out: vec3, i: number, j: number, k: number): vec3 {
        return vec3.transformMat4(out, vec3.set(out, i, j, k), this.gridToWorld(this._gridScratch));
    }

    // --- Influence volume (the box helpers the light probes and exposure volumes share) ---

    /** world -> volume unit cube (containment = |xyz| <= 0.5). */
    public get invVolumeMatrix(): mat4 { return boxInverseMatrix(this._invScratch, this.worldTransform, this._size); }

    /** Per-axis feather as a fraction of the unit cube. */
    public get volumeBlend(): [number, number, number] {
        return boxBlendFractions(this._size, this.worldScale, this._blendDistance);
    }

    /** How much of the volume's light applies at a world point: 1 inside, easing to 0 at the faces. */
    public weightAt(p: vec3): number {
        if (!this.enabled) return 0;
        return boxWeight(p, this.invVolumeMatrix, this.volumeBlend);
    }

    /** The box in cubic metres: the smaller volume is the more specific, and claims first. */
    public get volumeSize(): number {
        const k = this.worldScale, s = this._size;
        return Math.abs(s[0] * k[0] * s[1] * k[1] * s[2] * k[2]);
    }

    /** World distance from `p` to the box: 0 inside. */
    public distanceToVolume(p: vec3): number {
        const inv = this.invVolumeMatrix;
        const q = vec3.transformMat4(this._distScratch, p, inv);
        const cx = Math.min(0.5, Math.max(-0.5, q[0])), cy = Math.min(0.5, Math.max(-0.5, q[1])), cz = Math.min(0.5, Math.max(-0.5, q[2]));
        if (cx === q[0] && cy === q[1] && cz === q[2]) return 0;
        const box = mat4.invert(this._boxScratch, inv);
        if (!box) return vec3.distance(p, this.worldPosition);
        const nearest = vec3.transformMat4(this._distScratch, vec3.set(this._distScratch, cx, cy, cz), box);
        return vec3.distance(p, nearest);
    }

    public getBoundingBox(): { min: vec3, max: vec3 } { return boxWorldBounds(this.worldTransform, this._size); }

    protected _serializePayload(): any {
        return {
            giVolume: {
                size: [...this._size], probeCounts: [...this._probeCounts], probeInset: this._probeInset, rays: this._rays,
                maxRayDistance: this._maxRayDistance, captureResolution: this._captureResolution,
                includeGrass: this.includeGrass, blendDistance: this._blendDistance, intensity: this._intensity,
                normalBias: this._normalBias, viewBias: this._viewBias, multiBounce: this.multiBounce, additive: this.additive,
                enabled: this.enabled, bakeId: this.bakeId,
            },
        };
    }

    public static parse(parent: Node, json: any) {
        const node = new GIVolumeNode(json.name, json.giVolume ?? {}, json.id);
        Node.finishParse(node, parent, json);
    }
}

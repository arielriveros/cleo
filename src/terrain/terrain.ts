// Aliased: `Material` in this file already means the graphics material imported below.
import { Body, Heightfield, World, Material as PhysicsMaterial } from 'cannon-es';
import { vec3 } from 'gl-matrix';
import { v4 as uuidv4 } from 'uuid';
import { Geometry } from '../core/geometry';
import { bytesToBase64, base64ToBytes } from '../core/base64';
import { Model } from '../graphics/model';
import { Material, TerrainMaterial, TerrainFoliageRule } from '../graphics/material';
import { Texture } from '../graphics/texture';
import { TextureManager } from '../graphics/systems/textureManager';
import { Loader } from '../graphics/loader';
import { Logger } from '../core/logger';
import { FoliageLayer } from './foliage';

/** One paintable terrain material layer (splat channel 0..3). */
export interface TerrainLayer {
    /** Derived albedo texture id (TextureManager) or null. */
    albedoId: string | null;
    /** Derived normal-map id or null. */
    normalId: string | null;
    /** Derived displacement/height map id or null (r = height 0..1). */
    dispId: string | null;
    /** Parallax strength for the displacement map. */
    dispScale: number;
    /** Height-aware blend sharpness (0 = linear splat blend). */
    heightBlend: number;
    /** Albedo tint / base color (multiplies the albedo texture). */
    color: number[];
    metallic: number;
    roughness: number;
    /** UV repeat across the whole terrain. */
    tiling: number;
    /** Enable automatic height/slope masking for this layer. */
    auto: boolean;
    /** World-Y band the layer is visible in (auto blend). */
    hRange: [number, number];
    /** Slope band (0 flat .. 1 vertical) the layer is visible in (auto blend). */
    sRange: [number, number];
    /** Assigned terrain material (surface + foliage rules), if any. */
    material: TerrainMaterial | null;
    /** Terrain-material asset id (for scene serialize + edit-propagation). */
    materialId: string | null;
    /** @deprecated Legacy plain-albedo id; accepted by setLayer for back-compat with old scenes. */
    textureId?: string | null;
}

export type PaintBrush = { radius: number; strength: number; falloff: number; layer: number };

export type SculptMode = 'raise' | 'lower' | 'smooth' | 'flatten';

export interface SculptBrush {
    /** Brush radius in world units. */
    radius: number;
    /** Height change per second at the brush centre (world units). */
    strength: number;
    /** 0 = hard edge, 1 = fully feathered falloff. */
    falloff: number;
    mode: SculptMode;
    /** Target height for the 'flatten' mode (terrain-local Y). */
    flattenHeight?: number;
}

export interface TerrainConfig {
    /** World size of one side of the (square) terrain. */
    size?: number;
    /** Number of vertices per side (resolution). Heightfield is resolution x resolution. */
    resolution?: number;
    /** Quads per side of each render chunk (keeps each chunk under the 65k Uint16 index limit). */
    chunkQuads?: number;
}

/** One render tile of the terrain: a Model whose geometry Y is driven by the shared height field. */
export interface TerrainChunk {
    model: Model;
    /** Inclusive global grid column/row range this chunk covers. */
    c0: number; r0: number; c1: number; r1: number;
    /** Marked when its geometry has been re-deformed and needs a GPU re-upload. */
    dirty: boolean;
    /** Terrain-local Y extent of this chunk (its AABB, kept in sync with the heights). */
    minY: number; maxY: number;
    /** Detail level currently selected for this chunk (0 = full). */
    lod: number;
    /** Vertex steps of the coarse index buffers currently uploaded, or null if none are. */
    lodSteps: [number, number] | null;
}

/** Distance-based terrain LOD configuration (owned by the Renderer, applied per chunk per frame). */
export interface TerrainLodSettings {
    enabled: boolean;
    /** World distance past which a chunk drops to level 1 / level 2. */
    distance1: number;
    distance2: number;
    /** Vertex step of level 1 / level 2 (2, 4 or 8): triangles scale by 1/step². */
    step1: number;
    step2: number;
}

const ATTRIBUTES = ['position', 'normal', 'uv', 'tangent', 'bitangent'];

function resolveConfig(c: TerrainConfig): Required<TerrainConfig> {
    return {
        size: c.size ?? 200,
        resolution: Math.max(2, Math.floor(c.resolution ?? 129)),
        chunkQuads: Math.max(4, Math.floor(c.chunkQuads ?? 32)),
    };
}

/**
 * Heightfield terrain: data (heights) + physics + render chunks, independent of the scene graph.
 * Owned by a LandscapeNode which wraps each chunk Model in a child ModelNode. Sculpting/importing
 * mutate the shared `_heights` grid; the affected chunk geometries are re-deformed and flagged dirty,
 * and the node re-uploads them to the GPU. A single static cannon-es Heightfield body provides
 * walkable collision and is rebuilt on demand (after a stroke) rather than every frame.
 *
 * Assumes the owning node has no rotation/scale (identity orientation); terrain-local space then
 * differs from world space only by the node's translation.
 */
export class Terrain {
    private _cfg: Required<TerrainConfig>;
    private _R: number;              // vertices per side
    private _element: number;        // world spacing between samples
    private _heights: Float32Array;  // row-major [r * R + c]
    private _chunks: TerrainChunk[] = [];
    private _material: Material;

    private _world: World | null = null;
    private _body: Body | null = null;
    /** Surface the heightfield collides as; supplied by PhysicsSystem. See ensureRegistered. */
    private _physicsMaterial: PhysicsMaterial | null = null;
    private _bodyDirty = false;
    private _lastBodyBuild = 0;       // throttles heightfield rebuilds during a sculpt drag
    private _origin = vec3.create();  // node world position, terrain centre

    // Texture painting (splat map + up to 4 layers).
    private _splatRes: number;
    private _splat: Uint8Array;       // RGBA per texel, row-major
    private _splatTex: Texture;
    private _splatId: string;
    private _layers: TerrainLayer[] = [];
    private _foliage: FoliageLayer[] = [];
    // Runtime foliage layers created on demand for material-driven scatter, keyed by prototype name.
    private _foliageByKey: Map<string, FoliageLayer> = new Map();

    constructor(config: TerrainConfig = {}, material?: Material) {
        this._cfg = resolveConfig(config);
        this._R = this._cfg.resolution;
        this._element = this._cfg.size / (this._R - 1);
        this._heights = new Float32Array(this._R * this._R);
        this._material = material ?? Material.Terrain({ baseColor: [0.38, 0.5, 0.28] }, { side: 'front' });

        // Splat map: same resolution as the height grid. Default: full weight in layer 0 (R channel).
        this._splatRes = this._R;
        this._splat = new Uint8Array(this._splatRes * this._splatRes * 4);
        for (let i = 0; i < this._splatRes * this._splatRes; i++) this._splat[i * 4] = 255;
        this._splatTex = new Texture({ mipMap: false, wrapping: 'clamp' });
        this._splatTex.createFromData(this._splat, this._splatRes, this._splatRes);
        this._splatId = `__editor__terrain_splat_${uuidv4()}`;
        TextureManager.Instance.addTexture(this._splatTex, this._splatId);
        this._material.textures.set('u_splat', this._splatId);

        this._buildChunks();
    }

    public get config(): Required<TerrainConfig> { return this._cfg; }
    public get chunks(): TerrainChunk[] { return this._chunks; }
    public get heights(): Float32Array { return this._heights; }
    public get resolution(): number { return this._R; }
    public get size(): number { return this._cfg.size; }
    public get elementSize(): number { return this._element; }
    public set material(m: Material) {
        this._material = m;
        for (const ch of this._chunks) ch.model.material = m;
    }
    public get material(): Material { return this._material; }
    public setOrigin(worldPos: vec3): void { vec3.copy(this._origin, worldPos); }

    // --- height sampling ----------------------------------------------------------------------

    /** Bilinear height at terrain-local (x, z). Returns 0 outside the terrain footprint. */
    public heightAt(localX: number, localZ: number): number {
        const half = this._cfg.size / 2;
        const gx = (localX + half) / this._element;
        const gz = (localZ + half) / this._element;
        if (gx < 0 || gz < 0 || gx > this._R - 1 || gz > this._R - 1) return 0;
        const c0 = Math.floor(gx), r0 = Math.floor(gz);
        const c1 = Math.min(c0 + 1, this._R - 1), r1 = Math.min(r0 + 1, this._R - 1);
        const fx = gx - c0, fz = gz - r0;
        const R = this._R;
        const h00 = this._heights[r0 * R + c0], h10 = this._heights[r0 * R + c1];
        const h01 = this._heights[r1 * R + c0], h11 = this._heights[r1 * R + c1];
        const a = h00 + (h10 - h00) * fx;
        const b = h01 + (h11 - h01) * fx;
        return a + (b - a) * fz;
    }

    /** Analytic (seamless) surface normal at grid indices via central differences. */
    private _normalAt(c: number, r: number, out: [number, number, number]): void {
        const R = this._R, e = this._element;
        const cl = Math.max(0, c - 1), cr = Math.min(R - 1, c + 1);
        const rd = Math.max(0, r - 1), ru = Math.min(R - 1, r + 1);
        const dhx = (this._heights[r * R + cr] - this._heights[r * R + cl]) / ((cr - cl) * e || e);
        const dhz = (this._heights[ru * R + c] - this._heights[rd * R + c]) / ((ru - rd) * e || e);
        const nx = -dhx, ny = 1, nz = -dhz;
        const len = Math.hypot(nx, ny, nz) || 1;
        out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
    }

    // --- chunk geometry -----------------------------------------------------------------------

    private _buildChunks(): void {
        this._chunks = [];
        const quads = this._R - 1;
        const step = this._cfg.chunkQuads;
        for (let r0 = 0; r0 < quads; r0 += step) {
            for (let c0 = 0; c0 < quads; c0 += step) {
                const c1 = Math.min(c0 + step, quads);
                const r1 = Math.min(r0 + step, quads);
                const geometry = this._buildChunkGeometry(c0, r0, c1, r1);
                const chunk: TerrainChunk = {
                    model: new Model(geometry, this._material),
                    c0, r0, c1, r1, dirty: false,
                    minY: 0, maxY: 0, lod: 0, lodSteps: null,
                };
                this._updateChunkBounds(chunk);
                this._chunks.push(chunk);
            }
        }
    }

    /** Build a chunk geometry spanning global grid cols [c0..c1], rows [r0..r1] (vertices inclusive). */
    private _buildChunkGeometry(c0: number, r0: number, c1: number, r1: number): Geometry {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const tangents: [number, number, number][] = [];
        const bitangents: [number, number, number][] = [];
        const indices: number[] = [];
        const half = this._cfg.size / 2, e = this._element, R = this._R;
        const cols = c1 - c0, rows = r1 - r0;
        const n: [number, number, number] = [0, 1, 0];

        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                const x = -half + c * e;
                const z = -half + r * e;
                positions.push([x, this._heights[r * R + c], z]);
                this._normalAt(c, r, n);
                normals.push([n[0], n[1], n[2]]);
                uvs.push([c / (R - 1), r / (R - 1)]);
                // UVs are axis-aligned (u -> +X, v -> +Z), so the tangent frame is constant. Supplying it
                // explicitly avoids Geometry._calculateTangents, which mis-aligns tangents on indexed
                // meshes (breaks normal maps + parallax). default.vs negates the bitangent, so pass +Z.
                tangents.push([1, 0, 0]);
                bitangents.push([0, 0, 1]);
            }
        }
        const stride = cols + 1;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const tl = r * stride + c, tr = tl + 1;
                const bl = (r + 1) * stride + c, br = bl + 1;
                indices.push(tl, bl, tr, tr, bl, br);
            }
        }
        return new Geometry(positions, normals, uvs, tangents, bitangents, indices);
    }

    /** Rewrite a chunk geometry's Y + normals in place from the current heights and flag it dirty. */
    private _refreshChunkGeometry(chunk: TerrainChunk): void {
        const g = chunk.model.geometry;
        const positions = g.positions, normals = g.normals;
        const R = this._R;
        const n: [number, number, number] = [0, 1, 0];
        let i = 0;
        for (let r = chunk.r0; r <= chunk.r1; r++) {
            for (let c = chunk.c0; c <= chunk.c1; c++) {
                const i3 = i * 3;
                positions[i3 + 1] = this._heights[r * R + c];
                this._normalAt(c, r, n);
                normals[i3] = n[0]; normals[i3 + 1] = n[1]; normals[i3 + 2] = n[2];
                i++;
            }
        }
        this._updateChunkBounds(chunk);
        chunk.dirty = true;
    }

    /** Refresh a chunk's terrain-local Y extent from the height grid (the Y half of its LOD-distance AABB). */
    private _updateChunkBounds(chunk: TerrainChunk): void {
        const R = this._R;
        let min = Infinity, max = -Infinity;
        for (let r = chunk.r0; r <= chunk.r1; r++) {
            for (let c = chunk.c0; c <= chunk.c1; c++) {
                const h = this._heights[r * R + c];
                if (h < min) min = h;
                if (h > max) max = h;
            }
        }
        chunk.minY = isFinite(min) ? min : 0;
        chunk.maxY = isFinite(max) ? max : 0;
    }

    private _markRegionDirty(cMin: number, rMin: number, cMax: number, rMax: number): void {
        for (const ch of this._chunks) {
            if (ch.c1 < cMin || ch.c0 > cMax || ch.r1 < rMin || ch.r0 > rMax) continue;
            this._refreshChunkGeometry(ch);
        }
        this._bodyDirty = true;
    }

    // --- level of detail ----------------------------------------------------------------------

    /**
     * Coarse index set for a chunk at the given vertex `step` (2/4/8), over the chunk's UNCHANGED
     * full-resolution vertex buffer — an LOD level only decimates the triangulation, never the vertices.
     *
     * The chunk's border ring is kept at full resolution and fan-stitched to the decimated interior: every
     * chunk edge therefore uses the exact same vertices at every level, so two neighbours at different
     * levels always agree on their shared edge and no T-junction cracks can appear — whatever the
     * combination of levels, with no neighbour bookkeeping.
     */
    public buildLodIndices(chunk: TerrainChunk, step: number): number[] {
        const cols = chunk.c1 - chunk.c0, rows = chunk.r1 - chunk.r0;
        const stride = cols + 1;
        const v = (i: number, j: number) => j * stride + i;
        const indices: number[] = [];

        // Too small to decimate (the stitching needs at least a 2x2 grid of coarse cells): stay full-res.
        if (step < 2 || cols < 2 * step || rows < 2 * step) {
            for (let j = 0; j < rows; j++)
                for (let i = 0; i < cols; i++)
                    indices.push(v(i, j), v(i, j + 1), v(i + 1, j), v(i + 1, j), v(i, j + 1), v(i + 1, j + 1));
            return indices;
        }

        // Cell boundaries along each axis. The last cell absorbs the remainder when the chunk isn't a
        // whole number of steps across (edge chunks of a terrain whose resolution isn't a power of two + 1).
        const cuts = (n: number): number[] => {
            const out: number[] = [];
            for (let x = 0; x < n; x += step) out.push(x);
            out.push(n);
            return out;
        };
        const cutsX = cuts(cols), cutsZ = cuts(rows);

        for (let b = 0; b < cutsZ.length - 1; b++) {
            for (let a = 0; a < cutsX.length - 1; a++) {
                const x0 = cutsX[a], x1 = cutsX[a + 1];
                const z0 = cutsZ[b], z1 = cutsZ[b + 1];
                const onBorder = x0 === 0 || x1 === cols || z0 === 0 || z1 === rows;
                if (!onBorder) {
                    // Interior: a plain quad, same winding as the full-res builder.
                    indices.push(v(x0, z0), v(x0, z1), v(x1, z0), v(x1, z0), v(x0, z1), v(x1, z1));
                    continue;
                }

                // Walk the cell's outline (x0,z0) -> (x0,z1) -> (x1,z1) -> (x1,z0), subdividing into single
                // grid steps every edge that lies on the chunk border so it keeps all its real vertices.
                const ring: number[] = [];
                const edge = (
                    fromI: number, fromJ: number, toI: number, toJ: number, subdivide: boolean,
                ) => {
                    ring.push(v(fromI, fromJ));
                    if (!subdivide) return;
                    const di = Math.sign(toI - fromI), dj = Math.sign(toJ - fromJ);
                    const n = Math.abs(toI - fromI) + Math.abs(toJ - fromJ);
                    for (let k = 1; k < n; k++) ring.push(v(fromI + di * k, fromJ + dj * k));
                };
                edge(x0, z0, x0, z1, x0 === 0);
                edge(x0, z1, x1, z1, z1 === rows);
                edge(x1, z1, x1, z0, x1 === cols);
                edge(x1, z0, x0, z0, z0 === 0);

                // Fan from the corner that lies on no subdivided edge (guaranteed to exist by the 2*step
                // guard above), so no fan triangle degenerates onto a border edge.
                const xa = x0 === 0 ? x1 : x0;
                const za = z0 === 0 ? z1 : z0;
                const apex = ring.indexOf(v(xa, za));
                const n = ring.length;
                for (let k = 1; k <= n - 2; k++)
                    indices.push(ring[apex], ring[(apex + k) % n], ring[(apex + k + 1) % n]);
            }
        }
        return indices;
    }

    /** Detail level (0/1/2) for a chunk at this camera position, with hysteresis around the thresholds. */
    public lodFor(chunk: TerrainChunk, camPos: vec3, s: TerrainLodSettings): number {
        const half = this._cfg.size / 2, e = this._element;
        const minX = this._origin[0] - half + chunk.c0 * e, maxX = this._origin[0] - half + chunk.c1 * e;
        const minZ = this._origin[2] - half + chunk.r0 * e, maxZ = this._origin[2] - half + chunk.r1 * e;
        const minY = this._origin[1] + chunk.minY, maxY = this._origin[1] + chunk.maxY;
        // Distance to the closest point of the chunk's world AABB (0 when the camera is inside it).
        const dx = camPos[0] < minX ? minX - camPos[0] : (camPos[0] > maxX ? camPos[0] - maxX : 0);
        const dy = camPos[1] < minY ? minY - camPos[1] : (camPos[1] > maxY ? camPos[1] - maxY : 0);
        const dz = camPos[2] < minZ ? minZ - camPos[2] : (camPos[2] > maxZ ? camPos[2] - maxZ : 0);
        const d = Math.hypot(dx, dy, dz);

        let lod = 0;
        if (d >= s.distance2) lod = 2;
        else if (d >= s.distance1) lod = 1;
        // Refine only once comfortably inside the threshold, so a camera sitting on a boundary doesn't
        // flip a chunk's triangulation every frame.
        if (lod < chunk.lod) {
            if (chunk.lod === 2 && d >= s.distance2 * 0.9) return 2;
            if (lod === 0 && d >= s.distance1 * 0.9) return 1;
        }
        return lod;
    }

    // --- editing ------------------------------------------------------------------------------

    /**
     * Apply a sculpt brush at a world-space point (dt-scaled). Returns true if any height changed.
     * Marks affected chunks dirty (the node re-uploads them) and the physics body for rebuild.
     */
    public sculpt(worldPoint: vec3, brush: SculptBrush, dt: number): boolean {
        const half = this._cfg.size / 2, e = this._element, R = this._R;
        const lx = worldPoint[0] - this._origin[0];
        const lz = worldPoint[2] - this._origin[2];
        const rad = brush.radius;
        const cMin = Math.max(0, Math.floor((lx - rad + half) / e));
        const cMax = Math.min(R - 1, Math.ceil((lx + rad + half) / e));
        const rMin = Math.max(0, Math.floor((lz - rad + half) / e));
        const rMax = Math.min(R - 1, Math.ceil((lz + rad + half) / e));
        if (cMin > cMax || rMin > rMax) return false;

        const amount = brush.strength * dt;
        const flatten = brush.flattenHeight ?? this.heightAt(lx, lz);
        let changed = false;

        // For smoothing, snapshot the region so neighbour averaging is order-independent.
        const snapshot = brush.mode === 'smooth' ? this._heights.slice() : null;

        for (let r = rMin; r <= rMax; r++) {
            for (let c = cMin; c <= cMax; c++) {
                const vx = -half + c * e, vz = -half + r * e;
                const d = Math.hypot(vx - lx, vz - lz);
                if (d > rad) continue;
                // Smooth falloff: 1 at centre, ->0 at edge (falloff controls softness).
                const t = d / rad;
                const w = brush.falloff <= 0 ? 1 : Math.pow(1 - t, brush.falloff * 3);
                const idx = r * R + c;
                let h = this._heights[idx];
                switch (brush.mode) {
                    case 'raise': h += amount * w; break;
                    case 'lower': h -= amount * w; break;
                    case 'flatten': h += (flatten - h) * Math.min(1, Math.abs(amount) * w); break;
                    case 'smooth': {
                        const s = snapshot!;
                        const cl = Math.max(0, c - 1), cr = Math.min(R - 1, c + 1);
                        const rd = Math.max(0, r - 1), ru = Math.min(R - 1, r + 1);
                        const avg = (s[r * R + cl] + s[r * R + cr] + s[rd * R + c] + s[ru * R + c] + s[idx]) / 5;
                        h += (avg - h) * Math.min(1, Math.abs(amount) * w);
                        break;
                    }
                }
                if (h !== this._heights[idx]) { this._heights[idx] = h; changed = true; }
            }
        }
        if (changed) this._markRegionDirty(cMin, rMin, cMax, rMax);
        return changed;
    }

    /** Fill this terrain's height field by resampling another terrain's surface (bilinear), stretching its
     *  shape to this grid. Used by "Update Terrain" to preserve sculpting across a size/resolution change. */
    public resampleHeightsFrom(other: Terrain): void {
        const R = this._R, oldSize = other.size;
        for (let r = 0; r < R; r++) {
            for (let c = 0; c < R; c++) {
                const fracX = R > 1 ? c / (R - 1) : 0;
                const fracZ = R > 1 ? r / (R - 1) : 0;
                this._heights[r * R + c] = other.heightAt((fracX - 0.5) * oldSize, (fracZ - 0.5) * oldSize);
            }
        }
        for (const ch of this._chunks) this._refreshChunkGeometry(ch);
        this._bodyDirty = true;
    }

    /** Replace the height field from a heightmap image's red channel, scaled to [0, amplitude]. */
    public async importHeightmap(path: string, amplitude: number): Promise<void> {
        const image = await Loader.ImageToArray(path);
        const R = this._R;
        for (let r = 0; r < R; r++) {
            for (let c = 0; c < R; c++) {
                // Sample the image with normalized coords (nearest).
                const sx = Math.min(image.width - 1, Math.floor((c / (R - 1)) * (image.width - 1)));
                const sy = Math.min(image.height - 1, Math.floor((r / (R - 1)) * (image.height - 1)));
                const red = image.data[(sy * image.width + sx) * 4] / 255;
                this._heights[r * R + c] = red * amplitude;
            }
        }
        for (const ch of this._chunks) this._refreshChunkGeometry(ch);
        this._bodyDirty = true;
    }

    /** Render the current height field to a grayscale PNG data URL (normalized to its own min..max). */
    public exportHeightmap(): string {
        const R = this._R;
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < this._heights.length; i++) {
            const h = this._heights[i];
            if (h < min) min = h;
            if (h > max) max = h;
        }
        if (!isFinite(min)) { min = 0; max = 0; }
        const span = (max - min) || 1;
        const canvas = document.createElement('canvas');
        canvas.width = R; canvas.height = R;
        const ctx = canvas.getContext('2d')!;
        const img = ctx.createImageData(R, R);
        for (let i = 0; i < R * R; i++) {
            const v = Math.round(((this._heights[i] - min) / span) * 255);
            img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return canvas.toDataURL('image/png');
    }

    // --- texture layers & painting ------------------------------------------------------------

    public get layers(): TerrainLayer[] { return this._layers; }
    public get splatId(): string { return this._splatId; }

    private _defaultLayer(): TerrainLayer {
        return {
            albedoId: null, normalId: null, dispId: null, dispScale: 0.05, heightBlend: 0,
            color: [1, 1, 1], metallic: 0, roughness: 1,
            tiling: 20, auto: false, hRange: [0, 100], sRange: [0, 1],
            material: null, materialId: null,
        };
    }

    /** Read the per-layer surface (albedo/normal/displacement + scalar factors) out of a paint-layer
     *  material, mapping each base shading model's texture/property keys to the terrain-blend inputs.
     *  Displacement (height) is terrain-specific: stored under `displacementMap` for every base type. */
    private _deriveLayerSurface(tm: TerrainMaterial): {
        albedoId: string | null; normalId: string | null; dispId: string | null;
        dispScale: number; heightBlend: number; color: number[]; metallic: number; roughness: number;
    } {
        const p = tm.properties, t = tm.textures, bt = tm.type as unknown as string;
        const dispId = t.get('displacementMap') ?? null;
        const dispScale = tm.displacementScale, heightBlend = tm.heightBlend;
        if (bt === 'basic') {
            return {
                albedoId: t.get('texture') ?? null, normalId: null, dispId, dispScale, heightBlend,
                color: p.get('color') ?? [1, 1, 1], metallic: 0, roughness: 1,
            };
        }
        if (bt === 'pbr') {
            return {
                albedoId: t.get('baseColorTexture') ?? null,
                normalId: t.get('normalMap') ?? null,
                dispId, dispScale, heightBlend,
                color: p.get('baseColor') ?? [1, 1, 1],
                metallic: p.get('metallic') ?? 0,
                roughness: p.get('roughness') ?? 1,
            };
        }
        // blinn_phong
        return {
            albedoId: t.get('baseTexture') ?? null,
            normalId: t.get('normalMap') ?? null,
            dispId, dispScale, heightBlend,
            color: p.get('diffuse') ?? [1, 1, 1],
            metallic: 0, roughness: 0.7,
        };
    }

    /** Push a resolved layer's surface + blend uniforms into the composite terrain material. */
    private _writeLayerUniforms(index: number, L: TerrainLayer): void {
        const m = this._material;
        const setTex = (key: string, id: string | null, hasKey: string) => {
            if (id) { m.textures.set(key, id); m.properties.set(hasKey, 1); }
            else { m.textures.delete(key); m.properties.set(hasKey, 0); }
        };
        setTex(`u_albedo${index}`, L.albedoId, `u_hasAlbedo${index}`);
        setTex(`u_normal${index}`, L.normalId, `u_hasNormal${index}`);
        setTex(`u_disp${index}`, L.dispId, `u_hasDisp${index}`);
        m.properties.set(`u_color${index}`, [L.color[0], L.color[1], L.color[2]]);
        m.properties.set(`u_metallic${index}`, L.metallic);
        m.properties.set(`u_roughness${index}`, L.roughness);
        m.properties.set(`u_dispScale${index}`, L.dispScale);
        m.properties.set(`u_heightBlend${index}`, L.heightBlend);
        m.properties.set(`u_tiling${index}`, L.tiling);
        m.properties.set(`u_auto${index}`, L.auto ? 1 : 0);
        m.properties.set(`u_hRange${index}`, [L.hRange[0], L.hRange[1]]);
        m.properties.set(`u_sRange${index}`, [L.sRange[0], L.sRange[1]]);
    }

    /**
     * Configure a layer slot (0..3) and push its uniforms/textures into the composite terrain material.
     * `source` may be a {@link TerrainMaterial} (its surface + blend defaults are read), or — for
     * back-compat with old saved scenes — a legacy `{ textureId, tiling, auto, ... }` object (treated
     * as a plain Basic albedo). Passing null/undefined keeps the current surface and only applies `opts`.
     * `opts` overrides the blend params (tiling/auto/hRange/sRange) and/or the linked `materialId`.
     */
    public setLayer(index: number, source?: TerrainMaterial | Partial<TerrainLayer> | null, opts: Partial<TerrainLayer> = {}): void {
        if (index < 0 || index > 3) return;
        while (this._layers.length <= index) this._layers.push(this._defaultLayer());
        const L = this._layers[index];

        if (source instanceof TerrainMaterial) {
            const s = this._deriveLayerSurface(source);
            L.material = source; L.materialId = null;
            L.albedoId = s.albedoId; L.normalId = s.normalId; L.dispId = s.dispId;
            L.dispScale = s.dispScale; L.heightBlend = s.heightBlend;
            L.color = s.color; L.metallic = s.metallic; L.roughness = s.roughness;
            L.tiling = source.tiling; L.auto = source.auto;
            L.hRange = [source.hRange[0], source.hRange[1]];
            L.sRange = [source.sRange[0], source.sRange[1]];
        } else if (source && 'textureId' in source) {
            // Legacy plain-albedo layer (old scenes / basic texture pick).
            L.material = null; L.materialId = null;
            L.albedoId = source.textureId ?? null;
            L.normalId = null; L.dispId = null;
            L.dispScale = 0.05; L.heightBlend = 0;
            L.color = [1, 1, 1]; L.metallic = 0; L.roughness = 1;
            if (source.tiling !== undefined) L.tiling = source.tiling;
            if (source.auto !== undefined) L.auto = source.auto;
            if (source.hRange) L.hRange = [source.hRange[0], source.hRange[1]];
            if (source.sRange) L.sRange = [source.sRange[0], source.sRange[1]];
        }
        // else: keep existing surface/material; only opts below take effect.

        if (opts.tiling !== undefined) L.tiling = opts.tiling;
        if (opts.auto !== undefined) L.auto = opts.auto;
        if (opts.hRange) L.hRange = [opts.hRange[0], opts.hRange[1]];
        if (opts.sRange) L.sRange = [opts.sRange[0], opts.sRange[1]];
        if (opts.materialId !== undefined) L.materialId = opts.materialId;

        this._writeLayerUniforms(index, L);
        this._syncLayerUniforms();
    }

    /** Clear a layer slot (0..3): drop its material/surface and its composite uniforms. */
    public clearLayer(index: number): void {
        if (index < 0 || index > 3 || index >= this._layers.length) return;
        this._layers[index] = this._defaultLayer();
        this._writeLayerUniforms(index, this._layers[index]);
        this._syncLayerUniforms();
    }

    private _layerActive(L: TerrainLayer | undefined): boolean {
        return !!L && (!!L.material || !!L.albedoId);
    }

    private _syncLayerUniforms(): void {
        let count = 0;
        for (let i = 0; i < this._layers.length; i++) if (this._layerActive(this._layers[i])) count = i + 1;
        this._material.properties.set('u_layerCount', count);
        let useAuto = 0;
        for (const L of this._layers) if (L?.auto) useAuto = 1;
        this._material.properties.set('u_useAuto', useAuto);
    }

    /**
     * Paint the active layer's weight into the splat map at a world point (dt-scaled), renormalizing the
     * four channel weights to sum to 1, then upload the dirty sub-rectangle. Returns true if anything changed.
     */
    public paint(worldPoint: vec3, brush: PaintBrush, dt: number): boolean {
        const layer = brush.layer;
        if (layer < 0 || layer > 3) return false;
        const S = this._splatRes, half = this._cfg.size / 2, e = this._cfg.size / (S - 1);
        const lx = worldPoint[0] - this._origin[0], lz = worldPoint[2] - this._origin[2];
        const rad = brush.radius;
        const cMin = Math.max(0, Math.floor((lx - rad + half) / e));
        const cMax = Math.min(S - 1, Math.ceil((lx + rad + half) / e));
        const rMin = Math.max(0, Math.floor((lz - rad + half) / e));
        const rMax = Math.min(S - 1, Math.ceil((lz + rad + half) / e));
        if (cMin > cMax || rMin > rMax) return false;

        const gain = Math.min(1, brush.strength * dt);
        const ch = [0, 0, 0, 0];
        let changed = false;
        for (let r = rMin; r <= rMax; r++) {
            for (let c = cMin; c <= cMax; c++) {
                const vx = -half + c * e, vz = -half + r * e;
                const d = Math.hypot(vx - lx, vz - lz);
                if (d > rad) continue;
                const t = d / rad;
                const w = brush.falloff <= 0 ? 1 : Math.pow(1 - t, brush.falloff * 3);
                const add = gain * w;
                const idx = (r * S + c) * 4;
                ch[0] = this._splat[idx] / 255; ch[1] = this._splat[idx + 1] / 255;
                ch[2] = this._splat[idx + 2] / 255; ch[3] = this._splat[idx + 3] / 255;
                ch[layer] = ch[layer] + (1 - ch[layer]) * add;
                const remaining = 1 - ch[layer];
                const othersSum = ch[0] + ch[1] + ch[2] + ch[3] - ch[layer];
                if (othersSum > 1e-5) {
                    const scale = remaining / othersSum;
                    for (let k = 0; k < 4; k++) if (k !== layer) ch[k] *= scale;
                }
                this._splat[idx] = Math.round(ch[0] * 255); this._splat[idx + 1] = Math.round(ch[1] * 255);
                this._splat[idx + 2] = Math.round(ch[2] * 255); this._splat[idx + 3] = Math.round(ch[3] * 255);
                changed = true;
            }
        }
        if (changed) {
            const w = cMax - cMin + 1, h = rMax - rMin + 1;
            const sub = new Uint8Array(w * h * 4);
            for (let r = 0; r < h; r++) {
                const srcStart = ((rMin + r) * S + cMin) * 4;
                sub.set(this._splat.subarray(srcStart, srcStart + w * 4), r * w * 4);
            }
            this._splatTex.updateRegion(cMin, rMin, w, h, sub);
        }
        return changed;
    }

    // --- foliage ------------------------------------------------------------------------------

    public get foliage(): FoliageLayer[] { return this._foliage; }

    public addFoliage(layer: FoliageLayer): FoliageLayer { this._foliage.push(layer); return layer; }

    private _heightSampler = (wx: number, wz: number): number =>
        this._origin[1] + this.heightAt(wx - this._origin[0], wz - this._origin[2]);

    /** Scatter foliage instances for a layer at a world point. */
    public scatterFoliage(index: number, worldPoint: vec3, radius: number): boolean {
        const layer = this._foliage[index];
        if (!layer) return false;
        return layer.scatter(worldPoint[0], worldPoint[2], radius, this._heightSampler);
    }

    /** Erase foliage instances for a layer near a world point. */
    public eraseFoliage(index: number, worldPoint: vec3, radius: number): boolean {
        const layer = this._foliage[index];
        if (!layer) return false;
        return layer.erase(worldPoint[0], worldPoint[2], radius);
    }

    /** Nearest-texel RGBA splat weights (0..1) at a terrain-local point, matching paint()'s mapping. */
    public sampleSplat(localX: number, localZ: number, out: [number, number, number, number]): void {
        const S = this._splatRes, half = this._cfg.size / 2, e = this._cfg.size / (S - 1);
        let c = Math.round((localX + half) / e);
        let r = Math.round((localZ + half) / e);
        c = Math.max(0, Math.min(S - 1, c));
        r = Math.max(0, Math.min(S - 1, r));
        const idx = (r * S + c) * 4;
        out[0] = this._splat[idx] / 255; out[1] = this._splat[idx + 1] / 255;
        out[2] = this._splat[idx + 2] / 255; out[3] = this._splat[idx + 3] / 255;
    }

    /** Every foliage prototype contributed by an assigned layer material, tagged with its layer index. */
    private _activeFoliageRules(): { rule: TerrainFoliageRule; layerIndex: number }[] {
        const out: { rule: TerrainFoliageRule; layerIndex: number }[] = [];
        for (let i = 0; i < this._layers.length; i++) {
            const m = this._layers[i]?.material;
            if (!m) continue;
            for (const rule of m.foliageInclude) out.push({ rule, layerIndex: i });
        }
        return out;
    }

    /** True if any layer present (weight above threshold) at this point excludes the named foliage. */
    private _foliageExcludedAt(name: string, splat: [number, number, number, number]): boolean {
        for (let k = 0; k < 4; k++) {
            if (splat[k] < 0.15) continue;
            const m = this._layers[k]?.material;
            if (m && m.foliageExclude.includes(name)) return true;
        }
        return false;
    }

    /** Lazily create (or reuse) the runtime foliage layer for a prototype, keyed by its name. */
    private _resolveFoliageLayer(rule: TerrainFoliageRule): FoliageLayer {
        let layer = this._foliageByKey.get(rule.name);
        if (!layer) {
            layer = FoliageLayer.fromRule(rule);
            this._foliageByKey.set(rule.name, layer);
            this._foliage.push(layer);
        }
        return layer;
    }

    /**
     * Re-derive every active foliage layer's prototypes (LOD models, billboard impostor, cull distance,
     * scatter params) from its current rule, PRESERVING the scattered instances. Called by the editor
     * after the source mesh asset or terrain material was edited — never re-scatters.
     */
    public refreshFoliagePrototypes(): void {
        for (const { rule } of this._activeFoliageRules()) {
            const layer = this._foliageByKey.get(rule.name);
            if (layer) layer.setPrototype(rule);
        }
    }

    /**
     * Material-driven foliage scatter: for each foliage prototype an assigned layer material includes,
     * place instances (density-controlled) at random disc points where that layer is the dominant one
     * in the splat — skipping any point where a present material excludes that prototype. Instances go
     * into per-prototype runtime layers (created lazily) so the renderer's foliage pass draws them.
     */
    public scatterFoliageFromMaterials(worldPoint: vec3, radius: number): boolean {
        const rules = this._activeFoliageRules();
        if (rules.length === 0) return false;
        const wx = worldPoint[0], wz = worldPoint[2];
        const splat: [number, number, number, number] = [0, 0, 0, 0];
        const touched = new Set<FoliageLayer>();
        for (const { rule, layerIndex } of rules) {
            const density = Math.max(1, Math.floor(rule.density ?? 8));
            for (let i = 0; i < density; i++) {
                const a = Math.random() * Math.PI * 2;
                const rr = Math.sqrt(Math.random()) * radius;
                const px = wx + Math.cos(a) * rr;
                const pz = wz + Math.sin(a) * rr;
                this.sampleSplat(px - this._origin[0], pz - this._origin[2], splat);
                // Place only where this rule's own layer dominates, and nowhere a present material excludes it.
                let dom = -1, best = 0;
                for (let k = 0; k < 4; k++) if (splat[k] > best) { best = splat[k]; dom = k; }
                if (dom !== layerIndex || best < 1e-3) continue;
                if (this._foliageExcludedAt(rule.name, splat)) continue;
                const y = this._origin[1] + this.heightAt(px - this._origin[0], pz - this._origin[2]);
                const layer = this._resolveFoliageLayer(rule);
                layer.pushInstance(px, y, pz);
                touched.add(layer);
            }
        }
        for (const l of touched) l.commit();
        return touched.size > 0;
    }

    /** Erase foliage instances of every layer near a world point (the material-driven erase brush). */
    public eraseAllFoliage(worldPoint: vec3, radius: number): boolean {
        let any = false;
        for (const layer of this._foliage) if (layer.erase(worldPoint[0], worldPoint[2], radius)) any = true;
        return any;
    }

    /** Erase foliage near a world point EXCEPT layers whose name is in keepNames. Used while painting so a
     *  freshly-painted material's region keeps only that material's own included foliage. */
    public eraseFoliageExcept(worldPoint: vec3, radius: number, keepNames: string[]): boolean {
        let any = false;
        for (const layer of this._foliage) {
            if (keepNames.includes(layer.name)) continue;
            if (layer.erase(worldPoint[0], worldPoint[2], radius)) any = true;
        }
        return any;
    }

    /** Fraction (0..1) of splat texels where layer `index` is the dominant channel. */
    public layerCoverage(index: number): number {
        if (index < 0 || index > 3) return 0;
        const S = this._splatRes;
        let count = 0;
        const total = S * S;
        for (let i = 0; i < total; i++) {
            const b = i * 4;
            let dom = 0, best = this._splat[b];
            for (let k = 1; k < 4; k++) if (this._splat[b + k] > best) { best = this._splat[b + k]; dom = k; }
            if (dom === index) count++;
        }
        return total > 0 ? count / total : 0;
    }

    /**
     * Regenerate material-driven foliage across the ENTIRE terrain: clears existing instances, then for
     * each foliage prototype an assigned layer material includes, scatters jittered points over the whole
     * surface, placing where that rule's layer dominates and no present material excludes it. Density is
     * scaled by area (rule.density is treated as instances per ~100x100 world-unit tile).
     */
    public generateFoliageEverywhere(): boolean {
        const rules = this._activeFoliageRules();
        for (const layer of this._foliage) layer.clear();
        if (rules.length === 0) return false;

        const half = this._cfg.size / 2, size = this._cfg.size;
        const splat: [number, number, number, number] = [0, 0, 0, 0];
        const touched = new Set<FoliageLayer>();
        const areaTiles = Math.max(1, (size * size) / (100 * 100)); // density is per 100x100 tile
        for (const { rule, layerIndex } of rules) {
            const count = Math.max(1, Math.floor((rule.density ?? 8) * areaTiles));
            for (let i = 0; i < count; i++) {
                const lx = -half + Math.random() * size;
                const lz = -half + Math.random() * size;
                this.sampleSplat(lx, lz, splat);
                let dom = -1, best = 0;
                for (let k = 0; k < 4; k++) if (splat[k] > best) { best = splat[k]; dom = k; }
                if (dom !== layerIndex || best < 1e-3) continue;
                if (this._foliageExcludedAt(rule.name, splat)) continue;
                const y = this._origin[1] + this.heightAt(lx, lz);
                const layer = this._resolveFoliageLayer(rule);
                layer.pushInstance(this._origin[0] + lx, y, this._origin[2] + lz);
                touched.add(layer);
            }
        }
        for (const l of this._foliage) l.commit();
        return touched.size > 0;
    }

    // --- picking ------------------------------------------------------------------------------

    /**
     * Analytic ray march against the terrain surface. `origin`/`dir` are world space; returns the
     * world-space hit point or null. Robust and independent of the physics step (works in the editor).
     */
    public raycast(origin: vec3, dir: vec3, maxDistance = 10000): vec3 | null {
        const step = this._element * 0.5;
        let prevT = 0;
        let prevDiff = origin[1] - (this._origin[1] + this.heightAt(origin[0] - this._origin[0], origin[2] - this._origin[2]));
        for (let t = step; t <= maxDistance; t += step) {
            const px = origin[0] + dir[0] * t;
            const py = origin[1] + dir[1] * t;
            const pz = origin[2] + dir[2] * t;
            const surf = this._origin[1] + this.heightAt(px - this._origin[0], pz - this._origin[2]);
            const diff = py - surf;
            if (diff <= 0 && prevDiff > 0) {
                // Crossed the surface between prevT and t: linear-interpolate the crossing.
                const f = prevDiff / (prevDiff - diff);
                const ht = prevT + (t - prevT) * f;
                const hx = origin[0] + dir[0] * ht, hy = origin[1] + dir[1] * ht, hz = origin[2] + dir[2] * ht;
                // Reject crossings outside the terrain footprint (where heightAt clamps to 0).
                const half = this._cfg.size / 2;
                if (Math.abs(hx - this._origin[0]) <= half && Math.abs(hz - this._origin[2]) <= half)
                    return vec3.fromValues(hx, hy, hz);
            }
            prevT = t; prevDiff = diff;
        }
        return null;
    }

    // --- physics ------------------------------------------------------------------------------

    /** Build the cannon-es data grid (data[i][j], i along +X, j along -Z after the body rotation). */
    private _heightfieldData(): number[][] {
        const R = this._R, data: number[][] = new Array(R);
        for (let i = 0; i < R; i++) {
            const col = new Array(R);
            for (let j = 0; j < R; j++) col[j] = this._heights[(R - 1 - j) * R + i];
            data[i] = col;
        }
        return data;
    }

    /**
     * Create/refresh the static Heightfield body and register it with the world (self-heals).
     *
     * `material` is the surface the terrain collides as. It matters even though terrain has no friction
     * settings of its own: cannon only honors a ContactMaterial when BOTH bodies carry a material, so a
     * terrain left material-less would silently force every character back to the world default friction.
     * Kept on the instance so a sculpt rebuild re-applies it.
     */
    public ensureRegistered(world: World, material?: PhysicsMaterial): void {
        this._world = world;
        if (material) this._physicsMaterial = material;
        if (!this._body) {
            const shape = new Heightfield(this._heightfieldData(), { elementSize: this._element });
            const body = new Body({ mass: 0, material: this._physicsMaterial ?? undefined });
            body.addShape(shape);
            body.quaternion.setFromEuler(-Math.PI / 2, 0, 0); // field XY (Z up) -> world XZ (Y up)
            const half = this._cfg.size / 2;
            body.position.set(this._origin[0] - half, this._origin[1], this._origin[2] + half);
            this._body = body;
            world.addBody(body);
            this._bodyDirty = false;
            this._lastBodyBuild = Date.now();
            return;
        }
        if (this._physicsMaterial && this._body.material !== this._physicsMaterial) this._body.material = this._physicsMaterial;
        if (world.bodies.indexOf(this._body) === -1) world.addBody(this._body);
        // Rebuild at most a few times per second so a continuous sculpt drag doesn't rebuild every frame.
        if (this._bodyDirty && Date.now() - this._lastBodyBuild > 200) this._rebuildBody();
    }

    private _rebuildBody(): void {
        if (!this._world || !this._body) return;
        try {
            this._world.removeBody(this._body);
            const shape = new Heightfield(this._heightfieldData(), { elementSize: this._element });
            const body = new Body({ mass: 0, material: this._physicsMaterial ?? undefined });
            body.addShape(shape);
            body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
            const half = this._cfg.size / 2;
            body.position.set(this._origin[0] - half, this._origin[1], this._origin[2] + half);
            this._body = body;
            this._world.addBody(body);
            this._bodyDirty = false;
            this._lastBodyBuild = Date.now();
        } catch (e) {
            Logger.error((e as Error).toString(), 'Terrain');
        }
    }

    public dispose(world?: World): void {
        const w = world || this._world;
        if (w && this._body) w.removeBody(this._body);
        this._body = null;
    }

    // --- serialization ------------------------------------------------------------------------

    public serialize(): any {
        // Quantize heights to Uint16 across their own [min,max] range: ~half the size of Float32 with
        // sub-millimetre precision for typical terrains, and reconstructed exactly enough on load.
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < this._heights.length; i++) {
            const h = this._heights[i];
            if (h < min) min = h;
            if (h > max) max = h;
        }
        if (!isFinite(min)) { min = 0; max = 0; }
        const span = (max - min) || 1;
        const u16 = new Uint16Array(this._heights.length);
        for (let i = 0; i < this._heights.length; i++)
            u16[i] = Math.round(((this._heights[i] - min) / span) * 65535);

        return {
            size: this._cfg.size,
            resolution: this._cfg.resolution,
            chunkQuads: this._cfg.chunkQuads,
            heightFormat: 'u16',
            heightMin: min,
            heightMax: max,
            heights: bytesToBase64(new Uint8Array(u16.buffer)),
            splatRes: this._splatRes,
            splat: bytesToBase64(this._splat),
            layers: this._layers.map(L => ({
                materialId: L.materialId,
                material: L.material ? L.material.serialize() : null,
                textureId: L.material ? null : L.albedoId, // legacy plain-albedo layers
                tiling: L.tiling,
                auto: L.auto,
                hRange: [L.hRange[0], L.hRange[1]],
                sRange: [L.sRange[0], L.sRange[1]],
            })),
            foliage: this._foliage.map(f => f.serialize()),
        };
    }

    public static deserialize(json: any, material?: Material): Terrain {
        const terrain = new Terrain({
            size: json.size, resolution: json.resolution, chunkQuads: json.chunkQuads,
        }, material);
        if (json.heights) {
            const bytes = base64ToBytes(json.heights);
            if (json.heightFormat === 'u16') {
                const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
                const min = json.heightMin ?? 0, max = json.heightMax ?? 1;
                const span = (max - min) || 1;
                const n = Math.min(terrain._heights.length, u16.length);
                for (let i = 0; i < n; i++) terrain._heights[i] = min + (u16[i] / 65535) * span;
            } else {
                // Legacy Float32 heights (scenes saved before the Uint16 format).
                const floats = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
                terrain._heights.set(floats.subarray(0, terrain._heights.length));
            }
            for (const ch of terrain._chunks) terrain._refreshChunkGeometry(ch);
        }
        if (json.splat && json.splatRes === terrain._splatRes) {
            const sbytes = base64ToBytes(json.splat);
            terrain._splat.set(sbytes.subarray(0, terrain._splat.length));
            terrain._splatTex.updateRegion(0, 0, terrain._splatRes, terrain._splatRes, terrain._splat);
        }
        if (Array.isArray(json.layers)) {
            for (let i = 0; i < json.layers.length && i < 4; i++) {
                const lj = json.layers[i];
                if (!lj) continue;
                if (lj.material) {
                    const tm = TerrainMaterial.parse(lj.material);
                    terrain.setLayer(i, tm, {
                        tiling: lj.tiling, auto: lj.auto, hRange: lj.hRange, sRange: lj.sRange,
                        materialId: lj.materialId ?? null,
                    });
                } else {
                    terrain.setLayer(i, lj); // legacy plain-albedo (lj.textureId)
                }
            }
        }
        if (Array.isArray(json.foliage)) {
            for (const f of json.foliage) {
                const layer = FoliageLayer.deserialize(f);
                terrain.addFoliage(layer);
                terrain._foliageByKey.set(layer.name, layer); // reuse on further material-driven scatter
            }
        }
        return terrain;
    }
}

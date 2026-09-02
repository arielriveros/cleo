import { device } from './rhi/deviceHandle';
import { Texture } from './texture';
import { Logger } from '../core/logger';
import {
    DEFAULT_CLUSTER_GRID, DEFAULT_CLUSTER_LIGHT_CAP, buildClusters, buildSingleCluster,
    clusterDepthScaleBias, clusterTileScaleBias,
    type ClusterBuild, type ClusterGrid, type ClusterLight, type ClusterView,
} from './clusters';
import {
    INDICES_PER_TEXEL, LIGHT_DATA_WIDTH, LIGHT_DATA_WIDTH_SHIFT, LIGHT_RECORD_TEXELS,
    lightDataFloats, lightDataLayout, packClusterBuild, packLightRecord,
    type LightDataLayout,
} from './lightData';
import type { ShaderManager } from './systems/shaderManager';

// -----------------------------------------------------------------------------------------------
// The clustered light grid, as a GPU resource: the data texture, the staging buffer that fills it,
// and the handful of uniforms the shader needs to address it.
//
// The math is all in `clusters.ts` and the byte layout in `lightData.ts`, both GL-free and both unit
// tested. What is left here is the part that cannot be: allocating a texture, growing it, and
// uploading. Keeping the split at that seam is what lets the assignment be tested at all — a wrong
// cluster is a light that vanishes from part of the screen, which is indistinguishable from a
// falloff bug by looking at it.
//
// One frame is: `build` (or `buildSingle`), then a `packRecord` per light, then `upload`. The order
// matters — `build` is what decides how long the index list is, and therefore where in the staging
// buffer the records go.
// -----------------------------------------------------------------------------------------------

/** Lights past this are dropped. A MEMORY budget — the record region's size — not a shader array. */
export const MAX_LIGHTS = 1024;

export class LightGrid {
    private _texture: Texture | null = null;
    /** Rows currently allocated. Grown in powers of two; never shrunk. */
    private _rows = 0;

    private _staging: Float32Array = new Float32Array(0);
    private _build: ClusterBuild = { table: new Float32Array(0), indices: new Float32Array(0), used: 0, overflowed: 0 };
    private _layout: LightDataLayout = lightDataLayout(0, 0, 0);
    private _grid: ClusterGrid = { ...DEFAULT_CLUSTER_GRID };

    /** `tile = fragCoord * scale + bias`, backend-corrected. See `clusterTileScaleBias`. */
    private _tile: [number, number, number, number] = [0, 0, 0, 0];
    /** `slice = log(viewDepth) * scale + bias`. */
    private _z: [number, number] = [0, 0];

    private _lightCount = 0;
    private _uploadedRows = 0;

    /** Diagnostics for the renderer's stats panel. */
    public get lightCount(): number { return this._lightCount; }
    public get indexCount(): number { return this._build.used; }
    public get overflowed(): number { return this._build.overflowed; }
    public get grid(): Readonly<ClusterGrid> { return this._grid; }

    /** Bytes moved to the GPU on the last `upload`. */
    public get uploadBytes(): number { return this._uploadedRows * LIGHT_DATA_WIDTH * 16; }

    /**
     * The data texture. Allocated on first use, so a renderer that never lights anything never pays
     * for it, and so this class can be constructed before the device exists.
     */
    public get texture(): Texture {
        if (!this._texture) {
            this._texture = new Texture({
                // Neither renderable nor filterable is asked for, which is what makes rgba32float safe
                // on every device rather than something to feature-test. See `TextureConfig.loadOnly`.
                format: 'rgba32float',
                loadOnly: true,
                mipMap: false,
                minFilter: 'nearest',
                magFilter: 'nearest',
                mipMapFilter: 'nearest',
                wrapping: 'clamp',
            });
        }
        return this._texture;
    }

    /**
     * Assign `lights` to clusters for this view, and lay the frame out in the staging buffer.
     *
     * `flipY` says the fragment coordinate runs top-down, which is a property of the BACKEND and not
     * of anything this class can see. Both the cluster table and the index list are packed here; the
     * light records are still to be written, by `packRecord`.
     */
    public build(lights: readonly ClusterLight[], camera: ClusterView,
                 viewportWidth: number, viewportHeight: number, flipY: boolean): void {
        this._build = buildClusters(lights, camera, this._grid, DEFAULT_CLUSTER_LIGHT_CAP, this._build);
        this._tile = clusterTileScaleBias(viewportWidth, viewportHeight, this._grid, flipY);
        this._z = clusterDepthScaleBias(camera.near, camera.far, this._grid.z);
        this._layoutFrame(lights.length, this._clusterCount());
    }

    /**
     * One cluster holding every light, for a pass the grid was not built for.
     *
     * The light-probe capture renders six cube faces while the grid describes the main camera, so its
     * clusters mean nothing there. A degenerate 1x1x1 grid costs one loop over the lights, needs no
     * second code path in any shader, and makes every fragment resolve to cluster 0 whatever it
     * computes from its own coordinate.
     */
    public buildSingle(lightCount: number): void {
        this._grid = { x: 1, y: 1, z: 1 };
        this._build = buildSingleCluster(Math.min(lightCount, MAX_LIGHTS), this._build);
        // Any finite mapping resolves to tile 0 / slice 0 once the shader clamps into a 1x1x1 grid.
        this._tile = [0, 0, 0, 0];
        this._z = [0, 0];
        this._layoutFrame(lightCount, 1);
    }

    /** Restore the normal grid after a `buildSingle` pass. */
    public restoreGrid(grid: ClusterGrid = DEFAULT_CLUSTER_GRID): void {
        this._grid = { ...grid };
    }

    private _clusterCount(): number {
        return this._grid.x * this._grid.y * this._grid.z;
    }

    private _layoutFrame(lightCount: number, clusterCount: number): void {
        this._lightCount = Math.min(lightCount, MAX_LIGHTS);
        this._layout = lightDataLayout(clusterCount, this._lightCount, this._build.used);

        const floats = lightDataFloats(this._layout.rows);
        if (this._staging.length < floats) this._staging = new Float32Array(floats);
        // The table and the index list, straight in. Records are written by the caller after this.
        packClusterBuild(this._staging, this._layout, this._build, clusterCount);
    }

    /**
     * Write light `index`'s record. Positional rather than an object because it runs once per light
     * per frame and the parameter list IS the texel layout — see {@link packLightRecord}.
     */
    public packRecord(index: number,
                      position: ArrayLike<number>, invRangeSquared: number,
                      color: ArrayLike<number>, intensity: number,
                      direction: ArrayLike<number>, sourceRadius: number,
                      coneScale: number, coneOffset: number,
                      spotShadowLayer: number, pointShadowSlot: number): void {
        if (index < 0 || index >= this._lightCount) return;
        packLightRecord(this._staging, this._layout.lightRecordTexel + index * LIGHT_RECORD_TEXELS,
                        position, invRangeSquared, color, intensity, direction, sourceRadius,
                        coneScale, coneOffset, spotShadowLayer, pointShadowSlot);
    }

    /** Send the frame's rows to the GPU, growing the texture first if it has outgrown its storage. */
    public upload(): void {
        const rows = this._layout.rows;
        const texture = this.texture;

        if (rows > this._rows) {
            // Powers of two, so a scene that grows steadily reallocates a handful of times rather
            // than every frame. Storage is reallocated, not resized: `create` re-runs texImage2D.
            let next = Math.max(32, this._rows || 32);
            while (next < rows) next *= 2;
            texture.create(null, LIGHT_DATA_WIDTH, next);
            this._rows = next;
            Logger.print('info', [`Light grid texture: ${LIGHT_DATA_WIDTH}x${next} rgba32float ` +
                                  `(${((LIGHT_DATA_WIDTH * next * 16) / 1024) | 0} KB)`], 'LightGrid');
        }

        // Only the rows in use. Both back ends land this on a sub-image write from the origin, so the
        // untouched tail of the texture keeps whatever it held and nothing reads it.
        device.writeTexture(texture.rhiTexture, this._staging.subarray(0, rows * LIGHT_DATA_WIDTH * 4),
                            LIGHT_DATA_WIDTH, rows);
        this._uploadedRows = rows;
    }

    /**
     * Push the addressing uniforms to the CURRENTLY BOUND program.
     *
     * By name, like every other uniform in the engine — the backend decides whether that lands in a
     * std140 block or a WebGPU arena slot. Cheap enough to repeat per program: nine scalars.
     */
    public uploadUniforms(shaderManager: ShaderManager): void {
        shaderManager.setUniform('u_clusterTileScale', [this._tile[0], this._tile[1]]);
        shaderManager.setUniform('u_clusterTileBias', [this._tile[2], this._tile[3]]);
        shaderManager.setUniform('u_clusterDim', [this._grid.x, this._grid.y, this._grid.z]);
        shaderManager.setUniform('u_clusterZScale', this._z[0]);
        shaderManager.setUniform('u_clusterZBias', this._z[1]);
        shaderManager.setUniform('u_lightDataMask', LIGHT_DATA_WIDTH - 1);
        shaderManager.setUniform('u_lightDataShift', LIGHT_DATA_WIDTH_SHIFT);
        shaderManager.setUniform('u_clusterTableTexel', this._layout.clusterTableTexel);
        shaderManager.setUniform('u_lightRecordTexel', this._layout.lightRecordTexel);
        shaderManager.setUniform('u_lightIndexTexel', this._layout.lightIndexTexel);
    }

    public dispose(): void {
        this._texture?.delete();
        this._texture = null;
        this._rows = 0;
    }
}

/** Texels one light record occupies. Re-exported so the renderer needs one import, not two. */
export { LIGHT_RECORD_TEXELS, INDICES_PER_TEXEL };

import { mat4, quat } from 'gl-matrix';
import { Geometry } from '../core/geometry';
import { Model } from '../graphics/model';
import { Material } from '../graphics/material';

export type FoliageKind = 'mesh' | 'billboard';

export interface FoliageParams {
    /** Blades/props added per brush application. */
    density: number;
    minScale: number;
    maxScale: number;
}

const DEFAULT_PARAMS: FoliageParams = { density: 8, minScale: 0.8, maxScale: 1.4 };
const MAX_INSTANCES = 200000;

/** Build a two-quad crossed billboard (an "X"), base at y=0 up to y=1, UV 0..1, up-facing normals. */
export function crossQuadGeometry(): Geometry {
    const positions: [number, number, number][] = [
        [-0.5, 0, 0], [0.5, 0, 0], [0.5, 1, 0], [-0.5, 1, 0],
        [0, 0, -0.5], [0, 0, 0.5], [0, 1, 0.5], [0, 1, -0.5],
    ];
    const normals: [number, number, number][] = positions.map(() => [0, 1, 0]);
    const uvs: [number, number][] = [
        [0, 0], [1, 0], [1, 1], [0, 1],
        [0, 0], [1, 0], [1, 1], [0, 1],
    ];
    const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
    return new Geometry(positions, normals, uvs, [], [], indices);
}

/**
 * One GPU-instanced foliage layer for a terrain: either a scattered mesh prop (trees/rocks) or a textured
 * cross-quad billboard (grass). Stores compact per-instance data (position + yaw + uniform scale) and a
 * matrix buffer rebuilt from it; the renderer owns the actual WebGL instance buffer (referenced via
 * `glBuffer`/`uploadedVersion`) and draws all instances in one call.
 */
export class FoliageLayer {
    public readonly kind: FoliageKind;
    public name: string;
    public model: Model;
    public textureId: string | null;
    public params: FoliageParams;

    // Compact instance data, stride 5: [x, y, z, yaw, scale].
    private _instances: number[] = [];
    public matrices: Float32Array = new Float32Array(0);
    public count = 0;
    public version = 0;

    // Renderer-owned GPU state (set/updated by the renderer's foliage pass).
    public initialized = false;
    public glBuffer: WebGLBuffer | null = null;
    public uploadedVersion = -1;

    private _q = quat.create();
    private _m = mat4.create();

    constructor(kind: FoliageKind, name: string, model: Model, textureId: string | null, params?: Partial<FoliageParams>) {
        this.kind = kind;
        this.name = name;
        this.model = model;
        this.textureId = textureId;
        this.params = { ...DEFAULT_PARAMS, ...params };
    }

    public static Billboard(name: string, textureId: string, params?: Partial<FoliageParams>): FoliageLayer {
        const material = Material.Basic({ color: [1, 1, 1], texture: textureId }, { side: 'double', castShadow: false });
        return new FoliageLayer('billboard', name, new Model(crossQuadGeometry(), material), textureId, params);
    }

    public static Mesh(name: string, model: Model, params?: Partial<FoliageParams>): FoliageLayer {
        return new FoliageLayer('mesh', name, model, null, params);
    }

    /** Scatter new instances within the brush disc; Y is sampled from the terrain surface. */
    public scatter(worldX: number, worldZ: number, radius: number, sampleHeight: (x: number, z: number) => number): boolean {
        if (this.count >= MAX_INSTANCES) return false;
        const n = Math.max(1, Math.floor(this.params.density));
        let added = 0;
        for (let i = 0; i < n && this.count + added < MAX_INSTANCES; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * radius;
            const x = worldX + Math.cos(a) * r;
            const z = worldZ + Math.sin(a) * r;
            const y = sampleHeight(x, z);
            const yaw = Math.random() * Math.PI * 2;
            const scale = this.params.minScale + Math.random() * (this.params.maxScale - this.params.minScale);
            this._instances.push(x, y, z, yaw, scale);
            added++;
        }
        if (added > 0) { this._rebuild(); return true; }
        return false;
    }

    /** Remove instances whose base is within `radius` of the brush point. */
    public erase(worldX: number, worldZ: number, radius: number): boolean {
        const r2 = radius * radius;
        const kept: number[] = [];
        let removed = 0;
        for (let i = 0; i < this._instances.length; i += 5) {
            const dx = this._instances[i] - worldX, dz = this._instances[i + 2] - worldZ;
            if (dx * dx + dz * dz <= r2) { removed++; continue; }
            kept.push(this._instances[i], this._instances[i + 1], this._instances[i + 2], this._instances[i + 3], this._instances[i + 4]);
        }
        if (removed === 0) return false;
        this._instances = kept;
        this._rebuild();
        return true;
    }

    private _rebuild(): void {
        this.count = this._instances.length / 5;
        if (this.matrices.length < this.count * 16) this.matrices = new Float32Array(this.count * 16);
        for (let i = 0; i < this.count; i++) {
            const b = i * 5;
            quat.setAxisAngle(this._q, [0, 1, 0], this._instances[b + 3]);
            const s = this._instances[b + 4];
            mat4.fromRotationTranslationScale(this._m, this._q, [this._instances[b], this._instances[b + 1], this._instances[b + 2]], [s, s, s]);
            this.matrices.set(this._m, i * 16);
        }
        this.version++;
    }

    public serialize(): any {
        const inst = new Float32Array(this._instances);
        const bytes = new Uint8Array(inst.buffer);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk)
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
        return {
            kind: this.kind,
            name: this.name,
            textureId: this.textureId,
            params: this.params,
            model: this.kind === 'mesh' ? this.model.serialize() : undefined,
            instances: btoa(bin),
        };
    }

    public static deserialize(json: any): FoliageLayer {
        let layer: FoliageLayer;
        if (json.kind === 'billboard') layer = FoliageLayer.Billboard(json.name, json.textureId, json.params);
        else layer = FoliageLayer.Mesh(json.name, Model.parse(json.model), json.params);
        if (json.instances) {
            const bin = atob(json.instances);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const floats = new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
            layer._instances = Array.from(floats);
            layer._rebuild();
        }
        return layer;
    }
}

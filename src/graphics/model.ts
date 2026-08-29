import { Mesh } from './mesh';
import { Material } from './material';
import { Geometry } from '../core/geometry';
import { Loader } from './loader';
import { ImportTransform } from './utils/gltfLoader';
import { Logger } from '../core/logger';

interface FromPathptions {
    filePaths: string[];
    material?: Material;
}

interface FromFileOptions {
    files: File[]
    material?: Material;
}

/** One slice of a model's index buffer, drawn with `materials[i]`. */
export type Submesh = { start: number; count: number };

export class Model {
    private _geometry: Geometry;
    // Bumped on every swap; `ModelNode` compares it to decide whether the upload is still valid.
    private _geometryVersion: number = 0;
    private readonly  _mesh: Mesh;
    // One material per submesh; `material` is the get/set alias for `materials[0]`.
    private _materials: Material[];
    // Index ranges parallel to `_materials`, empty when the model is one whole-buffer draw. All parts
    // must share `type` and `config.transparent` — the renderer picks its pass from `materials[0]`.
    private _submeshes: Submesh[];

    constructor(geometry: Geometry, material: Material | Material[], submeshes: Submesh[] = []) {
        this._geometry = geometry;
        this._materials = Array.isArray(material) ? (material.length ? material : [Material.Default({})]) : [material];
        // A submesh list that does not line up with the materials is dropped, and the model falls back
        // to one whole-buffer draw with materials[0].
        this._submeshes = submeshes.length === this._materials.length ? submeshes : [];
        if (submeshes.length && submeshes.length !== this._materials.length)
            Logger.warn(`Model: ${submeshes.length} submeshes vs ${this._materials.length} materials — submeshes dropped`, 'Model');

        this._mesh = new Mesh();
    }

    public static fromPath(config: FromPathptions): Promise<{name: string, model: Model, transform?: ImportTransform}[]> {
        return new Promise<{name: string, model: Model, transform?: ImportTransform}[]>((resolve, reject) => {
            Loader.loadModelsFromPath(config.filePaths)
            .then((meshes) => {
                const models: {name: string, model: Model, transform?: ImportTransform}[] = [];
                for (const mesh of meshes)
                    models.push({
                        name: mesh.name,
                        model: new Model( mesh.geometry, config?.material ? config.material : mesh.material),
                        transform: mesh.transform
                    });
                resolve(models);
            })
            .catch(err => reject(err));
        });
    }

    public static fromFile(config: FromFileOptions): Promise<{name: string, model: Model, transform?: ImportTransform}[]> {
        return new Promise<{name: string, model: Model, transform?: ImportTransform}[]>((resolve, reject) => {
            Loader.loadModelsFromFile(config.files)
            .then((meshes) => {
                const models: {name: string, model: Model, transform?: ImportTransform}[] = [];
                for (const mesh of meshes)
                    models.push({
                        name: mesh.name,
                        model: new Model( mesh.geometry, config?.material ? config.material : mesh.material),
                        transform: mesh.transform
                    });
                resolve(models);
            })
            .catch(err => reject(err));
        });
    }

    public static parse(data: any): Model {
        const geometry = new Geometry(
            data.geometry.positions,
            data.geometry.normals,
            data.geometry.texCoords,
            data.geometry.tangents,
            data.geometry.bitangents,
            data.geometry.indices
        );

        // Both shapes must read: `materials`/`submeshes` is the multi-material form, `material` the single one.
        const materials = Array.isArray(data.materials) && data.materials.length
            ? data.materials.map((m: any) => Material.parse(m))
            : [Material.parse(data.material)];

        return new Model(geometry, materials, Array.isArray(data.submeshes) ? data.submeshes : []);
    }

    public serialize(): any {
        // Array.from is mandatory: JSON.stringify turns a Float32Array into an object, not an array.
        const geometry = {
            positions: Array.from(this._geometry.positions),
            normals: Array.from(this._geometry.normals),
            tangents: Array.from(this._geometry.tangents),
            bitangents: Array.from(this._geometry.bitangents),
            texCoords: Array.from(this._geometry.uvs),
            indices: Array.from(this._geometry.indices)
        };

        // `material` is written for every model so readers of the single-material shape keep working;
        // `materials`/`submeshes` appear only when there are several.
        const out: any = { geometry, material: this._materials[0].serialize() };
        if (this._submeshes.length > 1) {
            out.materials = this._materials.map(m => m.serialize());
            out.submeshes = this._submeshes.map(s => ({ start: s.start, count: s.count }));
        }
        return out;
    }

    public get geometry(): Geometry { return this._geometry; }
    /** Identity of the current geometry, for `ModelNode`'s re-upload check. */
    public get geometryVersion(): number { return this._geometryVersion; }

    /**
     * Replace this model's geometry. **Terrain chunks only** — see
     * `Terrain._rebuildChunksIfDensityChanged`, which is its one caller.
     *
     * Chunks are built in the terrain's constructor, before any layer exists, so the first `setLayer` is
     * when the real vertex density becomes knowable and every chunk has to be rebuilt at it. That
     * changes the vertex COUNT, and `Mesh.updateVertexData` is a fixed-size write. Bumping the version
     * makes
     * `ModelNode.initialized` go false, which re-runs `initializeModel` and therefore `Mesh.create`,
     * which reallocates. Nothing else should call this: an ordinary model's geometry is the authored
     * asset, and `serialize()` writes it.
     */
    public setGeometry(geometry: Geometry): void {
        if (this._geometry === geometry) return;
        this._geometry = geometry;
        this._geometryVersion++;
    }
    public get mesh(): Mesh { return this._mesh; }
    /** The first material. Assigning replaces it, leaving any further submesh materials alone. */
    public get material(): Material { return this._materials[0]; }
    public set material(material: Material) { this._materials[0] = material; }
    public get materials(): Material[] { return this._materials; }
    public set materials(materials: Material[]) { if (materials.length) this._materials = materials; }
    /** Index ranges parallel to {@link materials}; empty when the whole index buffer is one draw. */
    public get submeshes(): Submesh[] { return this._submeshes; }
    /** True when this model needs one draw call per material rather than a single whole-buffer draw. */
    public get hasSubmeshes(): boolean { return this._submeshes.length > 1; }
}
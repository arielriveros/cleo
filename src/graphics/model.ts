import { Mesh } from './mesh';
import { Material } from './material';
import { Geometry } from '../core/geometry';
import { Loader } from './loader';
import { ImportTransform } from './utils/gltfLoader';

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
    private readonly  _geometry: Geometry;
    private readonly  _mesh: Mesh;
    /**
     * One material per submesh. Almost every model has exactly one, and `material` stays the
     * get/set alias for `materials[0]` so the ~60 call sites that assume a single material — the
     * renderer's pass bucketing, the editor's material slot, foliage baking — keep working unchanged.
     */
    private _materials: Material[];
    /**
     * Index ranges parallel to `_materials`, or empty when the model draws its whole index buffer.
     *
     * Submeshes exist so a character split across several materials can still be ONE mesh, one node and
     * one skeleton. The parts must agree on material `type` and `config.transparent`: the renderer
     * chooses its pass, shader and sort key per NODE, from `materials[0]`, and a model whose parts
     * disagreed on those would have to straddle two passes.
     */
    private _submeshes: Submesh[];

    constructor(geometry: Geometry, material: Material | Material[], submeshes: Submesh[] = []) {
        this._geometry = geometry;
        this._materials = Array.isArray(material) ? (material.length ? material : [Material.Default({})]) : [material];
        this._submeshes = submeshes.length === this._materials.length ? submeshes : [];

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

        // Material (de)serialization lives on the Material class so standalone material assets and
        // Model share one code path. Legacy 'default'/'defaultSkinned' (and missing type) resolve to Blinn-Phong.
        // `materials`/`submeshes` are the multi-material form; `material` is the original single one and
        // is still what almost every saved model carries, so both shapes have to read.
        const materials = Array.isArray(data.materials) && data.materials.length
            ? data.materials.map((m: any) => Material.parse(m))
            : [Material.parse(data.material)];

        return new Model(geometry, materials, Array.isArray(data.submeshes) ? data.submeshes : []);
    }

    public serialize(): any {
        // Array.from is not optional: Geometry stores typed arrays, and JSON.stringify turns a
        // Float32Array into an OBJECT ({"0":x,"1":y,...}) rather than an array — which would silently
        // corrupt every saved model. Emitted flat; Geometry's constructor reads both the flat and the
        // legacy nested shape, so older projects keep loading.
        const geometry = {
            positions: Array.from(this._geometry.positions),
            normals: Array.from(this._geometry.normals),
            tangents: Array.from(this._geometry.tangents),
            bitangents: Array.from(this._geometry.bitangents),
            texCoords: Array.from(this._geometry.uvs),
            indices: Array.from(this._geometry.indices)
        };

        // Material flattening lives on the Material class (shared with standalone material assets).
        // `material` is still written for every model so anything reading the old shape (and older
        // builds of the player) keeps working; `materials`/`submeshes` only appear when there are several.
        const out: any = { geometry, material: this._materials[0].serialize() };
        if (this._submeshes.length > 1) {
            out.materials = this._materials.map(m => m.serialize());
            out.submeshes = this._submeshes.map(s => ({ start: s.start, count: s.count }));
        }
        return out;
    }

    public get geometry(): Geometry { return this._geometry; }
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
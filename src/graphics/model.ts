import { Mesh } from './mesh';
// Runtime import, but not a cycle: meshDisplacer takes `Model` as a TYPE only.
import { MeshDisplacer } from './systems/meshDisplacer';
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

/**
 * A geometry's buffers as they go into a serialized model — **typed arrays, copied**.
 *
 * Not `Array.from`: a plain `number[]` is PACKED_DOUBLE_ELEMENTS, 8 bytes per element, so writing a mesh
 * out that way doubles it, and an asset library of them stops fitting through a structured clone
 * (`DataCloneError … out of memory` on the way to IndexedDB). Everything that reads this shape back
 * already prefers typed arrays: `Geometry`'s constructor passes a `Float32Array`/`Uint32Array` through
 * with NO copy, and both the bundle and publish packers convert to typed arrays as their first step.
 *
 * Copied rather than aliased on purpose. `Array.from` was also acting as a defensive copy, and handing
 * out the live buffer would leave a stored asset sharing memory with the scene it was captured from.
 * A copy at 4 bytes an element is still half of what this used to cost.
 */
export function serializeGeometry(geometry: Geometry): any {
    return {
        positions: new Float32Array(geometry.positions),
        normals: new Float32Array(geometry.normals),
        tangents: new Float32Array(geometry.tangents),
        bitangents: new Float32Array(geometry.bitangents),
        texCoords: new Float32Array(geometry.uvs),
        indices: new Uint32Array(geometry.indices),
    };
}

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
        const geometry = serializeGeometry(this._geometry);

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
    /**
     * Release this model's GPU buffers.
     *
     * Dropping the last JS reference to a `Model` frees NOTHING — the VBO, IBO and VAO are driver
     * objects the GC cannot reach (see Mesh.dispose). Nothing called this until the editor was found
     * orphaning a full mesh set on every model re-instantiation, LOD regenerate and scene resync.
     *
     * Call it ONLY where the caller provably owns the mesh and is discarding it for good. It is
     * deliberately NOT wired into `Node.removeChild`: re-parenting goes through that too, and foliage
     * prototypes and terrain chunks share meshes, so an over-eager call renders geometry invisible with
     * no error at all. Safe to call twice.
     */
    public dispose(): void {
        // Before the mesh, and not optional: a displaced model owns a tessellated vertex buffer of its
        // own — 9.9 MB at level 3 on a 3941-triangle mesh, 33.8 at level 4 — held in a map keyed by this
        // object. Every material tab that previews a displaced material mints a fresh Model, so without
        // this, opening and closing one a few times is hundreds of megabytes the GPU never gets back.
        MeshDisplacer.Instance.release(this);
        this._mesh.dispose();
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
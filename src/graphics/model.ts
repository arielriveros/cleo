import { Mesh } from './mesh';
import { Material } from './material';
import { Geometry } from '../core/geometry';
import { Loader } from './loader';

interface FromPathptions {
    filePaths: string[];
    material?: Material;
}

interface FromFileOptions {
    files: File[]
    material?: Material;
}

export class Model {
    private readonly  _geometry: Geometry;
    private readonly  _mesh: Mesh;
    private _material: Material;

    constructor(geometry: Geometry, material: Material) {
        this._geometry = geometry;
        this._material = material;

        this._mesh = new Mesh();
    }

    public static fromPath(config: FromPathptions): Promise<{name: string, model: Model}[]> {
        return new Promise<{name: string, model: Model}[]>((resolve, reject) => {
            Loader.loadModelsFromPath(config.filePaths)
            .then((meshes) => {
                const models: {name: string, model: Model}[] = [];
                for (const mesh of meshes)
                    models.push({
                        name: mesh.name,
                        model: new Model( mesh.geometry, config?.material ? config.material : mesh.material)
                    });
                resolve(models);
            })
            .catch(err => reject(err));
        });
    }

    public static fromFile(config: FromFileOptions): Promise<{name: string, model: Model}[]> {
        return new Promise<{name: string, model: Model}[]>((resolve, reject) => {
            Loader.loadModelsFromFile(config.files)
            .then((meshes) => {
                const models: {name: string, model: Model}[] = [];
                for (const mesh of meshes)
                    models.push({
                        name: mesh.name,
                        model: new Model( mesh.geometry, config?.material ? config.material : mesh.material)
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
        const material = Material.parse(data.material);

        return new Model(geometry, material);
    }

    public serialize(): any {
        let geometry = {
            positions: this._geometry.positions,
            normals: this._geometry.normals,
            tangents: this._geometry.tangents,
            bitangents: this._geometry.bitangents,
            texCoords: this._geometry.uvs,
            indices: this._geometry.indices
        };

        // Material flattening lives on the Material class (shared with standalone material assets).
        const material = this._material.serialize();

        return { geometry, material };
    }

    public get geometry(): Geometry { return this._geometry; }
    public get mesh(): Mesh { return this._mesh; }
    public get material(): Material { return this._material; }
    public set material(material: Material) { this._material = material; }
}
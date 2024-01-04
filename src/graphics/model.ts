import { gl } from './renderer';
import { mat4, vec3 } from 'gl-matrix';
import { Mesh } from './mesh';
import { MaterialSystem } from './systems/materialSystem';
import { Material } from '../core/material';
import { Geometry } from '../core/geometry';
import { Loader } from './loader';


interface FromFileOptions {
    filePaths: string[];
    material?: Material;
}

export class Model {
    private readonly  _geometry: Geometry;
    private readonly  _mesh: Mesh;
    private readonly  _material: Material;

    constructor(geometry: Geometry, material: Material) {
        this._geometry = geometry;
        this._material = material;

        this._mesh = new Mesh();
    }

    public static FromFile(config: FromFileOptions): Promise<Model[]> {
        return new Promise<Model[]>((resolve, reject) => {
            Loader.loadFromFile(config.filePaths)
            .then((meshes) => {
                const models: Model[] = [];
                for (const mesh of meshes)
                    models.push(new Model(
                        mesh.geometry,
                        config?.material ? config.material : mesh.material
                    ));
                resolve(models);
            })
            .catch((err) => {
                reject(err);
            });
        });
    }

    public get geometry(): Geometry { return this._geometry; }
    public get mesh(): Mesh { return this._mesh; }
    public get material(): Material { return this._material; }
}
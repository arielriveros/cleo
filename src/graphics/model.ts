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

        let texData = data.material.textures;
        let baseTexture = texData.base;
        let specularMap = texData.specular;
        let normalMap = texData.normal;
        let emissiveMap = texData.emissive;
        let maskMap = texData.mask;
        let reflectivityMap = texData.reflectivity;
        
        let material = Material.Default({
            diffuse: data.material.diffuse,
            specular: data.material.specular,
            ambient: data.material.ambient,
            emissive: data.material.emissive,
            shininess: data.material.shininess,
            opacity: data.material.opacity,
            textures: {
                base: baseTexture,
                specular: specularMap,
                normal: normalMap,
                emissive: emissiveMap,
                mask: maskMap,
                reflectivity: reflectivityMap
            }},
            {
                side: data.material.config?.side,
                wireframe: data.material.config?.wireframe,
                transparent: data.material.config?.transparent,
                castShadow: data.material.config?.castShadow
            }
            );

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

        /* TODO: serialize for different types of materials */
        let material = {
            diffuse: this._material.properties.get('diffuse'),
            specular: this._material.properties.get('specular'),
            ambient: this._material.properties.get('ambient'),
            emissive: this._material.properties.get('emissive'),
            shininess: this._material.properties.get('shininess'),
            opacity: this._material.properties.get('opacity'),
            textures: {
                base: this._material.textures.get('baseTexture'),
                specular:  this._material.textures.get('specularMap'),
                normal: this._material.textures.get('normalMap'),
                emissive: this._material.textures.get('emissiveMap'),
                mask: this._material.textures.get('maskMap'),
                reflectivity: this._material.textures.get('reflectivityMap')
            },
            config: {
                side: this._material.config.side,
                wireframe: this._material.config.wireframe,
                transparent: this._material.config.transparent,
                castShadow: this._material.config.castShadow,
            }
        };

        return { geometry, material };        
    }

    public get geometry(): Geometry { return this._geometry; }
    public get mesh(): Mesh { return this._mesh; }
    public get material(): Material { return this._material; }
    public set material(material: Material) { this._material = material; }
}
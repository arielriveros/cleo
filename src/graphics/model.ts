import { Mesh } from './mesh';
import { Material } from './material';
import { Geometry } from '../core/geometry';
import { Loader } from './loader';
import { TextureManager } from '../cleo';

interface FromFileOptions {
    filePaths: string[];
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

    public static FromFile(config: FromFileOptions): Promise<{name: string, model: Model}[]> {
        return new Promise<{name: string, model: Model}[]>((resolve, reject) => {
            Loader.loadModelsFromFile(config.filePaths)
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

    public static FromJSON(path: string): Promise<Model> {
        return new Promise((resolve, reject) => {
            fetch(path)
            .then(res => res.json())
            .then(data => {
                const geometry = new Geometry(
                    data.geometry.positions,
                    data.geometry.normals,
                    data.geometry.texCoords,
                    data.geometry.tangents,
                    data.geometry.bitangents,
                    data.geometry.indices
                );

                let texData = data.material.textures;
                let baseTexture = texData.base ? TextureManager.Instance.addTextureFromBase64(texData.base, { wrapping: 'repeat' }) : undefined;
                let specularMap = texData.specular ? TextureManager.Instance.addTextureFromBase64(texData.specular, { wrapping: 'repeat' }) : undefined;
                let normalMap = texData.normal ? TextureManager.Instance.addTextureFromBase64(texData.normal, { wrapping: 'repeat' }) : undefined;
                let emissiveMap = texData.emissive ? TextureManager.Instance.addTextureFromBase64(texData.emissive, { wrapping: 'repeat' }) : undefined;
                let maskMap = texData.mask ? TextureManager.Instance.addTextureFromBase64(texData.mask, { wrapping: 'repeat' }) : undefined;
                let reflectivityMap = texData.reflectivity ? TextureManager.Instance.addTextureFromBase64(texData.reflectivity, { wrapping: 'repeat' }) : undefined;
                
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
                    }
                });
                resolve(new Model(geometry, material));
            })
            .catch(err => reject(err));
        })
    }

    public async toJSON(): Promise<any> {
        let geometry = {
            positions: this._geometry.positions,
            normals: this._geometry.normals,
            tangents: this._geometry.tangents,
            bitangents: this._geometry.bitangents,
            texCoords: this._geometry.uvs,
            indices: this._geometry.indices
        };

        const serialize = (texId: string): string => {
            const texture = this._material.textures.get(texId);
            if (!texture) return undefined;
            return TextureManager.Instance.serializeTexture(texture);
        }

        let material = {
            diffuse: this._material.properties.get('diffuse'),
            specular: this._material.properties.get('specular'),
            ambient: this._material.properties.get('ambient'),
            emissive: this._material.properties.get('emissive'),
            shininess: this._material.properties.get('shininess'),
            opacity: this._material.properties.get('opacity'),
            textures: {
                base: serialize('baseTexture'),
                specular:  serialize('specularMap'),
                normal: serialize('normalMap'),
                emissive: serialize('emissiveMap'),
                mask: serialize('maskMap'),
                reflectivity: serialize('reflectivityMap')
            }
        };

        console.log(material)

        return { geometry, material };        
    }

    public get geometry(): Geometry { return this._geometry; }
    public get mesh(): Mesh { return this._mesh; }
    public get material(): Material { return this._material; }
    public set material(material: Material) { this._material = material; }
}
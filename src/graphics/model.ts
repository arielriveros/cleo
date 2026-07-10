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

        const m = data.material || {};
        const config = {
            side: m.config?.side,
            wireframe: m.config?.wireframe,
            transparent: m.config?.transparent,
            castShadow: m.config?.castShadow
        };

        let material: Material;
        // Legacy 'default'/'defaultSkinned' (and missing type) fall through to the Blinn-Phong branch below.
        const type: string = m.type || 'blinn_phong';
        if (type === 'basic') {
            material = Material.Basic({
                color: m.color || [1,1,1],
                opacity: m.opacity ?? 1.0,
                texture: m.textures?.texture
            }, config);
        } else if (type === 'pbr') {
            material = Material.PBR({
                baseColor: m.baseColor || [1,1,1],
                metallic: m.metallic ?? 0.0,
                roughness: m.roughness ?? 1.0,
                opacity: m.opacity ?? 1.0,
                emissiveFactor: m.emissiveFactor || [0,0,0],
                textures: {
                    baseColorTexture: m.textures?.baseColorTexture,
                    metallicRoughnessTexture: m.textures?.metallicRoughnessTexture,
                    normalMap: m.textures?.normalMap,
                    occlusionMap: m.textures?.occlusionMap,
                    emissiveMap: m.textures?.emissiveMap
                }
            }, config);
        } else { // 'blinn_phong' (or legacy 'default')
            const texData = m.textures || {};
            material = Material.Default({
                diffuse: m.diffuse,
                specular: m.specular,
                ambient: m.ambient,
                emissive: m.emissive,
                shininess: m.shininess,
                opacity: m.opacity,
                textures: {
                    base: texData.base,
                    specular: texData.specular,
                    normal: texData.normal,
                    emissive: texData.emissive,
                    mask: texData.mask,
                    reflectivity: texData.reflectivity
                }
            }, config);
        }

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

        // Material serialization depending on shader type
        const cfg = {
            side: this._material.config.side,
            wireframe: this._material.config.wireframe,
            transparent: this._material.config.transparent,
            castShadow: this._material.config.castShadow,
        };

        const normalizeType = (t: string) => t === 'basicSkinned' ? 'basic' : (t === 'blinn_phongSkinned' ? 'blinn_phong' : t);
        const type = normalizeType(this._material.type as any);

        let material: any;
        if (type === 'basic') {
            material = {
                type,
                color: this._material.properties.get('color'),
                opacity: this._material.properties.get('opacity'),
                textures: {
                    texture: this._material.textures.get('texture')
                },
                config: cfg
            };
        } else if (type === 'pbr') {
            material = {
                type,
                baseColor: this._material.properties.get('baseColor'),
                metallic: this._material.properties.get('metallic'),
                roughness: this._material.properties.get('roughness'),
                opacity: this._material.properties.get('opacity'),
                emissiveFactor: this._material.properties.get('emissiveFactor'),
                textures: {
                    baseColorTexture: this._material.textures.get('baseColorTexture'),
                    metallicRoughnessTexture: this._material.textures.get('metallicRoughnessTexture'),
                    normalMap: this._material.textures.get('normalMap'),
                    occlusionMap: this._material.textures.get('occlusionMap'),
                    emissiveMap: this._material.textures.get('emissiveMap')
                },
                config: cfg
            };
        } else { // blinn_phong
            material = {
                type: 'blinn_phong',
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
                config: cfg
            };
        }

        return { geometry, material };        
    }

    public get geometry(): Geometry { return this._geometry; }
    public get mesh(): Mesh { return this._mesh; }
    public get material(): Material { return this._material; }
    public set material(material: Material) { this._material = material; }
}
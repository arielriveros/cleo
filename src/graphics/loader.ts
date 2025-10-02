import { Geometry } from "../core/geometry";
import { Material } from "./material";
import { OutputMaterial, loadAssimpModel, loadAssimpModelFromFiles, parseMaterial } from "./utils/assimpLoader";
import { TextureManager } from "./systems/textureManager";

/**
 * Determines the correct base path for assets based on the current environment
 * @param path The original path (e.g., '/assets/damagedHelmet/damaged_helmet.obj')
 * @returns The corrected path for the current environment
 */

export class Loader {
    public static async loadModelsFromPath(filePaths: string[]): Promise<{name: string, geometry: Geometry, material: Material}[]> {
        return new Promise(async (resolve, reject) => {
            const output: {name: string, geometry: Geometry, material?: Material }[] = [];
    
            const res = await loadAssimpModel(filePaths);

            const materials: { name: string; material: OutputMaterial; }[] = [];

            const relativePath = filePaths[0]?.split('/').slice(0, -1).join('/');
    
            Promise.all( res.materials.map(async (mat: any) => { materials.push(await parseMaterial(mat)); } ) )
            .then(() => {
                const meshes:{
                    name: any;
                    positions: ([number, number, number] | Float32Array)[];
                    normals: ([number, number, number] | Float32Array)[];
                    tangents: ([number, number, number] | Float32Array)[];
                    bitangents: ([number, number, number] | Float32Array)[];
                    uvs: (Float32Array | [number, number])[];
                    indices: number[];
                    materialindex: any;
                }[] = []
                for (const m of res.meshes) {
                    const name = m.name;
                    const vertices: number[] = m.vertices;
                    const normals: number[] = m.normals;
                    if (!normals) throw new Error(`Mesh ${name} has no normals`);
                    const uvs: number[] = m.texturecoords[0];
                    if (!uvs) throw new Error(`Mesh ${name} has no UVs`);
                    const indices: number[] = m.faces.flat();
        
                    const tangents: number[] = m.tangents;
                    const bitangents: number[] = m.bitangents;
        
                    const positions: [number, number, number][] = [];
                    for (let i = 0; i < vertices.length; i += 3)
                        positions.push([vertices[i], vertices[i + 1], vertices[i + 2]]);
        
                    const normalsVec: [number, number, number][] = [];
                    for (let i = 0; i < normals.length; i += 3)
                        normalsVec.push([normals[i], normals[i + 1], normals[i + 2]]);
        
                    const uvsVec: [number, number][] = [];
                    for (let i = 0; i < uvs.length; i += 2)
                        uvsVec.push([uvs[i], uvs[i + 1]]);
        
                    const tangentsVec: [number, number, number][] = [];
                    for (let i = 0; i < tangents.length; i += 3)
                        tangentsVec.push([tangents[i], tangents[i + 1], tangents[i + 2]]);
        
                    const bitangentsVec: [number, number, number][] = [];
                    for (let i = 0; i < bitangents.length; i += 3)
                        bitangentsVec.push([bitangents[i], bitangents[i + 1], bitangents[i + 2]]);
        
                    meshes.push({name,
                                 positions,
                                 normals: normalsVec,
                                 uvs: uvsVec,
                                 tangents: tangentsVec, 
                                 bitangents: bitangentsVec,
                                 indices, materialindex: m.materialindex});
                }

                for (const mesh of meshes) {
                    const geometry = new Geometry(
                        mesh.positions as [number, number, number][],
                        mesh.normals as [number, number, number][],
                        mesh.uvs as [number, number][],
                        mesh.tangents as [number, number, number][],
                        mesh.bitangents as [number, number, number][],
                        mesh.indices);
                    const matIndex = mesh.materialindex;
                    const materialDescription = materials[matIndex].material;

                    const material = Material.Default({
                        diffuse: materialDescription.diffuse,
                        specular: materialDescription.specular,
                        ambient: materialDescription.ambient,
                        emissive: materialDescription.emissive,
                        shininess: materialDescription.shininess,
                        opacity: materialDescription.opacity,
                        textures: {
                            base: materialDescription.texturesPaths.base ? TextureManager.Instance.addTextureFromPath(`${relativePath}/${materialDescription.texturesPaths.base}`, { wrapping: 'repeat' }) : undefined,
                            specular: materialDescription.texturesPaths.specular ? TextureManager.Instance.addTextureFromPath(`${relativePath}/${materialDescription.texturesPaths.specular}`, { wrapping: 'repeat' }) : undefined,
                            normal: materialDescription.texturesPaths.normal ? TextureManager.Instance.addTextureFromPath(`${relativePath}/${materialDescription.texturesPaths.normal}`, { wrapping: 'repeat' }) : undefined,
                            emissive: materialDescription.texturesPaths.emissive ? TextureManager.Instance.addTextureFromPath(`${relativePath}/${materialDescription.texturesPaths.emissive}`, { wrapping: 'repeat' }) : undefined,
                            mask: materialDescription.texturesPaths.mask ? TextureManager.Instance.addTextureFromPath(`${relativePath}/${materialDescription.texturesPaths.mask}`, { wrapping: 'repeat' }) : undefined,
                            reflectivity: materialDescription.texturesPaths.reflectivity ? TextureManager.Instance.addTextureFromPath(`${relativePath}/${materialDescription.texturesPaths.reflectivity}`, { wrapping: 'repeat' }) : undefined
                        }
                    });

                    output.push({name: mesh.name, geometry, material});
                }

                const models: {name: string, geometry: Geometry, material: Material}[] = [];
                for (const m of output) {
                    models.push({
                        name: m.name,
                        geometry: m.geometry,
                        material: m.material
                    });
                }

                resolve(models);        
            });
        });

    }

    public static async loadModelsFromFile(files: File[]): Promise<{name: string, geometry: Geometry, material: Material}[]> {
        return new Promise(async (resolve, reject) => {
            const output: {name: string, geometry: Geometry, material?: Material }[] = [];
    
            const res = await loadAssimpModelFromFiles(files);

            const materials: { name: string; material: OutputMaterial; }[] = [];

            const relativePath = files[0]?.name.split('/').slice(0, -1).join('/');

            Promise.all( res.materials.map(async (mat: any) => { materials.push(await parseMaterial(mat)); } ) )
            .then(() => {
                const meshes:{
                    name: any;
                    positions: ([number, number, number] | Float32Array)[];
                    normals: ([number, number, number] | Float32Array)[];
                    tangents: ([number, number, number] | Float32Array)[];
                    bitangents: ([number, number, number] | Float32Array)[];
                    uvs: (Float32Array | [number, number])[];
                    indices: number[];
                    materialindex: any;
                }[] = []
                for (const m of res.meshes) {
                    const name = m.name;
                    const vertices: number[] = m.vertices;
                    const normals: number[] = m.normals;
                    if (!normals) throw new Error(`Mesh ${name} has no normals`);
                    const uvs: number[] = m.texturecoords[0];
                    if (!uvs) throw new Error(`Mesh ${name} has no UVs`);
                    const indices: number[] = m.faces.flat();
        
                    const tangents: number[] = m.tangents;
                    const bitangents: number[] = m.bitangents;
        
                    const positions: [number, number, number][] = [];
                    for (let i = 0; i < vertices.length; i += 3)
                        positions.push([vertices[i], vertices[i + 1], vertices[i + 2]]);
        
                    const normalsVec: [number, number, number][] = [];
                    for (let i = 0; i < normals.length; i += 3)
                        normalsVec.push([normals[i], normals[i + 1], normals[i + 2]]);
        
                    const uvsVec: [number, number][] = [];
                    for (let i = 0; i < uvs.length; i += 2)
                        uvsVec.push([uvs[i], uvs[i + 1]]);
        
                    const tangentsVec: [number, number, number][] = [];
                    for (let i = 0; i < tangents.length; i += 3)
                        tangentsVec.push([tangents[i], tangents[i + 1], tangents[i + 2]]);
        
                    const bitangentsVec: [number, number, number][] = [];
                    for (let i = 0; i < bitangents.length; i += 3)
                        bitangentsVec.push([bitangents[i], bitangents[i + 1], bitangents[i + 2]]);

                    meshes.push({name,
                                 positions,
                                 normals: normalsVec,
                                 uvs: uvsVec,
                                 tangents: tangentsVec, 
                                 bitangents: bitangentsVec,
                                 indices, materialindex: m.materialindex});
                }

                for (const mesh of meshes) {
                    const geometry = new Geometry(
                        mesh.positions as [number, number, number][],
                        mesh.normals as [number, number, number][],
                        mesh.uvs as [number, number][],
                        mesh.tangents as [number, number, number][],
                        mesh.bitangents as [number, number, number][],
                        mesh.indices);
                    const matIndex = mesh.materialindex;
                    const materialDescription = materials[matIndex].material;

                    const material = Material.Default({
                        diffuse: materialDescription.diffuse,
                        specular: materialDescription.specular,
                        ambient: materialDescription.ambient,
                        emissive: materialDescription.emissive,
                        shininess: materialDescription.shininess,
                        opacity: materialDescription.opacity,
                        textures: {
                            base: materialDescription.texturesPaths.base?.split(/[\/\\]/).pop(),
                            specular: materialDescription.texturesPaths.specular?.split(/[\/\\]/).pop(),
                            normal: materialDescription.texturesPaths.normal?.split(/[\/\\]/).pop(),
                            emissive: materialDescription.texturesPaths.emissive?.split(/[\/\\]/).pop(),
                            mask: materialDescription.texturesPaths.mask?.split(/[\/\\]/).pop(),
                            reflectivity: materialDescription.texturesPaths.reflectivity?.split(/[\/\\]/).pop()
                        }
                    });

                    output.push({name: mesh.name, geometry, material});
                }

                const models: {name: string, geometry: Geometry, material: Material}[] = [];
                for (const m of output) {
                    models.push({
                        name: m.name,
                        geometry: m.geometry,
                        material: m.material
                    });
                }
                resolve(models);
            });
        });
    }

    public static async loadImage(path: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.src = path;
            image.onload = () => resolve(image);
            image.onerror = (err) => reject(err);
        });
    }

    public static ImageToArray(path: string): Promise<{data: Uint8Array, width: number, height: number}> {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.src = path;
            image.onload = () => {
                const data = new Uint8Array(image.width * image.height * 4);
                const canvas = document.createElement('canvas');
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext('2d');
                if (!context) throw new Error('Failed to create canvas context');
                context.drawImage(image, 0, 0);
                const imageData = context.getImageData(0, 0, image.width, image.height);
                data.set(imageData.data);
                resolve({
                    data: data,
                    width: image.width,
                    height: image.height
                });
            };
            image.onerror = (err) => reject(err);
        });
    }
}
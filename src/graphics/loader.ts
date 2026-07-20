import { Geometry } from "../core/geometry";
import { Material } from "./material";
import { OutputMaterial, AssimpParseResult, loadAssimpModel, parseMaterial, convertToGltf2FromFiles, parseAssimpFiles } from "./utils/assimpLoader";
import { GLTFLoader, ImportTransform, GltfParseResult } from "./utils/gltfLoader";
// Cycle (model.ts imports Loader), but a benign one: Model is only referenced inside method bodies,
// long after both modules have evaluated. Same shape as node.ts importing the cleo barrel.
import { Model } from "./model";
import { AnimatedModel, Animation, Skin } from "./animatedModel";
import { TextureManager } from "./systems/textureManager";

/**
 * Determines the correct base path for assets based on the current environment
 * @param path The original path (e.g., '/assets/damagedHelmet/damaged_helmet.obj')
 * @returns The corrected path for the current environment
 */

export class Loader {
    /**
     * Load models from file paths. Automatically detects GLTF files and uses appropriate loader.
     * For GLTF files with animations/skinning, use loadAnimatedModelsFromPath instead.
     */
    public static async loadModelsFromPath(filePaths: string[]): Promise<{name: string, geometry: Geometry, material: Material, transform?: ImportTransform}[]> {
        // Check if this is a GLTF file
        const mainFile = filePaths[0];
        if (mainFile && mainFile.toLowerCase().endsWith('.gltf')) {
            const gltfLoader = new GLTFLoader();
            return await gltfLoader.loadFromPath(mainFile);
        }

        // Fall back to Assimp loader for other formats
        return new Promise(async (resolve, reject) => {
            // `material` is required, not optional: the only push into this array supplies a real
            // Material.Default(...). The vestigial `?` made the copy into `models` below unassignable.
            const output: {name: string, geometry: Geometry, material: Material }[] = [];
    
            const res = await loadAssimpModel(filePaths);

            const materials: { name: string; material: OutputMaterial; }[] = [];

            const relativePath = filePaths[0]?.split('/').slice(0, -1).join('/');
    
            Promise.all( res.materials.map(async (mat: any) => { materials.push(await parseMaterial(mat, res.textures)); } ) )
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

                // Move helper functions to top-level scope of loadModelsFromPath
                const validateBase64Image = async (base64: string): Promise<boolean> => {
                    return new Promise((resolve) => {
                        const img = new Image();
                        img.onload = () => resolve(true);
                        img.onerror = () => resolve(false);
                        img.src = base64;
                    });
                };

                async function loadTextureSafe(base64: string | undefined, path: string | undefined, fallbackPath: string | undefined) {
                    if (base64) {
                        const isValid = await validateBase64Image(base64);
                        if (isValid) {
                            return TextureManager.Instance.addTextureFromBase64(base64, { wrapping: 'repeat', mipMap: false });
                        } else {
                            console.warn('Base64 texture data is not a valid image, skipping:', base64.slice(0, 50));
                        }
                    }
                    if (path && !path.startsWith('*')) {
                        return TextureManager.Instance.addTextureFromPath(fallbackPath ?? path, { wrapping: 'repeat' });
                    }
                    return undefined;
                }

                // Replace mesh loop with async/await
                (async () => {
                    for (const mesh of meshes) {
                        const geometry = new Geometry(
                            mesh.positions as [number, number, number][],
                            mesh.normals as [number, number, number][],
                            mesh.uvs as [number, number][],
                            mesh.tangents as [number, number, number][],
                            mesh.bitangents as [number, number, number][],
                            mesh.indices
                        );
                        const matIndex = mesh.materialindex;
                        const materialDescription = materials[matIndex].material;
                        const textures = {
                            base: await loadTextureSafe(materialDescription.texturesData.base, materialDescription.texturesPaths.base, `${relativePath}/${materialDescription.texturesPaths.base}`),
                            specular: await loadTextureSafe(materialDescription.texturesData.specular, materialDescription.texturesPaths.specular, `${relativePath}/${materialDescription.texturesPaths.specular}`),
                            normal: await loadTextureSafe(materialDescription.texturesData.normal, materialDescription.texturesPaths.normal, `${relativePath}/${materialDescription.texturesPaths.normal}`),
                            emissive: await loadTextureSafe(materialDescription.texturesData.emissive, materialDescription.texturesPaths.emissive, `${relativePath}/${materialDescription.texturesPaths.emissive}`),
                            mask: await loadTextureSafe(materialDescription.texturesData.mask, materialDescription.texturesPaths.mask, `${relativePath}/${materialDescription.texturesPaths.mask}`),
                            reflectivity: await loadTextureSafe(materialDescription.texturesData.reflectivity, materialDescription.texturesPaths.reflectivity, `${relativePath}/${materialDescription.texturesPaths.reflectivity}`)
                        };
                        const material = Material.Default({
                            diffuse: materialDescription.diffuse,
                            specular: materialDescription.specular,
                            ambient: materialDescription.ambient,
                            emissive: materialDescription.emissive,
                            shininess: materialDescription.shininess,
                            opacity: materialDescription.opacity,
                            textures
                        });
                        output.push({ name: mesh.name, geometry, material });
                    }
                    const models: { name: string, geometry: Geometry, material: Material }[] = [];
                    for (const m of output) {
                        models.push({
                            name: m.name,
                            geometry: m.geometry,
                            material: m.material
                        });
                    }
                    resolve(models);
                })();
            });
        });

    }

    /**
     * Load models from uploaded files. Automatically detects GLTF files and uses appropriate loader.
     * For GLTF files with animations/skinning, use loadAnimatedModelsFromFile instead.
     */
    public static async loadModelsFromFile(files: File[]): Promise<{name: string, geometry: Geometry, material: Material, transform?: ImportTransform}[]> {
        // Check if this is a GLTF file
        const gltfFile = files.find(f => f.name.toLowerCase().endsWith('.gltf'));
        if (gltfFile) {
            const gltfLoader = new GLTFLoader();
            return await gltfLoader.loadFromFiles(files);
        }

        // Fall back to Assimp loader for other formats. Split in two so the expensive half can run in
        // a worker: parseAssimpFiles is pure data, assembleAssimpModels does the GL work.
        return Loader.assembleAssimpModels(await parseAssimpFiles(files), files);
    }

    /**
     * Turn the pure output of `GLTFLoader.parseDescriptorsFromFiles` into live engine objects.
     *
     * This is the half that **must** run on the main thread: every image becomes a GL texture. Each
     * image is uploaded exactly once and shared by every material referencing it, which is what the
     * descriptor's image-index indirection is for.
     *
     * Returns `AnimatedModel`s when the descriptors carry skinning data, plain `Model`s otherwise —
     * matching what the eager loaders returned.
     */
    public static assembleGltfModels(
        parsed: GltfParseResult,
        files: File[]
    ): { name: string, model: Model | AnimatedModel, transform?: ImportTransform }[] {
        const cfg = { wrapping: 'repeat' as const };

        const textureIds: (string | undefined)[] = parsed.images.map((image): string | undefined => {
            try {
                switch (image.kind) {
                    case 'bytes': return TextureManager.Instance.addTextureFromBytes(image.bytes, image.mime, { ...cfg, mipMap: false });
                    case 'dataUri': return TextureManager.Instance.addTextureFromBase64(image.uri, { ...cfg, mipMap: false });
                    case 'file': {
                        const file = files.find(f => f.name === image.fileName);
                        return file ? TextureManager.Instance.addTextureFromFile(file, cfg) : undefined;
                    }
                    case 'path': return TextureManager.Instance.addTextureFromPath(image.uri, cfg);
                    default: return undefined; // 'missing' — the texture was never uploaded
                }
            } catch (error) {
                console.warn('Failed to load texture:', error);
                return undefined;
            }
        });

        const materials = parsed.materials.map(d => {
            const textures: any = {};
            for (const [slot, index] of Object.entries(d.textures) as [string, number | undefined][])
                if (index !== undefined) textures[slot] = textureIds[index];

            return Material.PBR({
                baseColor: d.baseColor,
                metallic: d.metallic,
                roughness: d.roughness,
                opacity: d.opacity,
                emissiveFactor: d.emissiveFactor,
                textures
            }, {
                side: d.doubleSided ? 'double' : 'front',
                transparent: d.transparent,
            });
        });

        return parsed.meshes.map(mesh => {
            const g = mesh.geometry;
            // Adopts the typed arrays directly — they may have been transferred from a worker.
            const geometry = new Geometry(g.positions, g.normals, g.uvs, g.tangents, [], g.indices);
            const material = materials[mesh.materialIndex] ?? Material.PBR({});

            const model = mesh.jointIndices && mesh.jointWeights
                ? new AnimatedModel(
                    geometry, material,
                    mesh.skinIndex !== undefined ? parsed.skins[mesh.skinIndex] : undefined,
                    mesh.jointIndices, mesh.jointWeights, parsed.animations)
                : new Model(geometry, material);

            return { name: mesh.name, model, transform: mesh.transform };
        });
    }

    /**
     * Turn the pure output of `parseAssimpFiles` into live `Geometry` + `Material` objects.
     *
     * This is the half that **must** run on the main thread: it creates GL textures via
     * `TextureManager`. Kept separate so the editor can run the parse in a Web Worker and call only
     * this on the main thread, while `loadModelsFromFile` above runs both back to back — so the
     * worker and inline paths execute the identical assembly code.
     *
     * `files` is still needed here: a material may reference a texture by filename, which is resolved
     * against the uploaded file list rather than embedded in the model.
     */
    public static async assembleAssimpModels(
        parsed: AssimpParseResult,
        files: File[]
    ): Promise<{ name: string, geometry: Geometry, material: Material }[]> {
        const validateBase64Image = async (base64: string): Promise<boolean> => {
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => resolve(true);
                img.onerror = () => resolve(false);
                img.src = base64;
            });
        };

        const loadTextureFromSources = async (texturePath: string | undefined, textureData: string | undefined) => {
            // First priority: use embedded base64 data if available and valid
            if (textureData) {
                const isValid = await validateBase64Image(textureData);
                if (isValid) {
                    return TextureManager.Instance.addTextureFromBase64(textureData, { wrapping: 'repeat', mipMap: false });
                } else {
                    console.warn('Base64 texture data is not a valid image, skipping:', textureData.slice(0, 50));
                }
            }

            // Second priority: look for texture file in uploaded files
            if (texturePath) {
                const textureFileName = texturePath.split(/[\/\\]/).pop();
                if (textureFileName) {
                    const textureFile = files.find(file =>
                        file.name.toLowerCase().endsWith(textureFileName.toLowerCase()) ||
                        file.name.toLowerCase() === textureFileName.toLowerCase()
                    );

                    if (textureFile) {
                        return TextureManager.Instance.addTextureFromFile(textureFile, { wrapping: 'repeat' });
                    }
                }
            }

            return undefined;
        };

        const models: { name: string, geometry: Geometry, material: Material }[] = [];
        for (const mesh of parsed.meshes) {
            // Adopts the typed arrays directly — no copy, and they may have been transferred here
            // from a worker.
            const geometry = new Geometry(
                mesh.positions, mesh.normals, mesh.uvs,
                mesh.tangents, mesh.bitangents, mesh.indices);

            const description = parsed.materials[mesh.materialIndex]?.material;
            if (!description) {
                models.push({ name: mesh.name, geometry, material: Material.Default({}) });
                continue;
            }

            const textures = {
                base: await loadTextureFromSources(description.texturesPaths.base, description.texturesData.base),
                specular: await loadTextureFromSources(description.texturesPaths.specular, description.texturesData.specular),
                normal: await loadTextureFromSources(description.texturesPaths.normal, description.texturesData.normal),
                emissive: await loadTextureFromSources(description.texturesPaths.emissive, description.texturesData.emissive),
                mask: await loadTextureFromSources(description.texturesPaths.mask, description.texturesData.mask),
                reflectivity: await loadTextureFromSources(description.texturesPaths.reflectivity, description.texturesData.reflectivity)
            };

            const material = Material.Default({
                diffuse: description.diffuse,
                specular: description.specular,
                ambient: description.ambient,
                emissive: description.emissive,
                shininess: description.shininess,
                opacity: description.opacity,
                textures
            });
            models.push({ name: mesh.name, geometry, material });
        }
        return models;
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

    /**
     * Load animated models with skinning and animation data from file paths.
     * Only works with GLTF files. For other formats, falls back to loadModelsFromPath.
     */
    public static async loadAnimatedModelsFromPath(filePath: string): Promise<{name: string, model: AnimatedModel, transform?: ImportTransform}[]> {
        // Check if this is a GLTF file
        if (filePath.toLowerCase().endsWith('.gltf')) {
            const gltfLoader = new GLTFLoader();
            return await gltfLoader.loadAnimatedFromPath(filePath);
        }

        // For non-GLTF files, throw an error since they don't support skeletal animation
        throw new Error('Animated models are only supported for GLTF files. Use loadModelsFromPath for static models.');
    }

    /**
     * Load animated models with skinning and animation data from uploaded files.
     * Only works with GLTF files. For other formats, falls back to loadModelsFromFile.
     */
    public static async loadAnimatedModelsFromFile(files: File[]): Promise<{name: string, model: AnimatedModel, transform?: ImportTransform}[]> {
        // Check if this is a GLTF file
        const gltfFile = files.find(f => f.name.toLowerCase().endsWith('.gltf'));
        if (gltfFile) {
            const gltfLoader = new GLTFLoader();
            return await gltfLoader.loadAnimatedFromFiles(files);
        }

        // For non-GLTF files, throw an error since they don't support skeletal animation
        throw new Error('Animated models are only supported for GLTF files. Use loadModelsFromFile for static models.');
    }

    /**
     * Parse animation clips (+ the source skeleton, with bone names) from an uploaded model file for
     * IMPORT/retargeting. Supports glTF natively; glb/fbx/obj are converted to glTF2 via assimp first.
     * Returns the first parsed model's clips + skin (all models in a file share one animations array).
     */
    public static async loadAnimationsFromFile(files: File[]): Promise<{ animations: Animation[]; skin: Skin | null }> {
        const hasGltf = files.some(f => f.name.toLowerCase().endsWith('.gltf'));
        let parseFiles = files;
        if (!hasGltf) {
            // glb/fbx/obj/… → convert to glTF2 (preserves skeleton + animations + node names).
            parseFiles = await convertToGltf2FromFiles(files);
        }
        const gltfLoader = new GLTFLoader();
        // Works whether or not the file contains a mesh/skin (animation-only files are supported).
        return await gltfLoader.loadAnimationsFromFiles(parseFiles);
    }
}

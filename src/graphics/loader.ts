import { Geometry } from "../core/geometry";
import { Material } from "./material";
import { OutputMaterial, AssimpParseResult, AssimpTextureSlots, loadAssimpModel, parseMaterial, convertToGltf2FromFiles, parseAssimpFiles } from "./utils/assimpLoader";
import { GLTFLoader, ImportTransform, GltfParseResult } from "./utils/gltfLoader";
// A cycle (model.ts imports Loader), but benign: Model is only referenced inside method bodies.
import { Model } from "./model";
import { AnimatedModel, Animation, Skin } from "./animatedModel";
import { TextureManager } from "./systems/textureManager";
import { Logger } from "../core/logger";

/** Resolve an asset path against the current environment's base path. */

/** One texture reference a model made that did not end up as a texture. */
export type UnresolvedTexture = {
    /** Basename of the image the model asked for. The import review matches uploaded files against this. */
    name: string;
    /** Where it was referenced from, e.g. "BodyMat · base colour". Display only. */
    from: string;
};

/**
 * Texture references a model made that did not become a texture. `missingFiles` are images absent from
 * the upload, which the user can supply; `unloadable` are references no file can repair.
 */
export type TextureLoadReport = { missingFiles: UnresolvedTexture[], unloadable: UnresolvedTexture[] };

/** Human-readable name for a texture slot, for the "where did this come from" line. */
const SLOT_LABELS: Record<string, string> = {
    base: 'base colour', baseColorTexture: 'base colour',
    specular: 'specular', normal: 'normal map', normalMap: 'normal map',
    emissive: 'emissive', emissiveMap: 'emissive',
    mask: 'opacity mask', reflectivity: 'reflectivity',
    metallicRoughnessTexture: 'metallic/roughness', occlusionMap: 'occlusion',
};

/** Last path segment, splitting on both separators (model files often carry Windows-style paths). */
function textureBaseName(path: string): string {
    return path.split(/[\\/]/).pop() || path;
}

/** An id like `base`, or `base (2)` if that is already registered. Ids are user-visible names here. */
function uniqueTextureId(base: string): string {
    const taken = TextureManager.Instance.textures;
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
        const candidate = `${base} (${n})`;
        if (!taken.has(candidate)) return candidate;
    }
}

export class Loader {
    /**
     * Load models from file paths, detecting glTF automatically. For skinned glTF use
     * {@link loadAnimatedModelsFromPath} instead.
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
                            Logger.print('warn', ['Base64 texture data is not a valid image, skipping:', base64.slice(0, 50)], 'Loader');
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
     * Load models from uploaded files, detecting glTF automatically. For skinned glTF use
     * {@link loadAnimatedModelsFromFile} instead.
     */
    public static async loadModelsFromFile(files: File[]): Promise<{name: string, geometry: Geometry, material: Material, transform?: ImportTransform}[]> {
        // Check if this is a GLTF file
        const gltfFile = files.find(f => f.name.toLowerCase().endsWith('.gltf'));
        if (gltfFile) {
            const gltfLoader = new GLTFLoader();
            return await gltfLoader.loadFromFiles(files);
        }

        // Split in two so the expensive half can run in a worker: parseAssimpFiles is pure data.
        return Loader.assembleAssimpModels(await parseAssimpFiles(files), files);
    }

    /**
     * Turn the pure output of `GLTFLoader.parseDescriptorsFromFiles` into live engine objects. Must run
     * on the main thread: it uploads every image as a GPU texture, once, shared across materials.
     */
    /**
     * `recovered` re-attaches texture slots that assimp's glTF2 EXPORTER dropped, by material index.
     *
     * Only the .fbx/.glb route supplies it, and only because that route is a detour: the file is
     * converted to glTF2 first (for skinning, node transforms and PBR slots) and the exporter emits
     * `baseColorTexture` and little else — FBX's `Bump` channel reaches assimp as
     * `aiTextureType_HEIGHT`, which it does not look for, and it has nowhere to put `AMBIENT` or
     * `SPECULAR` at all. Read back from the same scene via `readAssimpTextureSlots` and merged here so
     * the images are registered through the SAME `uniqueTextureId` path as the glTF's own, rather than
     * racing the editor's uploader for the name. A slot the glTF did provide always wins.
     */
    public static assembleGltfModels(
        parsed: GltfParseResult,
        files: File[],
        report?: TextureLoadReport,
        recovered?: AssimpTextureSlots[],
        /**
         * Auto-smooth angle for the weld, in degrees; 0 leaves the mesh exactly as it arrived.
         *
         * Faces meeting at less than this share a normal, faces meeting at more keep their own. 45 is
         * the default the importer passes: the scanned branch that prompted it has a 25.6 degree median
         * dihedral with an 80.4 degree p90, so 45 smooths the surface and leaves the real bark creases
         * hard. A uv seam always splits regardless — averaging a tangent across one is wrong.
         */
        weldCreaseDeg: number = 0
    ): { name: string, model: Model | AnimatedModel, transform?: ImportTransform }[] {
        const cfg = { wrapping: 'repeat' as const };

        // Which material/slot first referenced each image, so an unresolved one can name its origin.
        const referencedBy = new Map<number, string>();
        parsed.materials.forEach((d, mi) => {
            for (const [slot, index] of Object.entries(d.textures) as [string, number | undefined][])
                if (index !== undefined && !referencedBy.has(index))
                    referencedBy.set(index, `material ${mi} · ${SLOT_LABELS[slot] ?? slot}`);
        });

        const textureIds: (string | undefined)[] = parsed.images.map((image, i): string | undefined => {
            const from = referencedBy.get(i) ?? `image #${i}`;
            try {
                switch (image.kind) {
                    case 'bytes': return TextureManager.Instance.addTextureFromBytes(image.bytes, image.mime, { ...cfg, mipMap: false });
                    case 'dataUri': return TextureManager.Instance.addTextureFromBase64(image.uri, { ...cfg, mipMap: false });
                    case 'file': {
                        const file = files.find(f => f.name === image.fileName);
                        if (!file) { report?.missingFiles.push({ name: image.fileName, from }); return undefined; }
                        return TextureManager.Instance.addTextureFromFile(file, cfg, uniqueTextureId(file.name));
                    }
                    case 'path': return TextureManager.Instance.addTextureFromPath(image.uri, cfg);
                    default:
                        // A named URI is an absent file the user can supply, so it is missingFiles (which
                        // drives the review modal's picker) rather than unloadable, which reads as unfixable.
                        if (image.uri) report?.missingFiles.push({ name: textureBaseName(image.uri), from });
                        else report?.unloadable.push({ name: `image #${i}`, from });
                        return undefined;
                }
            } catch (error) {
                Logger.print('warn', ['Failed to load texture:', error], 'Loader');
                report?.unloadable.push({ name: `image #${i}`, from });
                return undefined;
            }
        });

        // A recovered slot names a file by whatever path the authoring tool wrote
        // (`..\..\ScanForge\foo_Normal.jpg`), so it is matched on BASENAME against the upload — the same
        // rule `findFile` uses for the glTF's own relative URIs. Memoised, because several slots and
        // several materials routinely point at one image and each registration is a GPU texture.
        const recoveredIds = new Map<string, string | undefined>();
        const resolveRecovered = (raw: string | undefined, from: string): string | undefined => {
            if (!raw) return undefined;
            const base = textureBaseName(raw);
            if (recoveredIds.has(base)) return recoveredIds.get(base);
            const file = files.find(f => f.name.toLowerCase() === base.toLowerCase());
            let id: string | undefined;
            if (!file) report?.missingFiles.push({ name: base, from });
            else {
                try { id = TextureManager.Instance.addTextureFromFile(file, cfg, uniqueTextureId(file.name)); }
                catch (error) {
                    Logger.print('warn', ['Failed to load recovered texture:', error], 'Loader');
                    report?.unloadable.push({ name: base, from });
                }
            }
            recoveredIds.set(base, id);
            return id;
        };

        const materials = parsed.materials.map((d, mi) => {
            const textures: any = {};
            for (const [slot, index] of Object.entries(d.textures) as [string, number | undefined][])
                if (index !== undefined) textures[slot] = textureIds[index];

            // Never over a slot the glTF itself filled: the conversion is the thing that lost these, so
            // anything that survived it is the more trustworthy of the two.
            const extra = recovered?.[mi];
            if (extra) {
                for (const [slot, raw] of Object.entries(extra) as [string, string | undefined][]) {
                    if (!raw || textures[slot] !== undefined) continue;
                    const id = resolveRecovered(raw, `material ${mi} · ${SLOT_LABELS[slot] ?? slot}`);
                    if (id) textures[slot] = id;
                }
            }

            return Material.PBR({
                baseColor: d.baseColor,
                metallic: d.metallic,
                roughness: d.roughness,
                opacity: d.opacity,
                alphaCutoff: d.alphaCutoff ?? 0,
                emissiveFactor: d.emissiveFactor,
                emissiveIntensity: d.emissiveIntensity ?? 1,
                textures
            }, {
                side: d.doubleSided ? 'double' : 'front',
                transparent: d.transparent,
            });
        });

        return parsed.meshes.map(mesh => {
            const g = mesh.geometry;
            // Adopts the typed arrays directly — they may have been transferred from a worker.
            //
            // `g.bitangents`, NOT `[]`. `Geometry`'s constructor recomputes the whole frame whenever
            // EITHER array is missing, so passing an empty one here threw away the glTF's authored
            // `TANGENT` — and the handedness `gltfLoader` decodes out of its `w` — on every mesh that
            // came through this path, which is the exact failure that decode exists to prevent. The
            // worker's transferable list already carries them.
            const raw = new Geometry(g.positions, g.normals, g.uvs, g.tangents, g.bitangents, g.indices);
            // WELD, because this route unwelds. Assimp's glTF2 exporter runs `MakeVerboseFormat`, so
            // every triangle arrives owning its own three vertices — measured on a scanned branch, 1963
            // authored positions became 11823 vertices under an identity index buffer. Nothing shared
            // means nothing interpolates ACROSS an edge, so the shading normal jumps at every triangle
            // boundary (55.8 degrees median between corners at one position, while each sat 9.4 degrees
            // from its own face) and `_calculateTangents` degenerates to per-face. Both the lighting and
            // the parallax chart come out faceted, and no amount of per-pixel interpolation can fix data
            // that is not smooth. `weldSmooth` is a no-op on an already-shared mesh.
            const geometry = weldCreaseDeg > 0 ? raw.weldSmooth(weldCreaseDeg) : raw;
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
     * Turn the pure output of `parseAssimpFiles` into live `Geometry` and `Material` objects. Must run
     * on the main thread: it creates textures. `files` resolves materials that name a texture by filename.
     */
    public static async assembleAssimpModels(
        parsed: AssimpParseResult,
        files: File[],
        report?: TextureLoadReport
    ): Promise<{ name: string, geometry: Geometry, material: Material }[]> {
        const validateBase64Image = async (base64: string): Promise<boolean> => {
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => resolve(true);
                img.onerror = () => resolve(false);
                img.src = base64;
            });
        };

        const loadTextureFromSources = async (
            texturePath: string | undefined, textureData: string | undefined, id: string, from: string
        ) => {
            // One line per reference: otherwise the only symptom of a failure below is an untextured model.
            if (texturePath)
                Logger.print('info', [`${from}: ${texturePath}${textureData ? ' (embedded data found)' : ''}`], 'Import');

            // First priority: use embedded base64 data if available and valid
            if (textureData) {
                const isValid = await validateBase64Image(textureData);
                if (isValid) {
                    return TextureManager.Instance.addTextureFromBase64(
                        textureData, { wrapping: 'repeat', mipMap: false }, uniqueTextureId(id));
                } else {
                    Logger.print('warn', ['Base64 texture data is not a valid image, skipping:', textureData.slice(0, 50)], 'Loader');
                    report?.unloadable.push({ name: id, from });
                    return undefined;
                }
            }

            if (!texturePath) return undefined;

            // `*N` is assimp's reference to an embedded texture, NOT a filename: reaching here means the
            // parse could not decode it, and searching the upload would report nothing.
            if (texturePath.startsWith('*')) {
                report?.unloadable.push({ name: `embedded texture ${texturePath}`, from });
                return undefined;
            }

            // Second priority: look for texture file in uploaded files
            const textureFileName = textureBaseName(texturePath);
            if (!textureFileName) return undefined;

            const textureFile = files.find(file =>
                file.name.toLowerCase().endsWith(textureFileName.toLowerCase()) ||
                file.name.toLowerCase() === textureFileName.toLowerCase()
            );
            if (!textureFile) {
                report?.missingFiles.push({ name: textureFileName, from });
                return undefined;
            }
            // Named after the file, not a UUID: the id is what the asset explorer shows.
            return TextureManager.Instance.addTextureFromFile(
                textureFile, { wrapping: 'repeat' }, uniqueTextureId(textureFile.name));
        };

        const models: { name: string, geometry: Geometry, material: Material }[] = [];
        for (const mesh of parsed.meshes) {
            // Adopts the typed arrays directly; they may have been transferred from a worker.
            const geometry = new Geometry(
                mesh.positions, mesh.normals, mesh.uvs,
                mesh.tangents, mesh.bitangents, mesh.indices);

            const description = parsed.materials[mesh.materialIndex]?.material;
            if (!description) {
                models.push({ name: mesh.name, geometry, material: Material.Default({}) });
                continue;
            }

            const matName = description.name || mesh.name || 'material';
            const slot = (name: keyof AssimpParseResult['materials'][number]['material']['texturesPaths']) =>
                loadTextureFromSources(
                    description.texturesPaths[name], description.texturesData[name],
                    `${matName}_${name}`, `${matName} · ${SLOT_LABELS[name] ?? name}`);

            const textures = {
                base: await slot('base'),
                specular: await slot('specular'),
                normal: await slot('normal'),
                emissive: await slot('emissive'),
                mask: await slot('mask'),
                reflectivity: await slot('reflectivity')
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

    /** Load skinned, animated models from file paths. glTF only; other formats fall back to {@link loadModelsFromPath}. */
    public static async loadAnimatedModelsFromPath(filePath: string): Promise<{name: string, model: AnimatedModel, transform?: ImportTransform}[]> {
        // Check if this is a GLTF file
        if (filePath.toLowerCase().endsWith('.gltf')) {
            const gltfLoader = new GLTFLoader();
            return await gltfLoader.loadAnimatedFromPath(filePath);
        }

        // For non-GLTF files, throw an error since they don't support skeletal animation
        throw new Error('Animated models are only supported for GLTF files. Use loadModelsFromPath for static models.');
    }

    /** Load skinned, animated models from uploaded files. glTF only; other formats fall back to {@link loadModelsFromFile}. */
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
     * Parse animation clips and their source skeleton from an uploaded model file, for retargeting.
     * glTF natively; glb/fbx/obj convert to glTF2 via assimp first. Returns the first model's clips.
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

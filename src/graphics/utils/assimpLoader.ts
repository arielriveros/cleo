import { Logger } from "../../core/logger";

// aiTextureType. A `$tex.file` property carries its type in `semantic`, and a material may well use more
// than one of these for the same slot, so each slot below is a PREFERENCE LIST tried in order.
const DIFFUSE_TEXTURE = 1;
const SPECULAR_TEXTURE = 2;
const AMBIENT_TEXTURE = 3;
const EMISSIVE_TEXTURE = 4;
const HEIGHT_TEXTURE = 5;
const NORMALS_TEXTURE = 6;
const MASK_TEXTURE = 8;
const BASE_COLOR_TEXTURE = 12;

// Base colour: legacy exporters write DIFFUSE, PBR ones (Stingray / Maya Standard Surface / 3ds Max
// Physical, and glTF via assimp) write BASE_COLOR — often only BASE_COLOR.
const BASE_SLOT = [DIFFUSE_TEXTURE, BASE_COLOR_TEXTURE];
// Image formats a browser can turn into a texture. DDS/TGA/PSD/EXR do appear in FBX files and have to be
// reported rather than handed to an <img>, which would just fail silently later.
const DECODABLE_HINTS = ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'];
// Normals: NORMALS is the correct type and what FBX/glTF use. HEIGHT stays as a fallback because assimp
// maps OBJ's `bump` directive onto it, and that is the case this code was originally written against.
const NORMAL_SLOT = [NORMALS_TEXTURE, HEIGHT_TEXTURE];

const assimpjs = require('./assimpjs');

/**
 * The emscripten module, instantiated once and reused.
 *
 * Each `assimpjs()` call builds a fresh WASM instance, and the three entry points below used to do
 * that independently — so importing a non-glTF file *with* animations paid full WASM startup twice
 * (once to load the meshes, once for the FBX→glTF2 conversion that reads the animations).
 */
let assimpModule: Promise<any> | null = null;
function getAssimp(): Promise<any> {
    if (!assimpModule) assimpModule = assimpjs() as Promise<any>;
    return assimpModule;
}

async function loadAssimpModel(urls: string[], options = {}): Promise<{ meshes: any[], materials: any[], textures?: any[] }> {
    try {
        const ajs = await getAssimp();

        // Fetch the files to import
        let files = [...urls];
        const responses = await Promise.all(files.map(file => fetch(file)));
        const arrayBuffers = await Promise.all(responses.map(res => res.arrayBuffer()));

        // Create a new file list object and add the files
        let fileList = new ajs.FileList();
        
        for (let i = 0; i < files.length; i++)
            fileList.AddFile(files[i], new Uint8Array(arrayBuffers[i]));
        
        // Convert file list to assimp json
        let result = ajs.ConvertFileList(fileList, 'assjson');

        // Check if the conversion succeeded
        if (!result.IsSuccess() || result.FileCount() == 0) {
            Logger.print('error', [result.GetErrorCode()], 'Import');
            throw new Error('Conversion failed');
        }

        // Get the result file and convert to string
        let resultFile = result.GetFile(0);
        let jsonContent = new TextDecoder().decode(resultFile.GetContent());

        // Parse the result JSON
        let resultJson = JSON.parse(jsonContent);

        const materials: any[] = resultJson.materials;
        const meshes: any[] = resultJson.meshes;
        const textures: any[] = resultJson.textures || [];

        let output: { meshes: any[]; materials: any[]; textures?: any[] };
        output = { meshes, materials, textures };
        return output;
    } 
    catch (error) {
        Logger.print('error', [error], 'Import');
        throw error;
    }
}

async function loadAssimpModelFromFiles(files: File[]): Promise<{ meshes: any[], materials: any[], textures?: any[] }> {
    try {
        const ajs = await getAssimp();

        // Create a new file list object and add the files
        let fileList = new ajs.FileList();
        
        for (let file of files) {
            const arrayBuffer = await file.arrayBuffer();
            fileList.AddFile(file.name, new Uint8Array(arrayBuffer));
        }
        
        // Convert file list to assimp json
        let result = ajs.ConvertFileList(fileList, 'assjson');

        // Check if the conversion succeeded
        if (!result.IsSuccess() || result.FileCount() == 0) {
            Logger.print('error', [result.GetErrorCode()], 'Import');
            throw new Error('Conversion failed');
        }

        // Get the result file and convert to string
        let resultFile = result.GetFile(0);
        let jsonContent = new TextDecoder().decode(resultFile.GetContent());

        // Parse the result JSON
        let resultJson = JSON.parse(jsonContent);

        const materials: any[] = resultJson.materials;
        const meshes: any[] = resultJson.meshes;
        const textures: any[] = resultJson.textures || [];

        let output: { meshes: any[]; materials: any[]; textures?: any[] };
        output = { meshes, materials, textures };
        return output;
    }
    catch (error) {
        Logger.print('error', [error], 'Import');
        throw error;
    }
}

/**
 * Convert any assimp-readable model file (fbx/glb/obj/…) to glTF 2.0 in-memory and return the output
 * files (the .gltf JSON + its .bin buffer [+ any textures]) as `File`s, so they can be fed straight to
 * the engine's GLTFLoader. Used by the animation-import path to extract skeletal animation (which the
 * assjson mesh path drops). The result files reference each other by relative name, which the
 * GLTFLoader resolves — so we preserve the assimp output paths as the File names.
 */
async function convertToGltf2FromFiles(files: File[]): Promise<File[]> {
    const ajs = await getAssimp();
    let fileList = new ajs.FileList();
    for (let file of files) {
        const arrayBuffer = await file.arrayBuffer();
        fileList.AddFile(file.name, new Uint8Array(arrayBuffer));
    }

    let result = ajs.ConvertFileList(fileList, 'gltf2');
    if (!result.IsSuccess() || result.FileCount() == 0) {
        Logger.print('error', ['Assimp glTF2 conversion error code:', result.GetErrorCode?.()], 'Import');
        throw new Error('Failed to convert model to glTF2 (assimp)');
    }

    const out: File[] = [];
    const count: number = result.FileCount();
    for (let i = 0; i < count; i++) {
        const rf = result.GetFile(i);
        const path: string = (typeof rf.GetPath === 'function' ? rf.GetPath() : '') || `assimp_out_${i}.gltf`;
        const name = path.split(/[\\/]/).pop() || path; // basename (URIs in the gltf are relative)
        const content: Uint8Array = rf.GetContent();
        // Copy into a fresh ArrayBuffer (the wasm view may be reused/freed after this call).
        out.push(new File([content.slice()], name));
    }
    return out;
}

interface AiMaterialProperties {
    key: string;
    type: string;
    semantic: number;
    index: number;
    value: any;
}

export interface OutputMaterial {
    name: string;
    diffuse: [number, number, number];
    specular: [number, number, number];
    ambient: [number, number, number];
    emissive: [number, number, number];
    shininess: number;
    opacity: number;
    texturesPaths: {
        base?: string;
        specular?: string;
        normal?: string;
        emissive?: string;
        mask?: string;
        reflectivity?: string;
    };
    texturesData: {
        base?: string;
        specular?: string;
        normal?: string;
        emissive?: string;
        mask?: string;
        reflectivity?: string;
    };
}

async function parseMaterial(mat: any, textures: any[] = []): Promise<{name: string, material: OutputMaterial}> {
    return new Promise((resolve, reject) => {

        const properties = mat.properties;
    
        const find = (property: AiMaterialProperties[], key: string): AiMaterialProperties[] => {
            const output = []
            for (const prop of property)
                if (prop.key === key) output.push(prop);
    
            return output;
        }
    
    
        const getValues = (properties: AiMaterialProperties[], key: string) => {
            const out = find(properties, key);
            const values = [];
            for (const prop of out)
                values.push(prop.value);
    
            return values;
        }
    
        const getVec3 = (properties: AiMaterialProperties[], key: string, index: number = 0) => {
            const value = getValues(properties, key)[index];
            if (!value) return [0.0, 0.0, 0.0];
            return value;
        }
    
        const getString = (properties: AiMaterialProperties[], key: string, index: number = 0) => {
            const value = getValues(properties, key)[index];
            if (!value) return '';
            return value;
        }
    
        const getNumber = (properties: AiMaterialProperties[], key: string, index: number = 0) => {
            const value = getValues(properties, key)[index];
            if (!value) return 0.0;
            return value;
        }
    
        /** The first `$tex.file` matching any of `types`, in preference order. */
        const getTexture = (properties: AiMaterialProperties[], types: number[]) => {
            const files = find(properties, '$tex.file');
            for (const type of types)
                for (const tex of files) if (tex.semantic === type) return tex.value;

            return undefined;
        }

        /**
         * The image bytes behind a `*N` reference — the form assimp gives a texture embedded in the model
         * file itself (the default for a self-contained FBX or a GLB).
         *
         * The field names matter and are easy to get wrong: this reads the **assjson exporter's** output
         * (`formathint` / `data` / `width` / `height`), NOT the C++ `aiTexture` struct's members
         * (`achFormatHint` / `pcData`). Reading the struct names silently yields `undefined` for every
         * texture ever, so an embedded-texture FBX imports with correct geometry and no maps at all —
         * and nothing downstream can tell that apart from a model that genuinely has no textures.
         */
        const getEmbeddedTextureData = (texturePath: string | undefined) => {
            if (!texturePath || !texturePath.startsWith('*') || !textures) return undefined;

            const index = parseInt(texturePath.substring(1), 10);
            const record = index >= 0 && index < textures.length ? textures[index] : undefined;
            if (!record) return undefined;

            // `height > 0` means raw uncompressed ARGB pixels rather than an encoded image, so there is no
            // mime type that would make a data: URL out of it. Rare (assimp keeps the original bytes when
            // it can) and not worth an encoder here.
            if (record.height > 0) {
                Logger.print('warn', [`Embedded texture ${texturePath} is raw pixel data, which is not supported`], 'Import');
                return undefined;
            }

            const hint = String(record.formathint ?? record.achFormatHint ?? '').toLowerCase().replace(/\0/g, '').trim();
            // The exporter pretty-prints the payload, so it arrives with embedded and trailing whitespace.
            const payload = String(record.data ?? record.pcData ?? '').replace(/\s/g, '');
            if (!hint || !payload) return undefined;
            if (!DECODABLE_HINTS.includes(hint)) {
                Logger.print('warn', [`Embedded texture ${texturePath} is a .${hint}, which browsers cannot decode`], 'Import');
                return undefined;
            }

            try {
                atob(payload.substring(0, 100)); // cheap sanity check; a bad payload throws here, not at upload
            } catch (e) {
                Logger.print('error', ['Invalid embedded texture data:', e], 'Import');
                return undefined;
            }
            return `data:image/${hint === 'jpg' ? 'jpeg' : hint};base64,${payload}`;
        }

        const name = getString(properties, '?mat.name');
        const diffuse = getVec3(properties, '$clr.diffuse');
        const specular = getVec3(properties, '$clr.specular');
        const ambient = getVec3(properties, '$clr.ambient');
        const emissive = getVec3(properties, '$clr.emissive');
        const shininess = getNumber(properties, '$mat.shininess');
        const opacity = getNumber(properties, '$mat.opacity');

        const diffuseMap = getTexture(properties, BASE_SLOT);
        const specularMap = getTexture(properties, [SPECULAR_TEXTURE]);
        const normalMap = getTexture(properties, NORMAL_SLOT);
        const emissiveMap = getTexture(properties, [EMISSIVE_TEXTURE]);
        const maskMap = getTexture(properties, [MASK_TEXTURE]);
        const reflectivityMap = getTexture(properties, [AMBIENT_TEXTURE]);

        const material: OutputMaterial = {
            name,
            diffuse, specular, ambient,
            emissive, shininess, opacity,
            texturesPaths: {
                base: diffuseMap,
                specular: specularMap,
                normal: normalMap,
                emissive: emissiveMap,
                mask: maskMap,
                reflectivity: reflectivityMap
            },
            texturesData: {
                base: getEmbeddedTextureData(diffuseMap),
                specular: getEmbeddedTextureData(specularMap),
                normal: getEmbeddedTextureData(normalMap),
                emissive: getEmbeddedTextureData(emissiveMap),
                mask: getEmbeddedTextureData(maskMap),
                reflectivity: getEmbeddedTextureData(reflectivityMap)
            }
        }
        
        resolve({name, material});
    });
}

/** One mesh, as flat typed arrays — the shape `Geometry` adopts without copying. */
export interface ParsedMesh {
    name: string;
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    tangents: Float32Array;
    bitangents: Float32Array;
    indices: Uint32Array;
    materialIndex: number;
}

/**
 * Everything a model file yields that does NOT require a GL context: geometry as typed arrays plus
 * material descriptors ({@link OutputMaterial} — colours, plus texture *paths* and base64 strings,
 * never decoded pixels).
 */
export interface AssimpParseResult {
    meshes: ParsedMesh[];
    materials: { name: string; material: OutputMaterial }[];
}

/**
 * Parse model files into plain data. **Pure: no DOM, no WebGL, no engine imports** — this module only
 * pulls in assimpjs, which is a SINGLE_FILE emscripten build that already supports worker
 * environments. That is what lets the editor run this inside a Web Worker (and fall back to running
 * it inline, unchanged, when a worker is unavailable).
 *
 * Pair with `Loader.assembleAssimpModels`, which does the GL half on the main thread.
 */
async function parseAssimpFiles(files: File[]): Promise<AssimpParseResult> {
    const res = await loadAssimpModelFromFiles(files);

    const materials: { name: string; material: OutputMaterial }[] = [];
    for (const mat of res.materials) materials.push(await parseMaterial(mat, res.textures));

    const meshes: ParsedMesh[] = [];
    for (const m of res.meshes) {
        const name = m.name;
        if (!m.normals) throw new Error(`Mesh ${name} has no normals`);
        const uvs: number[] = m.texturecoords?.[0];
        if (!uvs) throw new Error(`Mesh ${name} has no UVs`);

        // assimp hands these over already flat, so this is a straight typed-array wrap. The loader
        // used to explode each into an array of 3-element arrays here, only for Geometry to flatten
        // it again on upload.
        meshes.push({
            name,
            positions: new Float32Array(m.vertices),
            normals: new Float32Array(m.normals),
            uvs: new Float32Array(uvs),
            tangents: m.tangents ? new Float32Array(m.tangents) : new Float32Array(0),
            bitangents: m.bitangents ? new Float32Array(m.bitangents) : new Float32Array(0),
            indices: Uint32Array.from(m.faces.flat()),
            materialIndex: m.materialindex,
        });
    }

    return { meshes, materials };
}

/**
 * The buffers in `result` that can be transferred rather than copied across a worker boundary.
 *
 * Transferring detaches them in the sender, so only pass these when the sending side is done with the
 * result — which is the case for a worker replying with its final answer.
 */
function parseResultTransferables(result: AssimpParseResult): ArrayBuffer[] {
    const out: ArrayBuffer[] = [];
    for (const m of result.meshes)
        for (const a of [m.positions, m.normals, m.uvs, m.tangents, m.bitangents, m.indices])
            if (a.byteLength > 0) out.push(a.buffer as ArrayBuffer);
    return out;
}

export { loadAssimpModel, loadAssimpModelFromFiles, parseMaterial, convertToGltf2FromFiles, parseAssimpFiles, parseResultTransferables };
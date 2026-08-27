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
// Image formats a browser can decode. DDS/TGA/PSD/EXR appear in FBX files and must be REPORTED, not
// handed to an `<img>` that fails silently later.
const DECODABLE_HINTS = ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'];
// Normals: NORMALS is the correct type and what FBX/glTF use. HEIGHT stays as a fallback because assimp
// maps OBJ's `bump` directive onto it, and that is the case this code was originally written against.
const NORMAL_SLOT = [NORMALS_TEXTURE, HEIGHT_TEXTURE];

const assimpjs = require('./assimpjs');

// The emscripten module, instantiated once and reused: each `assimpjs()` call builds a fresh WASM
// instance, and an import can need it twice.
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

// Convert any assimp-readable model file to glTF 2.0 in memory, for the animation-import path — the
// assjson mesh path drops skeletal animation. Output File NAMES keep assimp's paths, which the
// GLTFLoader resolves the inter-file references against.
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

        // The image bytes behind a `*N` reference. Reads the assjson EXPORTER's field names
        // (`formathint`/`data`/`width`/`height`), never the C++ `aiTexture` struct's — those silently
        // yield undefined, and the model imports with no maps at all.
        const getEmbeddedTextureData = (texturePath: string | undefined) => {
            if (!texturePath || !texturePath.startsWith('*') || !textures) return undefined;

            const index = parseInt(texturePath.substring(1), 10);
            const record = index >= 0 && index < textures.length ? textures[index] : undefined;
            if (!record) return undefined;

            // `height > 0` means raw ARGB pixels rather than an encoded image, so there is no mime
            // type to build a data: URL from.
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
 * Everything a model file yields that needs no GL context: geometry as typed arrays, plus material
 * descriptors carrying texture paths and base64 strings, never decoded pixels.
 */
export interface AssimpParseResult {
    meshes: ParsedMesh[];
    materials: { name: string; material: OutputMaterial }[];
}

// Parse model files into plain data. PURE — no DOM, no WebGL, no engine imports — which is what lets
// the editor run this in a Web Worker. Pair with `Loader.assembleAssimpModels` for the GL half.
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

        // assimp hands these over already flat, so this is a straight typed-array wrap.
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

// The buffers in `result` that can be transferred rather than copied across a worker boundary.
// Transferring DETACHES them in the sender, so only use these when it is done with the result.
function parseResultTransferables(result: AssimpParseResult): ArrayBuffer[] {
    const out: ArrayBuffer[] = [];
    for (const m of result.meshes)
        for (const a of [m.positions, m.normals, m.uvs, m.tangents, m.bitangents, m.indices])
            if (a.byteLength > 0) out.push(a.buffer as ArrayBuffer);
    return out;
}

export { loadAssimpModel, loadAssimpModelFromFiles, parseMaterial, convertToGltf2FromFiles, parseAssimpFiles, parseResultTransferables };
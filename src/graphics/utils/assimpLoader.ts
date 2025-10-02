const DIFFUSE_TEXTURE = 1;
const SPECULAR_TEXTURE = 2;
const AMBIENT_TEXTURE = 3;

const EMISSIVE_TEXTURE = 4;
const NORMAL_TEXTURE = 5;
const MASK_TEXTURE = 8;

const assimpjs = require('./assimpjs');

/**
 * Determines the correct base path for assets based on the current environment
 * @param path The original path (e.g., '/assets/damagedHelmet/damaged_helmet.obj')
 * @returns The corrected path for the current environment
 */
function resolveAssetPath(path: string): string {
  // If the path already starts with http/https, use it as-is (for deployed scenarios)
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  
  // For local development, use the public folder
  if (path.startsWith('/assets/')) {
    return path; // This works for local development with public folder
  }
  
  // For deployed scenarios, try to construct the full URL
  // This handles cases where the app is deployed to a subdirectory
  const baseUrl = window.location.origin + window.location.pathname.replace(/\/[^\/]*$/, '');
  return baseUrl + path;
}

async function loadAssimpModel(urls: string[], options = {}): Promise<{ meshes: any[], materials: any[] }> {
    try {
        const ajs = await assimpjs();

        // Fetch the files to import
        let files = [...urls];
        // Resolve asset paths for both local and deployed scenarios
        const resolvedFiles = files.map(file => resolveAssetPath(file));
        const responses = await Promise.all(resolvedFiles.map(file => fetch(file)));
        const arrayBuffers = await Promise.all(responses.map(res => res.arrayBuffer()));

        // Create a new file list object and add the files
        let fileList = new ajs.FileList();
        
        for (let i = 0; i < files.length; i++)
            fileList.AddFile(files[i], new Uint8Array(arrayBuffers[i]));
        
        // Convert file list to assimp json
        let result = ajs.ConvertFileList(fileList, 'assjson');

        // Check if the conversion succeeded
        if (!result.IsSuccess() || result.FileCount() == 0) {
            console.error(result.GetErrorCode());
            throw new Error('Conversion failed');
        }

        // Get the result file and convert to string
        let resultFile = result.GetFile(0);
        let jsonContent = new TextDecoder().decode(resultFile.GetContent());

        // Parse the result JSON
        let resultJson = JSON.parse(jsonContent);

        const materials: any[] = resultJson.materials;
        const meshes: any[] = resultJson.meshes;

        let output: { meshes: any[]; materials: any[]; };
        output = { meshes, materials };
        return output;
    } 
    catch (error) {
        console.error(error);
        throw error;
    }
}

async function loadAssimpModelFromFiles(files: File[]): Promise<{ meshes: any[], materials: any[] }> {
    try {
        const ajs = await assimpjs();

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
            console.error(result.GetErrorCode());
            throw new Error('Conversion failed');
        }

        // Get the result file and convert to string
        let resultFile = result.GetFile(0);
        let jsonContent = new TextDecoder().decode(resultFile.GetContent());

        // Parse the result JSON
        let resultJson = JSON.parse(jsonContent);

        const materials: any[] = resultJson.materials;
        const meshes: any[] = resultJson.meshes;

        let output: { meshes: any[]; materials: any[]; };
        output = { meshes, materials };
        return output;
    }
    catch (error) {
        console.error(error);
        throw error;
    }
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
    }
}

async function parseMaterial(mat: any): Promise<{name: string, material: OutputMaterial}> {
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
    
        const getTexture = (properties: AiMaterialProperties[], type: number) => {
            const textures = find(properties, '$tex.file');
            for (const tex of textures) if (tex.semantic === type) return tex.value;
    
            return undefined;
        }
        
        const name = getString(properties, '?mat.name');
        const diffuse = getVec3(properties, '$clr.diffuse');
        const specular = getVec3(properties, '$clr.specular');
        const ambient = getVec3(properties, '$clr.ambient');
        const emissive = getVec3(properties, '$clr.emissive');
        const shininess = getNumber(properties, '$mat.shininess');
        const opacity = getNumber(properties, '$mat.opacity');

        const diffuseMap = getTexture(properties, DIFFUSE_TEXTURE);
        const specularMap = getTexture(properties, SPECULAR_TEXTURE);
        const normalMap = getTexture(properties, NORMAL_TEXTURE);
        const emissiveMap = getTexture(properties, EMISSIVE_TEXTURE);
        const maskMap = getTexture(properties, MASK_TEXTURE);
        const reflectivityMap = getTexture(properties, AMBIENT_TEXTURE);

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
            }
        }
        
        resolve({name, material});
    });
}

export { loadAssimpModel, loadAssimpModelFromFiles, parseMaterial };
const DIFFUSE_TEXTURE = 1;
const SPECULAR_TEXTURE = 2;
const AMBIENT_TEXTURE = 3;

const EMISSIVE_TEXTURE = 4;
const NORMAL_TEXTURE = 5;
const MASK_TEXTURE = 8;

const assimpjs = require('./assimpjs');

async function loadAssimpModel(urls: string[], options = {}): Promise<{ meshes: any[], materials: any[], textures?: any[] }> {
    try {
        const ajs = await assimpjs();

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
        const textures: any[] = resultJson.textures || [];

        let output: { meshes: any[]; materials: any[]; textures?: any[] };
        output = { meshes, materials, textures };
        return output;
    } 
    catch (error) {
        console.error(error);
        throw error;
    }
}

async function loadAssimpModelFromFiles(files: File[]): Promise<{ meshes: any[], materials: any[], textures?: any[] }> {
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
        const textures: any[] = resultJson.textures || [];

        let output: { meshes: any[]; materials: any[]; textures?: any[] };
        output = { meshes, materials, textures };
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
    
        const getTexture = (properties: AiMaterialProperties[], type: number) => {
            const textures = find(properties, '$tex.file');
            for (const tex of textures) if (tex.semantic === type) return tex.value;
    
            return undefined;
        }

        // Helper function to get embedded texture data
        const getEmbeddedTextureData = (texturePath: string) => {
            if (!texturePath || !textures) return undefined;
            
            // Check if the texture path refers to an embedded texture (usually starts with "*" followed by index)
            if (texturePath.startsWith('*')) {
                const textureIndex = parseInt(texturePath.substring(1));
                if (textureIndex >= 0 && textureIndex < textures.length) {
                    const textureData = textures[textureIndex];
                    console.log(`Processing embedded texture ${textureIndex}:`, {
                        format: textureData?.achFormatHint,
                        hasData: !!textureData?.pcData,
                        dataLength: textureData?.pcData?.length || 0,
                        mWidth: textureData?.mWidth,
                        mHeight: textureData?.mHeight,
                        fullData: textureData
                    });
                    
                    // Return base64 data if available
                    if (textureData && textureData.achFormatHint && textureData.pcData) {
                        const formatHint = textureData.achFormatHint.toLowerCase().replace(/\0/g, ''); // Remove null characters
                        const mimeType = formatHint === 'jpg' ? 'jpeg' : formatHint;
                        const base64String = `data:image/${mimeType};base64,${textureData.pcData}`;
                        
                        console.log(`Generated base64 string (first 100 chars):`, base64String.substring(0, 100));
                        console.log(`Base64 data length:`, textureData.pcData.length);
                        
                        // Try to validate the base64 data
                        try {
                            // Test if it's valid base64
                            atob(textureData.pcData.substring(0, 100));
                            return base64String;
                        } catch (e) {
                            console.error('Invalid base64 data:', e);
                            return undefined;
                        }
                    }
                }
            }
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

        console.log(`Material "${name}" texture paths:`, {
            diffuse: diffuseMap,
            specular: specularMap,
            normal: normalMap,
            emissive: emissiveMap,
            mask: maskMap,
            reflectivity: reflectivityMap
        });

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

export { loadAssimpModel, loadAssimpModelFromFiles, parseMaterial };
import { Material } from "../material";
import { Texture } from "../texture";
import { TextureManager } from "../systems/textureManager";

const DIFFUSE_TEXTURE = 1;
const SPECULAR_TEXTURE = 2;
const AMBIENT_TEXTURE = 3;

const EMISSIVE_TEXTURE = 4;
const NORMAL_TEXTURE = 5;
const MASK_TEXTURE = 8;

const assimpjs = require('./assimpjs');

async function loadAssimpModel(urls: string[], options = {}): Promise<{ meshes: any[], materials: any[] }> {
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

async function parseMaterial(mat: any, path?: string): Promise<{name: string, material: Material}> {
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

        let diffuseMap = getTexture(properties, DIFFUSE_TEXTURE);
        if (diffuseMap) { 
            let id = TextureManager.Instance.addTextureFromPath(`${path}/${diffuseMap}`, { wrapping: 'repeat' })
            diffuseMap = id;
        }

        let specularMap = getTexture(properties, SPECULAR_TEXTURE);
        if(specularMap) {
            let id = TextureManager.Instance.addTextureFromPath(`${path}/${specularMap}`, { wrapping: 'repeat' })
            specularMap = id;
        }

        let normalMap = getTexture(properties, NORMAL_TEXTURE);
        if (normalMap) {
            let id = TextureManager.Instance.addTextureFromPath(`${path}/${normalMap}`, { wrapping: 'repeat' })
            normalMap = id;
        }
        let emissiveMap = getTexture(properties, EMISSIVE_TEXTURE);
        if (emissiveMap) {
            let id = TextureManager.Instance.addTextureFromPath(`${path}/${emissiveMap}`, { wrapping: 'repeat' })
            emissiveMap = id;
        }
        let maskMap = getTexture(properties, MASK_TEXTURE);
        if (maskMap) {
            let id = TextureManager.Instance.addTextureFromPath(`${path}/${maskMap}`, { wrapping: 'repeat' })
            maskMap = id;
        }
        let reflectivityMap = getTexture(properties, AMBIENT_TEXTURE);
        if (reflectivityMap) {
            let id = TextureManager.Instance.addTextureFromPath(`${path}/${reflectivityMap}`, { wrapping: 'repeat' })
            reflectivityMap = id;
        }

        const material = Material.Default({
            ambient, diffuse, specular, shininess, emissive, opacity,
            textures: {
                base: diffuseMap,
                specular: specularMap,
                normal: normalMap,
                emissive: emissiveMap,
                mask: maskMap,
                reflectivity: reflectivityMap
            }}
        );
    
        
        resolve({name, material});
    });
}

export { loadAssimpModel, parseMaterial };
import { Geometry } from "../../core/geometry";
import { Material } from "../material";
import { TextureManager } from "../systems/textureManager";
import { AnimatedModel, Skin, Animation, AnimationSampler, AnimationChannel } from "../animatedModel";
import { mat4 } from "gl-matrix";

// GLTF Types based on the specification
interface GLTFAsset {
    version: string;
    generator?: string;
    copyright?: string;
}

interface GLTFBuffer {
    uri?: string;
    byteLength: number;
}

interface GLTFBufferView {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    target?: number;
}

interface GLTFAccessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    max?: number[];
    min?: number[];
    normalized?: boolean;
}

interface GLTFMaterial {
    name?: string;
    pbrMetallicRoughness?: {
        baseColorFactor?: number[];
        baseColorTexture?: { index: number };
        metallicFactor?: number;
        roughnessFactor?: number;
        metallicRoughnessTexture?: { index: number };
    };
    normalTexture?: { index: number };
    emissiveTexture?: { index: number };
    emissiveFactor?: number[];
    alphaMode?: string;
    alphaCutoff?: number;
    doubleSided?: boolean;
}

interface GLTFTexture {
    sampler?: number;
    source?: number;
}

interface GLTFImage {
    uri?: string;
    mimeType?: string;
    bufferView?: number;
}

interface GLTFMesh {
    name?: string;
    primitives: {
        attributes: {
            POSITION?: number;
            NORMAL?: number;
            TEXCOORD_0?: number;
            TANGENT?: number;
            JOINTS_0?: number;
            WEIGHTS_0?: number;
        };
        indices?: number;
        material?: number;
        mode?: number;
    }[];
}

interface GLTFSkin {
    name?: string;
    inverseBindMatrices?: number;
    joints: number[];
    skeleton?: number;
}

interface GLTFAnimationSampler {
    input: number;
    output: number;
    interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

interface GLTFAnimationChannel {
    sampler: number;
    target: {
        node?: number;
        path: 'translation' | 'rotation' | 'scale' | 'weights';
    };
}

interface GLTFAnimation {
    name?: string;
    samplers: GLTFAnimationSampler[];
    channels: GLTFAnimationChannel[];
}

interface GLTF {
    asset: GLTFAsset;
    scene?: number;
    scenes?: any[];
    nodes?: any[];
    meshes?: GLTFMesh[];
    materials?: GLTFMaterial[];
    textures?: GLTFTexture[];
    images?: GLTFImage[];
    accessors?: GLTFAccessor[];
    bufferViews?: GLTFBufferView[];
    buffers?: GLTFBuffer[];
    skins?: GLTFSkin[];
    animations?: GLTFAnimation[];
}

// Component type constants
const COMPONENT_TYPE = {
    BYTE: 5120,
    UNSIGNED_BYTE: 5121,
    SHORT: 5122,
    UNSIGNED_SHORT: 5123,
    UNSIGNED_INT: 5125,
    FLOAT: 5126
};

// Type size constants
const TYPE_SIZE = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16
};

export class GLTFLoader {
    private gltf: GLTF;
    private buffers: ArrayBuffer[] = [];
    private basePath: string = '';

    async loadFromPath(filePath: string): Promise<{name: string, geometry: Geometry, material: Material}[]> {
        // Extract base path for relative URI resolution
        this.basePath = filePath.substring(0, filePath.lastIndexOf('/') + 1);
        
        // Load the main GLTF JSON file
        const response = await fetch(filePath);
        const gltfJson = await response.json();
        this.gltf = gltfJson;

        // Load all buffers
        await this.loadBuffers();

        // Parse meshes and materials
        return this.parseMeshes();
    }

    async loadFromFiles(files: File[]): Promise<{name: string, geometry: Geometry, material: Material}[]> {
        const gltfFile = files.find(f => f.name.toLowerCase().endsWith('.gltf'));
        if (!gltfFile) {
            throw new Error('No GLTF file found in the uploaded files');
        }

        // Load GLTF JSON
        const gltfText = await gltfFile.text();
        this.gltf = JSON.parse(gltfText);

        // Load buffers from uploaded files
        await this.loadBuffersFromFiles(files);

        // Parse meshes and materials
        return this.parseMeshes();
    }

    /**
     * Load animated models with skinning and animation data from a file path
     */
    async loadAnimatedFromPath(filePath: string): Promise<{name: string, model: AnimatedModel}[]> {
        // Extract base path for relative URI resolution
        this.basePath = filePath.substring(0, filePath.lastIndexOf('/') + 1);
        
        // Load the main GLTF JSON file
        const response = await fetch(filePath);
        const gltfJson = await response.json();
        this.gltf = gltfJson;

        // Load all buffers
        await this.loadBuffers();

        // Parse meshes with animation data
        return this.parseAnimatedMeshes();
    }

    /**
     * Load animated models with skinning and animation data from uploaded files
     */
    async loadAnimatedFromFiles(files: File[]): Promise<{name: string, model: AnimatedModel}[]> {
        const gltfFile = files.find(f => f.name.toLowerCase().endsWith('.gltf'));
        if (!gltfFile) {
            throw new Error('No GLTF file found in the uploaded files');
        }

        // Load GLTF JSON
        const gltfText = await gltfFile.text();
        this.gltf = JSON.parse(gltfText);

        // Load buffers from uploaded files
        await this.loadBuffersFromFiles(files);

        // Parse meshes with animation data
        return this.parseAnimatedMeshes();
    }

    private async loadBuffers(): Promise<void> {
        if (!this.gltf.buffers) return;

        for (const buffer of this.gltf.buffers) {
            if (buffer.uri) {
                if (buffer.uri.startsWith('data:')) {
                    // Data URI - decode base64
                    const base64Data = buffer.uri.split(',')[1];
                    const binaryString = atob(base64Data);
                    const arrayBuffer = new ArrayBuffer(binaryString.length);
                    const uint8Array = new Uint8Array(arrayBuffer);
                    for (let i = 0; i < binaryString.length; i++) {
                        uint8Array[i] = binaryString.charCodeAt(i);
                    }
                    this.buffers.push(arrayBuffer);
                } else {
                    // External file
                    const bufferPath = this.basePath + buffer.uri;
                    const response = await fetch(bufferPath);
                    const arrayBuffer = await response.arrayBuffer();
                    this.buffers.push(arrayBuffer);
                }
            }
        }
    }

    private async loadBuffersFromFiles(files: File[]): Promise<void> {
        if (!this.gltf.buffers) return;

        for (const buffer of this.gltf.buffers) {
            if (buffer.uri && !buffer.uri.startsWith('data:')) {
                // Find the buffer file in uploaded files
                const bufferFile = files.find(f => f.name === buffer.uri || f.name.endsWith(buffer.uri!));
                if (bufferFile) {
                    const arrayBuffer = await bufferFile.arrayBuffer();
                    this.buffers.push(arrayBuffer);
                } else {
                    console.warn(`Buffer file ${buffer.uri} not found in uploaded files`);
                    this.buffers.push(new ArrayBuffer(0));
                }
            } else if (buffer.uri && buffer.uri.startsWith('data:')) {
                // Data URI - decode base64
                const base64Data = buffer.uri.split(',')[1];
                const binaryString = atob(base64Data);
                const arrayBuffer = new ArrayBuffer(binaryString.length);
                const uint8Array = new Uint8Array(arrayBuffer);
                for (let i = 0; i < binaryString.length; i++) {
                    uint8Array[i] = binaryString.charCodeAt(i);
                }
                this.buffers.push(arrayBuffer);
            } else {
                // Embedded buffer or missing URI
                this.buffers.push(new ArrayBuffer(0));
            }
        }
    }

    private getAccessorData(accessorIndex: number): Float32Array | Uint16Array | Uint32Array {
        const accessor = this.gltf.accessors![accessorIndex];
        const bufferView = this.gltf.bufferViews![accessor.bufferView!];
        const buffer = this.buffers[bufferView.buffer];

        const byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
        const componentSize = this.getComponentSize(accessor.componentType);
        const typeSize = TYPE_SIZE[accessor.type as keyof typeof TYPE_SIZE];
        const elementSize = componentSize * typeSize;
        const elementCount = accessor.count;

        const arrayBuffer = buffer.slice(byteOffset, byteOffset + elementCount * elementSize);

        // Return appropriate typed array based on component type
        switch (accessor.componentType) {
            case COMPONENT_TYPE.FLOAT:
                return new Float32Array(arrayBuffer);
            case COMPONENT_TYPE.UNSIGNED_SHORT:
                return new Uint16Array(arrayBuffer);
            case COMPONENT_TYPE.UNSIGNED_INT:
                return new Uint32Array(arrayBuffer);
            case COMPONENT_TYPE.UNSIGNED_BYTE:
                return new Uint8Array(arrayBuffer) as any;
            default:
                throw new Error(`Unsupported component type: ${accessor.componentType}`);
        }
    }

    private getComponentSize(componentType: number): number {
        switch (componentType) {
            case COMPONENT_TYPE.BYTE:
            case COMPONENT_TYPE.UNSIGNED_BYTE:
                return 1;
            case COMPONENT_TYPE.SHORT:
            case COMPONENT_TYPE.UNSIGNED_SHORT:
                return 2;
            case COMPONENT_TYPE.UNSIGNED_INT:
            case COMPONENT_TYPE.FLOAT:
                return 4;
            default:
                throw new Error(`Unknown component type: ${componentType}`);
        }
    }

    private convertToVec3Array(data: Float32Array): [number, number, number][] {
        const result: [number, number, number][] = [];
        for (let i = 0; i < data.length; i += 3) {
            result.push([data[i], data[i + 1], data[i + 2]]);
        }
        return result;
    }

    private convertToVec2Array(data: Float32Array): [number, number][] {
        const result: [number, number][] = [];
        for (let i = 0; i < data.length; i += 2) {
            // Flip V coordinate to convert from GLTF (bottom-left) to WebGL (top-left) convention
            result.push([data[i], 1.0 - data[i + 1]]);
        }
        return result;
    }

    private async loadImageFromBufferView(image: GLTFImage): Promise<string> {
        if (image.bufferView !== undefined) {
            const bufferView = this.gltf.bufferViews![image.bufferView];
            const buffer = this.buffers[bufferView.buffer];
            const byteOffset = bufferView.byteOffset || 0;
            const byteLength = bufferView.byteLength;
            
            const imageData = buffer.slice(byteOffset, byteOffset + byteLength);
            const uint8Array = new Uint8Array(imageData);
            
            // Convert to base64
            let binary = '';
            for (let i = 0; i < uint8Array.length; i++) {
                binary += String.fromCharCode(uint8Array[i]);
            }
            const base64 = btoa(binary);
            
            const mimeType = image.mimeType || 'image/jpeg';
            return `data:${mimeType};base64,${base64}`;
        }
        
        if (image.uri) {
            if (image.uri.startsWith('data:')) {
                return image.uri;
            } else {
                // External image file
                return this.basePath + image.uri;
            }
        }
        
        throw new Error('Image has no valid data source');
    }

    private async parseMeshes(): Promise<{name: string, geometry: Geometry, material: Material}[]> {
        const result: {name: string, geometry: Geometry, material: Material}[] = [];

        if (!this.gltf.meshes) return result;

        for (const mesh of this.gltf.meshes) {
            for (const primitive of mesh.primitives) {
                const geometry = await this.createGeometry(primitive);
                const material = await this.createMaterial(primitive.material);
                
                result.push({
                    name: mesh.name || 'Mesh',
                    geometry,
                    material
                });
            }
        }

        return result;
    }

    private async createGeometry(primitive: GLTFMesh['primitives'][0]): Promise<Geometry> {
        const positions: [number, number, number][] = [];
        const normals: [number, number, number][] = [];
        const uvs: [number, number][] = [];
        const tangents: [number, number, number][] = [];
        let indices: number[] = [];

        // Load positions
        if (primitive.attributes.POSITION !== undefined) {
            const positionData = this.getAccessorData(primitive.attributes.POSITION) as Float32Array;
            positions.push(...this.convertToVec3Array(positionData));
        }

        // Load normals
        if (primitive.attributes.NORMAL !== undefined) {
            const normalData = this.getAccessorData(primitive.attributes.NORMAL) as Float32Array;
            normals.push(...this.convertToVec3Array(normalData));
        }

        // Load texture coordinates
        if (primitive.attributes.TEXCOORD_0 !== undefined) {
            const uvData = this.getAccessorData(primitive.attributes.TEXCOORD_0) as Float32Array;
            uvs.push(...this.convertToVec2Array(uvData));
        }

        // Load tangents
        if (primitive.attributes.TANGENT !== undefined) {
            const tangentData = this.getAccessorData(primitive.attributes.TANGENT) as Float32Array;
            for (let i = 0; i < tangentData.length; i += 4) {
                tangents.push([tangentData[i], tangentData[i + 1], tangentData[i + 2]]);
            }
        }

        // Load indices
        if (primitive.indices !== undefined) {
            const indexData = this.getAccessorData(primitive.indices);
            indices = Array.from(indexData);
        } else {
            // Generate indices for non-indexed geometry
            for (let i = 0; i < positions.length; i++) {
                indices.push(i);
            }
        }

        return new Geometry(positions, normals, uvs, tangents, [], indices);
    }

    private async createMaterial(materialIndex?: number): Promise<Material> {
        if (materialIndex === undefined || !this.gltf.materials) {
            return Material.Default({});
        }

        const gltfMaterial = this.gltf.materials[materialIndex];
        const pbr = gltfMaterial.pbrMetallicRoughness;

        // Extract material properties
        const diffuse: [number, number, number] = pbr?.baseColorFactor ? 
            [pbr.baseColorFactor[0], pbr.baseColorFactor[1], pbr.baseColorFactor[2]] : 
            [1, 1, 1];

        const emissive: [number, number, number] = gltfMaterial.emissiveFactor ? 
            [gltfMaterial.emissiveFactor[0], gltfMaterial.emissiveFactor[1], gltfMaterial.emissiveFactor[2]] : 
            [0, 0, 0];

        // Load textures
        const textures: any = {};

        if (pbr?.baseColorTexture && this.gltf.textures && this.gltf.images) {
            const textureIndex = pbr.baseColorTexture.index;
            const texture = this.gltf.textures[textureIndex];
            if (texture.source !== undefined) {
                const image = this.gltf.images[texture.source];
                try {
                    const imageData = await this.loadImageFromBufferView(image);
                    if (imageData.startsWith('data:')) {
                        textures.base = TextureManager.Instance.addTextureFromBase64(imageData, { wrapping: 'repeat', mipMap: false });
                    } else {
                        textures.base = TextureManager.Instance.addTextureFromPath(imageData, { wrapping: 'repeat' });
                    }
                } catch (error) {
                    console.warn('Failed to load base color texture:', error);
                }
            }
        }

        if (gltfMaterial.normalTexture && this.gltf.textures && this.gltf.images) {
            const textureIndex = gltfMaterial.normalTexture.index;
            const texture = this.gltf.textures[textureIndex];
            if (texture.source !== undefined) {
                const image = this.gltf.images[texture.source];
                try {
                    const imageData = await this.loadImageFromBufferView(image);
                    if (imageData.startsWith('data:')) {
                        textures.normal = TextureManager.Instance.addTextureFromBase64(imageData, { wrapping: 'repeat', mipMap: false });
                    } else {
                        textures.normal = TextureManager.Instance.addTextureFromPath(imageData, { wrapping: 'repeat' });
                    }
                } catch (error) {
                    console.warn('Failed to load normal texture:', error);
                }
            }
        }

        if (gltfMaterial.emissiveTexture && this.gltf.textures && this.gltf.images) {
            const textureIndex = gltfMaterial.emissiveTexture.index;
            const texture = this.gltf.textures[textureIndex];
            if (texture.source !== undefined) {
                const image = this.gltf.images[texture.source];
                try {
                    const imageData = await this.loadImageFromBufferView(image);
                    if (imageData.startsWith('data:')) {
                        textures.emissive = TextureManager.Instance.addTextureFromBase64(imageData, { wrapping: 'repeat', mipMap: false });
                    } else {
                        textures.emissive = TextureManager.Instance.addTextureFromPath(imageData, { wrapping: 'repeat' });
                    }
                } catch (error) {
                    console.warn('Failed to load emissive texture:', error);
                }
            }
        }

        return Material.Default({
            diffuse,
            emissive,
            specular: [0.04, 0.04, 0.04], // Default for PBR
            ambient: [0.1, 0.1, 0.1],
            shininess: pbr?.roughnessFactor ? (1.0 - pbr.roughnessFactor) * 128 : 64,
            opacity: pbr?.baseColorFactor ? pbr.baseColorFactor[3] : 1.0,
            textures
        });
    }

    /**
     * Parse meshes with animation and skinning data
     */
    private async parseAnimatedMeshes(): Promise<{name: string, model: AnimatedModel}[]> {
        const result: {name: string, model: AnimatedModel}[] = [];

        if (!this.gltf.meshes) return result;

        // Parse all skins first
        const skins: (Skin | null)[] = [];
        if (this.gltf.skins) {
            for (const gltfSkin of this.gltf.skins) {
                skins.push(this.parseSkin(gltfSkin));
            }
        }

        // Parse all animations
        const animations: Animation[] = [];
        if (this.gltf.animations) {
            for (const gltfAnim of this.gltf.animations) {
                animations.push(this.parseAnimation(gltfAnim));
            }
        }

        // Parse meshes
        for (let meshIndex = 0; meshIndex < this.gltf.meshes.length; meshIndex++) {
            const mesh = this.gltf.meshes[meshIndex];
            
            for (const primitive of mesh.primitives) {
                const geometry = await this.createGeometry(primitive);
                const material = await this.createMaterial(primitive.material);
                
                // Extract skinning data if present
                let skin: Skin | undefined = undefined;
                let jointIndices: Float32Array | undefined = undefined;
                let jointWeights: Float32Array | undefined = undefined;
                
                // Check if this mesh has skinning attributes
                if (primitive.attributes.JOINTS_0 !== undefined && primitive.attributes.WEIGHTS_0 !== undefined) {
                    // Load joint indices
                    const jointData = this.getAccessorData(primitive.attributes.JOINTS_0);
                    jointIndices = new Float32Array(jointData);
                    
                    // Load joint weights
                    const weightData = this.getAccessorData(primitive.attributes.WEIGHTS_0) as Float32Array;
                    jointWeights = weightData;
                    
                    // Find the skin associated with this mesh
                    // In GLTF, skins are typically referenced by nodes, not meshes directly
                    // For now, we'll use the first available skin if any
                    if (skins.length > 0 && skins[0]) {
                        skin = skins[0];
                    }
                }
                
                const animatedModel = new AnimatedModel(
                    geometry,
                    material,
                    skin,
                    jointIndices,
                    jointWeights,
                    animations
                );
                
                result.push({
                    name: mesh.name || 'AnimatedMesh',
                    model: animatedModel
                });
            }
        }

        return result;
    }

    /**
     * Parse a GLTF skin into our Skin format
     */
    private parseSkin(gltfSkin: GLTFSkin): Skin {
        const joints: Skin['joints'] = [];
        
        // Load inverse bind matrices if present
        let inverseBindMatrices: mat4[] = [];
        if (gltfSkin.inverseBindMatrices !== undefined) {
            const data = this.getAccessorData(gltfSkin.inverseBindMatrices) as Float32Array;
            
            // Each matrix is 16 floats (4x4 matrix)
            for (let i = 0; i < data.length; i += 16) {
                const matrix = mat4.create();
                for (let j = 0; j < 16; j++) {
                    matrix[j] = data[i + j];
                }
                inverseBindMatrices.push(matrix);
            }
        } else {
            // If no inverse bind matrices provided, use identity matrices
            for (let i = 0; i < gltfSkin.joints.length; i++) {
                inverseBindMatrices.push(mat4.create());
            }
        }
        
        // Create joint objects
        for (let i = 0; i < gltfSkin.joints.length; i++) {
            joints.push({
                nodeIndex: gltfSkin.joints[i],
                inverseBindMatrix: inverseBindMatrices[i]
            });
        }
        
        return {
            name: gltfSkin.name,
            joints,
            skeleton: gltfSkin.skeleton
        };
    }

    /**
     * Parse a GLTF animation into our Animation format
     */
    private parseAnimation(gltfAnim: GLTFAnimation): Animation {
        const samplers: AnimationSampler[] = [];
        
        // Parse all samplers
        for (const gltfSampler of gltfAnim.samplers) {
            // Load input times
            const inputData = this.getAccessorData(gltfSampler.input) as Float32Array;
            const input = Array.from(inputData);
            
            // Load output values
            const outputData = this.getAccessorData(gltfSampler.output) as Float32Array;
            const output = Array.from(outputData);
            
            samplers.push({
                input,
                output,
                interpolation: gltfSampler.interpolation || 'LINEAR'
            });
        }
        
        // Parse all channels
        const channels: AnimationChannel[] = [];
        for (const gltfChannel of gltfAnim.channels) {
            if (gltfChannel.target.node !== undefined) {
                channels.push({
                    samplerIndex: gltfChannel.sampler,
                    targetNodeIndex: gltfChannel.target.node,
                    targetPath: gltfChannel.target.path
                });
            }
        }
        
        return {
            name: gltfAnim.name || 'Animation',
            samplers,
            channels
        };
    }
}

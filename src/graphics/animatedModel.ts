import { Mesh } from './mesh';
import { Material } from './material';
import { Geometry } from '../core/geometry';
import { mat4 } from 'gl-matrix';

// Animation data structures based on GLTF specification
export interface AnimationSampler {
    input: number[];  // Time values (keyframes)
    output: number[]; // Animation values (positions, rotations, scales)
    interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

export interface AnimationChannel {
    samplerIndex: number;
    targetNodeIndex: number;
    targetPath: 'translation' | 'rotation' | 'scale' | 'weights';
}

export interface Animation {
    name: string;
    samplers: AnimationSampler[];
    channels: AnimationChannel[];
}

// Skinning data structures
export interface Joint {
    nodeIndex: number;
    inverseBindMatrix: mat4;
    parentIndex?: number; // Parent node index for hierarchy traversal
}

export interface Skin {
    name?: string;
    joints: Joint[];
    skeleton?: number; // Root joint index
    nodeParents?: Map<number, number>; // Map of node index to parent node index
    nodeTransforms?: Map<number, mat4>; // Initial transforms for each node from GLTF
    nodeNames?: Map<number, string>; // Map of node index to bone/node name (for cross-file retargeting)
}

// Options for loading animated models
interface FromPathOptions {
    filePath: string;
    material?: Material;
}

interface FromFileOptions {
    files: File[];
    material?: Material;
}

/**
 * AnimatedModel class handles models with skeletal animation and skinning data.
 * It stores bones (joints), inverse bind matrices, and animation data that can be
 * accessed by an animation player for rendering animated meshes.
 */
export class AnimatedModel {
    private readonly _geometry: Geometry;
    private readonly _mesh: Mesh;
    private _material: Material;
    
    // Skinning data
    private readonly _skin: Skin | null = null;
    private readonly _jointIndices: Float32Array | null = null;  // JOINTS_0 attribute
    private readonly _jointWeights: Float32Array | null = null;  // WEIGHTS_0 attribute
    
    // Animation data
    private readonly _animations: Animation[] = [];
    
    // Initialization tracking
    private _vaoInitialized: boolean = false;
    private _isAnimated: boolean = false;
    
    constructor(
        geometry: Geometry,
        material: Material,
        skin?: Skin,
        jointIndices?: Float32Array,
        jointWeights?: Float32Array,
        animations?: Animation[]
    ) {
        this._geometry = geometry;
        this._material = material;
        this._mesh = new Mesh();
        
        if (skin) {
            this._skin = skin;
        }
        
        if (jointIndices) {
            this._jointIndices = jointIndices;
        }
        
        if (jointWeights) {
            this._jointWeights = jointWeights;
        }
        
        if (animations) {
            this._animations = animations;
        }
        
        // Initialize the mesh with bone data if available
        this._initializeMesh();
    }
    
    /**
     * Load an animated model from a file path (only GLTF supported for now)
     */
    public static async fromPath(config: FromPathOptions): Promise<{name: string, model: AnimatedModel}[]> {
        // This will be implemented to use the enhanced GLTF loader
        throw new Error('AnimatedModel.fromPath not yet implemented. Use GLTF loader directly.');
    }
    
    /**
     * Load an animated model from uploaded files (only GLTF supported for now)
     */
    public static async fromFile(config: FromFileOptions): Promise<{name: string, model: AnimatedModel}[]> {
        // This will be implemented to use the enhanced GLTF loader
        throw new Error('AnimatedModel.fromFile not yet implemented. Use GLTF loader directly.');
    }
    
    /**
     * Parse serialized animated model data
     */
    public static parse(data: any): AnimatedModel {
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
        } else {
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
        
        // Parse skin data
        let skin: Skin | undefined = undefined;
        if (data.skin) {
            // Parse nodeParents map
            const nodeParents = new Map<number, number>();
            if (data.skin.nodeParents) {
                for (const [key, value] of data.skin.nodeParents) {
                    nodeParents.set(Number(key), value);
                }
            }
            
            // Parse nodeTransforms map
            const nodeTransforms = new Map<number, mat4>();
            if (data.skin.nodeTransforms) {
                for (const [key, value] of data.skin.nodeTransforms) {
                    const matrix = mat4.create();
                    for (let i = 0; i < 16; i++) {
                        matrix[i] = value[i];
                    }
                    nodeTransforms.set(Number(key), matrix);
                }
            }

            // Parse nodeNames map
            const nodeNames = new Map<number, string>();
            if (data.skin.nodeNames) {
                for (const [key, value] of data.skin.nodeNames) {
                    nodeNames.set(Number(key), value);
                }
            }

            skin = {
                name: data.skin.name,
                joints: data.skin.joints.map((j: any) => {
                    const matrix = mat4.create();
                    for (let i = 0; i < 16; i++) {
                        matrix[i] = j.inverseBindMatrix[i];
                    }
                    return {
                        nodeIndex: j.nodeIndex,
                        inverseBindMatrix: matrix,
                        parentIndex: j.parentIndex
                    };
                }),
                skeleton: data.skin.skeleton,
                nodeParents,
                nodeTransforms,
                nodeNames
            };
        }
        
        // Parse joint attributes
        let jointIndices: Float32Array | undefined = undefined;
        if (data.jointIndices) {
            jointIndices = new Float32Array(data.jointIndices);
        }
        
        let jointWeights: Float32Array | undefined = undefined;
        if (data.jointWeights) {
            jointWeights = new Float32Array(data.jointWeights);
        }
        
        // Parse animations
        let animations: Animation[] | undefined = undefined;
        if (data.animations) {
            animations = data.animations;
        }
        
        return new AnimatedModel(geometry, material, skin, jointIndices, jointWeights, animations);
    }

    /**
     * Serialize the animated model for saving
     */
    public serialize(): any {
        let geometry = {
            positions: this._geometry.positions,
            normals: this._geometry.normals,
            tangents: this._geometry.tangents,
            bitangents: this._geometry.bitangents,
            texCoords: this._geometry.uvs,
            indices: this._geometry.indices
        };
        
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
        } else {
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
                    specular: this._material.textures.get('specularMap'),
                    normal: this._material.textures.get('normalMap'),
                    emissive: this._material.textures.get('emissiveMap'),
                    mask: this._material.textures.get('maskMap'),
                    reflectivity: this._material.textures.get('reflectivityMap')
                },
                config: cfg
            };
        }
        
        // Serialize skin data
        let skin: any = null;
        if (this._skin) {
            // Serialize nodeParents map
            const nodeParents: [number, number][] = [];
            if (this._skin.nodeParents) {
                for (const [key, value] of this._skin.nodeParents.entries()) {
                    nodeParents.push([key, value]);
                }
            }
            
            // Serialize nodeTransforms map
            const nodeTransforms: [number, number[]][] = [];
            if (this._skin.nodeTransforms) {
                for (const [key, value] of this._skin.nodeTransforms.entries()) {
                    nodeTransforms.push([key, Array.from(value)]);
                }
            }

            // Serialize nodeNames map (bone names for cross-file retargeting)
            const nodeNames: [number, string][] = [];
            if (this._skin.nodeNames) {
                for (const [key, value] of this._skin.nodeNames.entries()) {
                    nodeNames.push([key, value]);
                }
            }

            skin = {
                name: this._skin.name,
                joints: this._skin.joints.map(j => ({
                    nodeIndex: j.nodeIndex,
                    inverseBindMatrix: Array.from(j.inverseBindMatrix),
                    parentIndex: j.parentIndex
                })),
                skeleton: this._skin.skeleton,
                nodeParents,
                nodeTransforms,
                nodeNames
            };
        }
        
        // Serialize joint attributes
        let jointIndices = this._jointIndices ? Array.from(this._jointIndices) : null;
        let jointWeights = this._jointWeights ? Array.from(this._jointWeights) : null;
        
        // Serialize animations
        let animations = this._animations.length > 0 ? this._animations : null;
        
        return {
            geometry,
            material,
            skin,
            jointIndices,
            jointWeights,
            animations
        };
    }
    
    /**
     * Initialize the mesh with bone data if available
     */
    private _initializeMesh(): void {
        const vertexCount = this._geometry.positions.length;
        
        if (this.hasSkin && this._jointIndices && this._jointWeights) {
            // For skinned meshes, we need to create separate buffers for vertex data and bone data
            // since bone indices must be integers and can't be in the same buffer as floats
            const vertices = this._geometry.getData(['position', 'normal', 'uv', 'tangent', 'bitangent']);
            
            // Create bone indices array (4 per vertex)
            const boneIndices: number[] = [];
            const boneWeights: number[] = [];
            
            // Debug: log the data structure we're working with
            console.log(`Vertex count: ${vertexCount}`);
            console.log(`Joint indices length: ${this._jointIndices.length}`);
            console.log(`Joint weights length: ${this._jointWeights.length}`);
            console.log(`Expected bone data length: ${vertexCount * 4}`);
            
            for (let i = 0; i < vertexCount; i++) {
                const baseIndex = i * 4;
                
                // Bone indices (4 ints per vertex)
                if (this._jointIndices && baseIndex + 3 < this._jointIndices.length) {
                    boneIndices.push(Math.floor(this._jointIndices[baseIndex]));
                    boneIndices.push(Math.floor(this._jointIndices[baseIndex + 1]));
                    boneIndices.push(Math.floor(this._jointIndices[baseIndex + 2]));
                    boneIndices.push(Math.floor(this._jointIndices[baseIndex + 3]));
                } else {
                    // Default: use first bone with full weight (assume identity matrix at index 0)
                    boneIndices.push(0, 0, 0, 0);
                }
                
                // Bone weights (4 floats per vertex)
                let weights = [0.0, 0.0, 0.0, 0.0];
                if (this._jointWeights && baseIndex + 3 < this._jointWeights.length) {
                    weights[0] = this._jointWeights[baseIndex];
                    weights[1] = this._jointWeights[baseIndex + 1];
                    weights[2] = this._jointWeights[baseIndex + 2];
                    weights[3] = this._jointWeights[baseIndex + 3];
                    
                    // Normalize weights to ensure they sum to 1.0
                    const weightSum = weights[0] + weights[1] + weights[2] + weights[3];
                    if (weightSum > 0.0) {
                        weights[0] /= weightSum;
                        weights[1] /= weightSum;
                        weights[2] /= weightSum;
                        weights[3] /= weightSum;
                    } else {
                        // If all weights are 0, set full weight on first bone
                        weights[0] = 1.0;
                    }
                } else {
                    // Default: full weight on first bone (assume identity matrix at index 0)
                    weights[0] = 1.0;
                }
                
                boneWeights.push(weights[0], weights[1], weights[2], weights[3]);
            }
            
            console.log(`Created ${boneIndices.length / 4} vertices worth of bone data`);
            this._mesh.createAnimated(vertices, vertexCount, boneIndices, boneWeights, this._geometry.indices);
            this._isAnimated = true;
        } else {
            // For regular meshes, create normal mesh
            const vertices = this._geometry.getData(['position', 'normal', 'uv', 'tangent', 'bitangent']);
            this._mesh.create(vertices, vertexCount, this._geometry.indices);
            this._isAnimated = false;
        }
    }

    /**
     * Initialize the animated model's mesh with the appropriate shader
     */
    public initializeForSkinning(shaderType: 'basicSkinned' | 'blinn_phongSkinned' = 'blinn_phongSkinned'): void {
        if (!this.hasSkin) {
            throw new Error('Cannot initialize for skinning: model has no skin data');
        }
        
        // This method will be called by the renderer when the shader manager is available
        // For now, we just mark that it needs to be initialized
        console.log(`AnimatedModel needs to be initialized with shader: ${shaderType}`);
    }

    /**
     * Initialize VAO with shader attributes (called by renderer)
     */
    public initializeVAO(shaderAttributes: any[]): void {
        if (this._vaoInitialized) return;
        
        if (this.hasSkin && this._mesh.isAnimated) {
            this._mesh.initializeAnimatedVAO(shaderAttributes);
        } else {
            this._mesh.initializeVAO(shaderAttributes);
        }
        
        this._vaoInitialized = true;
    }

    // Getters
    public get geometry(): Geometry { return this._geometry; }
    public get mesh(): Mesh { return this._mesh; }
    public get material(): Material { return this._material; }
    public set material(material: Material) { this._material = material; }
    
    public get skin(): Skin | null { return this._skin; }
    public get jointIndices(): Float32Array | null { return this._jointIndices; }
    public get jointWeights(): Float32Array | null { return this._jointWeights; }
    public get animations(): Animation[] { return this._animations; }

    /**
     * Add an animation clip at runtime (e.g. an imported/retargeted clip). De-dups the name so it can
     * be selected/played by name. The clip is immediately playable — Animator.playAnimationByName
     * re-reads this array and rebuilds its bone map per play.
     */
    public addAnimation(clip: Animation): Animation {
        const taken = new Set(this._animations.map(a => a.name));
        let name = clip.name || 'clip';
        if (taken.has(name)) {
            let n = 2;
            while (taken.has(`${name} (${n})`)) n++;
            name = `${name} (${n})`;
        }
        const stored: Animation = { ...clip, name };
        this._animations.push(stored);
        return stored;
    }

    /** Remove an animation clip by name. Returns true if one was removed. */
    public removeAnimation(name: string): boolean {
        const i = this._animations.findIndex(a => a.name === name);
        if (i < 0) return false;
        this._animations.splice(i, 1);
        return true;
    }

    /** Rename a clip (de-duping the new name). Returns the final applied name, or null if not found. */
    public renameAnimation(oldName: string, newName: string): string | null {
        const clip = this._animations.find(a => a.name === oldName);
        if (!clip) return null;
        let name = (newName || '').trim() || oldName;
        if (name !== oldName) {
            const taken = new Set(this._animations.filter(a => a !== clip).map(a => a.name));
            if (taken.has(name)) {
                let n = 2;
                while (taken.has(`${name} (${n})`)) n++;
                name = `${name} (${n})`;
            }
        }
        clip.name = name;
        return name;
    }

    public get hasSkin(): boolean { return this._skin !== null; }
    public get hasAnimations(): boolean { return this._animations.length > 0; }
    
    /**
     * Get a specific animation by name
     */
    public getAnimation(name: string): Animation | undefined {
        return this._animations.find(anim => anim.name === name);
    }
    
    /**
     * Get a specific animation by index
     */
    public getAnimationByIndex(index: number): Animation | undefined {
        return this._animations[index];
    }
}

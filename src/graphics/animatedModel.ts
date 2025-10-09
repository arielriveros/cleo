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
}

export interface Skin {
    name?: string;
    joints: Joint[];
    skeleton?: number; // Root joint index
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
        
        let texData = data.material.textures;
        let material = Material.Default({
            diffuse: data.material.diffuse,
            specular: data.material.specular,
            ambient: data.material.ambient,
            emissive: data.material.emissive,
            shininess: data.material.shininess,
            opacity: data.material.opacity,
            textures: {
                base: texData.base,
                specular: texData.specular,
                normal: texData.normal,
                emissive: texData.emissive,
                mask: texData.mask,
                reflectivity: texData.reflectivity
            }},
            {
                side: data.material.config?.side,
                wireframe: data.material.config?.wireframe,
                transparent: data.material.config?.transparent,
                castShadow: data.material.config?.castShadow
            }
        );
        
        // Parse skin data
        let skin: Skin | undefined = undefined;
        if (data.skin) {
            skin = {
                name: data.skin.name,
                joints: data.skin.joints.map((j: any) => {
                    const matrix = mat4.create();
                    for (let i = 0; i < 16; i++) {
                        matrix[i] = j.inverseBindMatrix[i];
                    }
                    return {
                        nodeIndex: j.nodeIndex,
                        inverseBindMatrix: matrix
                    };
                }),
                skeleton: data.skin.skeleton
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
        
        let material = {
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
            config: {
                side: this._material.config.side,
                wireframe: this._material.config.wireframe,
                transparent: this._material.config.transparent,
                castShadow: this._material.config.castShadow,
            }
        };
        
        // Serialize skin data
        let skin: any = null;
        if (this._skin) {
            skin = {
                name: this._skin.name,
                joints: this._skin.joints.map(j => ({
                    nodeIndex: j.nodeIndex,
                    inverseBindMatrix: Array.from(j.inverseBindMatrix)
                })),
                skeleton: this._skin.skeleton
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
    
    // Getters
    public get geometry(): Geometry { return this._geometry; }
    public get mesh(): Mesh { return this._mesh; }
    public get material(): Material { return this._material; }
    public set material(material: Material) { this._material = material; }
    
    public get skin(): Skin | null { return this._skin; }
    public get jointIndices(): Float32Array | null { return this._jointIndices; }
    public get jointWeights(): Float32Array | null { return this._jointWeights; }
    public get animations(): Animation[] { return this._animations; }
    
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

import { Mesh } from './mesh';
import { Material } from './material';
import type { Submesh } from './model';
import { Geometry } from '../core/geometry';
import { Logger } from '../core/logger';
import { mat4 } from 'gl-matrix';
import type { IkRig } from './ik';

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
    /**
     * When true, the Animator extracts this clip's ROOT bone translation/rotation and applies it to the
     * character (the nearest bodied ancestor, else the model node) instead of posing it in place — so a clip
     * authored with root motion (e.g. a turn-in-place or a stepping locomotion) actually moves the character.
     * Plain data, so it rides the model-asset save through {@link AnimatedModel.serialize}/{@link parse}.
     */
    rootMotion?: boolean;
    /**
     * Set when this clip came from a SHARED animation asset rather than being embedded in the model.
     *
     * Such a clip is deliberately NOT serialized ({@link AnimatedModel.serialize} filters it out): it is
     * restored by resolving the id again, which is the whole point of a shared asset — one stored copy, not
     * one per character and one more per placement. A clip without this field is embedded, as before, and
     * saves exactly as it always did.
     */
    assetId?: string;
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
    /**
     * Inverse-kinematics setup for this skeleton — which joints are the legs, and how foot placement is tuned.
     *
     * It lives here, on the skin, because it is joint indices INTO this skeleton: it cannot be meaningful for
     * any other rig, and it is the same kind of thing as `nodeNames` — skeleton metadata rather than a
     * property of any one placed character. That also puts it on the side of the line the editor already
     * draws ("clips and skeleton belong to the model asset"), so it reaches every instance for free.
     *
     * Plain JSON, so it round-trips through serialize/parse below with no special handling.
     */
    ikRig?: IkRig;
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
    /** One per submesh; `material` aliases `[0]`. See {@link Model} for why the alias exists. */
    private _materials: Material[];
    /** Index ranges parallel to `_materials`, empty when the whole index buffer is one draw. */
    private _submeshes: Submesh[];

    // Skinning data
    private readonly _skin: Skin | null = null;
    private readonly _jointIndices: Float32Array | null = null;  // JOINTS_0 attribute
    private readonly _jointWeights: Float32Array | null = null;  // WEIGHTS_0 attribute
    
    // Animation data
    private readonly _animations: Animation[] = [];
    
    // Initialization tracking
    /** Which attribute layout the VAO currently holds; see initializeVAO. */
    private _vaoLayoutKey: string | null = null;
    private _isAnimated: boolean = false;
    
    constructor(
        geometry: Geometry,
        material: Material | Material[],
        skin?: Skin,
        jointIndices?: Float32Array,
        jointWeights?: Float32Array,
        animations?: Animation[],
        submeshes: Submesh[] = []
    ) {
        this._geometry = geometry;
        this._materials = Array.isArray(material) ? (material.length ? material : [Material.Default({})]) : [material];
        // A submesh list that does not line up with the materials is dropped, which turns the model back
        // into one whole-buffer draw with materials[0]. Say so: silently, it presents as "the second
        // material vanished on reload", because serialize() then writes only the singular `material`.
        this._submeshes = submeshes.length === this._materials.length ? submeshes : [];
        if (submeshes.length && submeshes.length !== this._materials.length)
            Logger.warn(`Model: ${submeshes.length} submeshes vs ${this._materials.length} materials — submeshes dropped`, 'Model');
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
        
        // One material per submesh, so this is a function called over `materials` below. The single
        // `material` key is what almost every saved model carries and stays the fallback.
        const parseMaterial = (m: any): Material => {
        m = m || {};
        const config = {
            side: m.config?.side,
            wireframe: m.config?.wireframe,
            transparent: m.config?.transparent,
            castShadow: m.config?.castShadow,
            probeable: m.config?.probeable
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
                // metallicRoughnessTexture is the pre-split key; Material.PBR fans it out to the
                // metallicMap/roughnessMap source slots so older saves reload unchanged.
                textures: {
                    baseColorTexture: m.textures?.baseColorTexture,
                    metallicMap: m.textures?.metallicMap,
                    roughnessMap: m.textures?.roughnessMap,
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
        return material;
        };

        const materials: Material[] = Array.isArray(data.materials) && data.materials.length
            ? data.materials.map(parseMaterial)
            : [parseMaterial(data.material)];
        const submeshes: Submesh[] = Array.isArray(data.submeshes) ? data.submeshes : [];

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
                nodeNames,
                // Plain JSON — joint indices and numbers — so it needs no reconstruction, only carrying.
                ikRig: data.skin.ikRig ?? undefined
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
            // Copied, never adopted by reference — see the note in serialize().
            animations = (data.animations as Animation[]).map(a => ({ ...a }));
        }
        
        return new AnimatedModel(geometry, materials, skin, jointIndices, jointWeights, animations, submeshes);
    }

    /**
     * Serialize the animated model for saving
     */
    public serialize(): any {
        // Array.from for the same reason as Model.serialize: JSON.stringify would turn the typed
        // arrays Geometry stores into objects and silently corrupt the save.
        const geometry = {
            positions: Array.from(this._geometry.positions),
            normals: Array.from(this._geometry.normals),
            tangents: Array.from(this._geometry.tangents),
            bitangents: Array.from(this._geometry.bitangents),
            texCoords: Array.from(this._geometry.uvs),
            indices: Array.from(this._geometry.indices)
        };
        
        // One material per submesh, so this is a function rather than a straight-line block. The skinned
        // type variants normalize back to their base type: the shader picks the skinned program from the
        // model being animated, not from the saved material.
        const serializeMaterial = (mat: Material): any => {
        const cfg = {
            side: mat.config.side,
            wireframe: mat.config.wireframe,
            transparent: mat.config.transparent,
            castShadow: mat.config.castShadow,
            probeable: mat.config.probeable,
        };
        const normalizeType = (t: string) => t === 'basicSkinned' ? 'basic' : (t === 'blinn_phongSkinned' ? 'blinn_phong' : t);
        const type = normalizeType(mat.type as any);

        let material: any;
        if (type === 'basic') {
            material = {
                type,
                color: mat.properties.get('color'),
                opacity: mat.properties.get('opacity'),
                textures: {
                    texture: mat.textures.get('texture')
                },
                config: cfg
            };
        } else if (type === 'pbr') {
            material = {
                type,
                baseColor: mat.properties.get('baseColor'),
                metallic: mat.properties.get('metallic'),
                roughness: mat.properties.get('roughness'),
                opacity: mat.properties.get('opacity'),
                emissiveFactor: mat.properties.get('emissiveFactor'),
                // Source maps only — the engine's derived (channel-packed) slots are never serialized.
                textures: {
                    baseColorTexture: mat.textures.get('baseColorTexture'),
                    metallicMap: mat.textures.get('metallicMap'),
                    roughnessMap: mat.textures.get('roughnessMap'),
                    normalMap: mat.textures.get('normalMap'),
                    occlusionMap: mat.textures.get('occlusionMap'),
                    emissiveMap: mat.textures.get('emissiveMap')
                },
                config: cfg
            };
        } else {
            material = {
                type: 'blinn_phong',
                diffuse: mat.properties.get('diffuse'),
                specular: mat.properties.get('specular'),
                ambient: mat.properties.get('ambient'),
                emissive: mat.properties.get('emissive'),
                shininess: mat.properties.get('shininess'),
                opacity: mat.properties.get('opacity'),
                textures: {
                    base: mat.textures.get('baseTexture'),
                    specular: mat.textures.get('specularMap'),
                    normal: mat.textures.get('normalMap'),
                    emissive: mat.textures.get('emissiveMap'),
                    mask: mat.textures.get('maskMap'),
                    reflectivity: mat.textures.get('reflectivityMap')
                },
                config: cfg
            };
        }
        return material;
        };

        const materials = this._materials.map(serializeMaterial);

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
                nodeNames,
                ikRig: this._skin.ikRig ?? null
            };
        }
        
        // Serialize joint attributes
        let jointIndices = this._jointIndices ? Array.from(this._jointIndices) : null;
        let jointWeights = this._jointWeights ? Array.from(this._jointWeights) : null;
        
        // Serialize animations.
        //
        // A COPY, not the live array. Every other field here is already copied (Array.from for the
        // geometry and joint arrays, a rebuilt object for the skin); this one was handing out live state,
        // and `parse` adopted it by reference — so a node parsed from another node's serialized payload
        // shared its `_animations`. The Animation Editor does exactly that, and adding one clip then
        // pushed it into the shared array twice: the second add collided with the first and addAnimation's
        // de-duper renamed it "<clip> (2)". The same aliasing silently made rename/delete no-ops on the
        // source node, since the clone's mutation had already changed the shared objects.
        //
        // Clips resolved from a shared animation asset are filtered out: they are restored by re-resolving
        // the model's `animationIds`, so writing them here would put a copy in every placement and in the
        // published game — exactly the duplication the shared asset exists to remove.
        const own = this._animations.filter(a => !a.assetId);
        let animations = own.length > 0 ? own.map(a => ({ ...a })) : null;
        
        // `material` is written for every model so the single-material readers (and older builds) keep
        // working; `materials`/`submeshes` appear only when there is more than one.
        const out: any = {
            geometry,
            material: materials[0],
            skin,
            jointIndices,
            jointWeights,
            animations
        };
        if (this._submeshes.length > 1) {
            out.materials = materials;
            out.submeshes = this._submeshes.map(s => ({ start: s.start, count: s.count }));
        }
        return out;
    }
    
    /**
     * Initialize the mesh with bone data if available
     */
    private _initializeMesh(): void {
        // `Geometry.positions` is a FLAT array, so its length is 3x the vertex count. Reading it as the
        // count uploaded both bone buffers at triple size (the extra two thirds filled with the
        // "no joint" defaults below) and left Mesh._vertexCount wrong for the drawArrays fallback and
        // for frameStats. The non-skinned path in ModelNode.initializeModel always used vertexCount.
        const vertexCount = this._geometry.vertexCount;

        if (this.hasSkin && this._jointIndices && this._jointWeights) {
            // For skinned meshes, we need to create separate buffers for vertex data and bone data
            // since bone indices must be integers and can't be in the same buffer as floats
            const vertices = this._geometry.getData(['position', 'normal', 'uv', 'tangent', 'bitangent']);

            // Create bone indices array (4 per vertex)
            const boneIndices: number[] = [];
            const boneWeights: number[] = [];

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
        Logger.info(`AnimatedModel needs to be initialized with shader: ${shaderType}`, 'Animation');
    }

    /**
     * Initialize the VAO for the attribute layout a particular program declares (called by renderer).
     *
     * Keyed by the LAYOUT rather than guarded by a once-only flag. The flag was wrong for any model
     * whose passes disagree about attribute locations: the first caller won and every later call was
     * silently dropped, so one of the two passes always read unbound attributes.
     *
     * That is not hypothetical — it is the unlit Basic family. Having no normal/tangent/bitangent, its
     * skinned vertex shaders put bone data at locations 2 and 3, while `shadowMapSkinned` mirrors the
     * LIT skinned layout and reads 5 and 6. Cascades run before the geometry pass, so the shadow
     * program initialized the VAO and `basicGeometrySkinned` was then drawn against it (or the reverse,
     * depending on which pass touched the model first) — GL_INVALID_OPERATION either way.
     *
     * Keying on the layout rather than removing the guard keeps the common path free: for the PBR and
     * Blinn-Phong families the shadow and geometry programs declare the SAME locations, so the key
     * matches and nothing is re-applied. Only a genuine layout change pays for a re-init.
     */
    public initializeVAO(shaderAttributes: any[]): void {
        const key = AnimatedModel._layoutKey(shaderAttributes);
        if (this._vaoLayoutKey === key) return;

        if (this.hasSkin && this._mesh.isAnimated) {
            this._mesh.initializeAnimatedVAO(shaderAttributes);
        } else {
            this._mesh.initializeVAO(shaderAttributes);
        }

        this._vaoLayoutKey = key;
    }

    /**
     * A stable identity for "which attributes at which locations".
     *
     * Sorted so two programs that reflect the same set in a different order — the enumeration order of
     * `getActiveAttrib` is driver-dependent — compare equal and do not thrash the VAO.
     */
    private static _layoutKey(shaderAttributes: any[]): string {
        return shaderAttributes
            .map(a => `${a.name}@${a.location}`)
            .sort()
            .join(',');
    }

    // Getters
    public get geometry(): Geometry { return this._geometry; }
    public get mesh(): Mesh { return this._mesh; }
    /** The first material. Assigning replaces it, leaving any further submesh materials alone. */
    public get material(): Material { return this._materials[0]; }
    public set material(material: Material) { this._materials[0] = material; }
    public get materials(): Material[] { return this._materials; }
    public set materials(materials: Material[]) { if (materials.length) this._materials = materials; }
    /** Index ranges parallel to {@link materials}; empty when the whole index buffer is one draw. */
    public get submeshes(): Submesh[] { return this._submeshes; }
    /** True when this model needs one draw call per material rather than a single whole-buffer draw. */
    public get hasSubmeshes(): boolean { return this._submeshes.length > 1; }
    
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

    /** Toggle root-motion extraction on a clip by name. Returns true if the clip exists. */
    public setAnimationRootMotion(name: string, on: boolean): boolean {
        const clip = this._animations.find(a => a.name === name);
        if (!clip) return false;
        clip.rootMotion = on;
        return true;
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

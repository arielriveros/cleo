import { Geometry } from "../../core/geometry";
import { Material } from "../material";
import { TextureManager } from "../systems/textureManager";
import { AnimatedModel, Skin, Animation, AnimationSampler, AnimationChannel } from "../animatedModel";
import { mat4, quat, vec3 } from "gl-matrix";

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
    occlusionTexture?: { index: number };
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

/** World-space TRS of the glTF scene node an imported mesh entry came from. */
export type ImportTransform = {
    translation: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
};

export class GLTFLoader {
    // Definite-assignment: every load entry point (loadFromJson/loadFromUrl/loadFromFiles/...) assigns this
    // before anything reads it; the constructor has no data to assign from.
    private gltf!: GLTF;
    private buffers: ArrayBuffer[] = [];
    private basePath: string = '';
    private files: File[] = [];
    // Shared glTF resources are referenced once PER PRIMITIVE by the parse loops; without these caches a
    // file with N primitives realizes N copies of each material and texture (fresh TextureManager ids,
    // re-decoded images) instead of sharing the handful the file actually defines.
    private materialCache = new Map<number, Material>();
    private textureIdCache = new Map<string, string | undefined>();

    async loadFromPath(filePath: string): Promise<{name: string, geometry: Geometry, material: Material, transform?: ImportTransform}[]> {
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

    async loadFromFiles(files: File[]): Promise<{name: string, geometry: Geometry, material: Material, transform?: ImportTransform}[]> {
        const gltfFile = files.find(f => f.name.toLowerCase().endsWith('.gltf'));
        if (!gltfFile) {
            throw new Error('No GLTF file found in the uploaded files');
        }

        // Keep the uploaded files so external texture URIs can be resolved against them
        this.files = files;

        // Load GLTF JSON
        const gltfText = await gltfFile.text();
        this.gltf = JSON.parse(gltfText);

        // Load buffers from uploaded files
        await this.loadBuffersFromFiles();

        // Parse meshes and materials
        return this.parseMeshes();
    }

    /**
     * Load animated models with skinning and animation data from a file path
     */
    async loadAnimatedFromPath(filePath: string): Promise<{name: string, model: AnimatedModel, transform?: ImportTransform}[]> {
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
    async loadAnimatedFromFiles(files: File[]): Promise<{name: string, model: AnimatedModel, transform?: ImportTransform}[]> {
        const gltfFile = files.find(f => f.name.toLowerCase().endsWith('.gltf'));
        if (!gltfFile) {
            throw new Error('No GLTF file found in the uploaded files');
        }

        // Keep the uploaded files so external texture URIs can be resolved against them
        this.files = files;

        // Load GLTF JSON
        const gltfText = await gltfFile.text();
        this.gltf = JSON.parse(gltfText);

        // Load buffers from uploaded files
        await this.loadBuffersFromFiles();

        // Parse meshes with animation data
        return this.parseAnimatedMeshes();
    }

    /**
     * Parse ONLY animation clips + the source skeleton (bone names/parents) from uploaded files,
     * for animation IMPORT/retargeting. Unlike loadAnimatedFromFiles this does NOT require a mesh or
     * skin — animation-only files (e.g. a Mixamo export with "skin" unchecked) are supported: the
     * skeleton is reconstructed from the glTF node hierarchy + the nodes the animation targets.
     */
    async loadAnimationsFromFiles(files: File[]): Promise<{ animations: Animation[]; skin: Skin }> {
        const gltfFile = files.find(f => f.name.toLowerCase().endsWith('.gltf'));
        if (!gltfFile) throw new Error('No GLTF file found in the uploaded files');
        this.files = files;
        this.gltf = JSON.parse(await gltfFile.text());
        await this.loadBuffersFromFiles();
        return this.parseAnimationsAndSkeleton();
    }

    /** Build clips + a source Skin (with nodeNames/nodeParents) from the loaded glTF, mesh or not. */
    private parseAnimationsAndSkeleton(): { animations: Animation[]; skin: Skin } {
        const animations: Animation[] = [];
        if (this.gltf.animations) {
            for (const a of this.gltf.animations) animations.push(this.parseAnimation(a));
        }

        // Node name/parent/transform maps over ALL nodes (mirrors the parseSkin node loop).
        const nodeParents = new Map<number, number>();
        const nodeNames = new Map<number, string>();
        const nodeTransforms = new Map<number, mat4>();
        if (this.gltf.nodes) {
            for (let i = 0; i < this.gltf.nodes.length; i++) {
                const node = this.gltf.nodes[i];
                if (typeof node.name === 'string' && node.name.length > 0) nodeNames.set(i, node.name);
                if (node.children) for (const ci of node.children) nodeParents.set(ci, i);
                const t = mat4.create();
                if (node.matrix) { for (let k = 0; k < 16; k++) t[k] = node.matrix[k]; }
                else {
                    mat4.fromRotationTranslationScale(t,
                        (node.rotation ?? [0, 0, 0, 1]) as any,
                        (node.translation ?? [0, 0, 0]) as any,
                        (node.scale ?? [1, 1, 1]) as any);
                }
                nodeTransforms.set(i, t);
            }
        }

        // Prefer a real skin (has inverse-bind matrices); else synthesize joints from animated nodes.
        if (this.gltf.skins && this.gltf.skins.length > 0) {
            return { animations, skin: this.parseSkin(this.gltf.skins[0]) };
        }
        const animatedNodes = new Set<number>();
        for (const a of animations) for (const ch of a.channels) animatedNodes.add(ch.targetNodeIndex);
        const joints = [...animatedNodes].sort((x, y) => x - y).map(ni => ({
            nodeIndex: ni, inverseBindMatrix: mat4.create(), parentIndex: nodeParents.get(ni),
        }));
        return { animations, skin: { joints, nodeParents, nodeTransforms, nodeNames } };
    }

    /**
     * Decode an embedded `data:` buffer URI. `fetch` handles data URIs and decodes base64 natively — the
     * previous atob + per-character `charCodeAt` copy ran ~125 million iterations on a 125 MB embedded
     * model and was one of the main reasons importing froze the editor.
     */
    private static async decodeDataUri(uri: string): Promise<ArrayBuffer> {
        return (await fetch(uri)).arrayBuffer();
    }

    private async loadBuffers(): Promise<void> {
        if (!this.gltf.buffers) return;

        for (const buffer of this.gltf.buffers) {
            if (buffer.uri) {
                if (buffer.uri.startsWith('data:')) {
                    this.buffers.push(await GLTFLoader.decodeDataUri(buffer.uri));
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

    private async loadBuffersFromFiles(): Promise<void> {
        if (!this.gltf.buffers) return;

        for (const buffer of this.gltf.buffers) {
            if (buffer.uri && !buffer.uri.startsWith('data:')) {
                // Find the buffer file among the provided files (folder import or multi-select)
                const bufferFile = this.findFile(buffer.uri);
                if (bufferFile) {
                    const arrayBuffer = await bufferFile.arrayBuffer();
                    this.buffers.push(arrayBuffer);
                } else {
                    console.warn(`Buffer file ${buffer.uri} not found in uploaded files`);
                    this.buffers.push(new ArrayBuffer(0));
                }
            } else if (buffer.uri && buffer.uri.startsWith('data:')) {
                this.buffers.push(await GLTFLoader.decodeDataUri(buffer.uri));
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

    /**
     * Match a GLTF-relative URI (e.g. "textures/foo.png") against the provided files.
     * Robust to folder imports (webkitRelativePath) and plain multi-select (basename only).
     */
    private findFile(uri: string): File | undefined {
        const target = decodeURIComponent(uri).replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
        const base = target.split('/').pop()!;
        // Prefer a relative-path suffix match (disambiguates same-named files in different folders)
        const file = this.files.find(f => {
            const rel = ((f as any).webkitRelativePath || f.name).replace(/\\/g, '/').toLowerCase();
            return rel === target || rel.endsWith('/' + target);
        });
        // Fall back to basename (a plain multi-select <input> preserves only basenames)
        return file ?? this.files.find(f => f.name.toLowerCase() === base);
    }

    /**
     * The raw compressed bytes of an image stored in a bufferView (embedded / .glb).
     *
     * Copied out rather than returned as a view: the Texture retains these bytes for serialization, and a
     * view would pin the model's whole (often enormous) glTF buffer alive for as long as the texture exists.
     */
    private bufferViewImageBytes(image: GLTFImage): Uint8Array {
        const bufferView = this.gltf.bufferViews![image.bufferView!];
        const buffer = this.buffers[bufferView.buffer];
        const byteOffset = bufferView.byteOffset || 0;
        return new Uint8Array(buffer.slice(byteOffset, byteOffset + bufferView.byteLength));
    }

    /**
     * Resolve a GLTF texture reference into a TextureManager texture id.
     * Handles embedded bufferView images, data URIs, uploaded external files
     * (file-import flow), and external paths (path-load flow).
     */
    private loadTexture(textureIndex: number): string | undefined {
        if (!this.gltf.textures || !this.gltf.images) return undefined;

        const texture = this.gltf.textures[textureIndex];
        if (!texture || texture.source === undefined) return undefined;

        const image = this.gltf.images[texture.source];
        // Many texture/material entries typically alias few images — and several image entries can even
        // share one URI (Blender exports do this) — so key the cache on the image's actual source to
        // decode/upload each underlying image exactly once.
        const cacheKey = image.uri !== undefined ? `uri:${image.uri}` : `bv:${image.bufferView}`;
        if (this.textureIdCache.has(cacheKey)) return this.textureIdCache.get(cacheKey);
        const id = this.resolveTexture(image);
        this.textureIdCache.set(cacheKey, id);
        return id;
    }

    private resolveTexture(image: GLTFImage): string | undefined {
        const cfg = { wrapping: 'repeat' as const };

        try {
            // 1. Embedded image (bufferView): hand the compressed bytes straight to the TextureManager. It
            //    decodes them from a Blob — no base64 in either direction (this used to hand-roll a data
            //    URL one character at a time, then make the browser decode it right back).
            if (image.bufferView !== undefined) {
                const bytes = this.bufferViewImageBytes(image);
                const mime = image.mimeType || 'image/jpeg';
                return TextureManager.Instance.addTextureFromBytes(bytes, mime, { ...cfg, mipMap: false });
            }

            // 2. Inline data URI
            if (image.uri && image.uri.startsWith('data:')) {
                return TextureManager.Instance.addTextureFromBase64(image.uri, { ...cfg, mipMap: false });
            }

            // 3. External URI
            if (image.uri) {
                // 3a. File-import flow: resolve against the provided files (folder or multi-select).
                // If the referenced file wasn't uploaded, return undefined (missing) rather than falling
                // through to a doomed relative fetch — the latter rejects with an image error Event.
                if (this.files.length) {
                    const file = this.findFile(image.uri);
                    return file ? TextureManager.Instance.addTextureFromFile(file, cfg) : undefined;
                }
                // 3b. Path-load flow: resolve relative to the GLTF's base path
                return TextureManager.Instance.addTextureFromPath(this.basePath + image.uri, cfg);
            }
        } catch (error) {
            console.warn('Failed to load texture:', error);
        }

        return undefined;
    }

    /**
     * One entry per scene-node → mesh reference, carrying the node's name and world TRS so importers
     * can place multi-part files (e.g. several variants laid out side by side) as authored, instead of
     * flattening everything to the origin. Falls back to one identity-transform instance per mesh when
     * no node references any mesh.
     */
    private getMeshInstances(): { meshIndex: number; name?: string; transform?: ImportTransform; skinIndex?: number }[] {
        const instances: { meshIndex: number; name?: string; transform?: ImportTransform; skinIndex?: number }[] = [];
        const nodes = this.gltf.nodes;
        if (nodes && nodes.length) {
            let roots: number[] | undefined = this.gltf.scenes?.[this.gltf.scene ?? 0]?.nodes;
            if (!roots || !roots.length) {
                // No scene list — treat every parentless node as a root.
                const hasParent = new Set<number>();
                for (const n of nodes) for (const c of n?.children ?? []) hasParent.add(c);
                roots = nodes.map((_: any, i: number) => i).filter((i: number) => !hasParent.has(i));
            }
            const visit = (nodeIndex: number, parentWorld: mat4) => {
                const node = nodes[nodeIndex];
                if (!node) return;
                const local = mat4.create();
                if (node.matrix) {
                    for (let k = 0; k < 16; k++) local[k] = node.matrix[k];
                } else {
                    mat4.fromRotationTranslationScale(local,
                        (node.rotation ?? [0, 0, 0, 1]) as any,
                        (node.translation ?? [0, 0, 0]) as any,
                        (node.scale ?? [1, 1, 1]) as any);
                }
                const world = mat4.multiply(mat4.create(), parentWorld, local);
                if (node.mesh !== undefined) {
                    const t = vec3.create(), r = quat.create(), s = vec3.create();
                    mat4.getTranslation(t, world);
                    mat4.getRotation(r, world);
                    mat4.getScaling(s, world);
                    instances.push({
                        meshIndex: node.mesh,
                        name: typeof node.name === 'string' && node.name ? node.name : undefined,
                        // Skinned vertices are posed by the skeleton, not the node's transform.
                        transform: node.skin === undefined ? {
                            translation: [t[0], t[1], t[2]],
                            rotation: [r[0], r[1], r[2], r[3]],
                            scale: [s[0], s[1], s[2]],
                        } : undefined,
                        skinIndex: node.skin,
                    });
                }
                for (const c of node.children ?? []) visit(c, world);
            };
            for (const r of roots) visit(r, mat4.create());
        }
        if (!instances.length && this.gltf.meshes) {
            for (let i = 0; i < this.gltf.meshes.length; i++) instances.push({ meshIndex: i });
        }
        return instances;
    }

    private async parseMeshes(): Promise<{name: string, geometry: Geometry, material: Material, transform?: ImportTransform}[]> {
        const result: {name: string, geometry: Geometry, material: Material, transform?: ImportTransform}[] = [];

        if (!this.gltf.meshes) return result;

        for (const instance of this.getMeshInstances()) {
            const mesh = this.gltf.meshes[instance.meshIndex];
            if (!mesh) continue;
            for (const primitive of mesh.primitives) {
                const geometry = await this.createGeometry(primitive);
                const material = await this.createMaterial(primitive.material);

                result.push({
                    name: instance.name || mesh.name || 'Mesh',
                    geometry,
                    material,
                    transform: instance.transform
                });
            }
        }

        return result;
    }

    private async createGeometry(primitive: GLTFMesh['primitives'][0]): Promise<Geometry> {
        // Assign (never push(...spread)) the converted arrays: spreading 65k+ vertices as call
        // arguments overflows the JS engine's argument limit and throws a RangeError on large meshes.
        let positions: [number, number, number][] = [];
        let normals: [number, number, number][] = [];
        let uvs: [number, number][] = [];
        const tangents: [number, number, number][] = [];
        let indices: number[] = [];

        // Load positions
        if (primitive.attributes.POSITION !== undefined) {
            const positionData = this.getAccessorData(primitive.attributes.POSITION) as Float32Array;
            positions = this.convertToVec3Array(positionData);
        }

        // Load normals
        if (primitive.attributes.NORMAL !== undefined) {
            const normalData = this.getAccessorData(primitive.attributes.NORMAL) as Float32Array;
            normals = this.convertToVec3Array(normalData);
        }

        // Load texture coordinates
        if (primitive.attributes.TEXCOORD_0 !== undefined) {
            const uvData = this.getAccessorData(primitive.attributes.TEXCOORD_0) as Float32Array;
            uvs = this.convertToVec2Array(uvData);
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
            return Material.PBR({});
        }

        const cached = this.materialCache.get(materialIndex);
        if (cached) return cached;

        const gltfMaterial = this.gltf.materials[materialIndex];
        const pbr = gltfMaterial.pbrMetallicRoughness;

        const baseColor: [number, number, number] = pbr?.baseColorFactor ?
            [pbr.baseColorFactor[0], pbr.baseColorFactor[1], pbr.baseColorFactor[2]] :
            [1, 1, 1];

        const emissiveFactor: [number, number, number] = gltfMaterial.emissiveFactor ?
            [gltfMaterial.emissiveFactor[0], gltfMaterial.emissiveFactor[1], gltfMaterial.emissiveFactor[2]] :
            [0, 0, 0];

        // GLTF is a PBR format: build a PBR material and load its full metallic-roughness texture set
        // (baseColor, metallic-roughness, normal, occlusion, emissive) rather than a Blinn-Phong subset,
        // so imported/uploaded textures are all actually used.
        const textures: any = {};
        if (pbr?.baseColorTexture) textures.baseColorTexture = this.loadTexture(pbr.baseColorTexture.index);
        if (pbr?.metallicRoughnessTexture) textures.metallicRoughnessTexture = this.loadTexture(pbr.metallicRoughnessTexture.index);
        if (gltfMaterial.normalTexture) textures.normalMap = this.loadTexture(gltfMaterial.normalTexture.index);
        if (gltfMaterial.occlusionTexture) textures.occlusionMap = this.loadTexture(gltfMaterial.occlusionTexture.index);
        if (gltfMaterial.emissiveTexture) textures.emissiveMap = this.loadTexture(gltfMaterial.emissiveTexture.index);

        const material = Material.PBR({
            baseColor,
            metallic: pbr?.metallicFactor === undefined ? 1.0 : pbr.metallicFactor,
            roughness: pbr?.roughnessFactor === undefined ? 1.0 : pbr.roughnessFactor,
            opacity: pbr?.baseColorFactor ? pbr.baseColorFactor[3] : 1.0,
            emissiveFactor,
            textures
        }, {
            side: gltfMaterial.doubleSided ? 'double' : 'front',
            transparent: gltfMaterial.alphaMode === 'BLEND',
        });
        this.materialCache.set(materialIndex, material);
        return material;
    }

    /**
     * Parse meshes with animation and skinning data
     */
    private async parseAnimatedMeshes(): Promise<{name: string, model: AnimatedModel, transform?: ImportTransform}[]> {
        const result: {name: string, model: AnimatedModel, transform?: ImportTransform}[] = [];

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

        // Parse meshes (one entry per scene-node reference, so node names/transforms are preserved)
        for (const instance of this.getMeshInstances()) {
            const mesh = this.gltf.meshes[instance.meshIndex];
            if (!mesh) continue;

            for (const primitive of mesh.primitives) {
                const geometry = await this.createGeometry(primitive);
                const material = await this.createMaterial(primitive.material);
                
                // Extract skinning data if present
                let skin: Skin | undefined = undefined;
                let jointIndices: Float32Array | undefined = undefined;
                let jointWeights: Float32Array | undefined = undefined;
                
                // Check if this mesh has skinning attributes
                if (primitive.attributes.JOINTS_0 !== undefined && primitive.attributes.WEIGHTS_0 !== undefined) {
                    // Load joint indices (keep as original integer type, don't convert to Float32Array)
                    const jointData = this.getAccessorData(primitive.attributes.JOINTS_0);
                    
                    // Convert to Float32Array only if it's not already a typed array of integers
                    if (jointData instanceof Float32Array) {
                        // If it's already float32, convert to integers
                        jointIndices = new Float32Array(jointData.length);
                        for (let i = 0; i < jointData.length; i++) {
                            jointIndices[i] = Math.floor(jointData[i]);
                        }
                    } else if (jointData instanceof Uint16Array || jointData instanceof Uint32Array) {
                        // Convert integer arrays to Float32Array with proper integer values
                        jointIndices = new Float32Array(jointData.length);
                        for (let i = 0; i < jointData.length; i++) {
                            jointIndices[i] = jointData[i];
                        }
                    } else {
                        jointIndices = new Float32Array(jointData);
                    }
                    
                    // Load joint weights
                    const weightData = this.getAccessorData(primitive.attributes.WEIGHTS_0) as Float32Array;
                    jointWeights = weightData;
                    
                    // Skins are referenced by the glTF node that instantiates the mesh; use that
                    // node's skin when known, otherwise fall back to the first available skin.
                    const skinIndex = instance.skinIndex !== undefined ? instance.skinIndex : 0;
                    if (skins.length > skinIndex && skins[skinIndex]) {
                        skin = skins[skinIndex]!;
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
                    name: instance.name || mesh.name || 'AnimatedMesh',
                    model: animatedModel,
                    transform: instance.transform
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
        
        // Build node parent map and extract node transforms from GLTF node hierarchy
        const nodeParents = new Map<number, number>();
        const nodeTransforms = new Map<number, mat4>();
        const nodeNames = new Map<number, string>();

        if (this.gltf.nodes) {
            for (let nodeIndex = 0; nodeIndex < this.gltf.nodes.length; nodeIndex++) {
                const node = this.gltf.nodes[nodeIndex];

                // Capture the node/bone name (used to retarget imported clips across files by name)
                if (typeof node.name === 'string' && node.name.length > 0) {
                    nodeNames.set(nodeIndex, node.name);
                }

                // Build parent map
                if (node.children) {
                    for (const childIndex of node.children) {
                        nodeParents.set(childIndex, nodeIndex);
                    }
                }
                
                // Extract node's initial transform
                const transform = mat4.create();
                
                if (node.matrix) {
                    // Node has a direct matrix
                    for (let i = 0; i < 16; i++) {
                        transform[i] = node.matrix[i];
                    }
                } else {
                    // Build from TRS (translation, rotation, scale)
                    const translation = node.translation ? 
                        [node.translation[0], node.translation[1], node.translation[2]] : 
                        [0, 0, 0];
                    const rotation = node.rotation ? 
                        [node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3]] : 
                        [0, 0, 0, 1];
                    const scale = node.scale ? 
                        [node.scale[0], node.scale[1], node.scale[2]] : 
                        [1, 1, 1];
                    
                    mat4.fromRotationTranslationScale(transform, rotation as any, translation as any, scale as any);
                }
                
                nodeTransforms.set(nodeIndex, transform);
            }
        }
        
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
        
        // Create joint objects with parent information
        for (let i = 0; i < gltfSkin.joints.length; i++) {
            const nodeIndex = gltfSkin.joints[i];
            joints.push({
                nodeIndex,
                inverseBindMatrix: inverseBindMatrices[i],
                parentIndex: nodeParents.get(nodeIndex)
            });
        }
        
        return {
            name: gltfSkin.name,
            joints,
            skeleton: gltfSkin.skeleton,
            nodeParents,
            nodeTransforms,
            nodeNames
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

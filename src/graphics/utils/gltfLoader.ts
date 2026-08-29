import { Geometry } from "../../core/geometry";
import { Material } from "../material";
import { TextureManager } from "../systems/textureManager";
import { AnimatedModel, Skin, Animation, AnimationSampler, AnimationChannel } from "../animatedModel";
import { Logger } from "../../core/logger";
import { mat4, quat, vec3 } from "gl-matrix";
import { collapseFbxPivots } from "./fbxPivots";

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
    /**
     * The only glTF extension this loader reads.
     *
     * `emissiveFactor` is capped at 1 per channel by the spec, so glTF has the same problem this engine
     * had: an emissive surface cannot be authored bright enough to do anything in an HDR pipeline.
     * `KHR_materials_emissive_strength` is the spec's answer, and it maps exactly onto
     * `emissiveIntensity`. Silently dropping it meant every emissive material imported from a modern
     * exporter arrived at a fraction of its authored brightness.
     */
    extensions?: {
        KHR_materials_emissive_strength?: { emissiveStrength?: number };
    };
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

/**
 * Where an image's pixels come from, without decoding them. `bytes` is transferable; the rest are
 * references the main thread resolves against `TextureManager`.
 */
export type GltfImageSource =
    | { kind: 'bytes'; bytes: Uint8Array; mime: string }
    | { kind: 'dataUri'; uri: string }
    | { kind: 'file'; fileName: string }
    | { kind: 'path'; uri: string }
    | { kind: 'missing'; uri?: string };

/** PBR material parameters plus indices into {@link GltfParseResult.images} — no texture ids, no GL. */
export interface GltfMaterialDescriptor {
    baseColor: [number, number, number];
    metallic: number;
    roughness: number;
    opacity: number;
    emissiveFactor: [number, number, number];
    /** KHR_materials_emissive_strength, or 1. Multiplies the factor above. */
    emissiveIntensity: number;
    doubleSided: boolean;
    transparent: boolean;
    /** glTF `alphaMode: MASK` as a cutoff; 0 when the material is not masked. */
    alphaCutoff?: number;
    textures: {
        baseColorTexture?: number;
        metallicRoughnessTexture?: number;
        normalMap?: number;
        occlusionMap?: number;
        emissiveMap?: number;
    };
}

export interface GltfGeometryDescriptor {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    tangents: Float32Array;
    indices: Uint32Array;
}

export interface GltfMeshDescriptor {
    name: string;
    geometry: GltfGeometryDescriptor;
    materialIndex: number;
    transform?: ImportTransform;
    /** Present only for skinned primitives parsed in animated mode. */
    jointIndices?: Float32Array;
    jointWeights?: Float32Array;
    skinIndex?: number;
}

/** Everything a glTF yields that needs no GL context. See `GLTFLoader.parseDescriptorsFromFiles`. */
export interface GltfParseResult {
    meshes: GltfMeshDescriptor[];
    materials: GltfMaterialDescriptor[];
    images: GltfImageSource[];
    skins: (Skin | undefined)[];
    animations: Animation[];
}

export class GLTFLoader {
    // Definite-assignment: every load entry point (loadFromJson/loadFromUrl/loadFromFiles/...) assigns this
    // before anything reads it; the constructor has no data to assign from.
    private gltf!: GLTF;
    private buffers: ArrayBuffer[] = [];
    private basePath: string = '';
    private files: File[] = [];
    // Shared glTF resources are referenced once PER PRIMITIVE, so without these caches a file with N
    // primitives realizes N copies of each material and texture.
    private materialCache = new Map<number, Material>();
    private textureIdCache = new Map<string, string | undefined>();
    // Descriptor-mode state: images described once each, keyed the same way textureIdCache is.
    private imageSources: GltfImageSource[] = [];
    private imageIndexCache = new Map<string, number>();

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

    /** Load skinned, animated models from a file path. */
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

    /** Load skinned, animated models from uploaded files. */
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
     * Parse only animation clips and their source skeleton, for retargeting. Needs no mesh or skin —
     * an animation-only file's skeleton is reconstructed from the node hierarchy and animation targets.
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

        // Fold assimp's FBX pivots away BEFORE anything reads the hierarchy — see fbxPivots.ts.
        const fromFile = this.gltf.skins && this.gltf.skins.length > 0 ? this.parseSkin(this.gltf.skins[0]) : null;
        const collapsed = collapseFbxPivots({ nodeParents, nodeTransforms, nodeNames }, animations, fromFile?.joints);
        const graph = {
            nodeParents: collapsed.nodeParents,
            nodeTransforms: collapsed.nodeTransforms,
            nodeNames: collapsed.nodeNames,
        };

        // Prefer a real skin (has inverse-bind matrices); else synthesize joints from animated nodes.
        if (fromFile) return { animations: collapsed.animations, skin: { ...fromFile, ...graph } };

        // AFTER the collapse, so the joints are the real bones rather than the pivots carrying curves.
        const animatedNodes = new Set<number>();
        for (const a of collapsed.animations) for (const ch of a.channels) animatedNodes.add(ch.targetNodeIndex);
        const joints = [...animatedNodes].sort((x, y) => x - y).map(ni => ({
            nodeIndex: ni, inverseBindMatrix: mat4.create(), parentIndex: collapsed.nodeParents.get(ni),
        }));
        return { animations: collapsed.animations, skin: { joints, ...graph } };
    }

    // Decode an embedded `data:` buffer URI through `fetch`, which decodes base64 natively.
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
                    Logger.warn(`Buffer file ${buffer.uri} not found in uploaded files`, 'Loader');
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

    // Match a glTF-relative URI against the provided files, handling folder imports and multi-select.
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

    // The compressed bytes of an image stored in a bufferView. COPIED, not viewed: the Texture retains
    // them, and a view would pin the model's whole glTF buffer alive.
    private bufferViewImageBytes(image: GLTFImage): Uint8Array {
        const bufferView = this.gltf.bufferViews![image.bufferView!];
        const buffer = this.buffers[bufferView.buffer];
        const byteOffset = bufferView.byteOffset || 0;
        return new Uint8Array(buffer.slice(byteOffset, byteOffset + bufferView.byteLength));
    }

    // ---- descriptor mode -------------------------------------------------------------------------
    // Everything below produces PLAIN DATA — no Texture, Material, Geometry or GL — so glTF parsing can
    // run in a Web Worker. The eager paths below wrap these same functions, so the two cannot drift.

    // Describe an image without decoding or uploading it. File resolution happens here — only the
    // parser knows how a glTF URI maps onto the upload list — and the descriptor carries the name.
    private describeImage(image: GLTFImage): GltfImageSource {
        if (image.bufferView !== undefined)
            return { kind: 'bytes', bytes: this.bufferViewImageBytes(image), mime: image.mimeType || 'image/jpeg' };

        if (image.uri && image.uri.startsWith('data:'))
            return { kind: 'dataUri', uri: image.uri };

        if (image.uri) {
            // File-import flow: a URI that was not uploaded stays unresolved (kind 'missing') rather
            // than falling through to a relative fetch that is certain to fail.
            if (this.files.length) {
                const file = this.findFile(image.uri);
                return file ? { kind: 'file', fileName: file.name } : { kind: 'missing', uri: image.uri };
            }
            return { kind: 'path', uri: this.basePath + image.uri };
        }
        return { kind: 'missing' };
    }

    // Index into `GltfParseResult.images` for a texture reference, deduped by SOURCE: many texture
    // entries alias few images, and several image entries can share one URI.
    private imageIndexFor(textureIndex: number): number | undefined {
        if (!this.gltf.textures || !this.gltf.images) return undefined;
        const texture = this.gltf.textures[textureIndex];
        if (!texture || texture.source === undefined) return undefined;

        const image = this.gltf.images[texture.source];
        const cacheKey = image.uri !== undefined ? `uri:${image.uri}` : `bv:${image.bufferView}`;
        const cached = this.imageIndexCache.get(cacheKey);
        if (cached !== undefined) return cached;

        const index = this.imageSources.length;
        this.imageSources.push(this.describeImage(image));
        this.imageIndexCache.set(cacheKey, index);
        return index;
    }

    /** Material parameters plus image *indices* — no texture ids, so no GL. */
    private describeMaterial(materialIndex?: number): GltfMaterialDescriptor {
        if (materialIndex === undefined || !this.gltf.materials)
            return { baseColor: [1, 1, 1], metallic: 1, roughness: 1, opacity: 1, emissiveFactor: [0, 0, 0], emissiveIntensity: 1, doubleSided: false, transparent: false, textures: {} };

        const gltfMaterial = this.gltf.materials[materialIndex];
        const pbr = gltfMaterial.pbrMetallicRoughness;

        const textures: GltfMaterialDescriptor['textures'] = {};
        if (pbr?.baseColorTexture) textures.baseColorTexture = this.imageIndexFor(pbr.baseColorTexture.index);
        if (pbr?.metallicRoughnessTexture) textures.metallicRoughnessTexture = this.imageIndexFor(pbr.metallicRoughnessTexture.index);
        if (gltfMaterial.normalTexture) textures.normalMap = this.imageIndexFor(gltfMaterial.normalTexture.index);
        if (gltfMaterial.occlusionTexture) textures.occlusionMap = this.imageIndexFor(gltfMaterial.occlusionTexture.index);
        if (gltfMaterial.emissiveTexture) textures.emissiveMap = this.imageIndexFor(gltfMaterial.emissiveTexture.index);

        return {
            baseColor: pbr?.baseColorFactor
                ? [pbr.baseColorFactor[0], pbr.baseColorFactor[1], pbr.baseColorFactor[2]]
                : [1, 1, 1],
            metallic: pbr?.metallicFactor === undefined ? 1.0 : pbr.metallicFactor,
            roughness: pbr?.roughnessFactor === undefined ? 1.0 : pbr.roughnessFactor,
            opacity: pbr?.baseColorFactor ? pbr.baseColorFactor[3] : 1.0,
            emissiveFactor: gltfMaterial.emissiveFactor
                ? [gltfMaterial.emissiveFactor[0], gltfMaterial.emissiveFactor[1], gltfMaterial.emissiveFactor[2]]
                : [0, 0, 0],
            emissiveIntensity:
                gltfMaterial.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1,
            doubleSided: !!gltfMaterial.doubleSided,
            transparent: gltfMaterial.alphaMode === 'BLEND',
            // 0.5 is the glTF default for MASK; 0 disables the cutout for every other alpha mode.
            alphaCutoff: gltfMaterial.alphaMode === 'MASK' ? (gltfMaterial.alphaCutoff ?? 0.5) : 0,
            textures,
        };
    }

    /** Vertex attributes as flat typed arrays — the shape `Geometry` adopts without copying. */
    private describeGeometry(primitive: GLTFMesh['primitives'][0]): GltfGeometryDescriptor {
        const empty = new Float32Array(0);
        let positions: Float32Array = empty, normals: Float32Array = empty;
        let uvs: Float32Array = empty, tangents: Float32Array = empty;

        if (primitive.attributes.POSITION !== undefined)
            positions = this.getAccessorData(primitive.attributes.POSITION) as Float32Array;
        if (primitive.attributes.NORMAL !== undefined)
            normals = this.getAccessorData(primitive.attributes.NORMAL) as Float32Array;
        if (primitive.attributes.TEXCOORD_0 !== undefined) {
            const src = this.getAccessorData(primitive.attributes.TEXCOORD_0) as Float32Array;
            // Flip V: glTF UVs have a bottom-left origin, the engine samples top-left. Copied rather
            // than adopted in place because the accessor data may be a view onto a shared buffer.
            uvs = new Float32Array(src.length);
            for (let i = 0; i < src.length; i += 2) {
                uvs[i] = src[i];
                uvs[i + 1] = 1.0 - src[i + 1];
            }
        }

        // glTF tangents are vec4 (xyz + handedness); Geometry stores vec3, so drop w.
        if (primitive.attributes.TANGENT !== undefined) {
            const src = this.getAccessorData(primitive.attributes.TANGENT) as Float32Array;
            tangents = new Float32Array((src.length / 4) * 3);
            for (let i = 0, o = 0; i < src.length; i += 4, o += 3) {
                tangents[o] = src[i]; tangents[o + 1] = src[i + 1]; tangents[o + 2] = src[i + 2];
            }
        }

        let indices: Uint32Array;
        if (primitive.indices !== undefined) {
            const data = this.getAccessorData(primitive.indices);
            indices = data instanceof Uint32Array ? data : Uint32Array.from(data);
        } else {
            // Non-indexed geometry: consecutive triples form triangles.
            const count = positions.length / 3;
            indices = new Uint32Array(count);
            for (let i = 0; i < count; i++) indices[i] = i;
        }

        return { positions, normals, uvs, tangents, indices };
    }

    /**
     * Parse uploaded glTF files into plain data. Pure — no DOM, no WebGL — so it is safe in a worker;
     * pair with `Loader.assembleGltfModels`. `animated` adds skins, clips and joint bindings.
     */
    public async parseDescriptorsFromFiles(files: File[], animated: boolean): Promise<GltfParseResult> {
        this.files = files;
        // .gltf only, matching loadFromFiles: a .glb is binary (JSON.parse of its text would fail) and
        // is routed through the assimp path instead.
        const gltfFile = files.find(f => f.name.toLowerCase().endsWith('.gltf'));
        if (!gltfFile) throw new Error('No GLTF file found in the uploaded files');

        this.gltf = JSON.parse(await gltfFile.text());
        await this.loadBuffersFromFiles();
        return this.buildDescriptors(animated);
    }

    private buildDescriptors(animated: boolean): GltfParseResult {
        this.imageSources = [];
        this.imageIndexCache = new Map();

        const materials: GltfMaterialDescriptor[] = [];
        const materialIndexByGltfIndex = new Map<number, number>();
        const materialSlot = (gltfIndex?: number): number => {
            const key = gltfIndex === undefined ? -1 : gltfIndex;
            const existing = materialIndexByGltfIndex.get(key);
            if (existing !== undefined) return existing;
            const slot = materials.length;
            materials.push(this.describeMaterial(gltfIndex));
            materialIndexByGltfIndex.set(key, slot);
            return slot;
        };

        const skins: (Skin | null)[] = [];
        let animations: Animation[] = [];
        if (animated) {
            if (this.gltf.skins) for (const s of this.gltf.skins) skins.push(this.parseSkin(s));
            if (this.gltf.animations) for (const a of this.gltf.animations) animations.push(this.parseAnimation(a));
            animations = this.collapsePivots(skins, animations);
        }

        const meshes: GltfMeshDescriptor[] = [];
        if (this.gltf.meshes) {
            for (const instance of this.getMeshInstances()) {
                const mesh = this.gltf.meshes[instance.meshIndex];
                if (!mesh) continue;
                for (const primitive of mesh.primitives) {
                    const descriptor: GltfMeshDescriptor = {
                        name: instance.name || mesh.name || (animated ? 'AnimatedMesh' : 'Mesh'),
                        geometry: this.describeGeometry(primitive),
                        materialIndex: materialSlot(primitive.material),
                        transform: instance.transform,
                    };

                    if (animated && primitive.attributes.JOINTS_0 !== undefined && primitive.attributes.WEIGHTS_0 !== undefined) {
                        const jointData = this.getAccessorData(primitive.attributes.JOINTS_0);
                        // Joint indices ride in a Float32Array (that is what the skinned shader binds),
                        // so integer accessor types are widened and float ones floored.
                        const jointIndices = new Float32Array(jointData.length);
                        for (let i = 0; i < jointData.length; i++)
                            jointIndices[i] = jointData instanceof Float32Array ? Math.floor(jointData[i]) : jointData[i];

                        descriptor.jointIndices = jointIndices;
                        descriptor.jointWeights = this.getAccessorData(primitive.attributes.WEIGHTS_0) as Float32Array;
                        // Skins are referenced by the node that instantiates the mesh; fall back to the
                        // first skin when the node does not say.
                        descriptor.skinIndex = instance.skinIndex !== undefined ? instance.skinIndex : 0;
                    }

                    meshes.push(descriptor);
                }
            }
        }

        return { meshes, materials, images: this.imageSources, skins: skins.map(s => s ?? undefined), animations };
    }

    // Fold assimp's FBX pivots away across every skin and clip at once — the node graph is one shared
    // hierarchy. A character and an animation file must BOTH be collapsed or their chains disagree.
    private collapsePivots(skins: (Skin | null)[], animations: Animation[]): Animation[] {
        const first = skins.find(s => s) as Skin | undefined;
        if (!first?.nodeNames || !first.nodeParents || !first.nodeTransforms) return animations;

        const joints = skins.flatMap(s => s?.joints ?? []);
        const collapsed = collapseFbxPivots(
            { nodeParents: first.nodeParents, nodeTransforms: first.nodeTransforms, nodeNames: first.nodeNames },
            animations, joints);
        if (collapsed.removed.size === 0) return animations;

        for (const skin of skins) {
            if (!skin) continue;
            skin.nodeParents = collapsed.nodeParents;
            skin.nodeTransforms = collapsed.nodeTransforms;
            skin.nodeNames = collapsed.nodeNames;
        }
        return collapsed.animations;
    }

    /** Buffers in `result` that can be transferred rather than copied across a worker boundary. */
    public static parseResultTransferables(result: GltfParseResult): ArrayBuffer[] {
        const out: ArrayBuffer[] = [];
        const add = (a?: { buffer: ArrayBufferLike; byteLength: number }) => {
            if (a && a.byteLength > 0) out.push(a.buffer as ArrayBuffer);
        };
        for (const m of result.meshes) {
            add(m.geometry.positions); add(m.geometry.normals); add(m.geometry.uvs);
            add(m.geometry.tangents); add(m.geometry.indices);
            add(m.jointIndices); add(m.jointWeights);
        }
        for (const img of result.images) if (img.kind === 'bytes') add(img.bytes);
        return out;
    }

    // Resolve a glTF texture reference to a TextureManager id: bufferView images, data URIs, uploaded
    // files and external paths.
    private loadTexture(textureIndex: number): string | undefined {
        if (!this.gltf.textures || !this.gltf.images) return undefined;

        const texture = this.gltf.textures[textureIndex];
        if (!texture || texture.source === undefined) return undefined;

        const image = this.gltf.images[texture.source];
        // Key on the image's SOURCE, so each underlying image is decoded and uploaded exactly once.
        const cacheKey = image.uri !== undefined ? `uri:${image.uri}` : `bv:${image.bufferView}`;
        if (this.textureIdCache.has(cacheKey)) return this.textureIdCache.get(cacheKey);
        const id = this.resolveTexture(image);
        this.textureIdCache.set(cacheKey, id);
        return id;
    }

    private resolveTexture(image: GLTFImage): string | undefined {
        const cfg = { wrapping: 'repeat' as const };

        try {
            // 1. Embedded image: hand the compressed bytes straight over, decoded from a Blob.
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
                // 3a. File-import flow. An unresolved reference returns undefined rather than falling
                // through to a relative fetch, which rejects with an image error Event.
                if (this.files.length) {
                    const file = this.findFile(image.uri);
                    return file ? TextureManager.Instance.addTextureFromFile(file, cfg) : undefined;
                }
                // 3b. Path-load flow: resolve relative to the GLTF's base path
                return TextureManager.Instance.addTextureFromPath(this.basePath + image.uri, cfg);
            }
        } catch (error) {
            Logger.print('warn', ['Failed to load texture:', error], 'Loader');
        }

        return undefined;
    }

    // One entry per scene-node -> mesh reference with the node's world TRS, so a multi-part file places
    // as authored. Falls back to one identity instance per mesh when no node references any.
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

    // Eager-path geometry, delegating to `describeGeometry` so attribute decoding has one implementation.
    private async createGeometry(primitive: GLTFMesh['primitives'][0]): Promise<Geometry> {
        const g = this.describeGeometry(primitive);
        return new Geometry(g.positions, g.normals, g.uvs, g.tangents, [], g.indices);
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

        // glTF is a PBR format, so load the whole metallic-roughness set rather than a Blinn-Phong subset.
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
            // See describeMaterial: MASK is a cutout, not transparency.
            alphaCutoff: gltfMaterial.alphaMode === 'MASK' ? (gltfMaterial.alphaCutoff ?? 0.5) : 0,
            emissiveFactor,
            emissiveIntensity:
                gltfMaterial.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1,
            textures
        }, {
            side: gltfMaterial.doubleSided ? 'double' : 'front',
            transparent: gltfMaterial.alphaMode === 'BLEND',
        });
        this.materialCache.set(materialIndex, material);
        return material;
    }

    // Parse meshes with their animation and skinning data.
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
        let animations: Animation[] = [];
        if (this.gltf.animations) {
            for (const gltfAnim of this.gltf.animations) {
                animations.push(this.parseAnimation(gltfAnim));
            }
        }
        // Same pivot fold as the descriptor path, so the eager loader cannot drift from it.
        animations = this.collapsePivots(skins, animations);

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

    // Convert a glTF skin into the engine's Skin.
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

    // Convert a glTF animation into the engine's Animation.
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

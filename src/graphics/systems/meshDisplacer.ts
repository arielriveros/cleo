import { device } from '../rhi/deviceHandle';
import { BufferUsage, ShaderStage } from '../rhi/types';
import type { Buffer as GpuBuffer, ComputePipeline } from '../rhi/resources';
import { Logger } from '../../core/logger';
import { TextureManager } from './textureManager';
import type { Model } from '../model';
import {
    tessSegments, tessVertsPerTri, tessTrisPerTri, buildTessIndices, buildDisplaceAttributes,
    DISPLACE_ATTRIB_STRIDE, presubdivideLevels, presubdivideBase,
} from './meshDisplace';
// @ts-ignore -- WGSL module, typed by the loader
import MeshDisplaceComputeProgram from '../shaders/wgsl/meshDisplaceCompute.wgsl';

/** Floats per vertex in MODEL_VERTEX_LAYOUT. Position 3, normal 3, uv 2, tangent 3, bitangent 3. */
const VERTEX_FLOATS = 14;

/**
 * Runs the compute tessellator, and owns the buffers it writes into.
 *
 * WebGPU only. WebGL2 has no compute stage, so a model marked for displacement simply draws
 * undisplaced there and keeps whatever the material's parallax setting is — see `canDisplace`. The gate
 * is `capabilities.hasCompute`, never a backend name: the question is whether this device can run a
 * dispatch, which is also how `Renderer._bakeCloudNoise` asks it.
 *
 * State is keyed per Model rather than per Mesh because the inputs that invalidate it — the height map,
 * the depth, the subdivision level — live on the material and the model, and because a Mesh is shared
 * by every instance of a model and must not be displaced twice.
 */
export class MeshDisplacer {
    private static _instance: MeshDisplacer | null = null;
    public static get Instance(): MeshDisplacer {
        if (!this._instance) this._instance = new MeshDisplacer();
        return this._instance;
    }

    private _pipeline: ComputePipeline | null = null;
    private _entries = new Map<Model, DisplaceEntry>();

    /** Whether this device can displace at all. False on WebGL2, always. */
    public get canDisplace(): boolean { return device.capabilities.hasCompute; }

    /**
     * Bring `model`'s displaced buffers up to date, allocating or freeing as its settings change.
     *
     * Safe to call every frame: everything after the key comparison is skipped when nothing moved, and
     * the key covers every input the dispatch reads. Call it from a point in the frame where NO pass is
     * open — the same requirement `TexturePacker._bake` and the cloud-noise bake carry, because it opens
     * its own encoder.
     */
    public update(model: Model): void {
        const settings = readSettings(model);
        const mesh = model.mesh;
        if (!settings || !this.canDisplace) {
            // Also the path that UNDOES a displacement when the user turns it off.
            if (this._entries.has(model)) this.release(model);
            return;
        }

        const key = `${settings.heightId}|${settings.depth}|${settings.level}|${settings.invert}` +
                    `|${mesh.baseVertexCount}|${model.geometryVersion}`;
        const existing = this._entries.get(model);
        if (existing && existing.key === key) return;

        const texture = TextureManager.Instance.getTexture(settings.heightId);
        // Still decoding. Do NOT record the key — leaving it unset is what makes the next frame retry,
        // and the deleted terrain bake lost a whole feature to recording a key for a null context.
        if (!texture || !texture.sampledView) return;

        if (existing) this.release(model);
        const entry = this._build(model, settings, key);
        if (entry) this._entries.set(model, entry);
    }

    /** Drop a model's displaced buffers and put its Mesh back on the authored ones. */
    public release(model: Model): void {
        const entry = this._entries.get(model);
        if (!entry) return;
        model.mesh.setDisplaced(null, null, 0, 0, 0);
        entry.vertices.destroy();
        entry.indices.destroy();
        entry.srcIndices.destroy();
        entry.attributes.destroy();
        entry.uniforms.destroy();
        entry.srcVertices?.destroy();
        this._entries.delete(model);
    }

    /** Every model this holds buffers for, so a scene teardown does not leak tens of megabytes. */
    public releaseAll(): void {
        for (const model of [...this._entries.keys()]) this.release(model);
    }

    private _build(model: Model, settings: DisplaceSettings, key: string): DisplaceEntry | null {
        const mesh = model.mesh;
        const geometry = model.geometry;
        const triangleCount = Math.floor(geometry.indices.length / 3);
        if (triangleCount === 0) return null;

        // THE VERTEX STRIDE IS NOT A CONSTANT. `Geometry.getData` packs only the attributes the
        // material's program declares AND the geometry actually has, so a mesh missing tangents — or
        // drawn by an unlit program — uploads a shorter vertex than the shader indexes. Reading past it
        // would not fail validation, it would silently displace by whatever the next vertex's bytes
        // happen to be. Check rather than assume.
        const present = 3
            + (geometry.normals.length ? 3 : 0) + (geometry.uvs.length ? 2 : 0)
            + (geometry.tangents.length ? 3 : 0) + (geometry.bitangents.length ? 3 : 0);
        if (present !== VERTEX_FLOATS) {
            Logger.print('warn', [
                `Cannot displace: this mesh packs ${present} floats per vertex, not ${VERTEX_FLOATS}. ` +
                'Displacement needs position, normal, uv, tangent and bitangent.',
            ], 'MeshDisplacer');
            return null;
        }

        // CPU PRE-SUBDIVISION, spent out of the user's level so the output count is unchanged. Only a
        // coarse mesh gets any: it exists to give a cube's faces interior vertices with their OWN uvs,
        // before the dominant-uv merge collapses every corner. See `presubdivideLevels`.
        const preLevels = presubdivideLevels(triangleCount, settings.level);
        const base = preLevels > 0
            ? presubdivideBase(geometry.positions, geometry.normals, geometry.uvs,
                               geometry.tangents, geometry.bitangents, geometry.indices, preLevels)
            : null;
        const baseTriangles = base ? base.triangleCount : triangleCount;

        const segments = tessSegments(settings.level - preLevels);
        const vertexCount = baseTriangles * tessVertsPerTri(segments);
        // DERIVED from the buffer rather than computed alongside it. Computing the draw count separately
        // is what let a pre-subdivided mesh ask for 9216 indices out of a 576-index buffer: the count
        // had moved to `baseTriangles` and this had not. Deriving it makes that disagreement unable to
        // exist rather than merely fixed.
        const indexData = buildTessIndices(baseTriangles, segments);
        const indexCount = indexData.length;

        const texture = TextureManager.Instance.getTexture(settings.heightId)!;
        const width = Math.max(1, texture.width || 1);
        const height = Math.max(1, texture.height || 1);
        if (!texture.sampledView) return null;

        // The mip whose texel matches an output edge. Band-limited on purpose: undersampled detail does
        // not vanish, it folds into low-frequency beat patterns.
        //
        // MEASURED from the chart, not guessed from the triangle count. `sqrt(triangleCount)` was the
        // first attempt and it conflates mesh density with CHART density: an 8-triangle ramp whose faces
        // each carry a 0..1 chart came out as 181 texels per output edge when the truth is 512, so it
        // sampled mip 7.5 of a 4096 map — a 16x16 image — and displaced by a near-constant. "Almost
        // totally flat" was that, and it only spared the dense meshes because there the guess happened
        // to land near the truth.
        // Over the FULL subdivision, CPU and GPU together — pre-subdivision shortens the base edge by
        // exactly the factor the dispatch no longer applies, so the output spacing is what it always was.
        const uvEdge = geometry.meanUvEdge();
        const texelsPerEdge = Math.max(1, (uvEdge * width) / Math.max(1, tessSegments(settings.level)));
        const lod = Math.max(0, Math.log2(texelsPerEdge));
        // A mesh whose vertices are far coarser than the map can only carry its low frequencies —
        // correctly, but it looks like the feature is not working. Say so once, with the number.
        if (texelsPerEdge > 8) {
            Logger.print('warn', [
                `Displacement is band-limited to mip ${lod.toFixed(1)}: one output edge spans ` +
                `${texelsPerEdge.toFixed(0)} texels of this ${width}px map, so the geometry can only ` +
                'carry its lowest frequencies. Raise the subdivision level, tile the uv, or leave the ' +
                'detail to the normal map.',
            ], 'MeshDisplacer');
        }
        // The 1x1 top mip IS the arithmetic mean, because generateMipmaps is a box filter — so the
        // centring the displacement needs costs one extra sample rather than a CPU decode.
        const meanLod = Math.log2(Math.max(width, height));

        const vertices = device.createBuffer({
            label: 'displace.vertices', size: vertexCount * VERTEX_FLOATS * 4,
            usage: BufferUsage.VERTEX | BufferUsage.STORAGE | BufferUsage.COPY_DST,
        });
        const indices = device.createBuffer({
            label: 'displace.indices', size: 0,
            usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
        });
        const indexBuffer = device.reallocateBuffer(indices, indexData);

        // A DEDICATED u32 COPY of the source indices, rather than binding the Mesh's own index buffer.
        // Two reasons, and each is on its own fatal:
        //  - that buffer is created `INDEX | COPY_DST` with no STORAGE, and WebGPU rejects the bind
        //    group outright — "[Invalid CommandBuffer from CommandEncoder] is invalid due to a previous
        //    error" is what that looks like from the queue;
        //  - `Mesh.create` narrows the format by range, so a mesh under 65536 vertices uploads UINT16,
        //    which `array<u32>` would read two indices at a time. The scan this exists for has 1963
        //    vertices, so it takes exactly that path.
        // `Geometry.indices` is already a Uint32Array, so this is a straight upload.
        const srcIndices = device.createBuffer({
            label: 'displace.srcIndices', size: 0,
            usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
        });
        const srcIndexBuffer = device.reallocateBuffer(srcIndices, base ? base.indices : geometry.indices);

        // Only allocated when the mesh was pre-subdivided; otherwise the dispatch reads the Mesh's own
        // vertex buffer, exactly as before.
        let srcVertexBuffer: GpuBuffer | null = null;
        if (base) {
            srcVertexBuffer = device.reallocateBuffer(device.createBuffer({
                label: 'displace.srcVertices', size: 0,
                usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
            }), base.vertices);
        }

        // From the PRE-SUBDIVIDED arrays when there are any: the whole point is that the merge sees the
        // interior vertices, which only exist after the split.
        const attributeData = base
            ? buildDisplaceAttributes(base.positions, base.uvs, base.normals)
            : buildDisplaceAttributes(geometry.positions, geometry.uvs, geometry.normals);
        const attributes = device.createBuffer({
            label: 'displace.seamAttribs', size: 0,
            usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
        });
        const attributeBuffer = device.reallocateBuffer(attributes, attributeData);

        // u32 x4, f32 x3, i32, vec2<f32>, vec2<f32> -> 4*4 + 3*4 + 4 = 32, then vec2 pairs at 32 and 40.
        // vec2<f32> aligns to 8, and 32 is already 8-aligned, so the block is 48 bytes with no gap.
        const uniformBytes = new ArrayBuffer(48);
        new Uint32Array(uniformBytes, 0, 4).set([baseTriangles, segments, tessVertsPerTri(segments), VERTEX_FLOATS]);
        new Float32Array(uniformBytes, 16, 3).set([settings.depth, 0, lod]);
        new Int32Array(uniformBytes, 28, 1).set([settings.invert ? 1 : 0]);
        new Float32Array(uniformBytes, 32, 2).set([1 / width * Math.pow(2, lod), 1 / height * Math.pow(2, lod)]);
        const uniforms = device.createBuffer({
            label: 'displace.uniforms', size: 48, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
        });

        // A buffer bound as `var<storage>` MUST carry STORAGE usage, and a GPUBuffer fixes its usage at
        // creation — so this cannot be repaired here, only reported. Checked because the failure is
        // otherwise opaque: WebGPU rejects the bind group during encoding and the only thing that
        // surfaces is "[Invalid CommandBuffer from CommandEncoder "meshDisplace"] is invalid due to a
        // previous error" at submit, naming neither the binding nor the reason.
        if (!srcVertexBuffer && (mesh.baseVertexBuffer.usage & BufferUsage.STORAGE) === 0) {
            Logger.print('error', [
                'Cannot displace: the vertex buffer for this mesh was created without STORAGE usage, ' +
                'so the compute pass cannot read it. See the constructor in graphics/mesh.ts.',
            ], 'MeshDisplacer');
            vertices.destroy(); indexBuffer.destroy(); srcIndexBuffer.destroy();
            attributeBuffer.destroy(); uniforms.destroy();
            return null;
        }

        const pipeline = this._ensurePipeline();
        if (!pipeline) {
            vertices.destroy(); indexBuffer.destroy(); srcIndexBuffer.destroy();
            attributeBuffer.destroy(); uniforms.destroy(); srcVertexBuffer?.destroy();
            return null;
        }

        // The MEAN is sampled in the shader from `meanLod`, so it rides in the uniform block as a level
        // rather than a value — one less CPU round trip, and it cannot go stale against the texture.
        new Float32Array(uniformBytes, 20, 1).set([meanLod]);
        device.writeBuffer(uniforms, 0, new Uint8Array(uniformBytes));

        const encoder = device.createCommandEncoder('meshDisplace');
        const pass = encoder.beginComputePass('meshDisplace');
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, device.createBindGroup({
            label: 'meshDisplace',
            layout: pipeline.bindGroupLayouts[0],
            entries: [
                { binding: 0, buffer: uniforms },
                { binding: 1, buffer: srcVertexBuffer ?? mesh.baseVertexBuffer },
                { binding: 2, buffer: srcIndexBuffer },
                { binding: 3, buffer: attributeBuffer },
                { binding: 4, buffer: vertices },
                // The sampler at binding 6 is synthesised by `createBindGroup`: this engine keeps
                // sampling state on the TEXTURE, so a bind group arrives one entry short of a
                // `texture_2d` + `sampler` layout and WebGPU would reject it on the count.
                { binding: 5, textureView: texture.sampledView },
            ],
        }));
        // Workgroup COUNTS, over a flat list of output vertices. @workgroup_size(64), and the shader
        // guards the tail because this rounds up.
        pass.dispatchWorkgroups(Math.ceil(vertexCount / 64));
        pass.end();
        encoder.finish();

        mesh.setDisplaced(vertices, indexBuffer, vertexCount, indexCount, segments);
        Logger.info(
            `Displaced mesh: ${triangleCount} -> ${indexCount / 3} triangles ` +
            `(level ${settings.level}${preLevels > 0 ? `, ${preLevels} of them on the cpu` : ''}, ` +
            `${(vertexCount * VERTEX_FLOATS * 4 / 1e6).toFixed(1)} MB)`,
            'MeshDisplacer');
        return { key, vertices, indices: indexBuffer, srcIndices: srcIndexBuffer,
                 attributes: attributeBuffer, uniforms, srcVertices: srcVertexBuffer };
    }

    private _ensurePipeline(): ComputePipeline | null {
        if (this._pipeline) return this._pipeline;
        try {
            const module = device.createShaderModule({
                label: 'meshDisplaceCompute',
                stage: ShaderStage.COMPUTE,
                source: MeshDisplaceComputeProgram.wgsl,
                entryPoints: MeshDisplaceComputeProgram.entryPoints,
                resources: MeshDisplaceComputeProgram.resources,
            });
            this._pipeline = device.createComputePipeline({ label: 'meshDisplace', compute: module });
        } catch (error) {
            Logger.print('error', ['Mesh displacement pipeline failed:', error], 'MeshDisplacer');
            return null;
        }
        return this._pipeline;
    }
}

interface DisplaceEntry {
    key: string;
    vertices: GpuBuffer;
    indices: GpuBuffer;
    srcIndices: GpuBuffer;
    attributes: GpuBuffer;
    uniforms: GpuBuffer;
    /** Null unless the mesh was pre-subdivided on the cpu; otherwise the dispatch reads the Mesh's own. */
    srcVertices: GpuBuffer | null;
}

interface DisplaceSettings {
    heightId: string;
    depth: number;
    level: number;
    invert: boolean;
}

/**
 * The displacement inputs a model carries, or null when it is not displaced.
 *
 * ALL of them off the MATERIAL, which already owns the height slot, the depth and its unit — the
 * surface decides how it wants to be represented, and a material moved onto another mesh carries its
 * relief with it.
 *
 * `model.material` is the FIRST submesh's. A multi-material model displaces as a whole or not at all:
 * the tessellation rewrites one shared vertex buffer, so a per-submesh level has nothing to write into.
 */
function readSettings(model: Model): DisplaceSettings | null {
    const material = model.material;
    if (!material) return null;
    const level = Math.max(0, Math.floor(Number(material.properties.get('displaceLevel') ?? 0)));
    if (level <= 0) return null;
    const heightId = material.textures.get('displacementMap');
    if (!heightId) return null;
    const authored = Number(material.properties.get('dispScale') ?? 0);
    if (!(authored > 0)) return null;
    // WORLD units, always. Geometry moves in world space, so a uv-unit depth has to be converted by the
    // mesh's own chart scale first — the same `worldPerUv` the shader derives per fragment, taken here
    // as the whole-mesh figure. Without this a 0.05 uv depth on an atlas-mapped scan displaces by 2.4
    // world units instead of 0.05.
    const inWorld = material.properties.get('depthInWorld') !== false;
    const depth = inWorld ? authored : authored * model.geometry.worldPerUv();
    return { heightId, depth, level, invert: !!material.properties.get('invertHeight') };
}

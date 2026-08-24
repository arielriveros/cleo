/**
 * The WebGPU implementation of the RHI device.
 *
 * Unlike `WebGL2Device`, this one declares `implements Device` from the start, and that asymmetry is
 * deliberate. The interface in `../device.ts` was written in WebGPU's vocabulary precisely because the
 * mapping only runs downhill: every concept it names — immutable pipelines, bind groups, explicit
 * render passes with load/store ops, texture views onto a single layer — exists natively here, so
 * there is nothing to stub and nothing to lie about. `WebGL2Device` is the one that has to synthesise
 * the missing halves, which is why it is still migrating resource type by resource type.
 *
 * That makes this file the reference implementation, and its real value right now is as a check on the
 * interface: anything the RHI describes that cannot be expressed cleanly here was described wrong.
 *
 * What it does NOT do yet is drive `renderer.ts`. The renderer still issues 160 raw `gl.*` calls, so
 * the path from a scene to this device does not exist — see WEBGPU_ROADMAP.md M5/M6. This is the
 * device tier only, exercised end to end by `tools/harness/webgpuCheck.js`.
 */

import { Logger } from '../../../core/logger';
import { frameStats, setViewportSize } from '../../renderStats';
import { ShaderManager } from '../../systems/shaderManager';
import {
    gpuTextureFormat, rhiTextureFormat, gpuTextureDimension, gpuViewDimension, layersForDimension,
    gpuBufferUsage, gpuTextureUsage, gpuAddressMode, gpuFilterMode, gpuCompare,
    gpuBlendFactor, gpuBlendOperation, gpuCullMode, gpuFrontFace, gpuTopology, gpuIndexFormat,
    gpuVertexFormat, gpuStepMode, gpuLoadOp, gpuStoreOp, gpuColorWriteMask,
} from './webgpuEnums';
import type { BindGroupEntry,
    Device, DeviceCapabilities, BackendKind, BufferDescriptor, TextureDescriptor,
    ShaderModuleDescriptor, RenderPipelineDescriptor, RenderTargetDescriptor,
    BindGroupDescriptor, CommandEncoder, RenderPassEncoder,
    ComputePipelineDescriptor, ComputePassEncoder,
} from '../device';
import type {
    Buffer, Texture, TextureView, Sampler, ShaderModule, BindGroup, BindGroupLayout,
    RenderPipeline, RenderTarget, ComputePipeline,
} from '../resources';
import type { ShaderProgram, ShaderProgramDescriptor } from '../shaderProgram';
import type { UniformBlockLayout } from '../uniformSet';
import { WebGPUShaderProgram } from './webgpuShaderProgram';
import type { PrimitiveTopology,
    TextureFormat, TextureDimension, TextureUsageFlags, BufferUsageFlags, SamplerDescriptor,
    VertexBufferLayout, PrimitiveState, DepthStencilState, ColorTargetState, RenderPassDescriptor,
    ShaderStageFlags, IndexFormat, BlendState, ShaderResource, TextureConfigureDescriptor,
} from '../types';
import { TEXTURE_FORMAT_INFO, textureByteSize, isDepthFormat, ShaderStage, TextureUsage,
         isTriangleTopology } from '../types';

const SCOPE = 'WebGPU';

/**
 * `copyTextureToBuffer` requires each row to start on a 256-byte boundary.
 *
 * Not a performance hint — a validation rule. A readback of a 100x100 RGBA8 texture needs a 512-byte
 * row stride carrying 400 bytes of pixels, and the padding has to be stripped afterwards. This is the
 * single biggest shape difference between `readPixels` here and on WebGL2, and the reason the RHI made
 * readback asynchronous for both backends rather than only for this one.
 */
const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

function alignUp(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

// ------------------------------------------------------------------------------------------------
// Resources
// ------------------------------------------------------------------------------------------------

class WebGPUBuffer implements Buffer {
    public readonly label: string;
    public readonly size: number;
    public readonly usage: BufferUsageFlags;
    public readonly handle: GPUBuffer;
    private _destroyed = false;

    constructor(device: GPUDevice, descriptor: BufferDescriptor, private readonly _onDestroy: () => void) {
        this.label = descriptor.label ?? 'buffer';
        // WebGPU rejects a zero-sized buffer and requires a multiple of 4 for most usages. Rounding up
        // is invisible to callers, who only ever address the range they asked for.
        this.size = Math.max(4, alignUp(descriptor.size, 4));
        this.usage = descriptor.usage;
        this.handle = device.createBuffer({
            label: this.label,
            size: this.size,
            usage: gpuBufferUsage(descriptor.usage),
        });
    }

    public destroy(): void {
        if (this._destroyed) return;
        this._destroyed = true;
        this.handle.destroy();
        this._onDestroy();
    }
}


/**
 * Mip-chain generation, which WebGPU does not have.
 *
 * WebGL2 has `generateMipmap` — one call, the driver fills the chain. WebGPU has nothing: a chain is
 * built by RENDERING each level from the one above, so it needs a shader, a sampler, a pipeline per
 * texture format, and one render pass per level. That is why this is an object and not a method.
 *
 * The same loop covers 2D and CUBE. A cube face is an array layer, so "for each layer, for each level,
 * blit from the level above" is the whole algorithm — the only difference is how many layers there are.
 * The plan for this work intended to implement 2D and defer cube, but the first thing that actually
 * needed a chain was the sky-atmosphere bake, which is a cube; splitting the loop to defer half of it
 * would have been more code than doing both.
 *
 * A pipeline is cached per format because a render pipeline names its colour target's format and the
 * engine mips `rgba8unorm` content textures and `rgba16float` capture cubes alike.
 */
class WebGPUMipGenerator {
    private readonly _pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
    private _module: GPUShaderModule | null = null;
    private _sampler: GPUSampler | null = null;

    constructor(private readonly _device: GPUDevice) {}

    /**
     * A fullscreen triangle, not a quad.
     *
     * Three vertices covering the viewport with no vertex buffer at all: the positions come from the
     * vertex index, so there is nothing to allocate and nothing to bind. The UV falls out of the same
     * arithmetic. A quad would need a buffer, a layout, and a reason.
     */
    private _shader(): GPUShaderModule {
        if (this._module) return this._module;
        this._module = this._device.createShaderModule({
            label: 'mip-blit',
            code: `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
    var out: VertexOutput;
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    out.uv = uv;
    out.position = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

@group(0) @binding(0) var u_source: texture_2d<f32>;
@group(0) @binding(1) var u_sampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(u_source, u_sampler, in.uv);
}
`,
        });
        return this._module;
    }

    private _linearSampler(): GPUSampler {
        if (!this._sampler)
            this._sampler = this._device.createSampler({
                label: 'mip-blit', magFilter: 'linear', minFilter: 'linear',
            });
        return this._sampler;
    }

    private _pipelineFor(format: GPUTextureFormat): GPURenderPipeline {
        let pipeline = this._pipelines.get(format);
        if (!pipeline) {
            const module = this._shader();
            pipeline = this._device.createRenderPipeline({
                label: `mip-blit:${format}`,
                layout: 'auto',
                vertex: { module, entryPoint: 'vs_main' },
                fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
                primitive: { topology: 'triangle-list' },
            });
            this._pipelines.set(format, pipeline);
        }
        return pipeline;
    }

    /**
     * Fill levels 1..N-1 of `texture` from level 0, one pass per level per layer.
     *
     * Requires RENDER_ATTACHMENT as well as TEXTURE_BINDING, because every level above the first is a
     * target before it is a source. The engine's colour textures carry both; a texture that does not
     * is refused by name rather than producing an empty chain nobody notices until it is sampled at
     * distance.
     */
    public generate(texture: WebGPUTexture): void {
        if (texture.mipLevelCount <= 1) return;
        if ((texture.usage & TextureUsage.RENDER_ATTACHMENT) === 0)
            throw new Error(`${texture.label}: cannot generate mips without RENDER_ATTACHMENT usage — ` +
                            `every level above the first is rendered into before it is sampled`);

        const format = gpuTextureFormat(texture.format);
        const pipeline = this._pipelineFor(format);
        const sampler = this._linearSampler();
        // Cube faces are array layers; a 2D texture is the same loop with one of them.
        const layers = texture.dimension === 'cube' ? 6 : texture.depthOrArrayLayers;
        const encoder = this._device.createCommandEncoder({ label: 'mip-blit' });

        for (let layer = 0; layer < layers; layer++) {
            for (let level = 1; level < texture.mipLevelCount; level++) {
                // `dimension: '2d'` on both sides even for a cube: the shader samples one face, and a
                // `texture_cube` binding would need a direction rather than a UV.
                const source = texture.handle.createView({
                    label: `${texture.label}[mip${level - 1},layer${layer}]`,
                    dimension: '2d', baseMipLevel: level - 1, mipLevelCount: 1,
                    baseArrayLayer: layer, arrayLayerCount: 1,
                });
                const destination = texture.handle.createView({
                    label: `${texture.label}[mip${level},layer${layer}]`,
                    dimension: '2d', baseMipLevel: level, mipLevelCount: 1,
                    baseArrayLayer: layer, arrayLayerCount: 1,
                });
                const pass = encoder.beginRenderPass({
                    label: `mip-blit[${level}]`,
                    colorAttachments: [{ view: destination, loadOp: 'clear', storeOp: 'store',
                                         clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
                });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, this._device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [{ binding: 0, resource: source }, { binding: 1, resource: sampler }],
                }));
                pass.draw(3);
                pass.end();
            }
        }
        this._device.queue.submit([encoder.finish()]);
    }
}

class WebGPUTexture implements Texture {
    public readonly label: string;
    public readonly format: TextureFormat;
    public readonly dimension: TextureDimension;
    // Mutable, unlike their WebGL2 counterparts, because `setSize` REPLACES the GPUTexture - see there.
    public width: number;
    public height: number;
    public depthOrArrayLayers: number;
    public mipLevelCount: number;
    /** See the interface. Bumped by `setSize` at the point it destroys and recreates the handle. */
    public generation = 0;
    public readonly usage: TextureUsageFlags;
    public handle: GPUTexture;
    /** False for the swap-chain texture, which the surface owns and recycles. */
    private readonly _owned: boolean;
    private _destroyed = false;

    /** The descriptor this was built from, so `setSize` can rebuild from it with new dimensions. */
    private readonly _descriptor: TextureDescriptor;

    constructor(descriptor: TextureDescriptor, handle: GPUTexture, owned: boolean,
                private readonly _queue: GPUQueue,
                private readonly _onDestroy: () => void,
                private readonly _recreate: ((d: TextureDescriptor) => GPUTexture) | null = null,
                private readonly _mips: WebGPUMipGenerator | null = null) {
        this._descriptor = descriptor;
        this.label = descriptor.label ?? 'texture';
        this.format = descriptor.format;
        this.dimension = descriptor.dimension ?? '2d';
        this.width = descriptor.width;
        this.height = descriptor.height;
        this.depthOrArrayLayers = layersForDimension(this.dimension, descriptor.depthOrArrayLayers);
        this.mipLevelCount = Math.max(1, descriptor.mipLevelCount ?? 1);
        this.usage = descriptor.usage;
        this.handle = handle;
        this._owned = owned;
    }

    // --- uploads -----------------------------------------------------------------------------
    //
    // The half of the Texture interface that WebGL2 satisfies by allocating storage through the
    // upload calls themselves. WebGPU cannot: a GPUTexture fixes its size, format and mip count at
    // creation, so an "allocate" here has nothing left to allocate.
    //
    // That is a real difference in the ownership model, not a missing call, and it is the last thing
    // standing between `graphics/texture.ts` and this backend. Where an operation maps, it is
    // implemented; where it needs the storage created later, it throws saying exactly that rather
    // than silently doing nothing to a texture the caller believes it just filled.

    private _config: TextureConfigureDescriptor | null = null;

    /** Remembered for the sampler this texture will be paired with; nothing to apply to the texture. */
    public configure(descriptor: TextureConfigureDescriptor): void { this._config = descriptor; }

    /** The state {@link configure} recorded, for the sampler the bind group pairs with this texture. */
    public get samplingConfig(): TextureConfigureDescriptor | null { return this._config; }

    public upload2D(image: TexImageSource | null, width: number, height: number, mipMap: boolean): void {
        // A null image means "allocate, do not fill", which `setSize` has already done by the time this
        // runs - `graphics/texture.ts` syncs the dimensions into the device BEFORE uploading, precisely
        // so this backend has storage to write into.
        if (!image) return this._requireSize(width, height, 'upload2D(null)');
        this._copyExternal(image, width, height, 0, 0);
        if (mipMap && this.mipLevelCount > 1) this.generateMipmaps();
    }

    public uploadCube(images: readonly TexImageSource[] | null, width: number, height: number,
                      mipMap: boolean): void {
        if (!images) return this._requireSize(width, height, 'uploadCube(null)');
        for (let face = 0; face < 6; face++) this._copyExternal(images[face], width, height, 0, face);
        if (mipMap && this.mipLevelCount > 1) this.generateMipmaps();
    }

    public uploadFace(face: number, image: TexImageSource, mipMap: boolean): void {
        this._copyExternal(image, this.width, this.height, 0, face);
        if (mipMap && this.mipLevelCount > 1) this.generateMipmaps();
    }

    public uploadBytes(data: Uint8Array, width: number, height: number): void {
        this.uploadRegion(0, 0, width, height, data);
    }

    public uploadRegion(x: number, y: number, width: number, height: number, data: Uint8Array): void {
        this._queue.writeTexture(
            { texture: this.handle, mipLevel: 0, origin: { x, y, z: 0 } },
            data as ArrayBufferView<ArrayBuffer>,
            { offset: 0, bytesPerRow: width * 4, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 });
    }

    public allocateCube(size: number): void { this._requireSize(size, size, 'allocateCube'); }
    public allocateVolume(width: number, height: number): void {
        this._requireSize(width, height, 'allocateVolume');
    }
    public allocateDepthArray(size: number): void { this._requireSize(size, size, 'allocateDepthArray'); }

    /**
     * Assert that `setSize` already allocated what this call is about to assume, rather than no-opping.
     *
     * These calls are satisfied before they run, so the honest body is empty - but an empty body is also
     * what a caller that FORGOT to sync would see, and the symptom of that is a texture full of nothing
     * surfacing several passes later. Checking costs two comparisons and turns it into a message naming
     * the call that was unsatisfied.
     */
    private _requireSize(width: number, height: number, operation: string): void {
        if (this.width === width && this.height === height) return;
        throw new Error(`${this.label}: ${operation} expects storage at ${width}x${height}, but this ` +
                        `texture is ${this.width}x${this.height} - call setSize before uploading`);
    }

    /**
     * A comparison sampler is a SAMPLER on this backend, not texture state.
     *
     * Recorded rather than applied, for the bind group to pair with. WebGL2 sets
     * `TEXTURE_COMPARE_MODE` on the texture object, which is the difference the RHI already documents
     * at `WebGL2Sampler`.
     */
    public setCompareMode(enabled: boolean): void {
        this._compare = enabled;
    }
    private _compare = false;
    public get compareEnabled(): boolean { return this._compare; }

    /**
     * Build this texture's mip chain by rendering each level from the one above.
     *
     * WebGL2's `generateMipmap` is one call into the driver; WebGPU has no equivalent, so the work is a
     * pass per level per layer. See {@link WebGPUMipGenerator}, which owns the pipeline because it is
     * cached per format and shared by every texture.
     */
    public generateMipmaps(): void {
        if (!this._mips)
            throw new Error(`${this.label}: no mip generator — this texture was not created by the device`);
        this._mips.generate(this);
    }

    /**
     * Give this texture storage at these dimensions, REPLACING the `GPUTexture` when they change.
     *
     * A `GPUTexture` fixes its size at creation and cannot be resized, so this is the WebGPU analogue of
     * `reallocateBuffer`: same wrapper, new handle. It exists because the engine's `graphics/texture.ts`
     * creates every texture at 0x0 and learns its dimensions later - from an upload, a `createVolume`, a
     * `Framebuffer.resize`. On WebGL2 that is free (`texImage2D` re-specifies storage in place and
     * `setSize` only records the numbers); here it is an allocation, and this is where it happens.
     *
     * The wrapper survives, so anything holding a `Texture` keeps working. A `TextureView` does NOT -
     * it wraps the old `GPUTexture` - which is why the engine asks for its render targets through
     * `Framebuffer.renderTarget` on every pass rather than caching one, and why the device evicts
     * targets whose attachments are destroyed.
     */
    public setSize(width: number, height: number, depthOrArrayLayers: number = 1,
                   mipLevelCount: number = 1): void {
        const layers = layersForDimension(this.dimension, depthOrArrayLayers);
        if (width === this.width && height === this.height
            && layers === this.depthOrArrayLayers && mipLevelCount === this.mipLevelCount) return;
        if (!this._owned || !this._recreate)
            throw new Error(`${this.label}: cannot be resized (${this.width}x${this.height} -> ` +
                            `${width}x${height}) - it is not owned by this device`);
        // Zero is how the engine spells "not sized yet"; allocating it is a validation error, and the
        // caller is about to come back with real numbers.
        if (width <= 0 || height <= 0) return;

        this.handle.destroy();
        // Before the new handle exists, so anything reading it mid-flight compares unequal rather than
        // equal-to-something-destroyed.
        this.generation++;
        this.width = width;
        this.height = height;
        this.depthOrArrayLayers = layers;
        this.mipLevelCount = mipLevelCount;
        this.handle = this._recreate({
            ...this._descriptor,
            width, height, depthOrArrayLayers: layers, mipLevelCount,
        });
    }

    private _copyExternal(source: TexImageSource, width: number, height: number,
                          mipLevel: number, layer: number): void {
        this._queue.copyExternalImageToTexture(
            { source: source as GPUCopyExternalImageSource, flipY: !(this._config?.flipY ?? true) },
            { texture: this.handle, mipLevel, origin: { x: 0, y: 0, z: layer } },
            { width, height, depthOrArrayLayers: 1 });
    }

    /**
     * The one shape that does not port, named at the point it is reached.
     *
     * Every one of these allocates storage on WebGL2 — `texImage2D` with null data, `texStorage3D`,
     * an immutable array. A GPUTexture already has its storage and cannot grow one. Closing this means
     * `graphics/texture.ts` creating its GPU texture once it knows its dimensions instead of
     * discovering them through the upload, which is a change to the class, not to this method.
     */
    private _needsCreationTimeSize(operation: string): never {
        throw new Error(`${this.label}: ${operation} allocates storage, and a GPUTexture fixes its ` +
                        'size at creation. The texture has to be created at its final dimensions.');
    }

    public get byteSize(): number {
        return textureByteSize(this.format, this.width, this.height,
                               this.depthOrArrayLayers, this.mipLevelCount);
    }

    public destroy(): void {
        if (this._destroyed) return;
        this._destroyed = true;
        if (this._owned) this.handle.destroy();
        this._onDestroy();
    }
}

class WebGPUTextureView implements TextureView {
    public readonly label: string;
    public readonly handle: GPUTextureView;

    constructor(public readonly texture: WebGPUTexture,
                public readonly baseMipLevel: number,
                public readonly baseArrayLayer: number,
                handle: GPUTextureView, label: string) {
        this.handle = handle;
        this.label = label;
        // Recorded at construction: this view is only valid for the storage that existed now.
        this.generation = texture.generation;
    }
    public readonly generation: number;

    /** Views are not separately allocated; the texture owns the storage. */
    public destroy(): void { /* no-op */ }
}

class WebGPUSampler implements Sampler {
    public readonly label: string;
    public readonly handle: GPUSampler;

    constructor(device: GPUDevice, public readonly descriptor: Readonly<SamplerDescriptor>, label: string) {
        this.label = label;
        this.handle = device.createSampler({
            label,
            addressModeU: gpuAddressMode(descriptor.addressModeU ?? 'clamp-to-edge'),
            addressModeV: gpuAddressMode(descriptor.addressModeV ?? 'clamp-to-edge'),
            addressModeW: gpuAddressMode(descriptor.addressModeW ?? 'clamp-to-edge'),
            magFilter: gpuFilterMode(descriptor.magFilter ?? 'linear'),
            minFilter: gpuFilterMode(descriptor.minFilter ?? 'linear'),
            mipmapFilter: gpuFilterMode(descriptor.mipmapFilter ?? 'nearest'),
            ...(descriptor.compare ? { compare: gpuCompare(descriptor.compare) } : {}),
            maxAnisotropy: Math.max(1, Math.floor(descriptor.maxAnisotropy ?? 1)),
        });
    }

    public destroy(): void { /* samplers are immutable and cheap; the device outlives them */ }
}

class WebGPUShaderModule implements ShaderModule {
    public readonly label: string;
    public readonly stage: ShaderStageFlags;
    public readonly entryPoints: { readonly vertex?: string; readonly fragment?: string; readonly compute?: string };
    /** Build-time reflection of what this program binds. Empty when the caller supplied none. */
    public readonly resources: readonly ShaderResource[];   // from the module, see the constructor
    public readonly handle: GPUShaderModule;
    public compilationInfo: readonly string[] = [];
    /**
     * Group indices the module actually declares.
     *
     * Needed because a pipeline built with `layout: 'auto'` throws from `getBindGroupLayout(i)` for any
     * group the shader does not use, and there is no way to ask how many there are. Scanning the source
     * is exact: `@group(N)` is the only way to declare one in WGSL.
     */
    public readonly groups: readonly number[];

    constructor(device: GPUDevice, descriptor: ShaderModuleDescriptor) {
        this.label = descriptor.label ?? 'shader';
        this.stage = descriptor.stage;
        this.entryPoints = { ...(descriptor.entryPoints ?? {}) };
        this.resources = descriptor.resources ?? [];
        this.handle = device.createShaderModule({ label: this.label, code: descriptor.source });

        const seen = new Set<number>();
        for (const match of descriptor.source.matchAll(/@group\(\s*(\d+)\s*\)/g)) seen.add(Number(match[1]));
        this.groups = Array.from(seen).sort((a, b) => a - b);
    }

    /**
     * Pull the compiler log.
     *
     * Separate from the constructor because `getCompilationInfo()` is a promise and module creation is
     * not — WebGPU reports shader errors asynchronously, and a module that failed to compile still
     * hands back an object. Callers that care (the editor's custom-material panel) await this; the
     * device awaits it once at creation so a broken built-in shader is not silent.
     */
    public async fetchCompilationInfo(): Promise<readonly string[]> {
        const info = await this.handle.getCompilationInfo();
        this.compilationInfo = info.messages
            .filter(m => m.type === 'error' || m.type === 'warning')
            .map(m => `${m.type} ${this.label}:${m.lineNum}:${m.linePos}: ${m.message}`);
        return this.compilationInfo;
    }

    public destroy(): void { /* modules are released with the device */ }
}

class WebGPUBindGroupLayout implements BindGroupLayout {
    public readonly label: string;
    constructor(public readonly group: number, public readonly handle: GPUBindGroupLayout, label: string) {
        this.label = label;
    }
    public destroy(): void { /* owned by the pipeline that produced it */ }
}

class WebGPUBindGroup implements BindGroup {
    public readonly label: string;
    public readonly handle: GPUBindGroup;
    constructor(public readonly layout: WebGPUBindGroupLayout, handle: GPUBindGroup, label: string) {
        this.handle = handle;
        this.label = label;
    }
    public destroy(): void { /* released with the device */ }
}

class WebGPURenderPipeline implements RenderPipeline {
    public readonly label: string;
    public readonly vertexLayouts: readonly VertexBufferLayout[];
    public readonly primitive: Readonly<PrimitiveState>;
    public readonly depthStencil?: Readonly<DepthStencilState>;
    public readonly colorTargets: readonly ColorTargetState[];
    public readonly bindGroupLayouts: readonly WebGPUBindGroupLayout[];
    public readonly handle: GPURenderPipeline;
    /** See the interface. */
    public readonly resources: readonly ShaderResource[];
    /**
     * Group indices BELOW the highest one the shaders declare that they never declared themselves.
     *
     * WebGPU requires a bind group at every index up to the pipeline's highest, and an `'auto'`
     * layout duly produces an empty one for each gap. The engine's shaders are full of gaps —
     * `outline` uses groups 1 and 2, `overdraw` uses 0 and 1, the lit families reach group 5 —
     * because the numbering is by ROLE (0 textures, 1 transform, 2 material, 3 shadows, ...) and no
     * program plays every role. Leaving the gaps to the caller would mean every draw site knowing
     * which roles its shader happens to skip, so the pass fills them instead.
     */
    public readonly emptyGroups: readonly number[];

    constructor(descriptor: RenderPipelineDescriptor, handle: GPURenderPipeline,
                groups: readonly number[]) {
        this.resources = (descriptor.vertex as WebGPUShaderModule).resources;
        this.label = descriptor.label ?? 'pipeline';
        this.vertexLayouts = descriptor.vertexLayouts;
        this.primitive = descriptor.primitive;
        this.depthStencil = descriptor.depthStencil;
        this.colorTargets = descriptor.colorTargets;
        this.handle = handle;
        this.bindGroupLayouts = groups.map(
            g => new WebGPUBindGroupLayout(g, handle.getBindGroupLayout(g), `${this.label}:group${g}`));
        const highest = groups.length ? Math.max(...groups) : -1;
        const gaps: number[] = [];
        for (let g = 0; g < highest; g++) if (!groups.includes(g)) gaps.push(g);
        this.emptyGroups = gaps;
    }

    /** The layout for a group index, or undefined when the shaders never declared it. */
    public layoutForGroup(group: number): WebGPUBindGroupLayout | undefined {
        return this.bindGroupLayouts.find(l => l.group === group);
    }

    /**
     * Bind groups over `program`'s uniform blocks, one per group this pipeline actually declares.
     *
     * Cached per program, because both halves are stable: a `ProgramUniforms` allocates its buffers
     * once, and a pipeline's layouts never change. Without the cache this would allocate a bind group
     * per draw on a path that runs hundreds of times a frame.
     *
     * A block whose group this pipeline does not declare is skipped rather than bound - the engine
     * numbers groups by ROLE, and a program's `ProgramUniforms` describes the whole module while a
     * pipeline built from it may legitimately reference only some of them.
     */
    public uniformGroupsFor(program: WebGPUShaderProgram,
                            device: GPUDevice): readonly { group: number; handle: GPUBindGroup }[] {
        let groups = this._uniformGroups.get(program);
        if (!groups) {
            // Grouped by GROUP INDEX, not one bind group per block. A group can declare several
            // bindings - the lit families put more than one block in the same group - and WebGPU
            // rejects a bind group whose entry count does not match its layout exactly ("Number of
            // entries (1) did not match the expected number of entries (2)"), so every block sharing an
            // index has to arrive in the same bind group.
            const byGroup = new Map<number, { binding: number; buffer: WebGPUBuffer }[]>();
            for (const set of program.uniforms.blocks) {
                if (!this.layoutForGroup(set.layout.group)) continue;
                const entries = byGroup.get(set.layout.group) ?? [];
                entries.push({ binding: set.layout.binding, buffer: set.buffer as WebGPUBuffer });
                byGroup.set(set.layout.group, entries);
            }
            groups = [];
            for (const [group, entries] of byGroup) {
                groups.push({
                    group,
                    handle: device.createBindGroup({
                        label: `${this.label}:uniforms${group}`,
                        layout: this.layoutForGroup(group)!.handle,
                        entries: entries.map(e => ({
                            binding: e.binding, resource: { buffer: e.buffer.handle },
                        })),
                    }),
                });
            }
            this._uniformGroups.set(program, groups);
        }
        return groups;
    }
    private readonly _uniformGroups =
        new WeakMap<WebGPUShaderProgram, { group: number; handle: GPUBindGroup }[]>();

    public destroy(): void { /* released with the device */ }
}

/**
 * A compute pipeline: the module, and the bind-group layouts `layout: 'auto'` derived from it.
 *
 * No `emptyGroups` counterpart to {@link WebGPURenderPipeline}'s, and that is not an omission. The
 * gap-filling exists because the engine's RASTER shaders number their groups by role (0 textures,
 * 1 transform, 2 material, ...) and so leave holes below their highest index. The one compute module
 * uses group 0 and only group 0, so there is no hole to fill — and inventing the machinery for a case
 * that does not occur would be guessing at what a second compute shader might do.
 */
class WebGPUComputePipeline implements ComputePipeline {
    public readonly label: string;
    public readonly bindGroupLayouts: readonly WebGPUBindGroupLayout[];
    public readonly handle: GPUComputePipeline;

    constructor(descriptor: ComputePipelineDescriptor, handle: GPUComputePipeline,
                groups: readonly number[]) {
        this.label = descriptor.label ?? 'compute-pipeline';
        this.handle = handle;
        this.bindGroupLayouts = groups.map(
            g => new WebGPUBindGroupLayout(g, handle.getBindGroupLayout(g), `${this.label}:group${g}`));
    }

    public destroy(): void { /* released with the device */ }
}

class WebGPURenderTarget implements RenderTarget {
    public readonly label: string;
    constructor(public readonly colorViews: readonly WebGPUTextureView[],
                public readonly depthView: WebGPUTextureView | undefined,
                public readonly width: number,
                public readonly height: number,
                label: string) {
        this.label = label;
    }
    public destroy(): void { /* the views' textures own the storage */ }
}

// ------------------------------------------------------------------------------------------------
// Command recording
// ------------------------------------------------------------------------------------------------

class WebGPURenderPassEncoder implements RenderPassEncoder {
    private _ended = false;
    /** Remembered from `setPipeline`, for the triangle count in `_countDraw`. */
    private _topology: PrimitiveTopology = 'triangle-list';

    constructor(private readonly _pass: GPURenderPassEncoder,
                private readonly _device: GPUDevice) {}

    /**
     * Bind the pipeline, and an empty group at every index its shaders skipped.
     *
     * See {@link WebGPURenderPipeline.emptyGroups}: WebGPU rejects a draw with any index below the
     * pipeline's highest left unset, and the engine numbers groups by role rather than densely. The
     * empties are built here rather than by the caller because a draw site has no business knowing
     * which roles its shader happens not to play — and because the failure is a validation error at
     * DRAW time ("No bind group set at group index 0"), far from the pass that forgot.
     */
    public setPipeline(pipeline: RenderPipeline): void {
        const p = pipeline as WebGPURenderPipeline;
        this._topology = p.primitive.topology;
        this._pass.setPipeline(p.handle);
        for (const group of p.emptyGroups)
            this._pass.setBindGroup(group, this._device.createBindGroup({
                layout: p.handle.getBindGroupLayout(group), entries: [],
            }));

        // The bound program's UNIFORM blocks, as bind groups.
        //
        // WebGL2 has nothing to do here: `Shader` uploads its std140 blocks to global UNIFORM_BUFFER
        // binding points and the draw finds them. WebGPU has no globals - a uniform buffer reaches a
        // shader only through a bind group - so without this every uniform group is unset and the
        // driver drops the draw with "No bind group set at group index N". That was the whole reason a
        // frame with the correct draw count rendered nothing.
        //
        // Done HERE rather than at the ~330 `setUniform` call sites, which is the migration's standing
        // constraint: a draw site should not have to know which groups its shader declares. The encoder
        // already reaches `ShaderManager` for the WebGL2 flush; this is the same reach.
        const program = ShaderManager.Instance.bound;
        if (program instanceof WebGPUShaderProgram)
            for (const { group, handle } of p.uniformGroupsFor(program, this._device))
                this._pass.setBindGroup(group, handle);
        this._program = program;
    }
    /** Remembered from `setPipeline` so the draw can flush its writes. See `_flushUniforms`. */
    private _program: ShaderProgram | null = null;

    /**
     * Upload whatever the pass wrote since the last draw.
     *
     * Mirrors `WebGL2RenderPassEncoder._beginDraw`, which calls `ShaderManager.flushBound()` for the
     * same reason: uniforms are buffered on the CPU and uploaded once, immediately before the draw that
     * reads them.
     *
     * **A known limitation, stated rather than hidden.** `queue.writeBuffer` is ordered against the
     * SUBMIT, not against the commands already recorded in this encoder - so when one pass draws many
     * objects with different `u_model`, every draw in it ends up reading the LAST value written. Single
     * draw passes (every fullscreen pass, the cube-face bakes) are correct today; multi-object passes
     * are not, and the fix is per-draw storage - dynamic offsets into one buffer, which is what WebGPU
     * expects and what the engine has no notion of yet.
     */
    private _flushUniforms(): void {
        if (this._program) this._program.flushUniformBlocks();
    }

    public setBindGroup(group: number, bindGroup: BindGroup, dynamicOffsets?: readonly number[]): void {
        this._pass.setBindGroup(group, (bindGroup as WebGPUBindGroup).handle,
                                dynamicOffsets ? Array.from(dynamicOffsets) : undefined);
    }

    public setVertexBuffer(slot: number, buffer: Buffer, offset: number = 0): void {
        this._pass.setVertexBuffer(slot, (buffer as WebGPUBuffer).handle, offset);
    }

    public setIndexBuffer(buffer: Buffer, format: IndexFormat, offset: number = 0): void {
        this._pass.setIndexBuffer((buffer as WebGPUBuffer).handle, gpuIndexFormat(format), offset);
    }

    public setViewport(x: number, y: number, width: number, height: number): void {
        this._pass.setViewport(x, y, width, height, 0, 1);
    }

    public setScissor(x: number, y: number, width: number, height: number): void {
        this._pass.setScissorRect(x, y, width, height);
    }

    public draw(vertexCount: number, instanceCount: number = 1, firstVertex: number = 0): void {
        this._flushUniforms();
        this._pass.draw(vertexCount, instanceCount, firstVertex);
        this._countDraw(vertexCount, instanceCount);
    }

    public drawIndexed(indexCount: number, instanceCount: number = 1, firstIndex: number = 0,
                       baseVertex: number = 0): void {
        this._flushUniforms();
        this._pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex);
        this._countDraw(indexCount, instanceCount);
    }

    /**
     * The per-frame counters, which this backend was not keeping at all.
     *
     * Every number the performance HUD shows and every `rhiDrawCalls` baseline the mesh harness pins
     * came from `webgl2Commands.ts` alone, so on WebGPU they all read zero — and a zero draw count next
     * to a black frame says "nothing drew" when the truth was "nothing counted". That cost a wrong
     * diagnosis before it cost anything else, which is the only reason it is worth a comment: an
     * instrument that reads zero on a backend it was never wired to is worse than no instrument.
     *
     * Mirrors `WebGL2RenderPassEncoder._countDraw` exactly, including charging instanced draws by
     * instance count, so the two backends' numbers are comparable rather than merely both present.
     */
    private _countDraw(elements: number, instanceCount: number): void {
        frameStats.drawCalls++;
        frameStats.rhiDrawCalls++;
        if (instanceCount > 1) { frameStats.instancedDrawCalls++; frameStats.instances += instanceCount; }
        frameStats.vertices += elements * instanceCount;
        if (isTriangleTopology(this._topology))
            frameStats.triangles += (elements / 3) * instanceCount;
    }

    public end(): void {
        if (this._ended) return;
        this._ended = true;
        this._pass.end();
    }
}

/**
 * Records dispatches inside one compute pass.
 *
 * Thin to the point of being uninteresting, which is the point: everything that makes the render-pass
 * encoder above non-trivial — empty bind groups for skipped role indices, viewport and scissor state,
 * two draw forms — has no compute analogue here.
 */
class WebGPUComputePassEncoder implements ComputePassEncoder {
    private _ended = false;

    constructor(private readonly _pass: GPUComputePassEncoder) {}

    public setPipeline(pipeline: ComputePipeline): void {
        this._pass.setPipeline((pipeline as WebGPUComputePipeline).handle);
    }

    public setBindGroup(group: number, bindGroup: BindGroup): void {
        this._pass.setBindGroup(group, (bindGroup as WebGPUBindGroup).handle);
    }

    public dispatchWorkgroups(x: number, y: number = 1, z: number = 1): void {
        this._pass.dispatchWorkgroups(x, y, z);
    }

    public end(): void {
        if (this._ended) return;
        this._ended = true;
        this._pass.end();
    }
}

/** `0n` is a syntax error at this project's `target: es6`; the call form is not. */
const BIGINT_ZERO = BigInt(0);
/** How many timestamps the query set holds: two per pass, so 64 passes in one submission. */
const TIMESTAMP_QUERY_CAPACITY = 128;
/** One `u64` per timestamp. */
const TIMESTAMP_BYTES = 8;
/**
 * Staging buffers in flight at once.
 *
 * Sized for the shape the renderer actually has TODAY: `_beginFullscreenPass` opens one command
 * encoder per pass, so a frame is ~35 separate submissions and each one that carries a timed pass
 * wants a staging buffer. Eight is a little over a fifth of that on purpose — a `mapAsync` resolves
 * within a frame or two, so the ring recycles far faster than it fills, and running out simply drops
 * that submission's timings rather than growing the pool without bound. Dropping is the correct
 * failure: a timing that had to wait for memory is not a timing of the GPU any more.
 */
const TIMESTAMP_STAGING_RING = 8;

interface TimestampStaging {
    buffer: GPUBuffer;
    /** Pass labels in query order, so index 2i/2i+1 is `labels[i]`'s begin/end. */
    labels: string[];
    state: 'free' | 'submitted' | 'mapping' | 'ready';
}

/**
 * The device's timestamp-query machinery: a `GPUQuerySet`, the `QUERY_RESOLVE` buffer it resolves
 * into, and a small `MAP_READ` staging ring the results are copied to for reading.
 *
 * Entirely internal to this file. Above the RHI the only two spellings are
 * `Device.setTimestampCollection` and `Device.collectTimestamps`, because a query set is not something
 * the renderer or the profiler should be able to name.
 *
 * TIMEBASE. WebGPU timestamps are nanoseconds since an unspecified epoch, and only differences are
 * meaningful — so a pass's cost is `end - begin` on the same query set, which is exactly what
 * `timestampWrites` gives. Browsers quantise the values (Chrome to ~100µs unless the origin trial for
 * finer resolution is on), so a pass under that is reported as 0 rather than as noise; that is a real
 * limit of the measurement and not something to smooth over here.
 *
 * QUERY INDEX REUSE is safe even though every submission restarts at 0. Queue submissions execute in
 * order, and each encoder's `resolveQuerySet` is recorded immediately after its own passes, so the
 * next submission's writes cannot overtake the previous one's resolve.
 */
class TimestampCollector {
    private _querySet: GPUQuerySet | null = null;
    private _resolve: GPUBuffer | null = null;
    private _ring: TimestampStaging[] = [];
    private _sink: ((label: string, ms: number) => void) | null = null;
    private _enabled = false;

    constructor(private readonly _device: GPUDevice, private readonly _supported: boolean) {}

    /** True when a pass should be given `timestampWrites`. */
    public get active(): boolean { return this._enabled; }
    public get querySet(): GPUQuerySet | null { return this._querySet; }

    public setEnabled(enabled: boolean, sink: (label: string, ms: number) => void): void {
        this._sink = sink;
        const on = enabled && this._supported;
        if (on === this._enabled) return;
        this._enabled = on;
        if (on) this._allocate();
        // Resources are NOT released on disable. Re-enabling is a checkbox in the profiler panel, and
        // a staging buffer that is still `mapping` when its owner is destroyed rejects its own
        // `mapAsync` — the drain below has to be able to finish for anything already submitted.
    }

    private _allocate(): void {
        if (this._querySet) return;
        this._querySet = this._device.createQuerySet({
            label: 'timestamps', type: 'timestamp', count: TIMESTAMP_QUERY_CAPACITY,
        });
        this._resolve = this._device.createBuffer({
            label: 'timestamp-resolve',
            size: TIMESTAMP_QUERY_CAPACITY * TIMESTAMP_BYTES,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
        for (let i = 0; i < TIMESTAMP_STAGING_RING; i++) {
            this._ring.push({
                buffer: this._device.createBuffer({
                    label: `timestamp-staging-${i}`,
                    size: TIMESTAMP_QUERY_CAPACITY * TIMESTAMP_BYTES,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                }),
                labels: [],
                state: 'free',
            });
        }
    }

    /**
     * Record the resolve + copy for one finished encoder, if a staging buffer is free.
     *
     * Must run BEFORE the encoder is submitted — `resolveQuerySet` is a command, not a queue
     * operation, and it has to sit in the same command buffer as the passes it is resolving.
     */
    public recordResolve(encoder: GPUCommandEncoder, labels: string[]): void {
        if (!this._enabled || !this._querySet || !this._resolve || labels.length === 0) return;
        const staging = this._ring.find(entry => entry.state === 'free');
        if (!staging) return;   // ring saturated: drop this submission's timings, never stall for one

        const count = labels.length * 2;
        encoder.resolveQuerySet(this._querySet, 0, count, this._resolve, 0);
        encoder.copyBufferToBuffer(this._resolve, 0, staging.buffer, 0, count * TIMESTAMP_BYTES);
        staging.labels = labels;
        staging.state = 'submitted';
    }

    /**
     * Deliver what is ready and start mapping what is newly submitted. Never waits — see
     * `Device.collectTimestamps`.
     */
    public collect(): void {
        if (!this._querySet) return;
        for (const entry of this._ring) {
            if (entry.state === 'ready') {
                this._drain(entry);
            } else if (entry.state === 'submitted') {
                entry.state = 'mapping';
                // `mapAsync` resolves only once the submission that wrote the buffer has completed, so
                // this IS the "has it finished" test — asked without blocking on the answer. The
                // rejection path matters: a device loss or a destroy rejects every outstanding map, and
                // an unhandled rejection here would surface as a page-level error from a profiler that
                // is meant to be invisible when off.
                entry.buffer.mapAsync(GPUMapMode.READ).then(
                    () => { entry.state = 'ready'; },
                    () => { entry.labels = []; entry.state = 'free'; },
                );
            }
        }
    }

    private _drain(entry: TimestampStaging): void {
        const times = new BigUint64Array(entry.buffer.getMappedRange());
        if (this._sink) {
            for (let i = 0; i < entry.labels.length; i++) {
                const begin = times[i * 2], end = times[i * 2 + 1];
                // Drop only what is not a measurement: an untouched pair of slots (both exactly zero
                // — the driver is allowed to leave them alone) and an end before its begin.
                //
                // A pass whose end EQUALS its begin is reported, as 0.000ms, and that is not a bug to
                // filter out. MEASURED on this driver: an empty clear pass reads back a zero delta
                // every time, because browsers quantise timestamps — Chrome to ~100µs unless the
                // fine-resolution origin trial is on — so anything under the quantum lands on the same
                // tick at both ends. Dropping those made a cheap pass VANISH from the profiler rather
                // than show up as "below the measurement floor", which is the more misleading of the
                // two readings and is what the first version of this line did.
                if (end < begin || (end === BIGINT_ZERO && begin === BIGINT_ZERO)) continue;
                this._sink(entry.labels[i], Number(end - begin) / 1e6);
            }
        }
        entry.buffer.unmap();
        entry.labels = [];
        entry.state = 'free';
    }

    public destroy(): void {
        this._enabled = false;
        this._sink = null;
        this._querySet?.destroy();
        this._querySet = null;
        this._resolve?.destroy();
        this._resolve = null;
        for (const entry of this._ring) entry.buffer.destroy();
        this._ring.length = 0;
    }
}

class WebGPUCommandEncoder implements CommandEncoder {
    private readonly _encoder: GPUCommandEncoder;
    private _finished = false;
    /** Labels of the passes in this encoder that were given `timestampWrites`, in query order. */
    private readonly _timedPasses: string[] = [];

    constructor(private readonly _device: GPUDevice,
                private readonly _timestamps: TimestampCollector | null, label?: string) {
        this._encoder = _device.createCommandEncoder({ label: label ?? 'commands' });
    }

    /** The raw encoder, for device-internal work (readback copies) that rides on the same submission. */
    public get raw(): GPUCommandEncoder { return this._encoder; }

    public beginRenderPass(target: RenderTarget, descriptor: RenderPassDescriptor): RenderPassEncoder {
        const rt = target as WebGPURenderTarget;

        // An attachment the descriptor does not mention still has to be listed, or WebGPU treats the
        // target as having fewer attachments than the pipeline writes and rejects the draw. Unmentioned
        // attachments load and store, which is WebGL2's implicit behaviour.
        const colorAttachments: GPURenderPassColorAttachment[] = rt.colorViews.map((view, index) => {
            const declared = descriptor.colorAttachments.find(a => a.target === index);
            const loadOp = declared ? gpuLoadOp(declared.loadOp) : 'load';
            return {
                view: view.handle,
                loadOp,
                storeOp: declared ? gpuStoreOp(declared.storeOp) : 'store',
                ...(loadOp === 'clear'
                    ? { clearValue: toGpuColor(declared?.clearValue) }
                    : {}),
            };
        });

        let depthStencilAttachment: GPURenderPassDepthStencilAttachment | undefined;
        if (rt.depthView) {
            const declared = descriptor.depthAttachment;
            const loadOp = declared ? gpuLoadOp(declared.loadOp) : 'load';
            // Narrowed to the requested LAYER when one is named, not the whole array. The shadow
            // cascades and the spot atlas are ONE texture rendered a layer at a time, so without this
            // every cascade would target the same view and the last one written would win.
            // `WebGL2Device.beginRenderPass` already honours it, by re-pointing the framebuffer's depth
            // attachment; this is the same instruction spelled the way WebGPU spells it.
            //
            // Created on demand rather than cached: a cascade pass runs a handful of times a frame, and
            // caching would need the generation-keyed eviction `graphics/texture.ts` carries for
            // exactly this reason.
            const layer = declared?.baseArrayLayer;
            const view = layer === undefined ? rt.depthView.handle
                : rt.depthView.texture.handle.createView({
                    label: `${rt.depthView.label}[layer${layer}]`,
                    dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1,
                    baseMipLevel: rt.depthView.baseMipLevel, mipLevelCount: 1,
                });
            depthStencilAttachment = {
                view,
                depthLoadOp: loadOp,
                depthStoreOp: declared ? gpuStoreOp(declared.storeOp) : 'store',
                ...(loadOp === 'clear' ? { depthClearValue: declared?.clearValue ?? 1.0 } : {}),
            };
        }

        setViewportSize(rt.width, rt.height);

        // GPU timing, when the profiler has it switched on. A timestamp can only be attached to a
        // pass — there is no WebGPU spelling for "time this span of the frame" — so the pass LABEL is
        // the only name a cost can be reported under, and gpuProfiler.ts maps it back onto a scope
        // name where that is honest. The pair is claimed here and resolved in `finish()`; a pass past
        // the query set's capacity is simply untimed rather than an error.
        const timestamps = this._timestamps;
        const queryIndex = this._timedPasses.length * 2;
        const timed = timestamps?.active && timestamps.querySet !== null
                      && queryIndex + 1 < TIMESTAMP_QUERY_CAPACITY;
        if (timed) this._timedPasses.push(descriptor.label);

        return new WebGPURenderPassEncoder(this._encoder.beginRenderPass({
            label: descriptor.label,
            colorAttachments,
            ...(depthStencilAttachment ? { depthStencilAttachment } : {}),
            ...(timed ? {
                timestampWrites: {
                    querySet: timestamps!.querySet!,
                    beginningOfPassWriteIndex: queryIndex,
                    endOfPassWriteIndex: queryIndex + 1,
                },
            } : {}),
        }), this._device);
    }

    public copyTextureToTexture(source: TextureView, destination: TextureView,
                                width: number, height: number): void {
        const src = source as WebGPUTextureView;
        const dst = destination as WebGPUTextureView;
        this._encoder.copyTextureToTexture(
            { texture: src.texture.handle, mipLevel: src.baseMipLevel, origin: { x: 0, y: 0, z: src.baseArrayLayer } },
            { texture: dst.texture.handle, mipLevel: dst.baseMipLevel, origin: { x: 0, y: 0, z: dst.baseArrayLayer } },
            { width, height, depthOrArrayLayers: 1 },
        );
    }

    /**
     * Open a compute pass.
     *
     * Placed between the copy and the finish deliberately: a dispatch is recorded work like any other,
     * so it shares this encoder's submission and orders against the passes around it. No
     * `timestampWrites` — WebGPU would accept them on a compute pass, but the profiler above the RHI
     * reports render passes, and the one compute workload the engine has runs once at startup.
     */
    public beginComputePass(label?: string): ComputePassEncoder {
        return new WebGPUComputePassEncoder(
            this._encoder.beginComputePass({ label: label ?? 'compute' }));
    }

    public finish(): void {
        if (this._finished) return;
        this._finished = true;
        // Before the submit, and in this encoder: `resolveQuerySet` is a recorded command, so it has
        // to share a command buffer with the passes whose timestamps it is resolving.
        this._timestamps?.recordResolve(this._encoder, this._timedPasses);
        this._device.queue.submit([this._encoder.finish()]);
    }
}

function toGpuColor(value: readonly number[] | undefined): GPUColorDict {
    return { r: value?.[0] ?? 0, g: value?.[1] ?? 0, b: value?.[2] ?? 0, a: value?.[3] ?? 1 };
}

function toGpuBlend(blend: BlendState): GPUBlendState {
    return {
        color: {
            srcFactor: gpuBlendFactor(blend.color.srcFactor),
            dstFactor: gpuBlendFactor(blend.color.dstFactor),
            operation: gpuBlendOperation(blend.color.operation),
        },
        alpha: {
            srcFactor: gpuBlendFactor(blend.alpha.srcFactor),
            dstFactor: gpuBlendFactor(blend.alpha.dstFactor),
            operation: gpuBlendOperation(blend.alpha.operation),
        },
    };
}

// ------------------------------------------------------------------------------------------------
// The device
// ------------------------------------------------------------------------------------------------

export class WebGPUDevice implements Device {
    public readonly backend: BackendKind = 'webgpu';
    public readonly capabilities: DeviceCapabilities;

    private readonly _buffers = new Set<WebGPUBuffer>();
    /** Shared mip-chain blitter, built on first use. One per device: its pipelines cache by format. */
    private _mipGenerator: WebGPUMipGenerator | null = null;
    private readonly _textures = new Set<WebGPUTexture>();
    private _surfaceFormat: TextureFormat;
    private _destroyed = false;
    private readonly _timestamps: TimestampCollector;

    constructor(
        private readonly _device: GPUDevice,
        private readonly _context: GPUCanvasContext | null,
        private readonly _canvas: HTMLCanvasElement | OffscreenCanvas | null,
        capabilities: DeviceCapabilities,
        surfaceFormat: TextureFormat,
    ) {
        this.capabilities = capabilities;
        this._surfaceFormat = surfaceFormat;
        this._timestamps = new TimestampCollector(_device, capabilities.hasTimestampQuery);

        // Nothing in WebGPU throws at the call site; validation errors arrive here. Without this the
        // first wrong descriptor produces a blank frame and no message at all.
        this._device.addEventListener('uncapturederror', (event) => {
            Logger.error(`uncaptured error: ${(event as GPUUncapturedErrorEvent).error.message}`, SCOPE);
        });
        void this._device.lost.then((info) => {
            if (this._destroyed) return;   // an intentional destroy() also resolves this promise
            Logger.error(`device lost (${info.reason}): ${info.message}`, SCOPE);
        });
    }

    /** The underlying device, for backend-internal callers. Never reachable from above the RHI. */
    public get raw(): GPUDevice { return this._device; }

    // -- resources -------------------------------------------------------------------------------

    public createBuffer(descriptor: BufferDescriptor): Buffer {
        const buffer = new WebGPUBuffer(this._device, descriptor, () => this._buffers.delete(buffer));
        this._buffers.add(buffer);
        return buffer;
    }

    /** The raw allocation, shared by `createTexture` and by `WebGPUTexture.setSize` re-creating one. */
    private _createGpuTexture(descriptor: TextureDescriptor): GPUTexture {
        const dimension = descriptor.dimension ?? '2d';
        // Clamped to 1, because `graphics/texture.ts` creates every texture at 0x0 and sizes it later.
        // WebGPU rejects a zero extent ASYNCHRONOUSLY, so it does not throw — it fires one uncaptured
        // validation error per texture, ~40 of them at boot, which buries whatever real error you are
        // actually looking for. A 1x1 placeholder is replaced by the first real `setSize`.
        const width = Math.max(1, descriptor.width);
        const height = Math.max(1, descriptor.height);
        return this._device.createTexture({
            label: descriptor.label ?? 'texture',
            format: gpuTextureFormat(descriptor.format),
            dimension: gpuTextureDimension(dimension),
            size: {
                width, height,
                depthOrArrayLayers: layersForDimension(dimension, descriptor.depthOrArrayLayers),
            },
            mipLevelCount: Math.max(1, descriptor.mipLevelCount ?? 1),
            usage: gpuTextureUsage(descriptor.usage),
        });
    }

    public createTexture(descriptor: TextureDescriptor): Texture {
        const handle = this._createGpuTexture(descriptor);
        this._mipGenerator ??= new WebGPUMipGenerator(this._device);
        const texture = new WebGPUTexture(descriptor, handle, true, this._device.queue,
                                          () => this._textures.delete(texture),
                                          d => this._createGpuTexture(d),
                                          this._mipGenerator);
        this._textures.add(texture);
        return texture;
    }

    public createTextureView(texture: Texture, baseMipLevel: number = 0,
                             baseArrayLayer: number = 0): TextureView {
        const tex = texture as WebGPUTexture;

        // A view onto ONE layer is `2d`, never `2d-array`/`cube`, even when the texture is an array or a
        // cube — that is how a shadow cascade or a cube face becomes a render attachment. A view that
        // spans the whole thing keeps the texture's own dimension so shaders can sample it as declared.
        const wholeTexture = tex.depthOrArrayLayers === 1;
        const dimension = wholeTexture ? gpuViewDimension(tex.dimension) : '2d';
        const arrayLayerCount = wholeTexture ? tex.depthOrArrayLayers : 1;

        return new WebGPUTextureView(tex, baseMipLevel, baseArrayLayer, tex.handle.createView({
            label: `${tex.label}[mip${baseMipLevel},layer${baseArrayLayer}]`,
            dimension,
            baseMipLevel,
            mipLevelCount: 1,
            baseArrayLayer,
            arrayLayerCount,
        }), `${tex.label}:view`);
    }

    /**
     * A view of the whole texture: every mip, every layer, the texture's own view dimension.
     *
     * Distinct from {@link createTextureView}, which narrows to one mip and one layer for use as an
     * attachment. Sampling a cascade array or a cube needs the opposite, and so does binding a 3D
     * texture as `texture_storage_3d` — the narrowed view is a `2d` view of one z-slice, which the
     * storage-texture binding rejects outright. That second use is why this is on the `Device`
     * interface now rather than a WebGPU-only extra: the cloud-noise compute bake cannot be written
     * without it.
     */
    public createWholeTextureView(texture: Texture): TextureView {
        const tex = texture as WebGPUTexture;
        return new WebGPUTextureView(tex, 0, 0, tex.handle.createView({
            label: `${tex.label}[sampled]`,
            dimension: gpuViewDimension(tex.dimension),
            baseMipLevel: 0,
            mipLevelCount: tex.mipLevelCount,
            baseArrayLayer: 0,
            arrayLayerCount: tex.dimension === '3d' ? undefined : tex.depthOrArrayLayers,
        }), `${tex.label}:sampled`);
    }

    /**
     * The sampler that pairs with `texture`, built from the state the texture itself carries.
     *
     * Cached on the STATE rather than on the texture: two textures configured the same way want the
     * same sampler, and WebGPU has a hard cap on how many a pipeline may bind. A depth texture in
     * comparison mode gets a `sampler_comparison`, which is a different WGSL type and cannot be shared
     * with the ordinary kind - `Texture.setDepthCompare` is what records that, and `WebGL2Sampler`
     * documents why the two backends disagree about where it lives.
     */
    private _samplerFor(texture: WebGPUTexture): Sampler {
        const c = texture.samplingConfig;
        const compare = isDepthFormat(texture.format) && texture.compareEnabled;
        const key = c ? `${c.addressMode}|${c.minFilter}|${compare}` : `default|${compare}`;
        let sampler = this._samplers.get(key);
        if (!sampler) {
            sampler = this.createSampler({
                addressModeU: c?.addressMode ?? 'clamp-to-edge',
                addressModeV: c?.addressMode ?? 'clamp-to-edge',
                addressModeW: c?.addressMode ?? 'clamp-to-edge',
                magFilter: c?.minFilter === 'nearest' ? 'nearest' : 'linear',
                minFilter: c?.minFilter === 'nearest' ? 'nearest' : 'linear',
                mipmapFilter: c?.minFilter === 'linear-mipmap-linear' ? 'linear' : 'nearest',
                ...(compare ? { compare: 'less' as const } : {}),
            });
            this._samplers.set(key, sampler);
        }
        return sampler;
    }
    private readonly _samplers = new Map<string, Sampler>();

    public createSampler(descriptor: SamplerDescriptor): Sampler {
        return new WebGPUSampler(this._device, { ...descriptor }, 'sampler');
    }

    /**
     * Build a program from the BUILD-TIME layout.
     *
     * Nothing is compiled here: the module is compiled by the pipeline that uses it. What this owns
     * is the uniform storage and the attribute list, neither of which WebGPU can be asked for at
     * runtime — which is why a descriptor without them is refused rather than guessed at. That is
     * the case for a custom material assembled from a user's GLSL, and refusing is the honest
     * outcome: it cannot run on this backend and should say so.
     */
    public createShaderProgram(descriptor: ShaderProgramDescriptor): ShaderProgram {
        if (!descriptor.vertexInputs || !descriptor.uniformBlocks)
            throw new Error(`${descriptor.label}: WebGPU needs the build-time vertex inputs and ` +
                            'uniform-block layouts; this program has neither (a runtime-assembled GLSL shader?)');
        return new WebGPUShaderProgram(this, descriptor.label, descriptor.vertexInputs,
                                       descriptor.uniformBlocks as UniformBlockLayout[]);
    }

    public createShaderModule(descriptor: ShaderModuleDescriptor): ShaderModule {
        // Refuse an empty module by name rather than compiling nothing and failing at pipeline creation
        // with no clue which program it was. The one caller that legitimately has no WGSL is a custom
        // material assembled from a user's GLSL at runtime - it cannot run on this backend and should
        // say so, exactly as `createShaderProgram` already does.
        if (!descriptor.source)
            throw new Error(`${descriptor.label ?? descriptor.program ?? 'shader'}: no WGSL - a ` +
                            `runtime-assembled GLSL program cannot be compiled by WebGPU`);
        const module = new WebGPUShaderModule(this._device, descriptor);
        // Fire and forget: the log is attached to the module when it arrives, and anything that is an
        // outright error is reported now rather than surfacing as a mystifying pipeline failure.
        void module.fetchCompilationInfo().then((messages) => {
            for (const message of messages) {
                if (message.startsWith('error')) Logger.error(message, SCOPE);
                else Logger.warn(message, SCOPE);
            }
        });
        return module;
    }

    public createRenderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline {
        const vertex = descriptor.vertex as WebGPUShaderModule;
        const fragment = descriptor.fragment as WebGPUShaderModule;

        const buffers: GPUVertexBufferLayout[] = descriptor.vertexLayouts.map(layout => ({
            arrayStride: layout.arrayStride,
            stepMode: gpuStepMode(layout.stepMode),
            attributes: layout.attributes.map(attribute => ({
                shaderLocation: attribute.shaderLocation,
                offset: attribute.offset,
                format: gpuVertexFormat(attribute.format),
            })),
        }));

        const targets: (GPUColorTargetState | null)[] = descriptor.colorTargets.map(target => ({
            format: gpuTextureFormat(target.format),
            ...(target.blend ? { blend: toGpuBlend(target.blend) } : {}),
            writeMask: gpuColorWriteMask(target.writeMask),
        }));

        const pipelineDescriptor: GPURenderPipelineDescriptor = {
            label: descriptor.label ?? 'pipeline',
            layout: 'auto',
            vertex: {
                module: vertex.handle,
                entryPoint: vertex.entryPoints.vertex ?? 'vs_main',
                buffers,
            },
            fragment: {
                module: fragment.handle,
                entryPoint: fragment.entryPoints.fragment ?? 'fs_main',
                targets,
            },
            primitive: {
                topology: gpuTopology(descriptor.primitive.topology),
                cullMode: gpuCullMode(descriptor.primitive.cullMode),
                frontFace: gpuFrontFace(descriptor.primitive.frontFace),
                ...(descriptor.primitive.stripIndexFormat
                    ? { stripIndexFormat: gpuIndexFormat(descriptor.primitive.stripIndexFormat) }
                    : {}),
            },
            ...(descriptor.depthStencil ? { depthStencil: toGpuDepthStencil(descriptor.depthStencil) } : {}),
        };

        const handle = this._device.createRenderPipeline(pipelineDescriptor);

        // `layout: 'auto'` derives the bind-group layouts from the shaders, so the groups a pipeline has
        // are the union of what its two modules declare — and asking for any other index throws.
        const groups = Array.from(new Set([...vertex.groups, ...fragment.groups])).sort((a, b) => a - b);
        return new WebGPURenderPipeline(descriptor, handle, groups);
    }

    public createComputePipeline(descriptor: ComputePipelineDescriptor): ComputePipeline {
        const module = descriptor.compute as WebGPUShaderModule;
        const handle = this._device.createComputePipeline({
            label: descriptor.label ?? 'compute-pipeline',
            layout: 'auto',
            compute: {
                module: module.handle,
                // No `cs_main` fallback to match the vertex/fragment ones above: those exist because
                // 55 hand-registered raster programs share a naming convention, and a compute module
                // that reaches here without its entry point named has nothing to fall back ON.
                entryPoint: module.entryPoints.compute,
            },
        });
        return new WebGPUComputePipeline(descriptor, handle, module.groups);
    }

    public createRenderTarget(descriptor: RenderTargetDescriptor): RenderTarget {
        const colorViews = descriptor.colorViews as WebGPUTextureView[];
        const depthView = descriptor.depthView as WebGPUTextureView | undefined;
        const reference = colorViews[0] ?? depthView;
        if (!reference) throw new Error('a render target needs at least one attachment');

        // Dimensions come from the attachment's mip level, not the texture's base size: a target for
        // mip 2 of a 512px texture is 128px, and getting this wrong silently scissors every draw.
        const width = Math.max(1, reference.texture.width >> reference.baseMipLevel);
        const height = Math.max(1, reference.texture.height >> reference.baseMipLevel);
        return new WebGPURenderTarget(colorViews, depthView, width, height,
                                      descriptor.label ?? 'render-target');
    }

    public createBindGroup(descriptor: BindGroupDescriptor): BindGroup {
        const layout = descriptor.layout as WebGPUBindGroupLayout;
        // The SAMPLER the caller did not pass.
        //
        // This engine keeps filter and wrap state on the TEXTURE, not in a separate sampler object, so
        // `_textureBindGroup` emits one entry per texture at binding 2N and nothing at 2N+1. WebGL2 is
        // happy with that - a combined sampler is one uniform - but a WGSL `texture_2d` + `sampler`
        // pair is two bindings, and WebGPU rejects a bind group whose entry count does not match its
        // layout ("Number of entries (1) did not match the expected number of entries (2)").
        //
        // Synthesised here rather than at the call site, for the same reason the uniform groups are:
        // the engine's model is that a texture carries its own sampling state, and a draw site should
        // not have to learn otherwise to satisfy one backend. `WebGPUTexture.samplingConfig` is exactly
        // that state, recorded by `configure()`.
        const withSamplers: BindGroupEntry[] = [];
        for (const entry of descriptor.entries) {
            withSamplers.push(entry);
            if (!('textureView' in entry)) continue;
            const texture = (entry.textureView as WebGPUTextureView).texture;
            withSamplers.push({ binding: entry.binding + 1, sampler: this._samplerFor(texture) });
        }

        const entries: GPUBindGroupEntry[] = withSamplers.map((entry) => {
            if ('buffer' in entry) {
                return {
                    binding: entry.binding,
                    resource: {
                        buffer: (entry.buffer as WebGPUBuffer).handle,
                        offset: entry.offset ?? 0,
                        ...(entry.size !== undefined ? { size: entry.size } : {}),
                    },
                };
            }
            if ('textureView' in entry) {
                return { binding: entry.binding, resource: (entry.textureView as WebGPUTextureView).handle };
            }

            // A storage texture binds as the same `GPUTextureView` a sampled one does — the arms
            // differ because WebGL2 has to be able to refuse this one, not because WebGPU treats it
            // differently. What WebGPU does check is that the texture carries STORAGE_BINDING usage
            // and that the view's dimension matches the shader's `texture_storage_*` type, which is
            // what `createWholeTextureView` is for on a 3D volume.
            if ('storageTextureView' in entry) {
                return { binding: entry.binding, resource: (entry.storageTextureView as WebGPUTextureView).handle };
            }
            return { binding: entry.binding, resource: (entry.sampler as WebGPUSampler).handle };
        });

        return new WebGPUBindGroup(layout, this._device.createBindGroup({
            label: descriptor.label ?? 'bind-group',
            layout: layout.handle,
            entries,
        }), descriptor.label ?? 'bind-group');
    }

    // -- surface ---------------------------------------------------------------------------------

    public getCurrentSurfaceTarget(): RenderTarget {
        if (!this._context || !this._canvas)
            throw new Error('this device has no surface (created without a canvas)');

        // Reacquired every frame on purpose: WebGPU hands back a different texture each time, and a
        // cached view from the previous frame is already invalid by the time it is used.
        const gpuTexture = this._context.getCurrentTexture();
        const descriptor: TextureDescriptor = {
            label: 'surface',
            format: this._surfaceFormat,
            dimension: '2d',
            width: gpuTexture.width,
            height: gpuTexture.height,
            depthOrArrayLayers: 1,
            mipLevelCount: 1,
            usage: 0,
        };
        const texture = new WebGPUTexture(descriptor, gpuTexture, false, this._device.queue, () => { /* surface-owned */ });
        const view = new WebGPUTextureView(texture, 0, 0, gpuTexture.createView({ label: 'surface' }), 'surface');
        return new WebGPURenderTarget([view], undefined, gpuTexture.width, gpuTexture.height, 'surface');
    }

    /** Re-`configure` after the canvas is resized, which invalidates the previous configuration. */
    public reconfigureSurface(): void {
        if (!this._context || !this._canvas) return;
        this._context.configure({
            device: this._device,
            format: gpuTextureFormat(this._surfaceFormat),
            alphaMode: 'opaque',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
    }

    // -- uploads ---------------------------------------------------------------------------------

    /**
     * Replace a buffer's contents, growing it if the data no longer fits.
     *
     * A `GPUBuffer`'s size is fixed at creation, so growing one means destroying it and making
     * another — which is why this returns the buffer to use from now on rather than mutating in
     * place. When the data still fits, the same buffer comes back and this is a plain queue write.
     *
     * Shrinking reuses the buffer too: the tail is simply not written, and nothing reads past the
     * range a draw was told about. Reallocating on every shrink would churn allocations for a caller
     * whose instance count merely dipped for a frame.
     */
    public reallocateBuffer(buffer: Buffer, data: ArrayBufferView): Buffer {
        const existing = buffer as WebGPUBuffer;
        if (data.byteLength <= existing.size) {
            this.writeBuffer(existing, 0, data);
            return existing;
        }
        const replacement = this.createBuffer({
            label: existing.label, size: data.byteLength, usage: existing.usage,
        });
        existing.destroy();
        this.writeBuffer(replacement, 0, data);
        return replacement;
    }

    public writeBuffer(buffer: Buffer, offset: number, data: ArrayBufferView): void {
        // `queue.writeBuffer` copies immediately from the caller's memory, so a typed array reused on
        // the next line is safe — unlike `mapAsync`, which is why uploads go through the queue here.
        this._device.queue.writeBuffer((buffer as WebGPUBuffer).handle, offset,
                                       data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    }

    public writeTexture(texture: Texture, data: ArrayBufferView, width: number, height: number,
                        mipLevel: number = 0, arrayLayer: number = 0): void {
        const tex = texture as WebGPUTexture;
        const bytesPerTexel = TEXTURE_FORMAT_INFO[tex.format].bytesPerTexel;
        this._device.queue.writeTexture(
            { texture: tex.handle, mipLevel, origin: { x: 0, y: 0, z: arrayLayer } },
            data.buffer as ArrayBuffer,
            // No 256-byte rule here: the alignment requirement applies to buffer COPIES, not to
            // `writeTexture`, which takes the tightly packed rows a caller naturally has.
            { offset: data.byteOffset, bytesPerRow: width * bytesPerTexel, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 },
        );
    }

    // -- commands --------------------------------------------------------------------------------

    public createCommandEncoder(label?: string): CommandEncoder {
        return new WebGPUCommandEncoder(this._device, this._timestamps, label);
    }

    /** See {@link Device.setTimestampCollection}. Everything it needs lives in `TimestampCollector`. */
    public setTimestampCollection(enabled: boolean, sink: (label: string, ms: number) => void): void {
        this._timestamps.setEnabled(enabled, sink);
    }

    /** See {@link Device.collectTimestamps}. */
    public collectTimestamps(): void { this._timestamps.collect(); }

    /**
     * Read a colour attachment back to the CPU.
     *
     * Three things make this longer than `gl.readPixels`: rows must start on 256-byte boundaries, the
     * copy has to be submitted before it can be mapped, and the mapped range is only valid until
     * `unmap()`. The padding strip at the end is what turns the aligned staging layout back into the
     * tightly packed buffer callers expect.
     */
    public async readPixels(view: TextureView, x: number, y: number,
                            width: number, height: number): Promise<Uint8Array> {
        const source = view as WebGPUTextureView;
        const format = source.texture.format;
        if (isDepthFormat(format))
            throw new Error(`readPixels cannot read the depth format ${format}`);

        const bytesPerTexel = TEXTURE_FORMAT_INFO[format].bytesPerTexel;
        const tightBytesPerRow = width * bytesPerTexel;
        const paddedBytesPerRow = alignUp(tightBytesPerRow, COPY_BYTES_PER_ROW_ALIGNMENT);

        const staging = this._device.createBuffer({
            label: 'readback',
            size: paddedBytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const encoder = this._device.createCommandEncoder({ label: 'readback' });
        encoder.copyTextureToBuffer(
            {
                texture: source.texture.handle,
                mipLevel: source.baseMipLevel,
                origin: { x, y, z: source.baseArrayLayer },
            },
            { buffer: staging, bytesPerRow: paddedBytesPerRow, rowsPerImage: height },
            { width, height, depthOrArrayLayers: 1 },
        );
        this._device.queue.submit([encoder.finish()]);

        await staging.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(staging.getMappedRange());
        const out = new Uint8Array(tightBytesPerRow * height);
        for (let row = 0; row < height; row++) {
            out.set(mapped.subarray(row * paddedBytesPerRow, row * paddedBytesPerRow + tightBytesPerRow),
                    row * tightBytesPerRow);
        }
        staging.unmap();
        staging.destroy();
        return out;
    }

    public destroy(): void {
        if (this._destroyed) return;
        this._destroyed = true;
        this._timestamps.destroy();
        for (const buffer of Array.from(this._buffers)) buffer.destroy();
        for (const texture of Array.from(this._textures)) texture.destroy();
        this._device.destroy();
    }
}

function toGpuDepthStencil(state: DepthStencilState): GPUDepthStencilState {
    return {
        format: gpuTextureFormat(state.format),
        depthWriteEnabled: state.depthWriteEnabled,
        depthCompare: gpuCompare(state.depthCompare),
        ...(state.depthBias !== undefined ? { depthBias: state.depthBias } : {}),
        ...(state.depthBiasSlopeScale !== undefined
            ? { depthBiasSlopeScale: state.depthBiasSlopeScale }
            : {}),
    };
}

// ------------------------------------------------------------------------------------------------
// Acquisition
// ------------------------------------------------------------------------------------------------

export interface WebGPUAcquireOptions {
    /** Rendering to the screen needs one; a headless device for bakes or tests does not. */
    canvas?: HTMLCanvasElement | OffscreenCanvas;
    /** `'high-performance'` picks the discrete GPU on a laptop with two. */
    powerPreference?: GPUPowerPreference;
}

/**
 * Optional features worth having when the adapter offers them.
 *
 * Each has to be requested explicitly at `requestDevice` — an adapter that *supports* a feature still
 * produces a device without it — and requesting one the adapter lacks is an outright failure rather
 * than a downgrade. Hence: intersect first, request second, then report what was actually granted.
 *
 * `float32-filterable` is the exact analogue of WebGL2's `OES_texture_float_linear`, whose absence
 * already silently demotes every `precision: 'high'` render target to RGBA8 in texture.ts.
 */
const OPTIONAL_FEATURES: GPUFeatureName[] = [
    'float32-filterable',
    'timestamp-query',
    'depth32float-stencil8',
];

/**
 * How many bind groups the engine's shaders actually declare.
 *
 * Four: group 0 textures, 1 every uniform block, 2 light-probe cubes, 3 shadow maps. That is also the
 * DEFAULT `maxBindGroups`, and adapters commonly report 4 as their maximum, so this is the ceiling
 * rather than a preference - see the group table in `chunks/modelVertex.wgsl`.
 *
 * It was six, one group per role, which put lit programs at group 5 and made Dawn reject them:
 * `[EntryPoint "fs_main"] infringes limits: the entry-point uses a binding with a group decoration (5)
 * that exceeds the maximum (4)`. Nothing else failed. The pipeline was simply invalid, the draws
 * recorded against it did nothing, and the pass still performed its clear - a frame that counted the
 * right number of draw calls and rendered not one pixel.
 */
const REQUIRED_BIND_GROUPS = 4;

/**
 * Acquire a WebGPU device, or explain why not.
 *
 * Returns null rather than throwing on every "this machine cannot" path — no `navigator.gpu`, no
 * adapter, a blocklisted driver — because all three are ordinary outcomes that the caller answers by
 * falling back to WebGL2, not by failing to start.
 */
export async function acquireWebGPUDevice(
    options: WebGPUAcquireOptions = {},
): Promise<WebGPUDevice | null> {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
        Logger.warn('navigator.gpu is not available (a secure context is required)', SCOPE);
        return null;
    }

    const adapter = await navigator.gpu.requestAdapter({
        powerPreference: options.powerPreference ?? 'high-performance',
    });
    if (!adapter) {
        Logger.warn('no WebGPU adapter (the driver may be blocklisted)', SCOPE);
        return null;
    }

    const requiredFeatures = OPTIONAL_FEATURES.filter(feature => adapter.features.has(feature));

    // Asked for against the ADAPTER's ceiling rather than as a constant, because requesting a limit an
    // adapter cannot meet fails `requestDevice` outright rather than degrading to what it can do. If an
    // adapter ever reports fewer than the engine needs, that is a real incompatibility and it should be
    // said plainly here rather than discovered later as a pipeline that silently draws nothing.
    const requiredLimits: Record<string, number> = {};
    if (adapter.limits.maxBindGroups >= REQUIRED_BIND_GROUPS)
        requiredLimits.maxBindGroups = REQUIRED_BIND_GROUPS;
    else
        Logger.warn(`adapter allows only ${adapter.limits.maxBindGroups} bind groups; the shaders `
                    + `number theirs by role and go up to ${REQUIRED_BIND_GROUPS - 1}, so lit `
                    + `pipelines will fail to build`, SCOPE);

    let device: GPUDevice;
    try {
        device = await adapter.requestDevice({ label: 'cleo', requiredFeatures, requiredLimits });
    } catch (error) {
        Logger.error(`requestDevice failed: ${String(error)}`, SCOPE);
        return null;
    }

    const preferredCanvasFormat = rhiTextureFormat(navigator.gpu.getPreferredCanvasFormat());

    let context: GPUCanvasContext | null = null;
    if (options.canvas) {
        context = options.canvas.getContext('webgpu') as GPUCanvasContext | null;
        if (!context) {
            Logger.error('canvas.getContext("webgpu") returned null', SCOPE);
            device.destroy();
            return null;
        }
    }

    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
    const limits = device.limits;
    const capabilities: DeviceCapabilities = {
        backend: 'webgpu',
        maxTextureSize: limits.maxTextureDimension2D,
        maxTextureArrayLayers: limits.maxTextureArrayLayers,
        max3DTextureSize: limits.maxTextureDimension3D,
        maxColorAttachments: limits.maxColorAttachments,
        maxSamplersPerStage: limits.maxSampledTexturesPerShaderStage,
        maxVertexAttributes: limits.maxVertexAttributes,
        maxUniformBufferBindingSize: limits.maxUniformBufferBindingSize,
        // 16-bit float targets are renderable and filterable in core WebGPU with no feature request;
        // only 32-bit filtering is gated, which is what the engine's HDR path actually cares about.
        floatRenderable: true,
        floatFilterable: device.features.has('float32-filterable'),
        hasCompute: true,
        hasStorageBuffers: true,
        hasTimestampQuery: device.features.has('timestamp-query'),
        // WebGPU has no anisotropy limit query; 16 is the ceiling every implementation accepts.
        maxAnisotropy: 16,
        preferredCanvasFormat,
        ...(info?.description || info?.vendor
            ? {
                adapterInfo: {
                    vendor: info.vendor ?? '',
                    architecture: info.architecture ?? '',
                    device: info.device ?? '',
                    description: info.description ?? '',
                },
            }
            : {}),
    };

    const result = new WebGPUDevice(device, context, options.canvas ?? null, capabilities,
                                    preferredCanvasFormat);
    if (context) result.reconfigureSurface();
    return result;
}

// The WebGPU implementation of the RHI device, and the reference implementation of the interface:
// every concept `../device.ts` names exists natively here, so anything that cannot be expressed
// cleanly was described wrong. Exercised end to end by `tools/harness/webgpuCheck.js`.

import { Logger } from '../../../core/logger';
import { frameStats, setViewportSize } from '../../renderStats';
import { ShaderManager } from '../../systems/shaderManager';
import { samplerBindingsOf, declaredGroupsOf } from './wgslBindings';
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
    ShaderStageFlags, IndexFormat, BlendState, ShaderResource, TextureConfigureDescriptor, AddressMode,
} from '../types';
import { TEXTURE_FORMAT_INFO, textureByteSize, isDepthFormat, ShaderStage, TextureUsage,
         isTriangleTopology } from '../types';

const SCOPE = 'WebGPU';

// What a texture is sampled with until `configure` says otherwise, so `uploadBytes` can record an
// address mode on a texture that was never configured.
const DEFAULT_SAMPLING: TextureConfigureDescriptor = {
    format: 'rgba8unorm', addressMode: 'clamp-to-edge', minFilter: 'linear', flipY: false, isDepth: false,
};

// `copyTextureToBuffer` requires each row to start on a 256-byte boundary — a validation rule, not a
// hint, so a readback's padding has to be stripped afterwards.
const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

// Distinct uniform slot signatures one program keeps bind groups for before the cache is dropped.
const UNIFORM_BIND_GROUP_CACHE_CAP = 4096;

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
 * Mip-chain generation, which WebGPU has no call for: each level is RENDERED from the one above, so
 * this needs a shader, a sampler and a pipeline per format. One loop covers 2D and cube.
 */
class WebGPUMipGenerator {
    private readonly _pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
    private _module: GPUShaderModule | null = null;
    private _sampler: GPUSampler | null = null;

    constructor(private readonly _device: GPUDevice) {}

    // A fullscreen TRIANGLE, not a quad: the positions come from the vertex index, so there is no
    // buffer to allocate and no layout to declare.
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
    // V INVERTED against the clip position, because a mip blit is a COPY and this runs on WebGPU.
    //
    // The triangle pairs clip y = -1 with uv.y = 0, which is the WebGL2 relationship. Here row 0 of
    // the destination is the TOP, at clip y = +1, so that fragment carries uv.y = 1 and would sample
    // the BOTTOM of the source: every generated level came out mirrored against its parent, and each
    // level mirrored again. Mip 0 is the rendered original and is always right, which is why nothing
    // looked wrong until something sampled a level ABOVE it - at distance, or at roughness.
    //
    // (Line comments only in here: this is a JS template literal, and a backtick in a doc comment
    // would close the string.)
    out.uv = vec2<f32>(uv.x, 1.0 - uv.y);
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
     * Fill levels 1..N-1 of `texture` from level 0, one pass per level per layer. Requires
     * RENDER_ATTACHMENT as well as TEXTURE_BINDING — every level above the first is a target first.
     */
    public generate(texture: WebGPUTexture, into: GPUCommandEncoder | null = null): void {
        if (texture.mipLevelCount <= 1) return;
        if ((texture.usage & TextureUsage.RENDER_ATTACHMENT) === 0)
            throw new Error(`${texture.label}: cannot generate mips without RENDER_ATTACHMENT usage — ` +
                            `every level above the first is rendered into before it is sampled`);

        const format = gpuTextureFormat(texture.format);
        const pipeline = this._pipelineFor(format);
        const sampler = this._linearSampler();
        // Cube faces are array layers; a 2D texture is the same loop with one of them.
        const layers = texture.dimension === 'cube' ? 6 : texture.depthOrArrayLayers;
        // Recording into the caller's `into` is what ORDERS this blit after the passes that drew level
        // 0; a private encoder submits immediately, ahead of the caller's unsubmitted work.
        // Only an encoder this method OWNS is submitted here.
        const encoder = into ?? this._device.createCommandEncoder({ label: 'mip-blit' });

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
        if (!into) this._device.queue.submit([encoder.finish()]);
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
    // A GPUTexture fixes its size, format and mip count at creation, so the "allocate" half of the
    // Texture interface has nothing to allocate here. Where an operation maps it is implemented;
    // where it needs storage created later it THROWS rather than silently doing nothing.

    private _config: TextureConfigureDescriptor | null = null;

    /** Remembered for the sampler this texture will be paired with; nothing to apply to the texture. */
    public configure(descriptor: TextureConfigureDescriptor): void { this._config = descriptor; }

    /** The state {@link configure} recorded, for the sampler the bind group pairs with this texture. */
    public get samplingConfig(): TextureConfigureDescriptor | null { return this._config; }

    public upload2D(image: TexImageSource | null, width: number, height: number, mipMap: boolean): void {
        // A null image means "allocate, do not fill", which `setSize` has already done.
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

    /**
     * Raw RGBA8 bytes, and the ADDRESS MODE they are sampled with. The mode must be honoured: this
     * backend keeps sampler state in `_config`, and the SSAO rotation noise depends on repeating.
     */
    public uploadBytes(data: Uint8Array, width: number, height: number, wrapping: AddressMode): void {
        this.uploadRegion(0, 0, width, height, data);
        this._config = { ...(this._config ?? DEFAULT_SAMPLING), addressMode: wrapping };
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
    /**
     * `setSize` already satisfied the size; the COMPARISON FLAG is what this call is still for. It is
     * recorded for `_samplerFor` to pair with — WebGPU refuses an ordinary sampler at a
     * `sampler_comparison` binding, which is what both shadow maps declare.
     */
    public allocateDepthArray(size: number, _layers: number, compare: boolean = true): void {
        this._requireSize(size, size, 'allocateDepthArray');
        this.setCompareMode(compare);
    }

    // Assert that `setSize` already allocated what this call assumes. An empty body is what a caller
    // that FORGOT to sync would also see, and that surfaces as an empty texture several passes later.
    private _requireSize(width: number, height: number, operation: string): void {
        if (this.width === width && this.height === height) return;
        throw new Error(`${this.label}: ${operation} expects storage at ${width}x${height}, but this ` +
                        `texture is ${this.width}x${this.height} - call setSize before uploading`);
    }

    /** Recorded, not applied: a comparison sampler is a SAMPLER here, for the bind group to pair with. */
    public setCompareMode(enabled: boolean): void {
        this._compare = enabled;
    }
    private _compare = false;
    public get compareEnabled(): boolean { return this._compare; }

    /** Build this texture's mip chain by rendering each level from the one above. */
    public generateMipmaps(encoder?: CommandEncoder): void {
        if (!this._mips)
            throw new Error(`${this.label}: no mip generator — this texture was not created by the device`);
        this._mips.generate(this, encoder ? (encoder as WebGPUCommandEncoder).raw : null);
    }

    /**
     * Give this texture storage, REPLACING the `GPUTexture` when the dimensions change — one cannot be
     * resized. The wrapper survives, so a `Texture` keeps working; every `TextureView` of it does NOT.
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

    // Refuse an operation that would allocate storage on WebGL2: a GPUTexture already has its own and
    // cannot grow one. Closing this means `graphics/texture.ts` sizing at creation.
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
    /** The engine-facing program NAME, which `ShaderManager` is keyed by. Used by `setPipeline`. */
    public readonly program: string;
    public readonly stage: ShaderStageFlags;
    public readonly entryPoints: { readonly vertex?: string; readonly fragment?: string; readonly compute?: string };
    /** Build-time reflection of what this program binds. Empty when the caller supplied none. */
    public readonly resources: readonly ShaderResource[];   // from the module, see the constructor
    public readonly handle: GPUShaderModule;
    public compilationInfo: readonly string[] = [];
    /**
     * Group indices the module declares. Needed because a `layout: 'auto'` pipeline throws from
     * `getBindGroupLayout(i)` for an unused group, and there is no way to ask how many there are.
     */
    public readonly groups: readonly number[];
    /**
     * `group -> the bindings in it this module declares as a SAMPLER`. Read off the SOURCE, not
     * `descriptor.resources`, since a module can legitimately arrive without reflection.
     */
    public readonly samplerBindings: ReadonlyMap<number, ReadonlySet<number>>;

    constructor(device: GPUDevice, descriptor: ShaderModuleDescriptor) {
        this.label = descriptor.label ?? 'shader';
        this.program = descriptor.program ?? this.label;
        this.stage = descriptor.stage;
        this.entryPoints = { ...(descriptor.entryPoints ?? {}) };
        this.resources = descriptor.resources ?? [];
        this.handle = device.createShaderModule({ label: this.label, code: descriptor.source });

        this.groups = declaredGroupsOf(descriptor.source);
        this.samplerBindings = samplerBindingsOf(descriptor.source);
    }

    /**
     * Pull the compiler log. Separate from the constructor because WebGPU reports shader errors
     * asynchronously and still hands back a module object for a failed compile.
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
    constructor(public readonly group: number, public readonly handle: GPUBindGroupLayout, label: string,
                /** Bindings in this group the shaders declare as a sampler. See `createBindGroup`. */
                public readonly samplerBindings: ReadonlySet<number> = new Set()) {
        this.label = label;
    }
    public destroy(): void { /* owned by the pipeline that produced it */ }
}

/** The sampler bindings `group` has across every module a pipeline was built from. */
function samplerBindingsIn(group: number, modules: readonly WebGPUShaderModule[]): Set<number> {
    const merged = new Set<number>();
    for (const module of modules)
        for (const binding of module.samplerBindings.get(group) ?? []) merged.add(binding);
    return merged;
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
    /** The program this pipeline draws with. See `WebGPURenderPassEncoder.setPipeline`. */
    public readonly program: string;
    public readonly vertexLayouts: readonly VertexBufferLayout[];
    public readonly primitive: Readonly<PrimitiveState>;
    public readonly depthStencil?: Readonly<DepthStencilState>;
    public readonly colorTargets: readonly ColorTargetState[];
    public readonly bindGroupLayouts: readonly WebGPUBindGroupLayout[];
    public readonly handle: GPURenderPipeline;
    /** See the interface. */
    public readonly resources: readonly ShaderResource[];
    /**
     * Group indices below the pipeline's highest that its shaders never declared. WebGPU requires a
     * bind group at every index, and this engine numbers groups by ROLE, so gaps are the norm.
     */
    public readonly emptyGroups: readonly number[];

    constructor(descriptor: RenderPipelineDescriptor, handle: GPURenderPipeline,
                groups: readonly number[], modules: readonly WebGPUShaderModule[]) {
        this.resources = (descriptor.vertex as WebGPUShaderModule).resources;
        this.program = (descriptor.vertex as WebGPUShaderModule).program;
        this.label = descriptor.label ?? 'pipeline';
        this.vertexLayouts = descriptor.vertexLayouts;
        this.primitive = descriptor.primitive;
        this.depthStencil = descriptor.depthStencil;
        this.colorTargets = descriptor.colorTargets;
        this.handle = handle;
        this.bindGroupLayouts = groups.map(
            g => new WebGPUBindGroupLayout(g, handle.getBindGroupLayout(g), `${this.label}:group${g}`,
                                           samplerBindingsIn(g, modules)));
        const highest = groups.length ? Math.max(...groups) : -1;
        const gaps: number[] = [];
        for (let g = 0; g < highest; g++) if (!groups.includes(g)) gaps.push(g);
        this.emptyGroups = gaps;
    }

    /**
     * The gap-filling bind groups, built once — they depend on nothing but the pipeline's own layout,
     * and each one is a real driver object on this backend.
     */
    public emptyBindGroups(device: GPUDevice): readonly { group: number; handle: GPUBindGroup }[] {
        if (!this._emptyBindGroups)
            this._emptyBindGroups = this.emptyGroups.map(group => ({
                group,
                handle: device.createBindGroup({
                    label: `${this.label}:empty${group}`,
                    layout: this.handle.getBindGroupLayout(group),
                    entries: [],
                }),
            }));
        return this._emptyBindGroups;
    }
    private _emptyBindGroups: { group: number; handle: GPUBindGroup }[] | null = null;

    /** The layout for a group index, or undefined when the shaders never declared it. */
    public layoutForGroup(group: number): WebGPUBindGroupLayout | undefined {
        return this.bindGroupLayouts.find(l => l.group === group);
    }

    /**
     * Bind groups over `program`'s uniform blocks AT THEIR CURRENT SLOTS, so each names a byte range
     * rather than a buffer. Cached by the SLOT SIGNATURE, never by the program — caching by program
     * gives every draw offset 0. A block whose group this pipeline does not declare is skipped.
     */
    public uniformGroupsFor(program: WebGPUShaderProgram,
                            device: GPUDevice): readonly { group: number; handle: GPUBindGroup }[] {
        let cache = this._uniformGroups.get(program);
        if (!cache) { cache = new Map(); this._uniformGroups.set(program, cache); }

        const signature = program.uniforms.bindingSignature();
        const cached = cache.get(signature);
        if (cached) return cached;

        // Grouped by GROUP INDEX, not one bind group per block: WebGPU rejects a bind group whose
        // entry count does not match its layout exactly.
        const byGroup = new Map<number, GPUBindGroupEntry[]>();
        for (const set of program.uniforms.blocks) {
            if (!this.layoutForGroup(set.layout.group)) continue;
            const entries = byGroup.get(set.layout.group) ?? [];
            entries.push({
                binding: set.layout.binding,
                // `size` is the BLOCK, not the arena: spanning every slot overruns
                // `maxUniformBufferBindingSize` and makes the shader read slot 0 at any offset.
                resource: {
                    buffer: (set.buffer as WebGPUBuffer).handle,
                    offset: set.byteOffset,
                    size: set.layout.size,
                },
            });
            byGroup.set(set.layout.group, entries);
        }

        const groups: { group: number; handle: GPUBindGroup }[] = [];
        for (const [group, entries] of byGroup) {
            groups.push({
                group,
                handle: device.createBindGroup({
                    label: `${this.label}<-${program.label}:uniforms${group}@${signature}`,
                    layout: this.layoutForGroup(group)!.handle,
                    entries,
                }),
            });
        }

        // Insurance, not an eviction policy: the signature space is bounded because slots reset at
        // every submit, and dropping the map costs one rebuild per signature.
        if (cache.size >= UNIFORM_BIND_GROUP_CACHE_CAP) cache.clear();
        cache.set(signature, groups);
        return groups;
    }
    private readonly _uniformGroups =
        new WeakMap<WebGPUShaderProgram, Map<string, { group: number; handle: GPUBindGroup }[]>>();

    public destroy(): void { /* released with the device */ }
}

/**
 * A compute pipeline: the module, plus the bind-group layouts `layout: 'auto'` derived from it. No
 * `emptyGroups` counterpart — the one compute module uses group 0 and nothing else.
 */
class WebGPUComputePipeline implements ComputePipeline {
    public readonly label: string;
    public readonly bindGroupLayouts: readonly WebGPUBindGroupLayout[];
    public readonly handle: GPUComputePipeline;

    constructor(descriptor: ComputePipelineDescriptor, handle: GPUComputePipeline,
                groups: readonly number[], module: WebGPUShaderModule) {
        this.label = descriptor.label ?? 'compute-pipeline';
        this.handle = handle;
        this.bindGroupLayouts = groups.map(
            g => new WebGPUBindGroupLayout(g, handle.getBindGroupLayout(g), `${this.label}:group${g}`,
                                           samplerBindingsIn(g, [module])));
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
     * Bind the pipeline, and an empty group at every index its shaders skipped — see
     * {@link WebGPURenderPipeline.emptyGroups}. A missing one fails at DRAW time, far from its cause.
     */
    public setPipeline(pipeline: RenderPipeline): void {
        const p = pipeline as WebGPURenderPipeline;
        this._topology = p.primitive.topology;
        this._pass.setPipeline(p.handle);
        for (const { group, handle } of p.emptyBindGroups(this._device))
            this._pass.setBindGroup(group, handle);

        // Bind the PROGRAM here, or a pass that never calls `bind` itself writes its uniforms into
        // whichever program the previous pass left bound. The blocks themselves are bound at draw
        // time by `_flushUniforms`. `bindIfRegistered`, not `bind`: a pipeline built straight from a
        // shader module has no engine-level program, and that is a pipeline with no uniforms.
        ShaderManager.Instance.bindIfRegistered(p.program);
        this._pipeline = p;
    }
    /** Remembered from `setPipeline` so the draw can bind against it. See `_flushUniforms`. */
    private _pipeline: WebGPURenderPipeline | null = null;

    // Upload whatever the pass wrote since the last draw: uniforms are buffered on the CPU and
    // uploaded once, immediately before the draw that reads them.
    private _flushUniforms(): void {
        // Read the program HERE, at the draw, never at `setPipeline`: the program bound at that moment
        // is frequently the previous pass's, and binding its groups feeds this pipeline another
        // program's buffers. At the draw, the bound program is by definition the one about to run.
        const program = ShaderManager.Instance.bound;
        if (!program) return;
        program.flushUniformBlocks();
        if (this._pipeline && program instanceof WebGPUShaderProgram)
            for (const { group, handle } of this._pipeline.uniformGroupsFor(program, this._device))
                this._pass.setBindGroup(group, handle);
    }

    public setBindGroup(group: number, bindGroup: BindGroup, dynamicOffsets?: readonly number[]): void {
        const handle = (bindGroup as WebGPUBindGroup).handle;
        // The third argument must be OMITTED when there are no offsets, never passed as `undefined`:
        // `setBindGroup` is overloaded on ARGUMENT COUNT, and an explicit undefined throws.
        if (dynamicOffsets) this._pass.setBindGroup(group, handle, Array.from(dynamicOffsets));
        else this._pass.setBindGroup(group, handle);
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

    // The per-frame counters. Mirrors `WebGL2RenderPassEncoder._countDraw` exactly, instanced charging
    // included, so the two backends' numbers are comparable.
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

/** Records dispatches inside one compute pass. */
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
// Staging buffers in flight at once. Running out drops that submission's timings rather than growing
// the pool — a timing that had to wait for memory is not a timing of the GPU.
const TIMESTAMP_STAGING_RING = 8;

interface TimestampStaging {
    buffer: GPUBuffer;
    /** Pass labels in query order, so index 2i/2i+1 is `labels[i]`'s begin/end. */
    labels: string[];
    state: 'free' | 'submitted' | 'mapping' | 'ready';
}

/**
 * The device's timestamp-query machinery: a query set, its resolve buffer, and a small staging ring.
 * Only differences are meaningful, and browsers quantise, so a pass under the quantum reads 0.
 * Query indices may restart at 0 per submission — submissions execute in order.
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
        // Resources are NOT released on disable: a staging buffer destroyed mid-map rejects its own
        // `mapAsync`, and the drain has to finish for anything already submitted.
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
     * Record the resolve and copy for one finished encoder. Must run BEFORE it is submitted:
     * `resolveQuerySet` is a command and has to sit in the same buffer as the passes it resolves.
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
                // `mapAsync` resolves only once the writing submission completes, so this IS the
                // "has it finished" test. The rejection path must be handled: a device loss rejects
                // every outstanding map.
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
                // Drop only what is not a measurement: untouched slots, and an end before its begin.
                // A zero DELTA is reported as 0.000ms — quantisation puts a cheap pass on the same
                // tick at both ends, and dropping those makes it vanish rather than read as floor.
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
                private readonly _timestamps: TimestampCollector | null,
                /**
                 * Called after `queue.submit` to release every uniform slot this submission read. The
                 * reset point is exactly there — a frame boundary is too late for a many-draw pass.
                 */
                private readonly _onSubmit: () => void = () => {},
                label?: string) {
        this._encoder = _device.createCommandEncoder({ label: label ?? 'commands' });
    }

    /** The raw encoder, for device-internal work (readback copies) that rides on the same submission. */
    public get raw(): GPUCommandEncoder { return this._encoder; }

    public beginRenderPass(target: RenderTarget, descriptor: RenderPassDescriptor): RenderPassEncoder {
        const rt = target as WebGPURenderTarget;

        // An attachment the descriptor does not mention must still be listed, or WebGPU rejects the
        // draw for writing more targets than the pass has. Unmentioned ones load and store.
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
            // Narrowed to the requested LAYER, not the whole array: the cascades and the spot atlas
            // are one texture rendered a layer at a time. Created on demand rather than cached.
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

        // A timestamp attaches only to a PASS, so its label is the only name a cost reports under.
        // The query pair is claimed here and resolved in `finish()`; past capacity, a pass is untimed.
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
     * Open a compute pass. A dispatch is recorded work like any other, so it shares this encoder's
     * submission and orders against the passes around it. Not timestamped.
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
        this._onSubmit();
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
        // Clamped to 1: `graphics/texture.ts` creates every texture at 0x0, and WebGPU rejects a zero
        // extent ASYNCHRONOUSLY — a wall of uncaptured validation errors that buries the real one.
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

        // A view onto ONE layer is `2d`, never `2d-array`/`cube` — that is how a cascade or a cube face
        // becomes an attachment. A whole-texture view keeps the texture's own dimension.
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
     * A view of the whole texture: every mip, every layer, the texture's own dimension. What sampling a
     * cascade array or a cube needs, and the only thing a `texture_storage_3d` binding accepts.
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
     * Cached on the STATE, not the texture, since WebGPU caps how many samplers a pipeline may bind.
     * A depth texture in comparison mode gets a `sampler_comparison`, which cannot be shared.
     */
    private _samplerFor(texture: WebGPUTexture): Sampler {
        const c = texture.samplingConfig;
        const depth = isDepthFormat(texture.format);
        const compare = depth && texture.compareEnabled;
        // A depth texture may only be FILTERED through a comparison sampler; sampled ordinarily it
        // must take a non-filtering one, or WebGPU refuses the bind group.
        const filter = depth && !compare ? 'nearest' as const
                     : (c?.minFilter === 'nearest' ? 'nearest' as const : 'linear' as const);
        const key = c ? `${c.addressMode}|${filter}|${compare}` : `default|${filter}|${compare}`;
        let sampler = this._samplers.get(key);
        if (!sampler) {
            sampler = this.createSampler({
                addressModeU: c?.addressMode ?? 'clamp-to-edge',
                addressModeV: c?.addressMode ?? 'clamp-to-edge',
                addressModeW: c?.addressMode ?? 'clamp-to-edge',
                magFilter: filter,
                minFilter: filter,
                mipmapFilter: !depth && c?.minFilter === 'linear-mipmap-linear' ? 'linear' : 'nearest',
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
     * Build a program from the BUILD-TIME layout — the uniform storage and attribute list, neither of
     * which WebGPU can be asked for at runtime. A descriptor without them is refused, not guessed at.
     */
    public createShaderProgram(descriptor: ShaderProgramDescriptor): ShaderProgram {
        if (!descriptor.vertexInputs || !descriptor.uniformBlocks)
            throw new Error(`${descriptor.label}: WebGPU needs the build-time vertex inputs and ` +
                            'uniform-block layouts; this program has neither (a runtime-assembled GLSL shader?)');
        const program = new WebGPUShaderProgram(this, descriptor.label, descriptor.vertexInputs,
                                               descriptor.uniformBlocks as UniformBlockLayout[],
                                               this._device.limits.minUniformBufferOffsetAlignment,
                                               p => this._programs.delete(p));
        // Registered so `releaseUniformSlots` can reach it: a program cannot know when the queue drained.
        this._programs.add(program);
        return program;
    }

    /**
     * Free every program's uniform slots. Safe ONLY after `queue.submit` — a slot holds the value a
     * recorded draw will read until its command buffer reaches the queue.
     */
    public releaseUniformSlots(): void {
        for (const program of this._programs) program.uniforms.resetCursors();
    }
    // Every program built on this device. A STRONG set: a weak one risks a program being collected
    // between its last draw and the slot reset that has to reach it.
    private readonly _programs = new Set<WebGPUShaderProgram>();

    public createShaderModule(descriptor: ShaderModuleDescriptor): ShaderModule {
        // Refuse an empty module BY NAME, rather than failing at pipeline creation with no clue which
        // program it was.
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
        return new WebGPURenderPipeline(descriptor, handle, groups, [vertex, fragment]);
    }

    public createComputePipeline(descriptor: ComputePipelineDescriptor): ComputePipeline {
        const module = descriptor.compute as WebGPUShaderModule;
        const handle = this._device.createComputePipeline({
            label: descriptor.label ?? 'compute-pipeline',
            layout: 'auto',
            compute: {
                module: module.handle,
                // No `cs_main` fallback: a compute module without its entry point named has nothing
                // to fall back on.
                entryPoint: module.entryPoints.compute,
            },
        });
        return new WebGPUComputePipeline(descriptor, handle, module.groups, module);
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
        // Synthesise the SAMPLER the caller did not pass: this engine keeps sampling state on the
        // TEXTURE, so a bind group arrives one entry short of a `texture_2d` + `sampler` layout, and
        // WebGPU rejects it on the count. Only where the slot is empty — a caller that passed its own
        // would otherwise get two entries at one binding, which is rejected the same way.
        const declared = new Set(descriptor.entries.map(e => e.binding));
        const withSamplers: BindGroupEntry[] = [];
        for (const entry of descriptor.entries) {
            withSamplers.push(entry);
            if (!('textureView' in entry)) continue;
            // Must not fire when the caller passed its own sampler, nor when the shader declares none
            // there at all — every `textureLoad` read. Either produces a rejected entry count.
            if (declared.has(entry.binding + 1)) continue;
            if (!layout.samplerBindings.has(entry.binding + 1)) continue;
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

            // Binds as the same `GPUTextureView` a sampled one does; the separate arm exists so
            // WebGL2 can refuse it. WebGPU checks STORAGE_BINDING usage and the view's dimension.
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
     * Replace a buffer's contents, growing it if the data no longer fits — a `GPUBuffer` cannot be
     * resized, so growing returns a NEW buffer. Shrinking reuses the old one and leaves the tail unwritten.
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
        // `queue.writeBuffer` copies immediately, so the caller may reuse its typed array.
        // The SIZE must be a multiple of 4 — an odd-count uint16 index buffer fails the whole upload —
        // so odd sizes are padded. `WebGPUBuffer` already rounds its allocation up, so there is room.
        const handle = (buffer as WebGPUBuffer).handle;
        if (data.byteLength % 4 === 0) {
            this._device.queue.writeBuffer(handle, offset,
                                           data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
            return;
        }
        const padded = new Uint8Array(alignUp(data.byteLength, 4));
        padded.set(new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength));
        this._device.queue.writeBuffer(handle, offset, padded.buffer, 0, padded.byteLength);
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
        return new WebGPUCommandEncoder(this._device, this._timestamps,
                                        () => this.releaseUniformSlots(), label);
    }

    /** See {@link Device.setTimestampCollection}. Everything it needs lives in `TimestampCollector`. */
    public setTimestampCollection(enabled: boolean, sink: (label: string, ms: number) => void): void {
        this._timestamps.setEnabled(enabled, sink);
    }

    /** See {@link Device.collectTimestamps}. */
    public collectTimestamps(): void { this._timestamps.collect(); }

    /**
     * Read a colour attachment back to the CPU. Rows must start on 256-byte boundaries, the copy must
     * be submitted before it can be mapped, and the padding is stripped to give callers a tight buffer.
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

// Optional features worth having when the adapter offers them. Each must be requested explicitly, and
// requesting one the adapter lacks fails outright — so intersect first, then request.
const OPTIONAL_FEATURES: GPUFeatureName[] = [
    'float32-filterable',
    'timestamp-query',
    'depth32float-stencil8',
];

// How many bind groups the engine's shaders declare: 0 textures, 1 uniforms, 2 probe cubes, 3 shadows.
// Also the default `maxBindGroups` and a common adapter maximum, so it is a CEILING, not a preference.
const REQUIRED_BIND_GROUPS = 4;

/**
 * Acquire a WebGPU device, or explain why not. Returns null rather than throwing on every "this
 * machine cannot" path, since the caller answers all of them by falling back to WebGL2.
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

    // Asked against the ADAPTER's ceiling, never as a constant: a limit it cannot meet fails
    // `requestDevice` outright rather than degrading.
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

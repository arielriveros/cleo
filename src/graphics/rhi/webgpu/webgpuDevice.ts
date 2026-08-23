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
import { setViewportSize } from '../../renderStats';
import {
    gpuTextureFormat, rhiTextureFormat, gpuTextureDimension, gpuViewDimension, layersForDimension,
    gpuBufferUsage, gpuTextureUsage, gpuAddressMode, gpuFilterMode, gpuCompare,
    gpuBlendFactor, gpuBlendOperation, gpuCullMode, gpuFrontFace, gpuTopology, gpuIndexFormat,
    gpuVertexFormat, gpuStepMode, gpuLoadOp, gpuStoreOp, gpuColorWriteMask,
} from './webgpuEnums';
import type {
    Device, DeviceCapabilities, BackendKind, BufferDescriptor, TextureDescriptor,
    ShaderModuleDescriptor, RenderPipelineDescriptor, RenderTargetDescriptor,
    BindGroupDescriptor, CommandEncoder, RenderPassEncoder,
} from '../device';
import type {
    Buffer, Texture, TextureView, Sampler, ShaderModule, BindGroup, BindGroupLayout,
    RenderPipeline, RenderTarget,
} from '../resources';
import type {
    TextureFormat, TextureDimension, TextureUsageFlags, BufferUsageFlags, SamplerDescriptor,
    VertexBufferLayout, PrimitiveState, DepthStencilState, ColorTargetState, RenderPassDescriptor,
    ShaderStageFlags, IndexFormat, BlendState, ShaderResource,
} from '../types';
import { TEXTURE_FORMAT_INFO, textureByteSize, isDepthFormat, ShaderStage } from '../types';

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

class WebGPUTexture implements Texture {
    public readonly label: string;
    public readonly format: TextureFormat;
    public readonly dimension: TextureDimension;
    public readonly width: number;
    public readonly height: number;
    public readonly depthOrArrayLayers: number;
    public readonly mipLevelCount: number;
    public readonly usage: TextureUsageFlags;
    public readonly handle: GPUTexture;
    /** False for the swap-chain texture, which the surface owns and recycles. */
    private readonly _owned: boolean;
    private _destroyed = false;

    constructor(descriptor: TextureDescriptor, handle: GPUTexture, owned: boolean,
                private readonly _onDestroy: () => void) {
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
    }

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
    public readonly resources: readonly ShaderResource[];
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

    constructor(descriptor: RenderPipelineDescriptor, handle: GPURenderPipeline,
                groups: readonly number[]) {
        this.label = descriptor.label ?? 'pipeline';
        this.vertexLayouts = descriptor.vertexLayouts;
        this.primitive = descriptor.primitive;
        this.depthStencil = descriptor.depthStencil;
        this.colorTargets = descriptor.colorTargets;
        this.handle = handle;
        this.bindGroupLayouts = groups.map(
            g => new WebGPUBindGroupLayout(g, handle.getBindGroupLayout(g), `${this.label}:group${g}`));
    }

    /** The layout for a group index, or undefined when the shaders never declared it. */
    public layoutForGroup(group: number): WebGPUBindGroupLayout | undefined {
        return this.bindGroupLayouts.find(l => l.group === group);
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

    constructor(private readonly _pass: GPURenderPassEncoder) {}

    public setPipeline(pipeline: RenderPipeline): void {
        this._pass.setPipeline((pipeline as WebGPURenderPipeline).handle);
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
        this._pass.draw(vertexCount, instanceCount, firstVertex);
    }

    public drawIndexed(indexCount: number, instanceCount: number = 1, firstIndex: number = 0,
                       baseVertex: number = 0): void {
        this._pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex);
    }

    public end(): void {
        if (this._ended) return;
        this._ended = true;
        this._pass.end();
    }
}

class WebGPUCommandEncoder implements CommandEncoder {
    private readonly _encoder: GPUCommandEncoder;
    private _finished = false;

    constructor(private readonly _device: GPUDevice, label?: string) {
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
            depthStencilAttachment = {
                view: rt.depthView.handle,
                depthLoadOp: loadOp,
                depthStoreOp: declared ? gpuStoreOp(declared.storeOp) : 'store',
                ...(loadOp === 'clear' ? { depthClearValue: declared?.clearValue ?? 1.0 } : {}),
            };
        }

        setViewportSize(rt.width, rt.height);
        return new WebGPURenderPassEncoder(this._encoder.beginRenderPass({
            label: descriptor.label,
            colorAttachments,
            ...(depthStencilAttachment ? { depthStencilAttachment } : {}),
        }));
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

    public finish(): void {
        if (this._finished) return;
        this._finished = true;
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
    private readonly _textures = new Set<WebGPUTexture>();
    private _surfaceFormat: TextureFormat;
    private _destroyed = false;

    constructor(
        private readonly _device: GPUDevice,
        private readonly _context: GPUCanvasContext | null,
        private readonly _canvas: HTMLCanvasElement | OffscreenCanvas | null,
        capabilities: DeviceCapabilities,
        surfaceFormat: TextureFormat,
    ) {
        this.capabilities = capabilities;
        this._surfaceFormat = surfaceFormat;

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

    public createTexture(descriptor: TextureDescriptor): Texture {
        const dimension = descriptor.dimension ?? '2d';
        const layers = layersForDimension(dimension, descriptor.depthOrArrayLayers);
        const handle = this._device.createTexture({
            label: descriptor.label ?? 'texture',
            format: gpuTextureFormat(descriptor.format),
            dimension: gpuTextureDimension(dimension),
            size: { width: descriptor.width, height: descriptor.height, depthOrArrayLayers: layers },
            mipLevelCount: Math.max(1, descriptor.mipLevelCount ?? 1),
            usage: gpuTextureUsage(descriptor.usage),
        });
        const texture = new WebGPUTexture(descriptor, handle, true, () => this._textures.delete(texture));
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
     * A view of the whole texture, as a shader samples it.
     *
     * Distinct from {@link createTextureView}, which narrows to one mip and one layer for use as an
     * attachment. Sampling a cascade array or a cube needs the opposite: every layer, every mip, and
     * the texture's own view dimension.
     */
    public createSamplingView(texture: Texture): TextureView {
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

    public createSampler(descriptor: SamplerDescriptor): Sampler {
        return new WebGPUSampler(this._device, { ...descriptor }, 'sampler');
    }

    public createShaderModule(descriptor: ShaderModuleDescriptor): ShaderModule {
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
        const entries: GPUBindGroupEntry[] = descriptor.entries.map((entry) => {
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
        const texture = new WebGPUTexture(descriptor, gpuTexture, false, () => { /* surface-owned */ });
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
        return new WebGPUCommandEncoder(this._device, label);
    }

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
    let device: GPUDevice;
    try {
        device = await adapter.requestDevice({ label: 'cleo', requiredFeatures });
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

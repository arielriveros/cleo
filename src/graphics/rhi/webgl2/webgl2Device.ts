import { gl } from '../../glContext';
import { GLState } from '../../systems/glState';
import { Logger } from '../../../core/logger';
import { setViewportSize } from '../../renderStats';
import { glBufferTarget, glBufferUsageHint, glTextureTarget, glTextureFormat, glAddressMode, glMinFilter, glMagFilter } from './glEnums';
import { detectWebGL2Capabilities, anisotropyExtension } from './capabilities';
import { applyVertexLayout } from './vertexArray';
import {
    WebGL2ShaderModule, WebGL2RenderPipeline, WebGL2BindGroup, WebGL2Sampler,
    WebGL2TextureView, WebGL2CommandEncoder, WebGL2RenderTarget,
} from './webgl2Commands';
import type {
    Device, DeviceCapabilities, BackendKind, BufferDescriptor, TextureDescriptor,
    ShaderModuleDescriptor, RenderPipelineDescriptor, BindGroupDescriptor, RenderTargetDescriptor,
    ComputePipelineDescriptor,
} from '../device';
import type { ComputePipeline } from '../resources';
import type { RenderPassDescriptor } from '../types';
import type { Buffer, Texture } from '../resources';
import type { BufferUsageFlags, TextureFormat, TextureDimension, TextureUsageFlags, SamplerDescriptor, AddressMode, TextureConfigureDescriptor } from '../types';
import { textureByteSize, TEXTURE_FORMAT_INFO, isDepthFormat } from '../types';
import type { ShaderProgram, ShaderProgramDescriptor } from '../shaderProgram';
import { Shader } from '../../shader';
import { device } from '../deviceHandle';

/**
 * The WebGL2 implementation of the RHI device. One gap remains, on the command encoder rather than
 * here: `CommandEncoder.copyTextureToTexture` throws.
 */
export class WebGL2Device implements Device {
    public readonly backend: BackendKind = 'webgl2';
    public readonly capabilities: DeviceCapabilities;

    /** Live resources, so `destroy()` can release what the caller did not. */
    private readonly _buffers = new Set<WebGL2Buffer>();
    private readonly _textures = new Set<WebGL2Texture>();
    private readonly _framebuffers = new Set<WebGL2Framebuffer>();
    /** Deduped pipelines, keyed by program + state. See createRenderPipeline. */
    private readonly _pipelines = new Map<string, WebGL2RenderPipeline>();
    /** VAOs by pipeline and buffer set. See vertexArrayFor. */
    private readonly _vertexArrays = new Map<WebGL2RenderPipeline, Map<string, WebGLVertexArrayObject>>();
    /** VAOs a caller owns and binds itself — Mesh and TileMesh. See createVertexArray. */
    private readonly _ownedVertexArrays = new Set<WebGLVertexArrayObject>();
    /** Deduped render targets, keyed by their attachment set. See createRenderTarget. */
    private readonly _renderTargets = new Map<string, WebGL2RenderTarget>();
    /** Which target keys each texture appears in, so destroying it releases them. */
    private readonly _targetsByTexture = new Map<number, Set<string>>();
    /** The canvas this context draws to — the surface, in WebGPU's vocabulary. */
    private readonly _canvas: HTMLCanvasElement | OffscreenCanvas;
    /** One reusable handle to the default framebuffer. See getCurrentSurfaceTarget. */
    private _surfaceTarget: WebGL2RenderTarget | null = null;
    /** Scratch framebuffer for readback, created on first use. See readPixels. */
    private _readbackFramebuffer: WebGL2Framebuffer | null = null;
    /** Scratch read/draw framebuffers for copyTextureToTexture, created on first use. */
    private _copyRead: WebGL2Framebuffer | null = null;
    private _copyDraw: WebGL2Framebuffer | null = null;

    constructor(context: WebGL2RenderingContext) {
        this.capabilities = detectWebGL2Capabilities(context);
        this._canvas = context.canvas;
    }

    /** Returns the concrete backend buffer, since callers inside the WebGL2 half need its `handle`. */
    public createBuffer(descriptor: BufferDescriptor): WebGL2Buffer {
        const buffer = new WebGL2Buffer(descriptor, () => this._buffers.delete(buffer));
        this._buffers.add(buffer);
        return buffer;
    }

    /**
     * Write into part of an existing buffer, leaving its size alone — a sub-write, NEVER a
     * reallocation, matching `queue.writeBuffer`. Use {@link reallocateBuffer} to resize.
     */
    public writeBuffer(buffer: WebGL2Buffer, offset: number, data: ArrayBufferView): void {
        gl.bindBuffer(buffer.target, buffer.handle);
        gl.bufferSubData(buffer.target, offset, data);
    }

    /**
     * Replace a buffer's entire contents, resizing to fit — `bufferData` discards the previous storage.
     * Right for a full rebuild, wrong for a partial edit. The only call whose size may change.
     */
    public reallocateBuffer(buffer: WebGL2Buffer, data: ArrayBufferView): WebGL2Buffer {
        gl.bindBuffer(buffer.target, buffer.handle);
        gl.bufferData(buffer.target, data, buffer.hint);
        buffer.setSize(data.byteLength);
        // Always the same object here: `bufferData` re-specifies storage in place, so every existing
        // VAO that references this buffer stays valid. See the interface for why it is returned.
        return buffer;
    }

    /**
     * Allocate a texture OBJECT only — the storage comes from whichever upload path the caller uses,
     * which reports the dimensions back through {@link WebGL2Texture.setSize}.
     */
    public createTexture(descriptor: TextureDescriptor): WebGL2Texture {
        const texture = new WebGL2Texture(descriptor, () => this._releaseTexture(texture));
        this._textures.add(texture);
        return texture;
    }

    // Forget a destroyed texture and tear down every render target attached to it. The eviction is what
    // makes {@link createRenderTarget}'s cache safe to keep for the device's lifetime.
    private _releaseTexture(texture: WebGL2Texture): void {
        this._textures.delete(texture);
        const keys = this._targetsByTexture.get(texture.id);
        if (!keys) return;
        this._targetsByTexture.delete(texture.id);
        for (const key of keys) {
            const target = this._renderTargets.get(key);
            if (!target) continue;
            this._renderTargets.delete(key);
            target.destroy();
        }
    }

    /**
     * Allocate a bare framebuffer object. WebGL2-only, and not how a render target is built — see
     * {@link createRenderTarget}. Only the two callers that re-point an attachment by hand need this.
     */
    public createFramebuffer(label: string = 'framebuffer'): WebGL2Framebuffer {
        const framebuffer = new WebGL2Framebuffer(label, () => this._framebuffers.delete(framebuffer));
        this._framebuffers.add(framebuffer);
        return framebuffer;
    }

    /**
     * A render target over these attachments, the attachment call chosen from each view's texture
     * DIMENSION. DEDUPED by attachment set — callers ask per pass — and evicted by {@link _releaseTexture}.
     */
    public createRenderTarget(descriptor: RenderTargetDescriptor): WebGL2RenderTarget {
        const colorViews = descriptor.colorViews as WebGL2TextureView[];
        const depthView = descriptor.depthView as WebGL2TextureView | undefined;
        const reference = colorViews[0] ?? depthView;
        if (!reference) throw new Error('a render target needs at least one attachment');

        const key = colorViews.map(viewKey).join(',') + '|' + (depthView ? viewKey(depthView) : '-');
        const cached = this._renderTargets.get(key);
        if (cached) return cached;

        // Dimensions come from the attachment's mip level, not the texture's base size: a target for
        // mip 2 of a 512px texture is 128px, and getting this wrong silently scissors every draw.
        const width = Math.max(1, reference.texture.width >> reference.baseMipLevel);
        const height = Math.max(1, reference.texture.height >> reference.baseMipLevel);

        const label = descriptor.label ?? 'render-target';
        const framebuffer = this.createFramebuffer(label);
        framebuffer.bind();
        colorViews.forEach((view, index) => framebuffer.attachColor(index, view));
        if (depthView) framebuffer.attachDepth(depthView);
        // Zero colour attachments is the shadow maps' normal case, and needs BOTH draw and read buffers
        // explicitly NONE or the framebuffer is incomplete and drops every draw silently.
        framebuffer.setDrawBuffers(colorViews.length);
        framebuffer.checkStatus('createRenderTarget');
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        const target = new WebGL2RenderTarget(framebuffer, width, height, colorViews, depthView, label, true);
        this._renderTargets.set(key, target);
        for (const view of depthView ? [...colorViews, depthView] : colorViews) {
            let keys = this._targetsByTexture.get(view.texture.id);
            if (!keys) { keys = new Set(); this._targetsByTexture.set(view.texture.id, keys); }
            keys.add(key);
        }
        return target;
    }

    /** Nothing to do: a WebGL2 drawing buffer follows `canvas.width`/`height` on its own. */
    public reconfigureSurface(): void { /* the drawing buffer follows the canvas */ }

    public getCurrentSurfaceTarget(): WebGL2RenderTarget {
        const width = this._canvas.width, height = this._canvas.height;
        if (!this._surfaceTarget || this._surfaceTarget.width !== width || this._surfaceTarget.height !== height)
            this._surfaceTarget = new WebGL2RenderTarget(null, width, height, [], undefined, 'surface');
        return this._surfaceTarget;
    }

    /**
     * Begin a render pass: bind the target, set the viewport, honour each load op. A `'clear'` with no
     * `clearValue` uses the standing clear colour; `storeOp` is recorded but ignored.
     */
    public beginRenderPass(target: WebGL2RenderTarget, descriptor: RenderPassDescriptor): void {
        target.bind();

        // Render into ONE layer of an array depth target, by re-pointing the depth attachment.
        const layer = descriptor.depthAttachment?.baseArrayLayer;
        const layered = target.depthTexture;
        if (layer !== undefined && target.framebuffer && layered)
            target.framebuffer.attachDepthLayer(layered, layer);

        // The TARGET's colour count, never the descriptor's — a descriptor names only the attachments
        // whose load op it cares about, and taking the count from it drops the rest of a G-buffer.
        if (target.framebuffer) target.framebuffer.setDrawBuffers(target.colorCount);

        let clearBits = 0;
        for (const attachment of descriptor.colorAttachments) {
            if (attachment.loadOp !== 'clear') continue;
            if (attachment.clearValue) gl.clearBufferfv(gl.COLOR, attachment.target, attachment.clearValue);
            else clearBits |= gl.COLOR_BUFFER_BIT;
        }
        if (descriptor.depthAttachment?.loadOp === 'clear') {
            if (descriptor.depthAttachment.clearValue !== undefined)
                gl.clearBufferfv(gl.DEPTH, 0, [descriptor.depthAttachment.clearValue]);
            else clearBits |= gl.DEPTH_BUFFER_BIT;
        }
        // A GL depth clear is MASKED by `depthMask`; WebGPU's `loadOp: 'clear'` is not. Force it, or a
        // pass whose predecessor left depth writes off silently clears nothing.
        if ((clearBits & gl.DEPTH_BUFFER_BIT) !== 0) GLState.depthMask(true);
        if (clearBits !== 0) gl.clear(clearBits);
    }

    // --------------------------------------------------------------------------------------------
    // The command model — pipelines, bind groups, encoders. See webgl2Commands.ts.
    // --------------------------------------------------------------------------------------------

    /**
     * Compile and link GLSL, then reflect it. The descriptor's WGSL half is ignored — the GLSL was
     * generated from that same module at build time.
     */
    public createShaderProgram(descriptor: ShaderProgramDescriptor): ShaderProgram {
        if (!descriptor.vertex || !descriptor.fragment)
            throw new Error(`${descriptor.label}: WebGL2 needs GLSL vertex and fragment stages`);
        // Dispose on failure: the constructor allocates the two shader objects and `create` throws
        // without deleting them.
        const shader = new Shader();
        try {
            return shader.create(descriptor.vertex, descriptor.fragment);
        } catch (error) {
            shader.dispose();
            throw error;
        }
    }

    public createShaderModule(descriptor: ShaderModuleDescriptor): WebGL2ShaderModule {
        return new WebGL2ShaderModule(descriptor);
    }

    /**
     * An immutable program-plus-state bundle, deduped by descriptor so two passes asking for the same
     * thing get the same object and `RenderPipeline` identity means something.
     */
    public createRenderPipeline(descriptor: RenderPipelineDescriptor): WebGL2RenderPipeline {
        const module = descriptor.vertex as WebGL2ShaderModule;
        // `vertexLayouts` MUST be part of the key: one program legitimately draws buffers of different
        // strides, and `vertexArrayFor` reads its layouts off the pipeline it is handed.
        const key = JSON.stringify([
            module.program, descriptor.primitive, descriptor.depthStencil ?? null, descriptor.colorTargets,
            descriptor.vertexLayouts,
        ]);
        let pipeline = this._pipelines.get(key);
        if (!pipeline) {
            pipeline = new WebGL2RenderPipeline(descriptor);
            this._pipelines.set(key, pipeline);
        }
        return pipeline;
    }

    public createBindGroup(descriptor: BindGroupDescriptor): WebGL2BindGroup {
        return new WebGL2BindGroup(descriptor);
    }

    /** Recorded, not applied — this engine keeps filter and wrap state on the texture. See WebGL2Sampler. */
    public createSampler(descriptor: SamplerDescriptor): WebGL2Sampler {
        return new WebGL2Sampler({ ...descriptor });
    }

    public createTextureView(texture: WebGL2Texture, baseMipLevel: number = 0,
                             baseArrayLayer: number = 0): WebGL2TextureView {
        return new WebGL2TextureView(texture, baseMipLevel, baseArrayLayer);
    }

    /**
     * The same object as {@link createTextureView} with no narrowing — the whole/narrowed distinction
     * is a WebGPU one, and sampling here always binds the whole texture regardless.
     */
    public createWholeTextureView(texture: WebGL2Texture): WebGL2TextureView {
        return new WebGL2TextureView(texture, 0, 0);
    }

    /** Always throws: WebGL2 has no compute stage. Check `capabilities.hasCompute` first. */
    public createComputePipeline(descriptor: ComputePipelineDescriptor): ComputePipeline {
        throw new Error(`${descriptor.label ?? 'compute pipeline'}: WebGL2 has no compute stage — ` +
                        'gate this path on capabilities.hasCompute');
    }

    /**
     * The VAO binding `buffers` through `pipeline`'s vertex layouts, built once per combination and
     * keyed by both. Survives `reallocateBuffer`, which keeps a buffer's handle.
     */
    // TODO: destroying a buffer does not evict its entries, so the cache grows with mesh churn.
    public vertexArrayFor(pipeline: WebGL2RenderPipeline,
                          buffers: readonly (WebGL2Buffer | null)[],
                          indexBuffer: WebGL2Buffer | null): WebGLVertexArrayObject {
        let byBuffers = this._vertexArrays.get(pipeline);
        if (!byBuffers) { byBuffers = new Map(); this._vertexArrays.set(pipeline, byBuffers); }

        const key = buffers.map(b => (b ? b.id : '-')).join(',') + '|' + (indexBuffer ? indexBuffer.id : '-');
        let vao = byBuffers.get(key);
        if (vao) return vao;

        vao = gl.createVertexArray() as WebGLVertexArrayObject;
        GLState.bindVAO(vao);
        pipeline.vertexLayouts.forEach((layout, slot) => {
            const buffer = buffers[slot];
            if (buffer) applyVertexLayout(layout, buffer.handle);
        });
        // The element binding is VAO state, which is why it belongs here rather than at draw time.
        if (indexBuffer) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer.handle);
        GLState.bindVAO(null);
        byBuffers.set(key, vao);
        return vao;
    }

    // -- uploads and readback ---------------------------------------------------------------------

    /**
     * Write tightly packed texels into existing texture storage. Does NOT flip rows, unlike the
     * image-upload paths — raw texel data must land identically on both backends.
     */
    public writeTexture(texture: WebGL2Texture, data: ArrayBufferView, width: number, height: number,
                        mipLevel: number = 0, arrayLayer: number = 0): void {
        texture.bindForUpload();
        texture.write(data, width, height, mipLevel, arrayLayer);
        texture.unbind();
    }

    /**
     * Read a colour attachment back to the CPU; resolves immediately. Rows come back bottom-up, and
     * eight-bit colour only — `RGBA`/`UNSIGNED_BYTE` is invalid against a float target.
     */
    public async readPixels(view: WebGL2TextureView, x: number, y: number,
                            width: number, height: number): Promise<Uint8Array> {
        return this.readPixelsSync(view, x, y, width, height);
    }

    /**
     * Copy a rectangle between texture views, via `blitFramebuffer` over two scratch framebuffers. The
     * buffer bit comes from the DESTINATION's format — a depth texture blitted as colour is a no-op.
     */
    public copyTexture(source: WebGL2TextureView, destination: WebGL2TextureView,
                       width: number, height: number): void {
        if (!this._copyRead) this._copyRead = this.createFramebuffer('copyRead');
        if (!this._copyDraw) this._copyDraw = this.createFramebuffer('copyDraw');
        const depth = isDepthFormat(destination.texture.format);

        // ATTACH FIRST, one framebuffer bound at a time: `framebufferTexture2D` writes to the DRAW
        // binding, so attaching with both bound lands both attachments on the draw framebuffer.
        this._copyRead.bind();
        if (depth) { this._copyRead.attachDepth(source); this._copyRead.setDrawBuffers(0); }
        else { this._copyRead.attachColor(0, source); this._copyRead.setDrawBuffers(1); }

        this._copyDraw.bind();
        if (depth) { this._copyDraw.attachDepth(destination); this._copyDraw.setDrawBuffers(0); }
        else { this._copyDraw.attachColor(0, destination); this._copyDraw.setDrawBuffers(1); }

        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._copyRead.handle);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._copyDraw.handle);
        gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height,
                           depth ? gl.DEPTH_BUFFER_BIT : gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    private readPixelsSync(view: WebGL2TextureView, x: number, y: number,
                          width: number, height: number): Uint8Array {
        const format = view.texture.format;
        if (isDepthFormat(format)) throw new Error(`readPixels cannot read the depth format ${format}`);
        if (TEXTURE_FORMAT_INFO[format].bytesPerTexel !== 4)
            throw new Error(`readPixels needs an 8-bit colour target on WebGL2; this one is ${format}`);

        if (!this._readbackFramebuffer) this._readbackFramebuffer = this.createFramebuffer('readback');
        const framebuffer = this._readbackFramebuffer;
        framebuffer.bind();
        framebuffer.attachColor(0, view);
        framebuffer.setDrawBuffers(1);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);

        const out = new Uint8Array(width * height * 4);
        gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);

        // Detach before unbinding, so the scratch framebuffer never holds a reference that would keep a
        // deleted texture's storage alive — or, worse, be read back on the next call.
        framebuffer.detachColor(0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return out;
    }

    // -- vertex state owned by a caller ------------------------------------------------------------

    /**
     * A vertex array object owned by the caller — what `Mesh` and `TileMesh` bind themselves, as
     * opposed to the ones {@link vertexArrayFor} builds. Tracked, so `destroy()` releases it.
     */
    public createVertexArray(): WebGLVertexArrayObject {
        const vao = gl.createVertexArray() as WebGLVertexArrayObject;
        this._ownedVertexArrays.add(vao);
        return vao;
    }

    public deleteVertexArray(vao: WebGLVertexArrayObject): void {
        this._ownedVertexArrays.delete(vao);
        gl.deleteVertexArray(vao);
    }

    /**
     * Point the CURRENT VAO's element binding at `buffer` — VAO state, not global, which is how a mesh
     * selects one of several LOD index buffers.
     */
    public bindIndexBuffer(buffer: WebGL2Buffer): void {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer.handle);
    }

    /** No-op: WebGL2 timing wraps renderer-defined SCOPES and does not go through the RHI. */
    public setTimestampCollection(_enabled: boolean, _sink: (label: string, ms: number) => void): void {}

    /** No-op. See {@link setTimestampCollection}. */
    public collectTimestamps(): void {}

    /** WebGL2 issues everything as it is recorded, so `finish()` is a no-op — see WebGL2CommandEncoder. */
    public createCommandEncoder(_label?: string): WebGL2CommandEncoder {
        return new WebGL2CommandEncoder((target, descriptor) =>
            this.beginRenderPass(target as WebGL2RenderTarget, descriptor));
    }

    public destroy(): void {
        // Targets first: each owns a framebuffer, and destroying it removes it from `_framebuffers`.
        for (const target of [...this._renderTargets.values()]) target.destroy();
        this._renderTargets.clear();
        this._targetsByTexture.clear();
        this._surfaceTarget = null;
        this._readbackFramebuffer = null;
        for (const framebuffer of [...this._framebuffers]) framebuffer.destroy();
        this._framebuffers.clear();
        for (const buffer of [...this._buffers]) buffer.destroy();
        this._buffers.clear();
        for (const texture of [...this._textures]) texture.destroy();
        this._textures.clear();
        this._pipelines.clear();
        for (const byBuffers of this._vertexArrays.values())
            for (const vao of byBuffers.values()) gl.deleteVertexArray(vao);
        this._vertexArrays.clear();
        for (const vao of this._ownedVertexArrays) gl.deleteVertexArray(vao);
        this._ownedVertexArrays.clear();
    }
}

/**
 * A GPU buffer. Holds its own target and draw hint: a WebGL2 buffer belongs to a target, and
 * re-binding one elsewhere is a driver hazard.
 */
export class WebGL2Buffer implements Buffer {
    /** Stable identity, for cache keys. The WebGLBuffer handle is an opaque object and cannot be one. */
    public readonly id: number = ++WebGL2Buffer._nextId;
    private static _nextId = 0;
    public readonly label: string;
    public readonly usage: BufferUsageFlags;
    public readonly target: number;
    public readonly hint: number;

    private _handle: WebGLBuffer | null;
    private _size: number;
    private readonly _onDestroy: () => void;

    constructor(descriptor: BufferDescriptor, onDestroy: () => void) {
        this.label = descriptor.label ?? 'buffer';
        this._size = descriptor.size;
        this.usage = descriptor.usage;
        this.target = glBufferTarget(descriptor.usage);
        this.hint = glBufferUsageHint(descriptor.usage);
        this._handle = gl.createBuffer();
        this._onDestroy = onDestroy;

        // Allocate up front when a size was given, so a later partial write has storage to land in.
        // A size of 0 means "sized by the first whole-buffer write".
        if (this._size > 0) {
            gl.bindBuffer(this.target, this._handle);
            gl.bufferData(this.target, this._size, this.hint);
        }
    }

    /** Bytes currently allocated. Changes only through {@link WebGL2Device.reallocateBuffer}. */
    public get size(): number { return this._size; }

    /** @internal Written by reallocateBuffer, which is the only operation that may resize a buffer. */
    public setSize(size: number): void { this._size = size; }

    /** The underlying WebGL object, for the callers that still build their own VAO. */
    public get handle(): WebGLBuffer {
        if (!this._handle) throw new Error(`Buffer "${this.label}" used after destroy()`);
        return this._handle;
    }

    public destroy(): void {
        if (!this._handle) return;
        gl.deleteBuffer(this._handle);
        this._handle = null;
        this._onDestroy();
    }
}

let anisoExt: any | null | undefined;

/**
 * `EXT_texture_filter_anisotropic`, fetched on FIRST USE rather than at module load: `gl` is a live
 * binding that is still null while this module is being evaluated. `undefined` means "not asked yet";
 * `null` means "asked, and the driver withholds it".
 */
function anisotropyExt(): any | null {
    if (anisoExt === undefined) anisoExt = anisotropyExtension(gl) ?? null;
    return anisoExt;
}

/**
 * A GPU texture. Byte accounting goes through the shared {@link textureByteSize} and reports the format
 * actually ALLOCATED, not the one requested, so a float downgrade is not counted at 2x.
 */
export class WebGL2Texture implements Texture {
    /** Stable identity, for cache keys — see {@link viewKey}. A WebGLTexture handle cannot be one. */
    public readonly id: number = ++WebGL2Texture._nextId;
    private static _nextId = 0;
    public readonly label: string;
    public readonly format: TextureFormat;
    public readonly dimension: TextureDimension;
    public readonly usage: TextureUsageFlags;
    public readonly target: number;

    private _handle: WebGLTexture | null;
    private _width: number;
    private _height: number;
    private _depthOrArrayLayers: number;
    private _mipLevelCount: number;
    private readonly _onDestroy: () => void;

    // The format triple every upload entry point needs, plus the sampler state. Set by configure().
    private _internalFormat: number = 0;
    private _glFormat: number = 0;
    private _type: number = 0;
    private _wrapS: number = 0;
    private _wrapT: number = 0;
    private _wrapR: number = 0;
    private _minFilter: number = 0;
    private _magFilter: number = 0;
    private _maxAnisotropy: number = 1;
    private _lodMinClamp: number | undefined;
    private _lodMaxClamp: number | undefined;
    /** Set once an upload or allocation has given this texture storage worth reconfiguring. */
    private _hasStorage: boolean = false;
    private _flipY: boolean = false;
    private _isDepth: boolean = false;
    private _boundSlot: number = 0;

    constructor(descriptor: TextureDescriptor, onDestroy: () => void) {
        this.label = descriptor.label ?? 'texture';
        this.format = descriptor.format;
        this.dimension = descriptor.dimension ?? '2d';
        this.usage = descriptor.usage;
        this.target = glTextureTarget(this.dimension);
        this._width = descriptor.width;
        this._height = descriptor.height;
        this._depthOrArrayLayers = descriptor.depthOrArrayLayers ?? 1;
        this._mipLevelCount = descriptor.mipLevelCount ?? 1;
        this._handle = gl.createTexture();
        this._onDestroy = onDestroy;
    }

    public get width(): number { return this._width; }
    public get height(): number { return this._height; }
    public get depthOrArrayLayers(): number { return this._depthOrArrayLayers; }
    public get mipLevelCount(): number { return this._mipLevelCount; }

    /** Always 0: this backend re-specifies storage in place and never replaces the texture object. */
    public readonly generation = 0;

    public setSize(width: number, height: number, depthOrArrayLayers: number = 1, mipLevelCount: number = 1): void {
        this._width = width;
        this._height = height;
        this._depthOrArrayLayers = depthOrArrayLayers;
        this._mipLevelCount = mipLevelCount;
    }

    public get byteSize(): number {
        // A cube's six faces are six full images at these dimensions, which the layer count carries.
        const layers = this.dimension === 'cube' ? this._depthOrArrayLayers * 6 : this._depthOrArrayLayers;
        return textureByteSize(this.format, this._width, this._height, layers, this._mipLevelCount);
    }

    /**
     * Settle the format triple and sampler state every upload below applies. Resolved HERE from the
     * neutral descriptor, never by the caller.
     */
    public configure(descriptor: TextureConfigureDescriptor): void {
        const triple = glTextureFormat(descriptor.format);
        this._internalFormat = triple.internalFormat;
        this._glFormat = triple.format;
        this._type = triple.type;
        this._wrapS = glAddressMode(descriptor.addressModeU);
        this._wrapT = glAddressMode(descriptor.addressModeV);
        this._wrapR = glAddressMode(descriptor.addressModeW);
        // WebGL2 fuses minification and the mip filter into a single enum. glMinFilter takes exactly the
        // pair the descriptor carries and does the fold here, which is why the descriptor keeps them
        // apart: the old fused spelling had no way to say "nearest minification WITH a mip chain".
        this._minFilter = glMinFilter(descriptor.minFilter, descriptor.mipmapFilter);
        this._magFilter = glMagFilter(descriptor.magFilter);
        this._maxAnisotropy = Math.max(1, Math.min(descriptor.maxAnisotropy, device.capabilities.maxAnisotropy));
        this._lodMinClamp = descriptor.lodMinClamp;
        this._lodMaxClamp = descriptor.lodMaxClamp;
        this._flipY = descriptor.flipY;
        this._isDepth = descriptor.isDepth;
        // A RE-configure has no upload behind it to carry the new state to the driver, so it is pushed
        // now. Skipped before the first upload, when there is no storage to parameterise.
        if (this._hasStorage) {
            this.bindForUpload();
            this._applySamplerState();
            this.unbind();
        }
    }

    /** Bind for SAMPLING, through the state cache. The frame's hottest bind path. */
    public bind(slot: number = 0): void {
        this._boundSlot = slot;
        GLState.bindTexture(slot, this.target, this.handle);
    }

    /**
     * Bind for MUTATION. texImage/texParameter/generateMipmap act on the active unit, so this forces
     * both the unit and the binding rather than letting the cache elide either.
     */
    public bindForUpload(): void {
        this._boundSlot = 0;
        GLState.bindTextureForced(0, this.target, this.handle);
    }

    /** Release whichever unit this texture was last bound to. */
    public unbind(): void {
        GLState.bindTexture(this._boundSlot, this.target, null);
    }

    /**
     * The sampler state `create()` applies: forced NEAREST/CLAMP for depth, configured otherwise.
     * The caller must have bound the texture for mutation — texParameter acts on the active unit.
     */
    private _applySamplerState(): void {
        this._hasStorage = true;
        if (this._isDepth) {
            gl.texParameteri(this.target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(this.target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(this.target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(this.target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return;
        }
        gl.texParameteri(this.target, gl.TEXTURE_MIN_FILTER, this._minFilter);
        gl.texParameteri(this.target, gl.TEXTURE_MAG_FILTER, this._magFilter);
        gl.texParameteri(this.target, gl.TEXTURE_WRAP_S, this._wrapS);
        gl.texParameteri(this.target, gl.TEXTURE_WRAP_T, this._wrapT);
        // R addresses the third axis, which only 3D and array targets have. WRAP_R on a 2D texture is
        // an INVALID_ENUM, so it is gated rather than written unconditionally.
        if (this.target === gl.TEXTURE_3D || this.target === gl.TEXTURE_2D_ARRAY)
            gl.texParameteri(this.target, gl.TEXTURE_WRAP_R, this._wrapR);

        // Both clamps go together whenever either is authored: they are texture state, so writing one
        // and leaving the other at its default silently opens the range back up at that end.
        if (this._lodMinClamp !== undefined || this._lodMaxClamp !== undefined) {
            gl.texParameterf(this.target, gl.TEXTURE_MIN_LOD, this._lodMinClamp ?? -1000);
            gl.texParameterf(this.target, gl.TEXTURE_MAX_LOD, this._lodMaxClamp ?? 1000);
        }

        // Written even at 1, not only when raised: sampler state lives on the texture object, so a
        // texture reconfigured back down to isotropic would otherwise keep the driver's last value.
        const ext = anisotropyExt();
        if (ext) gl.texParameterf(this.target, ext.TEXTURE_MAX_ANISOTROPY_EXT, this._maxAnisotropy);
    }

    /** Upload a 2D image, or allocate an empty 2D render target when `image` is null. */
    public upload2D(image: TexImageSource | null, width: number, height: number, mipMap: boolean): void {
        this.bindForUpload();
        this._clearPendingErrors();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, this._flipY);
        if (image) gl.texImage2D(this.target, 0, this._internalFormat, this._glFormat, this._type, image);
        else gl.texImage2D(this.target, 0, this._internalFormat, width, height, 0, this._glFormat, this._type, null);
        this._applySamplerState();
        if (mipMap) gl.generateMipmap(this.target);
        this.checkForErrors();
    }

    /** The six cube-face targets, in GL face order. */
    public static cubeFaces(): number[] {
        return [
            gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
            gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
            gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
        ];
    }

    /** Upload all six cube faces, or allocate six empty ones when `images` is null. */
    public uploadCube(images: readonly TexImageSource[] | null, width: number, height: number, mipMap: boolean): void {
        this.bindForUpload();
        this._clearPendingErrors();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, this._flipY);
        const faces = WebGL2Texture.cubeFaces();
        for (let i = 0; i < faces.length; i++) {
            if (images) gl.texImage2D(faces[i], 0, this._internalFormat, this._glFormat, this._type, images[i]);
            else gl.texImage2D(faces[i], 0, this._internalFormat, width, height, 0, this._glFormat, this._type, null);
        }
        this._applySamplerState();
        if (mipMap) gl.generateMipmap(this.target);
        this.checkForErrors();
    }

    /** Upload one cube face, by index into +X -X +Y -Y +Z -Z — not a GL face enum. */
    public uploadFace(face: number, image: TexImageSource, mipMap: boolean): void {
        this.bindForUpload();
        const target = WebGL2Texture.cubeFaces()[face];
        this._clearPendingErrors();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, this._flipY);
        gl.texImage2D(target, 0, this._internalFormat, this._glFormat, this._type, image);
        if (mipMap) gl.generateMipmap(this.target);
        this.checkForErrors();
    }

    /**
     * Upload raw RGBA bytes. Always RGBA8/UNSIGNED_BYTE and never flipped or mipmapped, so the data
     * maps 1:1 to UVs — this is the editable-splat-map path, which `uploadRegion` then patches.
     */
    public uploadBytes(data: Uint8Array, width: number, height: number, wrapping: AddressMode): void {
        this.bindForUpload();
        this._clearPendingErrors();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(this.target, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.texParameteri(this.target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(this.target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(this.target, gl.TEXTURE_WRAP_S, glAddressMode(wrapping));
        gl.texParameteri(this.target, gl.TEXTURE_WRAP_T, glAddressMode(wrapping));
        this.checkForErrors();
    }

    public uploadRegion(x: number, y: number, width: number, height: number, data: Uint8Array): void {
        this.bindForUpload();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texSubImage2D(this.target, 0, x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

    /**
     * Write tightly packed texels into one mip level and one layer or cube face of EXISTING storage —
     * a sub-image, never an allocation, and never flipped. `arrayLayer` selects a cube face or a layer.
     */
    public write(data: ArrayBufferView, width: number, height: number,
                 mipLevel: number, arrayLayer: number): void {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        switch (this.dimension) {
            case 'cube':
                gl.texSubImage2D(WebGL2Texture.cubeFaces()[arrayLayer], mipLevel, 0, 0, width, height,
                                 this._glFormat, this._type, data);
                break;
            case '2d-array':
            case '3d':
                gl.texSubImage3D(this.target, mipLevel, 0, 0, arrayLayer, width, height, 1,
                                 this._glFormat, this._type, data);
                break;
            default:
                gl.texSubImage2D(this.target, mipLevel, 0, 0, width, height,
                                 this._glFormat, this._type, data);
        }
    }

    // Fail loudly when an allocation is aimed at a target this texture was not created for: the bind
    // and the allocation would land on different targets, and the driver would silently do nothing.
    private _requireDimension(expected: TextureDimension, method: string): void {
        if (this.dimension !== expected)
            throw new Error(`Texture "${this.label}": ${method} needs a '${expected}' texture, ` +
                            `but this one was created as '${this.dimension}'`);
    }

    /** Immutable storage for a renderable cubemap: `levels` mips per face. */
    public allocateCube(size: number, levels: number): void {
        this._requireDimension('cube', 'allocateCube');
        this.bindForUpload();
        gl.texStorage2D(gl.TEXTURE_CUBE_MAP, levels, this._internalFormat, size, size);
        const minFilter = levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, minFilter);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    }

    /**
     * Immutable storage for a renderable 3D volume. `texStorage3D`, not `texImage3D` — only immutable
     * storage makes the slices valid `framebufferTextureLayer` attachments.
     */
    public allocateVolume(width: number, height: number, depth: number, wrapping: AddressMode): void {
        this._requireDimension('3d', 'allocateVolume');
        this.bindForUpload();
        this._clearPendingErrors();
        gl.texStorage3D(gl.TEXTURE_3D, 1, this._internalFormat, width, height, depth);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        const wrap = glAddressMode(wrapping);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, wrap);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, wrap);
        this.checkForErrors();
    }

    /**
     * Immutable storage for a renderable depth ARRAY — the cascaded shadow map. A `compare` texture
     * must NOT inherit the forced NEAREST other depth textures get, and wraps CLAMP, never REPEAT.
     */
    public allocateDepthArray(size: number, layers: number, compare: boolean): void {
        this._requireDimension('2d-array', 'allocateDepthArray');
        this.bindForUpload();
        this._clearPendingErrors();
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, this._internalFormat, size, size, layers);
        const filter = compare ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (compare) {
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LESS);
        }
        this.checkForErrors();
    }

    /**
     * Toggle hardware depth comparison. Sampling a COMPARE_REF_TO_TEXTURE texture through a non-shadow
     * sampler is undefined, so the cascade debug blit switches it off around its draw.
     */
    public setCompareMode(enabled: boolean): void {
        this.bindForUpload();
        gl.texParameteri(this.target, gl.TEXTURE_COMPARE_MODE, enabled ? gl.COMPARE_REF_TO_TEXTURE : gl.NONE);
        gl.texParameteri(this.target, gl.TEXTURE_MIN_FILTER, enabled ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(this.target, gl.TEXTURE_MAG_FILTER, enabled ? gl.LINEAR : gl.NEAREST);
    }

    /** The encoder argument is WebGPU's; `gl.generateMipmap` is immediate-mode and already ordered. */
    public generateMipmaps(): void {
        this.bindForUpload();
        gl.generateMipmap(this.target);
    }

    // Drain any already-flagged error first: `gl.getError()` is a GLOBAL sticky flag, so a later check
    // would blame this texture for whatever went wrong anywhere since the last one.
    private _clearPendingErrors(): void {
        // Bounded: the queue can hold several, and a driver that always returns an error would
        // otherwise spin here forever.
        for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) { /* drain */ }
    }

    /** Report a GL error raised since {@link _clearPendingErrors}, attributed to this texture. */
    public checkForErrors(): void {
        const error = gl.getError();
        if (error !== gl.NO_ERROR)
            Logger.error('Error creating texture: ' + error + ' with format ' + this.format +
                         ', internal format ' + this._internalFormat + ', gl format ' + this._glFormat, 'Texture');
    }

    /** The underlying WebGL object. Temporary, for the same reason as {@link WebGL2Buffer.handle}. */
    public get handle(): WebGLTexture {
        if (!this._handle) throw new Error(`Texture "${this.label}" used after destroy()`);
        return this._handle;
    }

    public destroy(): void {
        if (!this._handle) return;
        gl.deleteTexture(this._handle);
        this._handle = null;
        this._onDestroy();
    }
}

// The identity of a view, for the render-target cache. Texture id, not the handle, which is opaque.
function viewKey(view: WebGL2TextureView): string {
    return `${view.texture.id}:${view.baseMipLevel}:${view.baseArrayLayer}`;
}

/**
 * A framebuffer object — just a name that attachments hang off. What hangs off it is decided by
 * {@link WebGL2Device.createRenderTarget}, from the DIMENSION of each view's texture.
 */
export class WebGL2Framebuffer {
    public readonly label: string;

    private _handle: WebGLFramebuffer | null;
    private readonly _onDestroy: () => void;

    constructor(label: string, onDestroy: () => void) {
        this.label = label;
        this._handle = gl.createFramebuffer();
        this._onDestroy = onDestroy;
    }

    /** Make this the current draw target. Viewport and clears are a pass concern — see beginRenderPass. */
    public bind(): void { gl.bindFramebuffer(gl.FRAMEBUFFER, this.handle); }

    /**
     * Attach a colour view, picking the entry point from the view's texture DIMENSION — a 2D target, a
     * cube face and one array layer are three WebGL2 calls but one WebGPU concept.
     */
    public attachColor(index: number, view: WebGL2TextureView): void {
        const texture = view.texture;
        switch (texture.dimension) {
            case 'cube':
                this.attachColorCubeFace(index, texture.handle, view.baseArrayLayer, view.baseMipLevel);
                break;
            case '2d-array':
            case '3d':
                this.attachColorLayer(index, texture.handle, view.baseArrayLayer, view.baseMipLevel);
                break;
            default:
                this.attachColor2D(index, texture.handle, view.baseMipLevel);
        }
    }

    /** Attach a depth view. The same dispatch as {@link attachColor}; a cube depth face is not a case
     *  the engine has, so it is not silently mis-attached — it throws. */
    public attachDepth(view: WebGL2TextureView): void {
        const texture = view.texture;
        switch (texture.dimension) {
            case '2d-array':
            case '3d':
                this.attachDepthLayer(texture.handle, view.baseArrayLayer, view.baseMipLevel);
                break;
            case 'cube':
                throw new Error(`Framebuffer "${this.label}": a cube face cannot be a depth attachment`);
            default:
                this.attachDepth2D(texture.handle, view.baseMipLevel);
        }
    }

    /** Attach a 2D colour target. `mip` selects a level of a mipmapped target. */
    public attachColor2D(index: number, texture: WebGLTexture, mip: number = 0): void {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, gl.TEXTURE_2D, texture, mip);
    }

    /** Attach one face of a cubemap as a colour target. `face` is an index 0..5 in GL face order. */
    public attachColorCubeFace(index: number, texture: WebGLTexture, face: number, mip: number = 0): void {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index,
                                gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, texture, mip);
    }

    /** Attach one layer of a 2D array, or one slice of a 3D texture, as a colour target. */
    public attachColorLayer(index: number, texture: WebGLTexture, layer: number, mip: number = 0): void {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, texture, mip, layer);
    }

    /** Release colour attachment `index`. Used by the readback scratch framebuffer between calls. */
    public detachColor(index: number): void {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, gl.TEXTURE_2D, null, 0);
    }

    public attachDepth2D(texture: WebGLTexture, mip: number = 0): void {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, mip);
    }

    public attachDepthLayer(texture: WebGLTexture, layer: number, mip: number = 0): void {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, texture, mip, layer);
    }

    /**
     * Declare which colour attachments this framebuffer writes. A `count` of 0 is depth-only and needs
     * BOTH `drawBuffers([NONE])` and `readBuffer(NONE)`, or the framebuffer is incomplete.
     */
    public setDrawBuffers(count: number): void {
        if (count <= 0) {
            gl.drawBuffers([gl.NONE]);
            gl.readBuffer(gl.NONE);
            return;
        }
        const attachments: number[] = [];
        for (let i = 0; i < count; i++) attachments.push(gl.COLOR_ATTACHMENT0 + i);
        gl.drawBuffers(attachments);
    }

    /** Log and return false when the attachment set is incomplete. An incomplete framebuffer drops
     *  every draw silently, so this is the only place the mistake is visible. */
    public checkStatus(context: string): boolean {
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status === gl.FRAMEBUFFER_COMPLETE) return true;
        Logger.error('Framebuffer "' + this.label + '" incomplete (' + status + ') during ' + context, 'Renderer');
        return false;
    }

    public get handle(): WebGLFramebuffer {
        if (!this._handle) throw new Error(`Framebuffer "${this.label}" used after destroy()`);
        return this._handle;
    }

    public destroy(): void {
        if (!this._handle) return;
        gl.deleteFramebuffer(this._handle);
        this._handle = null;
        this._onDestroy();
    }
}

/**
 * The live device, narrowed to THIS backend — a greppable exception for the callers that still name a
 * concept WebGPU has no equivalent of. Throws under any other backend rather than mis-typing.
 */
export function glDevice(): WebGL2Device {
    if (!(device instanceof WebGL2Device))
        throw new Error('a WebGL2-only path was reached while a different backend is active');
    return device;
}

/**
 * Release the current device's resources, for a lost or replaced context. Also resets `GLState`, whose
 * cache would otherwise describe a context that no longer exists.
 */
export function destroyDevice(): void {
    if (!device) return;
    device.destroy();
    GLState.reset();
}

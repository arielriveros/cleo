import { gl } from '../../glContext';
import { GLState } from '../../systems/glState';
import { Logger } from '../../../core/logger';
import { setViewportSize } from '../../renderStats';
import { glBufferTarget, glBufferUsageHint, glTextureTarget } from './glEnums';
import { detectWebGL2Capabilities } from './capabilities';
import { applyVertexLayout } from './vertexArray';
import {
    WebGL2ShaderModule, WebGL2RenderPipeline, WebGL2BindGroup, WebGL2Sampler,
    WebGL2TextureView, WebGL2CommandEncoder,
} from './webgl2Commands';
import type {
    DeviceCapabilities, BackendKind, BufferDescriptor, TextureDescriptor,
    ShaderModuleDescriptor, RenderPipelineDescriptor, BindGroupDescriptor,
} from '../device';
import type { RenderPassDescriptor } from '../types';
import type { Buffer, Texture } from '../resources';
import type { BufferUsageFlags, TextureFormat, TextureDimension, TextureUsageFlags, SamplerDescriptor } from '../types';
import { textureByteSize } from '../types';

/**
 * The WebGL2 implementation of the RHI device.
 *
 * Deliberately NOT declared `implements Device` yet. The interface in `../device.ts` describes the
 * finished thing, and claiming it now would mean methods that throw — which reads as "supported" to
 * every caller and to the compiler alike. Each capability is added here as the renderer is migrated off
 * raw `gl.*`; when the last one lands, the `implements` clause goes on and the interface starts being
 * enforced.
 *
 * Migrated so far: buffers, textures, framebuffers, render-pass boundaries, and the command model —
 * shader modules, pipelines, bind groups and pass encoders (see `webgl2Commands.ts`).
 *
 * Still missing, and each blocking a specific group of passes: vertex/index buffer state on the pass
 * encoder (the geometry passes), `copyTextureToTexture` (the depth copy), `readPixels` (thumbnail
 * capture), and `getCurrentSurfaceTarget`.
 */
export class WebGL2Device {
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

    constructor(context: WebGL2RenderingContext) {
        this.capabilities = detectWebGL2Capabilities(context);
    }

    /**
     * Returns the concrete backend buffer, not the RHI `Buffer` interface.
     *
     * A backend may be more specific than the contract it fulfils, and callers inside the WebGL2 half —
     * `Mesh` building a VAO, the renderer binding an instance buffer — genuinely need `handle`. Code
     * above the RHI takes the interface and never sees it.
     */
    public createBuffer(descriptor: BufferDescriptor): WebGL2Buffer {
        const buffer = new WebGL2Buffer(descriptor, () => this._buffers.delete(buffer));
        this._buffers.add(buffer);
        return buffer;
    }

    /**
     * Write into part of an existing buffer, leaving its size alone.
     *
     * This is WebGPU's `queue.writeBuffer` semantic exactly: a sub-write, never a reallocation. Keeping
     * it strict matters — an earlier version fell back to a whole-buffer `bufferData` whenever the data
     * happened to fill the buffer, which silently turned terrain sculpting and the tilemap's per-frame
     * UV update into reallocations instead of the in-place updates they were written as.
     */
    public writeBuffer(buffer: WebGL2Buffer, offset: number, data: ArrayBufferView): void {
        gl.bindBuffer(buffer.target, buffer.handle);
        gl.bufferSubData(buffer.target, offset, data);
    }

    /**
     * Replace a buffer's entire contents, resizing it to fit.
     *
     * The other half of the pair, and deliberately named for what it costs: `bufferData` discards the
     * previous storage, which lets the driver hand back new memory rather than stalling until in-flight
     * draws stop reading the old. That is the right call for a full rebuild (a remeshed tilemap chunk,
     * the instance-matrix array each frame) and the wrong one for a partial edit.
     *
     * A WebGPU backend has no direct equivalent and satisfies this by recreating the buffer, which is
     * why the size is allowed to change here and nowhere else.
     */
    public reallocateBuffer(buffer: WebGL2Buffer, data: ArrayBufferView): void {
        gl.bindBuffer(buffer.target, buffer.handle);
        gl.bufferData(buffer.target, data, buffer.hint);
        buffer.setSize(data.byteLength);
    }

    /**
     * Allocate a texture object.
     *
     * Only the object: the storage still comes from whichever upload path the caller uses, because
     * WebGL2 has half a dozen of them (`texImage2D` per cube face, `texStorage3D` for a volume,
     * `texStorage2D` for an immutable array) and collapsing those into one descriptor is a separate
     * change from owning the handle and the lifetime. Dimensions are reported back through
     * {@link WebGL2Texture.setSize} once the upload knows them.
     */
    public createTexture(descriptor: TextureDescriptor): WebGL2Texture {
        const texture = new WebGL2Texture(descriptor, () => this._textures.delete(texture));
        this._textures.add(texture);
        return texture;
    }

    /**
     * Allocate a framebuffer object.
     *
     * The attachments are still the caller's business — `Framebuffer` attaches 2D colour targets,
     * `CubeFramebuffer` swaps one face per draw, `LayeredDepthFramebuffer` points at one layer of an
     * array — and those three shapes are exactly what a `RenderTarget` descriptor will unify later.
     * What moves here now is the handle and the lifetime, which is what was actually leaking: only
     * LayeredDepthFramebuffer ever deleted its own, so every other framebuffer the engine made lived
     * until the context died.
     */
    public createFramebuffer(label: string = 'framebuffer'): WebGL2Framebuffer {
        const framebuffer = new WebGL2Framebuffer(label, () => this._framebuffers.delete(framebuffer));
        this._framebuffers.add(framebuffer);
        return framebuffer;
    }

    /**
     * Begin a render pass: bind the target, set the viewport, and honour each attachment's load op.
     *
     * This replaces the `fbo.bind(); gl.clear(BITS);` pair that every pass in the renderer opened with.
     * The two were only ever adjacent by convention — nothing stopped a pass binding and forgetting to
     * clear, and one that did produced a frame of the previous pass's contents rather than an error.
     *
     * `loadOp: 'clear'` without a `clearValue` uses the context's standing clear colour, which is what
     * `gl.clear` did and what the renderer's `clearColor` setting still means. A descriptor that names
     * a value gets `clearBufferfv` instead, per attachment.
     *
     * `storeOp` is recorded but not acted on: WebGL2 always stores. It is here because on a tile-based
     * mobile GPU `'discard'` is what lets the driver skip writing a scratch target back out of tile
     * memory at all, and WebGPU exposes it directly.
     */
    public beginRenderPass(target: RenderPassTarget, descriptor: RenderPassDescriptor): void {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer ? target.framebuffer.handle : null);

        // Render into ONE layer of an array depth target: the shadow cascades and the spot atlas.
        // WebGPU expresses this as a view with a `baseArrayLayer`; WebGL2 re-points the framebuffer's
        // depth attachment at the layer, which is what `LayeredDepthFramebuffer.bindLayer` did by hand.
        const layer = descriptor.depthAttachment?.baseArrayLayer;
        if (layer !== undefined && target.framebuffer && target.depthTexture)
            target.framebuffer.attachDepthLayer(target.depthTexture, layer);

        // How many colour attachments the TARGET has — not how many the descriptor happens to mention.
        // Those differ: a pass descriptor names the attachments whose load op it cares about, and the
        // fullscreen helper names exactly one even when drawing into the 3-attachment G-buffer. Taking
        // the count from the descriptor set draw buffers to 1 there and threw away the normal and
        // emissive targets — a spectacular failure, but one that renders rather than throwing.
        //
        // Zero is not a degenerate case but the shadow maps' normal one: with no colour attachment,
        // BOTH draw and read buffers must be explicitly NONE or the framebuffer is incomplete.
        if (target.framebuffer && target.colorCount !== undefined)
            target.framebuffer.setDrawBuffers(target.colorCount);
        gl.viewport(0, 0, target.width, target.height);
        setViewportSize(target.width, target.height);

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
        // A GL depth clear is MASKED by `depthMask`; WebGPU's `loadOp: 'clear'` is not. Without this the
        // clear silently does nothing whenever the previous pass left depth writes off — and a pass
        // beginning with stale depth is exactly the failure the load op exists to prevent. Forcing the
        // mask here also means a pass no longer depends on inherited state to honour its own descriptor.
        if ((clearBits & gl.DEPTH_BUFFER_BIT) !== 0) GLState.depthMask(true);
        if (clearBits !== 0) gl.clear(clearBits);
    }

    // --------------------------------------------------------------------------------------------
    // The command model — pipelines, bind groups, encoders. See webgl2Commands.ts.
    // --------------------------------------------------------------------------------------------

    /**
     * A handle to an already-registered program, plus its build-time reflection.
     *
     * Nothing is compiled here: `Renderer` links and registers every program through `Shader` and
     * `ShaderManager` during initialization, and re-doing that inside the backend would duplicate the
     * uniform reflection and std140 handling that the migration depends on.
     */
    public createShaderModule(descriptor: ShaderModuleDescriptor): WebGL2ShaderModule {
        return new WebGL2ShaderModule(descriptor);
    }

    /**
     * An immutable program + state bundle, deduped by descriptor.
     *
     * Cached because a pipeline is pure data on this backend — two passes asking for the same program
     * and the same state must get the same object, or `RenderPipeline` identity stops meaning anything
     * to a caller that compares them. The key is JSON of the state precisely because `rhi/types.ts`
     * chose string unions over numeric enums.
     */
    public createRenderPipeline(descriptor: RenderPipelineDescriptor): WebGL2RenderPipeline {
        const module = descriptor.vertex as WebGL2ShaderModule;
        const key = JSON.stringify([
            module.program, descriptor.primitive, descriptor.depthStencil ?? null, descriptor.colorTargets,
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
     * The VAO that binds `buffers` through `pipeline`'s vertex layouts, built once per combination.
     *
     * WebGPU has no such object — a pipeline carries its vertex layouts and buffers are bound per draw.
     * WebGL2 needs the two baked together, so this is where that difference lives. Keyed by pipeline
     * AND buffers because the same mesh drawn by two programs needs two VAOs (their attribute locations
     * differ) and the same program over two meshes likewise.
     *
     * Reallocating a buffer's storage keeps its handle, so a VAO survives `reallocateBuffer` — which is
     * what terrain sculpting and the per-frame instance upload both do. Destroying a buffer does not
     * invalidate the entry: the cache grows with mesh churn until the device is destroyed. That is worth
     * fixing before this path carries a scene's whole draw list, and is called out rather than hidden.
     */
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

    /** WebGL2 issues everything as it is recorded, so `finish()` is a no-op — see WebGL2CommandEncoder. */
    public createCommandEncoder(_label?: string): WebGL2CommandEncoder {
        return new WebGL2CommandEncoder((target, descriptor) =>
            this.beginRenderPass(target as unknown as RenderPassTarget, descriptor));
    }

    public destroy(): void {
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
    }
}

/**
 * A GPU buffer.
 *
 * Holds its own target and draw hint rather than taking them per call, because in WebGL2 a buffer is
 * bound to a target and re-binding the same buffer elsewhere is a driver hazard, not a convenience.
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
        // A size of 0 means "sized by the first whole-buffer write", which is how geometry uploads
        // work: the vertex count is not known until the data arrives.
        if (this._size > 0) {
            gl.bindBuffer(this.target, this._handle);
            gl.bufferData(this.target, this._size, this.hint);
        }
    }

    /** Bytes currently allocated. Changes only through {@link WebGL2Device.reallocateBuffer}. */
    public get size(): number { return this._size; }

    /** @internal Written by reallocateBuffer, which is the only operation that may resize a buffer. */
    public setSize(size: number): void { this._size = size; }

    /**
     * The underlying WebGL object.
     *
     * The one deliberate hole in the abstraction, and a temporary one: `Mesh` still builds its own VAO
     * and the renderer still binds buffers by hand, so both need the handle. It disappears when render
     * pipelines take over vertex-layout ownership in M5.
     */
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

/**
 * A GPU texture.
 *
 * Byte accounting goes through the shared {@link textureByteSize}, which sums the real mip levels
 * rather than using the 4/3 (or 8/7 for a volume) closed form the engine used to. The difference is
 * small and in the honest direction — a chain stops at 1x1 rather than converging on a limit — and it
 * means the renderer's GPU-memory readout and the RHI agree on one formula instead of two.
 *
 * It also reports the format actually ALLOCATED. The old accounting read the requested precision, so a
 * high-precision target silently downgraded to RGBA8 on a device without float support still reported
 * itself as 16-bit — inflating the reported total by 2x exactly when memory pressure mattered most.
 */
export class WebGL2Texture implements Texture {
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

    // The WebGL2-specific half: the format triple every upload entry point needs, plus the sampler
    // state `create()` applies. Set by configure(), which the engine-level Texture calls once it has
    // resolved a format against the device's capabilities.
    private _internalFormat: number = 0;
    private _glFormat: number = 0;
    private _type: number = 0;
    private _wrapping: number = 0;
    private _minFilter: number = 0;
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

    /** Record the dimensions an upload just established. */
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

    /** The GL format triple and sampler state this texture uploads with. */
    public configure(internalFormat: number, format: number, type: number,
                     wrapping: number, minFilter: number, flipY: boolean, isDepth: boolean): void {
        this._internalFormat = internalFormat;
        this._glFormat = format;
        this._type = type;
        this._wrapping = wrapping;
        this._minFilter = minFilter;
        this._flipY = flipY;
        this._isDepth = isDepth;
    }

    /**
     * Bind for *sampling*, through the GL state cache — a rebind of the texture already on that unit
     * costs nothing. This is the frame's hottest bind path (every material map on every draw).
     */
    public bind(slot: number = 0): void {
        this._boundSlot = slot;
        GLState.bindTexture(slot, this.target, this.handle);
    }

    /**
     * Bind for *mutation* (texImage/texParameter/generateMipmap), which all act on the active unit —
     * so this forces both the unit and the binding rather than letting the cache elide either.
     */
    public bindForUpload(): void {
        this._boundSlot = 0;
        GLState.bindTextureForced(0, this.target, this.handle);
    }

    /** Release whichever unit this texture was last bound to. */
    public unbind(): void {
        GLState.bindTexture(this._boundSlot, this.target, null);
    }

    /** The sampler state `create()` applies: forced NEAREST/CLAMP for depth, configured otherwise. */
    private _applySamplerState(): void {
        const params = this._isDepth
            ? [gl.NEAREST, gl.NEAREST, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE]
            : [this._minFilter, gl.LINEAR, this._wrapping, this._wrapping];
        gl.texParameteri(this.target, gl.TEXTURE_MIN_FILTER, params[0]);
        gl.texParameteri(this.target, gl.TEXTURE_MAG_FILTER, params[1]);
        gl.texParameteri(this.target, gl.TEXTURE_WRAP_S, params[2]);
        gl.texParameteri(this.target, gl.TEXTURE_WRAP_T, params[3]);
    }

    /** Upload a 2D image, or allocate an empty 2D render target when `image` is null. */
    public upload2D(image: TexImageSource | null, width: number, height: number, mipMap: boolean): void {
        this._clearPendingErrors();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !this._flipY);
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
        this._clearPendingErrors();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !this._flipY);
        const faces = WebGL2Texture.cubeFaces();
        for (let i = 0; i < faces.length; i++) {
            if (images) gl.texImage2D(faces[i], 0, this._internalFormat, this._glFormat, this._type, images[i]);
            else gl.texImage2D(faces[i], 0, this._internalFormat, width, height, 0, this._glFormat, this._type, null);
        }
        this._applySamplerState();
        if (mipMap) gl.generateMipmap(this.target);
        this.checkForErrors();
    }

    /** Upload one cube face. `face` is a GL face target from {@link cubeFaces}. */
    public uploadFace(face: number, image: TexImageSource, mipMap: boolean): void {
        this._clearPendingErrors();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !this._flipY);
        gl.texImage2D(face, 0, this._internalFormat, this._glFormat, this._type, image);
        if (mipMap) gl.generateMipmap(this.target);
        this.checkForErrors();
    }

    /**
     * Upload raw RGBA bytes. Always RGBA8/UNSIGNED_BYTE and never flipped or mipmapped, so the data
     * maps 1:1 to UVs — this is the editable-splat-map path, which `uploadRegion` then patches.
     */
    public uploadBytes(data: Uint8Array, width: number, height: number, wrapping: number): void {
        this._clearPendingErrors();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(this.target, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.texParameteri(this.target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(this.target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(this.target, gl.TEXTURE_WRAP_S, wrapping);
        gl.texParameteri(this.target, gl.TEXTURE_WRAP_T, wrapping);
        this.checkForErrors();
    }

    public uploadRegion(x: number, y: number, width: number, height: number, data: Uint8Array): void {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texSubImage2D(this.target, 0, x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

    /** Immutable storage for a renderable cubemap: `levels` mips per face. */
    public allocateCube(size: number, levels: number): void {
        gl.texStorage2D(gl.TEXTURE_CUBE_MAP, levels, this._internalFormat, size, size);
        const minFilter = levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, minFilter);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    }

    /**
     * Immutable storage for a renderable 3D volume.
     *
     * `texStorage3D` rather than `texImage3D` is what makes the layers valid attachment targets for
     * `framebufferTextureLayer`, which is how the volume gets filled — one fullscreen draw per slice.
     */
    public allocateVolume(width: number, height: number, depth: number, wrapping: number): void {
        this._clearPendingErrors();
        gl.texStorage3D(gl.TEXTURE_3D, 1, this._internalFormat, width, height, depth);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, wrapping);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, wrapping);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, wrapping);
        this.checkForErrors();
    }

    /**
     * Immutable storage for a renderable depth ARRAY — the cascaded shadow map.
     *
     * `compare` turns it into a `sampler2DArrayShadow`: the hardware does the comparison and bilinearly
     * filters the RESULT, so one tap is already a 2x2 percentage-closer filter. That is why this path
     * must NOT inherit the forced NEAREST that `_applySamplerState` gives every other depth texture.
     * CLAMP, not REPEAT: a lookup outside a cascade's footprint must read the border rather than wrap
     * around and shadow the far side of the map with unrelated geometry.
     */
    public allocateDepthArray(size: number, layers: number, compare: boolean): void {
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
     * Toggle hardware depth comparison.
     *
     * Sampling a COMPARE_REF_TO_TEXTURE texture through a non-shadow sampler is undefined per GLES 3.0,
     * so the editor's cascade debug blit has to switch it off around its draw.
     */
    public setCompareMode(enabled: boolean): void {
        gl.texParameteri(this.target, gl.TEXTURE_COMPARE_MODE, enabled ? gl.COMPARE_REF_TO_TEXTURE : gl.NONE);
        gl.texParameteri(this.target, gl.TEXTURE_MIN_FILTER, enabled ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(this.target, gl.TEXTURE_MAG_FILTER, enabled ? gl.LINEAR : gl.NEAREST);
    }

    public generateMipmaps(): void { gl.generateMipmap(this.target); }

    /**
     * Drain any error already flagged, so a later `checkForErrors` cannot blame this texture for it.
     *
     * `gl.getError()` reports a GLOBAL sticky flag, not the result of the last call, so checking it
     * after an upload reports whatever went wrong ANYWHERE since the previous check. That is not a
     * theoretical worry: a draw-time INVALID_OPERATION once surfaced as "Error creating texture" from
     * inside `Framebuffer.resize` and again from an async `image.onload`, neither of which could have
     * caused it — and the real culprit went unnamed while two innocent call sites were accused.
     */
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

/**
 * A framebuffer object.
 *
 * Thin on purpose: in WebGL2 a framebuffer really is just a name that attachments hang off, and the
 * three classes above it attach very different things. Giving it a device-owned identity is what lets
 * the attachment shapes converge on one `RenderTarget` descriptor later without also having to move
 * every attachment call in the same change.
 */
/**
 * What a render pass draws into: a framebuffer and its size, or `null` for the default framebuffer.
 *
 * Deliberately not the full RHI `RenderTarget` yet — that names its attachments as texture views, and
 * the three framebuffer classes still own their own attachment wiring. This is the part every pass
 * needs today, and it is what the engine-level Framebuffer/CubeFramebuffer/LayeredDepthFramebuffer
 * hand over when they open a pass.
 */
export interface RenderPassTarget {
    readonly framebuffer: WebGL2Framebuffer | null;
    readonly width: number;
    readonly height: number;
    /** The array depth texture, when a pass renders into one of its layers. See beginRenderPass. */
    readonly depthTexture?: WebGLTexture | null;
    /** Colour attachments this target has. Absent for a caller that manages draw buffers itself. */
    readonly colorCount?: number;
}

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

    /** Attach a 2D colour target. `mip` selects a level of a mipmapped target. */
    public attachColor2D(index: number, texture: WebGLTexture, mip: number = 0): void {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, gl.TEXTURE_2D, texture, mip);
    }

    /** Attach one face of a cubemap as a colour target. `face` is an index 0..5 in GL face order. */
    public attachColorCubeFace(index: number, texture: WebGLTexture, face: number, mip: number = 0): void {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index,
                                gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, texture, mip);
    }

    /**
     * Attach one layer of a 2D array or one slice of a 3D texture as a colour target.
     *
     * The WebGL2 spelling of what WebGPU expresses as `createView({ baseArrayLayer })`. Both APIs can
     * do it, which is why the cascade array and the cloud-noise volume survive the port unchanged.
     */
    public attachColorLayer(index: number, texture: WebGLTexture, layer: number, mip: number = 0): void {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + index, texture, mip, layer);
    }

    public attachDepth2D(texture: WebGLTexture, mip: number = 0): void {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, mip);
    }

    public attachDepthLayer(texture: WebGLTexture, layer: number, mip: number = 0): void {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, texture, mip, layer);
    }

    /**
     * Declare which colour attachments this framebuffer writes.
     *
     * `count` of 0 means depth-only, which needs BOTH `drawBuffers([NONE])` and `readBuffer(NONE)`:
     * without the pair the framebuffer is incomplete on a depth-only attachment set, and the failure
     * is a silently dropped draw rather than an error.
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
 * The live device, in a module of its own — the same shape, and for the same reason, as `glContext.ts`.
 *
 * Every low-level wrapper needs to reach the device, and routing that through the renderer would put
 * the renderer (and therefore the scene, and therefore every node class) back into the dependency
 * graph of the smallest leaves in the engine. Exported as a live binding so consumers read `device` as
 * a plain value and see the assignment the moment the renderer makes it.
 */
export let device: WebGL2Device;

/** Called once by the renderer, immediately after it acquires a context. */
export function setDevice(next: WebGL2Device): void { device = next; }

/** Release the current device's resources. Used when a context is lost or replaced. */
export function destroyDevice(): void {
    if (!device) return;
    device.destroy();
    GLState.reset();
}

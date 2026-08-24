import { gl } from '../../glContext';
import { GLState } from '../../systems/glState';
import { Logger } from '../../../core/logger';
import { setViewportSize } from '../../renderStats';
import { glBufferTarget, glBufferUsageHint, glTextureTarget, glTextureFormat, glAddressMode, glMinFilter } from './glEnums';
import { detectWebGL2Capabilities } from './capabilities';
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
 * The WebGL2 implementation of the RHI device.
 *
 * Now declared `implements Device`: every method the interface names is real here, so the compiler
 * enforces the contract rather than the header having to promise it. That clause was deliberately
 * withheld while any of them would have had to throw — a stub reads as "supported" to a caller and to
 * `tsc` alike — and it goes on now that `createRenderTarget`, `getCurrentSurfaceTarget`, `writeTexture`
 * and `readPixels` are implemented.
 *
 * One gap remains, and it is on the command ENCODER rather than the device:
 * `CommandEncoder.copyTextureToTexture` still throws, because the one copy the engine performs is a
 * depth `blitFramebuffer` the renderer issues by hand.
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
    public reallocateBuffer(buffer: WebGL2Buffer, data: ArrayBufferView): WebGL2Buffer {
        gl.bindBuffer(buffer.target, buffer.handle);
        gl.bufferData(buffer.target, data, buffer.hint);
        buffer.setSize(data.byteLength);
        // Always the same object here: `bufferData` re-specifies storage in place, so every existing
        // VAO that references this buffer stays valid. See the interface for why it is returned.
        return buffer;
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
        const texture = new WebGL2Texture(descriptor, () => this._releaseTexture(texture));
        this._textures.add(texture);
        return texture;
    }

    /**
     * Forget a destroyed texture, and tear down every render target that was still attached to it.
     *
     * The second half is what makes {@link createRenderTarget}'s cache safe to keep for the lifetime of
     * the device. Without it a target would outlive its attachments — every IBL bake allocates fresh
     * cubemaps and would strand 36 framebuffers pointing at deleted storage, which is a leak the GL
     * driver reports as nothing at all.
     */
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
     * Allocate a framebuffer object.
     *
     * WebGL2-only, and no longer how the engine builds a render target: {@link createRenderTarget} owns
     * the attachments, which is the half that used to be scattered across three engine classes.
     *
     * Two callers still attach by hand, and both have a reason. `Renderer._bakeCloudNoise` re-points
     * one attachment at each of 128 slices of a volume, so a target per slice would mean 128
     * framebuffers for a one-off bake. `TexturePacker` re-points its at whichever output texture it is
     * writing, and those churn. Neither shape has a WebGPU equivalent — there, a render pass just names
     * a different view — so both are on the list to move, not to keep.
     */
    public createFramebuffer(label: string = 'framebuffer'): WebGL2Framebuffer {
        const framebuffer = new WebGL2Framebuffer(label, () => this._framebuffers.delete(framebuffer));
        this._framebuffers.add(framebuffer);
        return framebuffer;
    }

    /**
     * A render target over these attachments: a framebuffer with the views attached and validated.
     *
     * This is where `Framebuffer`, `CubeFramebuffer` and `LayeredDepthFramebuffer` converge. Each one
     * reallocated its attachments differently — N 2D colour textures, one cube face swapped per draw,
     * one layer of an immutable `texStorage3D` depth array — and every one of those is a `TextureView`
     * with a mip level and an array layer. The attachment call is chosen from the view's texture
     * DIMENSION rather than from a flag the caller passes, so a cube face and a cascade layer stop
     * being different kinds of framebuffer and become different kinds of view.
     *
     * **Deduped by attachment set, and that is load-bearing rather than an optimisation.** WebGPU names
     * its attachment views at `beginRenderPass` and keeps no framebuffer at all, so callers written for
     * that model — the renderer's `.renderTarget` getters, called once per pass per frame — legitimately
     * ask for the same target repeatedly. Creating a framebuffer per call would allocate one per pass
     * per frame forever. The cache is evicted when an attachment texture is destroyed; see
     * {@link _releaseTexture}.
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
        // Zero colour attachments is not a degenerate case but the shadow maps' normal one, and it needs
        // BOTH draw and read buffers explicitly NONE or the framebuffer is incomplete — which drops
        // every draw silently rather than raising anything.
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

    /**
     * The default framebuffer, at canvas resolution.
     *
     * WebGPU hands back a different swap-chain texture every frame, which is why the interface says to
     * reacquire this rather than hold it. WebGL2 has no swap chain — framebuffer 0 is always there — so
     * one object is reused and only its size is refreshed, which is what the canvas can actually change
     * between calls. Callers written for the WebGPU rule work unchanged on both.
     */
    /**
     * Nothing to do: a WebGL2 drawing buffer is resized by assigning `canvas.width`/`height`, which the
     * renderer has already done by the time it calls this. Present so the renderer can state the intent
     * once for both backends rather than asking which one it is on.
     */
    public reconfigureSurface(): void { /* the drawing buffer follows the canvas */ }

    public getCurrentSurfaceTarget(): WebGL2RenderTarget {
        const width = this._canvas.width, height = this._canvas.height;
        if (!this._surfaceTarget || this._surfaceTarget.width !== width || this._surfaceTarget.height !== height)
            this._surfaceTarget = new WebGL2RenderTarget(null, width, height, [], undefined, 'surface');
        return this._surfaceTarget;
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
    public beginRenderPass(target: WebGL2RenderTarget, descriptor: RenderPassDescriptor): void {
        target.bind();

        // Render into ONE layer of an array depth target: the shadow cascades and the spot atlas.
        // WebGPU expresses this as a view with a `baseArrayLayer`; WebGL2 re-points the framebuffer's
        // depth attachment at the layer, which is what `LayeredDepthFramebuffer.bindLayer` did by hand.
        const layer = descriptor.depthAttachment?.baseArrayLayer;
        const layered = target.depthTexture;
        if (layer !== undefined && target.framebuffer && layered)
            target.framebuffer.attachDepthLayer(layered, layer);

        // How many colour attachments the TARGET has — not how many the descriptor happens to mention.
        // Those differ: a pass descriptor names the attachments whose load op it cares about, and the
        // fullscreen helper names exactly one even when drawing into the 3-attachment G-buffer. Taking
        // the count from the descriptor set draw buffers to 1 there and threw away the normal and
        // emissive targets — a spectacular failure, but one that renders rather than throwing.
        //
        // Zero is not a degenerate case but the shadow maps' normal one: with no colour attachment,
        // BOTH draw and read buffers must be explicitly NONE or the framebuffer is incomplete.
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
    /**
     * Compile and link GLSL, then reflect it.
     *
     * The WGSL half of the descriptor is ignored here — WebGL2 cannot read it, and the GLSL it needs
     * was generated from that same module at build time. A caller with only WGSL (there is none
     * today) would be a mistake worth hearing about.
     */
    public createShaderProgram(descriptor: ShaderProgramDescriptor): ShaderProgram {
        if (!descriptor.vertex || !descriptor.fragment)
            throw new Error(`${descriptor.label}: WebGL2 needs GLSL vertex and fragment stages`);
        // Dispose on failure, here rather than at the call site. `Shader`'s constructor creates the two
        // GL shader objects and `create` throws without deleting them, so a failed compile leaked a
        // pair unless the caller wrapped it — which the custom-material registration path, the one
        // caller that compiles source a user can get wrong, did not.
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
     * The same object as {@link createTextureView} with no narrowing, and that is the honest answer
     * here rather than a shortcut.
     *
     * The distinction the interface draws — a whole-texture view versus one mip of one layer — is a
     * WebGPU one. This backend has no view object at all: a `WebGL2TextureView` is a texture handle
     * plus the mip and layer that `framebufferTextureLayer` will be given when it becomes an
     * attachment, and sampling always binds the whole texture to a unit regardless. So base 0 of
     * layer 0 IS the whole texture from a sampler's point of view.
     */
    public createWholeTextureView(texture: WebGL2Texture): WebGL2TextureView {
        return new WebGL2TextureView(texture, 0, 0);
    }

    /**
     * Refused, in the same voice as {@link glDevice}.
     *
     * WebGL2 has no compute stage in any form — not an extension, not an emulation. The engine's one
     * compute workload (the cloud-noise volume bake) has a complete raster path for exactly this
     * reason and picks between them on `capabilities.hasCompute`, which is a hardcoded `false` here.
     * Reaching this method means a caller skipped that check, so it throws rather than returning
     * something inert that would fail later and further away.
     */
    public createComputePipeline(descriptor: ComputePipelineDescriptor): ComputePipeline {
        throw new Error(`${descriptor.label ?? 'compute pipeline'}: WebGL2 has no compute stage — ` +
                        'gate this path on capabilities.hasCompute');
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

    // -- uploads and readback ---------------------------------------------------------------------

    /**
     * Write tightly packed texels into existing texture storage.
     *
     * `queue.writeTexture` on WebGPU, `texSubImage*` here, and identical in the one respect that
     * matters: neither flips the rows. Every other upload path in this backend passes
     * `UNPACK_FLIP_Y_WEBGL` because it is handed an `HTMLImageElement` whose rows run the other way;
     * raw texel data does not, and flipping it would put the same bytes in different texels on the two
     * backends.
     */
    public writeTexture(texture: WebGL2Texture, data: ArrayBufferView, width: number, height: number,
                        mipLevel: number = 0, arrayLayer: number = 0): void {
        texture.bindForUpload();
        texture.write(data, width, height, mipLevel, arrayLayer);
        texture.unbind();
    }

    /**
     * Read a colour attachment back to the CPU.
     *
     * Resolves immediately: WebGL2 readback really is synchronous, and pretending otherwise would add
     * a frame of latency for nothing. The signature is a promise because WebGPU's cannot be anything
     * else — `copyTextureToBuffer` followed by `mapAsync` — and one honest signature for both backends
     * beats two that diverge at exactly the call site that would then need rewriting.
     *
     * The view is attached to a scratch framebuffer rather than assuming it is already bound, so a
     * caller need not have just finished rendering into it. Rows come back bottom-up, as `gl.readPixels`
     * produces them; both backends leave the flip to the caller.
     *
     * Eight-bit colour only, and that is a real WebGL2 constraint rather than a shortcut: `RGBA` +
     * `UNSIGNED_BYTE` is the one combination guaranteed against any renderable colour buffer, and it is
     * INVALID against a float target — which is precisely why the renderer's thumbnail framebuffer is
     * deliberately not `precision: 'high'`. Saying so here means a float readback fails with the reason
     * rather than with `INVALID_OPERATION` from inside the driver.
     */
    public async readPixels(view: WebGL2TextureView, x: number, y: number,
                            width: number, height: number): Promise<Uint8Array> {
        return this.readPixelsSync(view, x, y, width, height);
    }

    /**
     * The same readback without the promise — PRIVATE, and the only reason it still exists is that
     * `readPixels` above is genuinely synchronous on this backend and there is no point pretending
     * otherwise inside the class.
     *
     * It used to be public, for two engine callers that returned a data URL from a straight-line call:
     * `Renderer.screenshotOffscreen` and `Renderer.renderProbePreview`. Both are `async` now, so no
     * caller outside this file can reach a synchronous readback — which is the property that matters,
     * since WebGPU has no counterpart and never will.
     */
    /**
     * Copy a rectangle from one texture view to another.
     *
     * WebGPU has a real copy command; WebGL2 has `blitFramebuffer`, which needs the two textures
     * attached to a READ and a DRAW framebuffer first. Two scratch framebuffers are kept for it
     * rather than going through `createRenderTarget`: those are deduped and retained for the life of
     * their attachments, and a copy is a transient thing whose source changes with every resize.
     *
     * The buffer bit is chosen from the DESTINATION's format, because that is what decides which
     * attachment point the blit has to write — a depth texture blitted as colour is silently a no-op.
     */
    public copyTexture(source: WebGL2TextureView, destination: WebGL2TextureView,
                       width: number, height: number): void {
        if (!this._copyRead) this._copyRead = this.createFramebuffer('copyRead');
        if (!this._copyDraw) this._copyDraw = this.createFramebuffer('copyDraw');
        const depth = isDepthFormat(destination.texture.format);

        // ATTACH FIRST, one framebuffer bound at a time.
        //
        // `framebufferTexture2D` writes to the DRAW binding — `gl.FRAMEBUFFER` is an alias for it —
        // so attaching while READ and DRAW point at different objects lands BOTH attachments on the
        // draw one. The read framebuffer then has no depth, the blit reads an incomplete framebuffer,
        // and every later draw raises INVALID_FRAMEBUFFER_OPERATION rather than the blit itself
        // failing where you could see it.
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
     * A vertex array object, owned by the caller.
     *
     * WebGL2-only, and it has no WebGPU counterpart at all — there a pipeline carries its vertex layouts
     * and buffers are bound per draw, which is what {@link vertexArrayFor} builds for draws recorded
     * through a pass encoder. This is the OTHER kind: `Mesh` and `TileMesh` still own a VAO each and
     * bind it themselves. Tracked so `destroy()` releases one the caller forgot, which is the same
     * reason buffers and textures are tracked.
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
     * Point the current VAO's element binding at `buffer`.
     *
     * The element binding is VAO state rather than global state, which is exactly why this exists as a
     * call at all: a mesh with LOD levels has several index buffers over one vertex buffer, and
     * selecting a level means re-pointing this. `RenderPassEncoder.setIndexBuffer` is the same idea for
     * draws recorded through the RHI.
     */
    public bindIndexBuffer(buffer: WebGL2Buffer): void {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer.handle);
    }

    /**
     * No-op, and not a gap. WebGL2's per-pass timing does not go through the RHI at all: the profiler
     * wraps `EXT_disjoint_timer_query_webgl2` `TIME_ELAPSED` queries around renderer-defined SCOPES,
     * which are not render passes and have no descriptor to hang a `timestampWrites` off. See the
     * two-name-space note at the top of gpuProfiler.ts.
     *
     * Implemented rather than omitted so the interface stays complete on both backends — and a plain
     * no-op rather than a `glDevice()`-style throw, because the profiler calls these unconditionally
     * once a device exists and "this backend times differently" is not an unported call site.
     */
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
    /**
     * Always 0: this backend re-specifies storage in place and never replaces the texture object, so a
     * view taken at any point stays valid for the life of the texture. See the interface for why the
     * number exists at all.
     */
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

    /** The GL format triple and sampler state this texture uploads with. */
    /**
     * Settle the state every upload below applies.
     *
     * The GL triple is resolved HERE rather than by the caller, which is the point of the neutral
     * descriptor: `graphics/texture.ts` used to compute `internalFormat`/`format`/`type` itself and
     * hand three GL enums to a backend, which is exactly the coupling that made it un-portable.
     */
    public configure(descriptor: TextureConfigureDescriptor): void {
        const triple = glTextureFormat(descriptor.format);
        this._internalFormat = triple.internalFormat;
        this._glFormat = triple.format;
        this._type = triple.type;
        this._wrapping = glAddressMode(descriptor.addressMode);
        // `linear-mipmap-linear` is the pair, not a third filter: WebGL2 has one enum for both
        // halves, so the neutral descriptor names the combination and the split happens here.
        const mip = descriptor.minFilter === 'linear-mipmap-linear';
        const base = descriptor.minFilter === 'nearest' ? 'nearest' : 'linear';
        this._minFilter = glMinFilter(base, mip ? base : null);
        this._flipY = descriptor.flipY;
        this._isDepth = descriptor.isDepth;
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
        this.bindForUpload();
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
        this.bindForUpload();
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

    /** Upload one cube face, by index into +X -X +Y -Y +Z -Z — not a GL face enum. */
    public uploadFace(face: number, image: TexImageSource, mipMap: boolean): void {
        this.bindForUpload();
        const target = WebGL2Texture.cubeFaces()[face];
        this._clearPendingErrors();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !this._flipY);
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
     * Write tightly packed texels into one mip level, and one layer or cube face, of existing storage.
     *
     * The WebGL2 half of {@link WebGL2Device.writeTexture}. Never flipped: `queue.writeTexture` has no
     * flip and neither does this, so the same bytes land in the same texels on both backends — a
     * difference that would otherwise show up only as an upside-down texture in one build.
     *
     * A sub-image, never an allocation. `arrayLayer` selects a cube FACE on a cubemap and a layer or
     * slice on an array or volume, which is the same distinction {@link WebGL2Framebuffer.attachColor}
     * makes for the other direction.
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

    /**
     * Fail loudly when an allocation is aimed at a target this texture was not created for.
     *
     * `bindForUpload` binds `this.target`; the allocators below name their target explicitly because
     * WebGL2 has a different entry point per shape. When the two disagree the bind lands on one target
     * and the allocation on another, so the driver sees NOTHING bound: it logs
     * "Zero is bound to target" plus one "no texture bound to target" per parameter, does nothing, and
     * execution continues with an unallocated texture. That is a console message rather than a failure,
     * and it survived in the renderer's IBL fallback cube for as long as that cube existed.
     */
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
     * Immutable storage for a renderable 3D volume.
     *
     * `texStorage3D` rather than `texImage3D` is what makes the layers valid attachment targets for
     * `framebufferTextureLayer`, which is how the volume gets filled — one fullscreen draw per slice.
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
     * Immutable storage for a renderable depth ARRAY — the cascaded shadow map.
     *
     * `compare` turns it into a `sampler2DArrayShadow`: the hardware does the comparison and bilinearly
     * filters the RESULT, so one tap is already a 2x2 percentage-closer filter. That is why this path
     * must NOT inherit the forced NEAREST that `_applySamplerState` gives every other depth texture.
     * CLAMP, not REPEAT: a lookup outside a cascade's footprint must read the border rather than wrap
     * around and shadow the far side of the map with unrelated geometry.
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
     * Toggle hardware depth comparison.
     *
     * Sampling a COMPARE_REF_TO_TEXTURE texture through a non-shadow sampler is undefined per GLES 3.0,
     * so the editor's cascade debug blit has to switch it off around its draw.
     */
    public setCompareMode(enabled: boolean): void {
        this.bindForUpload();
        gl.texParameteri(this.target, gl.TEXTURE_COMPARE_MODE, enabled ? gl.COMPARE_REF_TO_TEXTURE : gl.NONE);
        gl.texParameteri(this.target, gl.TEXTURE_MIN_FILTER, enabled ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(this.target, gl.TEXTURE_MAG_FILTER, enabled ? gl.LINEAR : gl.NEAREST);
    }

    public generateMipmaps(): void {
        this.bindForUpload();
        gl.generateMipmap(this.target);
    }

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
 * The identity of a view, for the render-target cache.
 *
 * Texture id rather than the `WebGLTexture` object because a handle is opaque and cannot be part of a
 * string key — the same reason {@link WebGL2Buffer} carries an id for the VAO cache.
 */
function viewKey(view: WebGL2TextureView): string {
    return `${view.texture.id}:${view.baseMipLevel}:${view.baseArrayLayer}`;
}

/**
 * A framebuffer object.
 *
 * Thin on purpose: in WebGL2 a framebuffer really is just a name that attachments hang off. What hangs
 * off it now is decided by {@link WebGL2Device.createRenderTarget} from the DIMENSION of each view's
 * texture, which is what let the engine's three framebuffer classes collapse into one shape.
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
     * Attach a colour view, picking the entry point from the view's texture dimension.
     *
     * The dispatch is the whole collapse: a 2D target, a cube FACE and one LAYER of an array are three
     * WebGL2 calls but one WebGPU concept, and choosing between them from the texture rather than from a
     * caller-supplied flag is what removed the need for three framebuffer classes.
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

    /**
     * Attach one layer of a 2D array or one slice of a 3D texture as a colour target.
     *
     * The WebGL2 spelling of what WebGPU expresses as `createView({ baseArrayLayer })`. Both APIs can
     * do it, which is why the cascade array and the cloud-noise volume survive the port unchanged.
     */
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
 * The live device, narrowed to THIS backend.
 *
 * A named exception, and greppable on purpose. `rhi/deviceHandle.ts` hands out the INTERFACE, which is
 * what every migrated consumer wants and what the compiler then holds it to. These callers are not
 * migrated, and each one names a concept WebGPU does not have: `Mesh` and `TileMesh` own a
 * `WebGLVertexArrayObject` and hand raw `WebGLBuffer` handles to `vertexAttribPointer`,
 * `uniformBlocks` binds buffers to the global UNIFORM_BUFFER binding points, `texturePacker` builds its
 * own framebuffer, and the renderer reads pixels back synchronously.
 *
 * Every call here is one of those. The list shrinks as each owner is migrated, which it would not if
 * the same access were bought by widening `Device` with methods only one backend can implement.
 *
 * Throws rather than handing back a mis-typed object when another backend is live: a WebGL2-only path
 * reached under WebGPU is a bug in the caller, and the throw is what says so at the call that did it.
 */
export function glDevice(): WebGL2Device {
    if (!(device instanceof WebGL2Device))
        throw new Error('a WebGL2-only path was reached while a different backend is active');
    return device;
}

/**
 * Release the current device's resources. Used when a context is lost or replaced.
 *
 * The handle itself moved to `rhi/deviceHandle.ts` so its consumers are typed against the INTERFACE
 * rather than against this class — see the note there. This function stays behind because what it does
 * after `destroy()` is WebGL2's business: `GLState` caches the GL state machine, and a device that is
 * going away leaves the cache describing a context that no longer exists.
 */
export function destroyDevice(): void {
    if (!device) return;
    device.destroy();
    GLState.reset();
}

import { gl } from '../rhi/webgl2/glContext';
import { GLState } from '../rhi/webgl2/glState';
import { device } from '../rhi/deviceHandle';
import { countFullscreenPass, frameStats, setViewportSize } from '../renderStats';
import { gpuProfiler, type RenderPass } from '../gpuProfiler';
import { cpuProfiler } from '../cpuProfiler';
import type { Mesh } from '../mesh';
import type { Texture } from '../texture';
import type { RenderTarget } from '../rhi/resources';
import type { CommandEncoder, RenderPassEncoder } from '../rhi/device';

/** What PassEncoder reads from the renderer that owns it. */
export interface PassEncoderHost {
    /** The standing clear colour, used when a pass clears without naming a value. */
    clearColor(): readonly number[];
    /** The profiler's per-pass kill switch (see `beginPass`). */
    passEnabled(name: RenderPass): boolean;
}

/**
 * The renderer's pass plumbing: opening and closing render passes, the frame's single command encoder,
 * recording a mesh draw, the shared screen quad, and the profiler scopes every pass is timed under.
 * Split out of Renderer so every subsystem opens passes the same way.
 */
export class PassEncoder {
    /** The target of the open pass, for the pipeline cache to derive attachment formats from. */
    public target: RenderTarget | null = null;

    /** The encoder recording the pass currently open. */
    public encoder: CommandEncoder | null = null;

    // ONE command encoder for the whole frame, and therefore one `queue.submit`.
    // Null outside a frame: passes opened during INITIALISATION fall back to one encoder each, and a
    // readback that must see its own work forces the boundary with `flushFrameEncoder`.
    public frameEncoder: CommandEncoder | null = null;

    /** The shared fullscreen quad, built once the device exists (Renderer initialisation). */
    public screenQuad!: Mesh;

    private _shadowDrawMark = 0;
    private _shadowTriangleMark = 0;

    constructor(private readonly _host: PassEncoderHost) {}

    /**
     * Set the GL viewport and keep the profiler's notion of it in sync. Every viewport change in the
     * renderer must go through here, or `countFullscreenPass` charges the wrong pixel count.
     */
    public setViewport(width: number, height: number): void {
        // The GL call is WebGL2's alone: a viewport is PASS state on WebGPU, set by the pass encoder
        // from its target's dimensions. `setViewportSize` is not skipped, because `renderStats` charges
        // fullscreen passes by area on both backends and a missing size would silently zero `shadedMpx`.
        if (gl) gl.viewport(0, 0, width, height);
        setViewportSize(width, height);
    }

    /**
     * Draw the shared screen quad, counted against the fill-rate stats. Use this rather than
     * `screenQuad.draw()` for any screen-space pass. With a pass, the draw is RECORDED — on WebGPU a
     * draw outside an encoder is not a draw.
     */
    public drawFullscreen(pass?: RenderPassEncoder): void {
        countFullscreenPass();
        if (pass && this.recordDraw(pass, this.screenQuad, 0, 0)) return;
        this.screenQuad.draw();
    }

    /**
     * The device's surface target: the default framebuffer at canvas resolution. Reacquire it every
     * frame rather than holding it — WebGPU hands back a fresh swap-chain texture each time.
     */
    public screenTarget(): RenderTarget {
        return device.getCurrentSurfaceTarget();
    }

    /**
     * Open a fullscreen pass on `target`. The encoder is held on the renderer, so `finish()` happens in
     * {@link endFullscreenPass} AFTER the draws are recorded — WebGPU submits nothing until then.
     */
    public beginFullscreenPass(target: RenderTarget, label: string, clear: boolean,
                                 clearValue?: [number, number, number, number],
                                 clearDepth: boolean = clear,
                                 /** Clear EVERY colour attachment to `clearValue`, not attachment 0 alone. */
                                 clearAll: boolean = false): RenderPassEncoder {
        this.encoder = this.acquireEncoder(label);
        // So `_pipelineFor` can read the formats it has to agree with. Same lifetime as the encoder.
        this.target = target;
        // EVERY colour attachment when clearing to the standing colour (matching `gl.clear`); a NAMED
        // clearValue clears attachment 0 alone (matching `clearBufferfv`). The standing colour is
        // passed explicitly — WebGPU has no context-state equivalent of `gl.clearColor`.
        const standing = this._host.clearColor();
        const standingValue: [number, number, number, number] =
            [standing[0], standing[1], standing[2], standing[3] ?? 1];
        const colorAttachments = (clear && (!clearValue || clearAll))
            ? target.colorViews.map((_view, index) => ({
                target: index, loadOp: 'clear' as const, storeOp: 'store' as const,
                clearValue: clearValue ?? standingValue,
            }))
            : [{
                target: 0,
                loadOp: (clear ? 'clear' : 'load') as 'clear' | 'load',
                storeOp: 'store' as const,
                // Absent means "the standing clear colour", which is what a bare `gl.clear` used. A
                // named value goes through clearBufferfv instead and needs no save/restore of the
                // context's colour — which is what the thumbnail path used to do by hand.
                ...(clearValue ? { clearValue } : {}),
            }];
        const pass = this.encoder.beginRenderPass(target, {
            label,
            colorAttachments,
            // Separate from the colour op because several targets carry no depth at all and the passes
            // that write them said `{ color: true }` — clearing depth there was never intended, even
            // though on a depthless framebuffer it happens to be a no-op.
            depthAttachment: { loadOp: clearDepth ? 'clear' : 'load', storeOp: 'store' },
        });
        return pass;
    }

    /**
     * Put the blend function back to the pipeline default, which is a SEPARATE function: alpha blend
     * for RGB, destination ALPHA untouched. Never restore with a plain `gl.blendFunc` — the scene
     * buffer's alpha is the bloom-eligibility mask, and overwriting its factors erodes it.
     */
    public restoreDefaultBlend(): void {
        // Standing context state, which WebGPU does not have — a pipeline carries its own blend. The
        // callers are legacy paths restoring what they disturbed; they go when those do.
        if (!gl) return;
        GLState.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    }

    /** Draw the screen quad and close the pass: the last two steps of every fullscreen pass. */
    public drawFullscreenAndEnd(pass: RenderPassEncoder): void {
        this.drawFullscreen(pass);
        this.endFullscreenPass(pass);
    }

    public endFullscreenPass(pass: RenderPassEncoder): void {
        pass.end();
        // Only an encoder this pass OWNS is finished here. The frame encoder outlives every pass in the
        // frame and is submitted once, by `flushFrameEncoder`.
        if (this.encoder) this.finishIfOwned(this.encoder);
        this.encoder = null;
        this.target = null;
    }

    /** The frame's encoder, or a fresh one when there is no frame open. See {@link _frameEncoder}. */
    public acquireEncoder(label: string): CommandEncoder {
        return this.frameEncoder ?? device.createCommandEncoder(label);
    }

    /**
     * Finish `encoder` if this call owns it. The frame's encoder is never finished here: it outlives every
     * pass in the frame and is submitted once, by {@link flushFrameEncoder}.
     */
    public finishIfOwned(encoder: CommandEncoder): void {
        if (encoder !== this.frameEncoder) encoder.finish();
    }

    /**
     * Copy colour attachments, recorded into the frame's encoder exactly as {@link copyDepth} records a
     * depth copy and for the same reason: on WebGPU a copy on its own encoder is submitted BEFORE the
     * frame's unsubmitted passes, and would read the previous frame's G-buffer.
     */
    public copyColors(sources: readonly Texture[], destinations: readonly Texture[],
                      width: number, height: number): void {
        const encoder = this.acquireEncoder('copyColor');
        for (let i = 0; i < sources.length; i++)
            encoder.copyTextureToTexture(sources[i].attachmentView, destinations[i].attachmentView, width, height);
        this.finishIfOwned(encoder);
    }

    /**
     * Copy a depth buffer, through the RHI, for a later pass that must depth-test or depth-read
     * against another attachment.
     *
     * Recorded into the FRAME's encoder whenever one is open, exactly as {@link beginFullscreenPass}
     * records its passes, and finished here only when this call owns the encoder.
     *
     * That is the whole correctness of it on WebGPU, and it used to be wrong. `finish()` SUBMITS,
     * while the frame's render passes sit unsubmitted in {@link frameEncoder} until the end of the
     * frame -- so a copy on its own encoder ran BEFORE every draw it was supposed to be copying
     * the results of. It read whatever the depth buffer held before the frame started: the
     * previous frame's depth in a live viewport, which a barely-moving camera makes look almost
     * right, and on a resized buffer nothing at all.
     *
     * An offscreen capture is where that becomes total rather than subtle. It resizes every
     * target, renders ONE frame and reads it back, so "before this frame" is a freshly allocated
     * buffer -- zeroed, which reads as depth 0, which is `covered` everywhere. Every thumbnail and
     * every baked impostor came back a fully opaque rectangle on WebGPU while WebGL2, whose
     * commands execute as they are issued, was correct.
     *
     * The other two callers were quietly wrong the same way: the deferred G-buffer depth handed to
     * the forward overlay, and TAA's previous-frame depth.
     */
    public copyDepth(source: Texture, destination: Texture, width: number, height: number): void {
        const encoder = this.acquireEncoder('copyDepth');
        encoder.copyTextureToTexture(source.attachmentView, destination.attachmentView, width, height);
        this.finishIfOwned(encoder);
    }

    /**
     * Copy one layer of a depth array into the same layer of another (a shadow atlas's static copy into
     * the live one), recorded into the frame's encoder for the reason {@link copyDepth} gives.
     */
    public copyDepthLayer(source: Texture, destination: Texture, layer: number, size: number): void {
        const encoder = this.acquireEncoder('copyDepthLayer');
        encoder.copyTextureToTexture(source.layerView(layer), destination.layerView(layer), size, size);
        this.finishIfOwned(encoder);
    }

    /**
     * Submit whatever the frame has recorded so far. Anything that must OBSERVE the frame's work has
     * to call this first — a readback cannot see commands still in an unsubmitted encoder.
     */
    public flushFrameEncoder(reopen: boolean = false): void {
        if (!this.frameEncoder) return;
        const encoder = this.frameEncoder;
        this.frameEncoder = null;
        encoder.finish();
        if (reopen) this.frameEncoder = device.createCommandEncoder('frame');
    }

    /**
     * Build a just-rendered texture's mip chain, recorded into the frame's own encoder.
     *
     * A mip chain is built by READING level 0, so a generator that submits its own encoder runs BEFORE
     * the passes still sitting in `_frameEncoder` and every level above the first comes out empty.
     * `null` when no frame is open is correct — each pass finishes its own encoder there.
     */
    public generateMipsAfterRender(texture: Texture): void {
        texture.generateMipmaps(this.frameEncoder ?? undefined);
    }

    /**
     * Open a depth-only pass into one layer of an array target: a shadow cascade, or a spot slot.
     * No colour attachments. The LAYER belongs to the descriptor, not the target.
     */
    public beginDepthPass(target: RenderTarget, label: string, layer: number,
                            loadOp: 'clear' | 'load' = 'clear'): RenderPassEncoder {
        frameStats.shadowLayers++;
        this._shadowDrawMark = frameStats.drawCalls;
        this._shadowTriangleMark = frameStats.triangles;
        this.encoder = this.acquireEncoder(label);
        this.target = target;
        return this.encoder.beginRenderPass(target, {
            label,
            colorAttachments: [],
            depthAttachment: { loadOp, storeOp: 'store', baseArrayLayer: layer },
        });
    }

    /** Close a pass opened by {@link beginDepthPass}, charging what it drew to the shadow counters. */
    public endDepthPass(pass: RenderPassEncoder): void {
        frameStats.shadowDraws += frameStats.drawCalls - this._shadowDrawMark;
        frameStats.shadowTriangles += frameStats.triangles - this._shadowTriangleMark;
        this.endFullscreenPass(pass);
    }

    /**
     * Open a GPU timing scope, and report whether the pass should run at all. Call as
     * `if (!this.beginPass('x')) return;` — a switched-off pass must never also be timed.
     */
    public beginPass(name: RenderPass): boolean {
        if (!this._host.passEnabled(name)) return false;
        this.scope(name);
        return true;
    }

    /**
     * Open one render scope, timed on BOTH sides.
     *
     * The two profilers share these boundaries deliberately: a GPU pass table with no CPU column sends
     * you looking at the GPU when the cost is submission, and two independently placed sets of scopes
     * would produce rows that cannot be compared. Flat, never nested — WebGL2 allows one active timer
     * query, so opening a scope closes the previous one on both sides.
     */
    public scope(name: RenderPass | string): void {
        gpuProfiler.beginPass(name);
        cpuProfiler.beginPass(name);
    }

    /** Close the open scope on both profilers. */
    public endScope(): void {
        gpuProfiler.endPass();
        cpuProfiler.endPass();
    }

    // Record a mesh draw through the RHI. Returns false ONLY for a skinned mesh missing its bone
    // buffers — everything else records, indexed or not, LOD levels and submesh ranges included.
    // `lod` >= 0 draws that index level instead of the active one, for a whole-buffer draw only.
    public recordDraw(pass: RenderPassEncoder, mesh: Mesh, firstIndex: number, indexCount: number,
                        lod: number = -1, firstInstance: number = 0): boolean {
        const level = lod >= 0 && indexCount === 0 && firstIndex === 0 && mesh.hasLods ? lod : -1;
        const indices = level >= 0 ? mesh.lodIndexBuffer(level) : mesh.activeIndexBuffer;
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        if (mesh.isAnimated) {
            // Bone data rides in dedicated buffers rather than the interleaved vertex, so it is two
            // more slots — at the locations THIS program declares, which differ between the lit and
            // unlit families. See boneLayouts.
            if (!mesh.boneIndicesBuffer || !mesh.boneWeightsBuffer) return false;
            pass.setVertexBuffer(1, mesh.boneIndicesBuffer);
            pass.setVertexBuffer(2, mesh.boneWeightsBuffer);
        }
        // A mesh with no index buffer records an ARRAY draw rather than falling back;
        // `firstIndex`/`indexCount` become the vertex range.
        if (!indices) {
            // Nothing to rasterize is not a draw. An empty mesh reaches here from a node added THIS
            // frame — the shadow pass precedes the geometry pass that builds it. Returns TRUE: the
            // draw was handled, and the caller's fallback is a raw `gl` call.
            const count = indexCount > 0 ? indexCount : mesh.vertexCount;
            if (count > 0) pass.draw(count, 1, firstIndex, firstInstance);
            return true;
        }
        pass.setIndexBuffer(indices, level >= 0 ? mesh.lodIndexFormat(level) : mesh.activeIndexFormat);
        const count = indexCount > 0 ? indexCount : level >= 0 ? mesh.lodIndexCount(level) : mesh.activeIndexCount;
        if (count > 0) pass.drawIndexed(count, 1, firstIndex, 0, firstInstance);
        return true;
    }
}

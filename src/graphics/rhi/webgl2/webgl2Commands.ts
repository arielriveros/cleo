/**
 * The RHI command model, expressed on WebGL2.
 *
 * WebGPU has immutable pipelines, bind groups and explicit render passes; WebGL2 has one enormous
 * mutable global. Translating the former onto the latter is routine — that is why `rhi/types.ts` took
 * WebGPU's vocabulary — and this file is where it happens: a pipeline bind becomes the deduped
 * `GLState` calls the renderer already made by hand, and a bind group becomes texture-unit assignment
 * plus a sampler uniform set by name.
 *
 * **This module deliberately reaches up into `Shader` and `ShaderManager`.** The RHI *interface* stays
 * backend-agnostic, but the WebGL2 *implementation* has no reason to re-link programs, re-reflect
 * uniforms or re-implement std140 blocks when the engine already does all three, correctly, and has
 * been doing so for the whole migration. Duplicating that machinery inside the backend would be
 * strictly worse. Binding through `ShaderManager` rather than `Shader.use()` directly also preserves
 * two things that would otherwise quietly break: `setUniform` needs `_boundShader` to be current, and
 * `tools/harness/programCoverage.js` measures shader coverage by wrapping `ShaderManager.bind`.
 *
 * Vertex state IS modelled: `setVertexBuffer`/`setIndexBuffer` record buffers by slot, and a draw binds
 * a VAO built from the pipeline's vertex layouts over them (cached on the device). WebGPU carries the
 * layouts on the pipeline and binds buffers per draw; baking the two together is the WebGL2-shaped half
 * of that difference. Meshes that still own their own VAO — skinned, LOD, tilemap — keep drawing through
 * `Mesh` until their layouts move onto pipelines too.
 */

import { gl } from '../../glContext';
import { GLState } from '../../systems/glState';
import { ShaderManager } from '../../systems/shaderManager';
import type { Shader } from '../../shader';
import {
    glCompare, glBlendFactor, glBlendOperation, glCullMode, glFrontFace,
    glTopology, glIndexType, indexByteSize, isTriangleTopology,
} from './glEnums';
import { frameStats } from '../../renderStats';
import { device } from './webgl2Device';
import type { WebGL2Texture, WebGL2Buffer } from './webgl2Device';
import type {
    RenderPipelineDescriptor, BindGroupDescriptor, ShaderModuleDescriptor,
    RenderPassEncoder, CommandEncoder,
} from '../device';
import type {
    ShaderModule, RenderPipeline, RenderTarget, TextureView, Sampler,
    BindGroup, BindGroupLayout, Buffer,
} from '../resources';
import type {
    VertexBufferLayout, PrimitiveState, DepthStencilState, ColorTargetState,
    ShaderStageFlags, IndexFormat, SamplerDescriptor, ShaderResource,
} from '../types';

// ------------------------------------------------------------------------------------------------
// Shader modules and pipelines
// ------------------------------------------------------------------------------------------------

/**
 * A linked program, reached by the name it is registered under.
 *
 * WebGPU compiles a module from WGSL; here the program was already built and registered during
 * renderer initialization, so the "module" is a handle to it plus the build-time reflection that says
 * what it binds where. Resolution is lazy: `Renderer` registers its programs in one pass and may create
 * pipelines before or after, and a module that resolved eagerly would depend on that ordering.
 */
export class WebGL2ShaderModule implements ShaderModule {
    public readonly label: string;
    public readonly stage: ShaderStageFlags;
    public readonly entryPoints: { readonly vertex?: string; readonly fragment?: string; readonly compute?: string };
    public readonly compilationInfo: readonly string[] = [];
    /** Build-time reflection from the `.wgsl` loader; empty for a hand-written GLSL program. */
    public readonly resources: readonly ShaderResource[];
    /** The name this program is registered under in ShaderManager. */
    public readonly program: string;

    constructor(descriptor: ShaderModuleDescriptor) {
        this.label = descriptor.label ?? descriptor.program ?? 'shader';
        this.stage = descriptor.stage;
        this.entryPoints = { ...(descriptor.entryPoints ?? {}) };
        this.resources = descriptor.resources ?? [];
        if (!descriptor.program)
            throw new Error(`${this.label}: the WebGL2 backend needs a registered program name`);
        this.program = descriptor.program;
    }

    public get shader(): Shader { return ShaderManager.Instance.getShader(this.program); }

    /** The GLSL sampler name for a (group, binding), or undefined when the program declares no such
     *  resource. A texture and its sampler share one name — see `findResources` in wgslTranslate. */
    public glslNameFor(group: number, binding: number): string | undefined {
        return this.resources.find(r => r.group === group && r.binding === binding)?.glslName;
    }

    public destroy(): void { /* the program is owned by ShaderManager */ }
}

class WebGL2BindGroupLayout implements BindGroupLayout {
    public readonly label: string;
    constructor(public readonly group: number, public readonly module: WebGL2ShaderModule) {
        this.label = `${module.label}:group${group}`;
    }
    public destroy(): void { /* nothing allocated */ }
}

/**
 * An immutable bundle of program + render state.
 *
 * `apply()` is the whole translation. Every call goes through `GLState`, which already dedupes against
 * what the driver holds, so re-applying a pipeline that is already current costs nothing — that is what
 * makes it safe to set the pipeline at the top of every pass rather than tracking transitions by hand.
 */
export class WebGL2RenderPipeline implements RenderPipeline {
    public readonly label: string;
    public readonly vertexLayouts: readonly VertexBufferLayout[];
    public readonly primitive: Readonly<PrimitiveState>;
    public readonly depthStencil?: Readonly<DepthStencilState>;
    public readonly colorTargets: readonly ColorTargetState[];
    public readonly bindGroupLayouts: readonly WebGL2BindGroupLayout[];
    public readonly module: WebGL2ShaderModule;

    constructor(descriptor: RenderPipelineDescriptor) {
        this.label = descriptor.label ?? 'pipeline';
        this.vertexLayouts = descriptor.vertexLayouts;
        this.primitive = descriptor.primitive;
        this.depthStencil = descriptor.depthStencil;
        this.colorTargets = descriptor.colorTargets;
        this.module = descriptor.vertex as WebGL2ShaderModule;

        // Groups come from what the shaders declare, so asking for one they do not use is a mistake
        // rather than an empty bind — the same rule WebGPU enforces through `layout: 'auto'`.
        const groups = [...new Set(this.module.resources.map(r => r.group))].sort((a, b) => a - b);
        this.bindGroupLayouts = groups.map(g => new WebGL2BindGroupLayout(g, this.module));
    }

    public layoutForGroup(group: number): WebGL2BindGroupLayout | undefined {
        return this.bindGroupLayouts.find(l => l.group === group);
    }

    public apply(): void {
        // Through ShaderManager, not Shader.use(): see the note at the top of this file.
        ShaderManager.Instance.bind(this.module.program);

        if (this.depthStencil) {
            GLState.enable(gl.DEPTH_TEST);
            GLState.depthMask(this.depthStencil.depthWriteEnabled);
            gl.depthFunc(glCompare(this.depthStencil.depthCompare));
        } else {
            // No depth state means no depth interaction at all. Masking as well as disabling matters:
            // DEPTH_TEST off still lets writes through on some drivers, and a fullscreen pass that
            // stamped the depth buffer would break every later pass that reads it.
            GLState.disable(gl.DEPTH_TEST);
            GLState.depthMask(false);
        }

        const cull = glCullMode(this.primitive.cullMode);
        if (cull === null) GLState.disable(gl.CULL_FACE);
        else { GLState.enable(gl.CULL_FACE); GLState.cullFace(cull); }
        gl.frontFace(glFrontFace(this.primitive.frontFace));

        // WebGL2 blends globally, so target 0 decides. Every pass in this engine that blends writes one
        // attachment; a future multi-target blend would need EXT_draw_buffers_indexed and should fail
        // loudly here rather than silently applying the wrong state.
        const blending = this.colorTargets.filter(t => t.blend);
        if (blending.length > 1)
            throw new Error(`${this.label}: WebGL2 cannot blend colour targets independently`);

        const blend = this.colorTargets[0]?.blend;
        if (blend) {
            GLState.enable(gl.BLEND);
            gl.blendFuncSeparate(
                glBlendFactor(blend.color.srcFactor), glBlendFactor(blend.color.dstFactor),
                glBlendFactor(blend.alpha.srcFactor), glBlendFactor(blend.alpha.dstFactor));
            gl.blendEquationSeparate(
                glBlendOperation(blend.color.operation), glBlendOperation(blend.alpha.operation));
        } else {
            GLState.disable(gl.BLEND);
        }

        const mask = this.colorTargets[0]?.writeMask;
        gl.colorMask(mask ? mask[0] : true, mask ? mask[1] : true,
                     mask ? mask[2] : true, mask ? mask[3] : true);
    }

    public destroy(): void { /* the program is owned by ShaderManager */ }
}

// ------------------------------------------------------------------------------------------------
// Bind groups
// ------------------------------------------------------------------------------------------------

/**
 * A texture view, as the WebGL2 backend sees one.
 *
 * WebGL2 has no view object: binding a texture binds the whole thing, and a mip or layer is reached at
 * attachment time instead. So this carries the engine texture and the unit-binding call, and the
 * mip/layer fields exist to satisfy the interface for callers that pass views around.
 */
export class WebGL2TextureView implements TextureView {
    public readonly label: string;
    constructor(public readonly texture: WebGL2Texture,
                public readonly baseMipLevel: number = 0,
                public readonly baseArrayLayer: number = 0) {
        this.label = `${texture.label}:view`;
    }
    public bind(unit: number): void { this.texture.bind(unit); }
    public destroy(): void { /* the texture owns the storage */ }
}

/**
 * A sampler, recorded but not applied.
 *
 * **A known divergence, stated rather than hidden.** This engine sets filtering and wrapping on the
 * texture object, the way WebGL2 has always worked, so a bind group's sampler entries have nothing to
 * do here — the texture already carries its own. WebGPU treats samplers as separate objects and honours
 * them, which means a texture sampled two different ways by two passes works there and not here. Real
 * `gl.createSampler` objects are the eventual answer; until a pass needs one, recording the descriptor
 * is enough to keep the two backends' call sites identical.
 */
export class WebGL2Sampler implements Sampler {
    public readonly label = 'sampler';
    constructor(public readonly descriptor: Readonly<SamplerDescriptor>) {}
    public destroy(): void { /* nothing allocated */ }
}

/**
 * A render target: a framebuffer plus the views attached to it.
 *
 * Carries `framebuffer`/`width`/`height` as well as the RHI's `colorViews`/`depthView` because the pass
 * boundary still binds by framebuffer handle. The views are what a *later* migration will attach with,
 * once `Framebuffer`, `CubeFramebuffer` and `LayeredDepthFramebuffer` collapse into this one shape.
 *
 * A `framebuffer` of null is the default framebuffer — the screen.
 */
export class WebGL2RenderTarget implements RenderTarget {
    public readonly label: string;
    constructor(public readonly framebuffer: { handle: WebGLFramebuffer } | null,
                public readonly width: number,
                public readonly height: number,
                public readonly colorViews: readonly WebGL2TextureView[] = [],
                public readonly depthView: WebGL2TextureView | undefined = undefined,
                label: string = 'render-target') {
        this.label = label;
    }
    public destroy(): void { /* the framebuffer and its attachments are owned elsewhere */ }
}

export class WebGL2BindGroup implements BindGroup {
    public readonly label: string;
    public readonly layout: WebGL2BindGroupLayout;
    private readonly _entries: BindGroupDescriptor['entries'];

    constructor(descriptor: BindGroupDescriptor) {
        this.layout = descriptor.layout as WebGL2BindGroupLayout;
        this.label = descriptor.label ?? this.layout.label;
        this._entries = descriptor.entries;
    }

    /**
     * Bind this group's textures, starting at `firstUnit`, and point the program's samplers at them.
     *
     * Returns the next free unit so a pass can bind several groups without them colliding. Unit
     * assignment being the backend's business rather than the renderer's is the entire point of the
     * exercise: it is what retires `SHADOW_UNIT = 6` / `SPOT_SHADOW_UNIT = 15` and the rule that a
     * custom material silently drops every sampler past unit 15.
     */
    public apply(shader: Shader, allocate: () => number): void {
        const module = this.layout.module;

        for (const entry of this._entries) {
            if ('sampler' in entry) continue;   // see WebGL2Sampler — the texture carries its own state
            if ('buffer' in entry) continue;    // uniform blocks still flow through Shader.setUniform

            const name = module.glslNameFor(this.layout.group, entry.binding);
            if (!name)
                throw new Error(
                    `${this.label}: ${module.label} declares no resource at group ${this.layout.group} ` +
                    `binding ${entry.binding}`);

            const unit = allocate();
            (entry.textureView as WebGL2TextureView).bind(unit);
            shader.setUniform(name, unit);
        }
    }

    public destroy(): void { /* nothing allocated */ }
}

// ------------------------------------------------------------------------------------------------
// Command recording
// ------------------------------------------------------------------------------------------------

export class WebGL2RenderPassEncoder implements RenderPassEncoder {
    private _pipeline: WebGL2RenderPipeline | null = null;
    /** Next free texture unit. Groups bind consecutively from 0, in the order they are set. */
    private _nextUnit = 0;
    /** Units the caller has claimed outside the bind-group system. See reserveTextureUnits. */
    private readonly _reserved = new Set<number>();
    /** Vertex buffers by slot, matching the pipeline's vertexLayouts. */
    private readonly _vertexBuffers: (WebGL2Buffer | null)[] = [];
    private _indexBuffer: WebGL2Buffer | null = null;
    private _indexFormat: IndexFormat = 'uint16';
    private _ended = false;

    public setPipeline(pipeline: RenderPipeline): void {
        this._pipeline = pipeline as WebGL2RenderPipeline;
        this._pipeline.apply();
        this._nextUnit = 0;
    }

    public setBindGroup(_group: number, bindGroup: BindGroup): void {
        if (!this._pipeline) throw new Error('setBindGroup before setPipeline');
        (bindGroup as WebGL2BindGroup).apply(this._pipeline.module.shader, () => this._allocateUnit());
    }

    /**
     * Keep these texture units out of the allocator for this pass.
     *
     * Transitional, and it exists for exactly one situation: a pass whose bindings are PARTLY migrated.
     * `deferredLighting` binds its G-buffer and IBL groups here while its shadow group is still bound by
     * `_uploadShadowUniforms` at the renderer's hardcoded units — a helper shared with the forward
     * passes, so it cannot move until they do. Without this the allocator would hand a cube texture the
     * unit the shadow array already occupies: not a subtle error, a draw-time sampler-type collision.
     *
     * Delete this the moment nothing binds a texture unit outside a bind group.
     */
    public reserveTextureUnits(units: readonly number[]): void {
        for (const unit of units) this._reserved.add(unit);
    }

    private _allocateUnit(): number {
        while (this._reserved.has(this._nextUnit)) this._nextUnit++;
        return this._nextUnit++;
    }

    public setViewport(x: number, y: number, width: number, height: number): void {
        gl.viewport(x, y, width, height);
    }

    public setScissor(x: number, y: number, width: number, height: number): void {
        gl.scissor(x, y, width, height);
    }

    public setVertexBuffer(slot: number, buffer: Buffer): void {
        this._vertexBuffers[slot] = buffer as WebGL2Buffer;
    }

    public setIndexBuffer(buffer: Buffer, format: IndexFormat): void {
        this._indexBuffer = buffer as WebGL2Buffer;
        this._indexFormat = format;
    }

    public draw(vertexCount: number, instanceCount: number = 1, firstVertex: number = 0): void {
        const topology = this._beginDraw();
        if (instanceCount > 1) gl.drawArraysInstanced(topology, firstVertex, vertexCount, instanceCount);
        else gl.drawArrays(topology, firstVertex, vertexCount);
        this._countDraw(vertexCount, instanceCount);
    }

    public drawIndexed(indexCount: number, instanceCount: number = 1, firstIndex: number = 0): void {
        const topology = this._beginDraw();
        const type = glIndexType(this._indexFormat);
        const offset = firstIndex * indexByteSize(this._indexFormat);
        if (instanceCount > 1) gl.drawElementsInstanced(topology, indexCount, type, offset, instanceCount);
        else gl.drawElements(topology, indexCount, type, offset);
        this._countDraw(indexCount, instanceCount);
    }

    /**
     * Bind the VAO this draw needs and flush pending uniform writes.
     *
     * The VAO is built from the PIPELINE's vertex layouts over the buffers set on this encoder, and
     * cached on the device — WebGPU carries the layouts on the pipeline and binds buffers per draw, so
     * baking the two together is exactly the WebGL2-shaped part of the difference.
     */
    private _beginDraw(): number {
        if (!this._pipeline) throw new Error('draw before setPipeline');
        GLState.bindVAO(device.vertexArrayFor(this._pipeline, this._vertexBuffers, this._indexBuffer));
        // Uniform writes go to a CPU buffer and upload once, immediately before the draw that reads
        // them — the same contract `Mesh.draw` has always honoured through `flushBound`.
        ShaderManager.Instance.flushBound();
        return glTopology(this._pipeline.primitive.topology);
    }

    private _countDraw(elements: number, instanceCount: number): void {
        frameStats.drawCalls++;
        frameStats.rhiDrawCalls++;
        if (instanceCount > 1) { frameStats.instancedDrawCalls++; frameStats.instances += instanceCount; }
        frameStats.vertices += elements * instanceCount;
        if (isTriangleTopology(this._pipeline!.primitive.topology))
            frameStats.triangles += (elements / 3) * instanceCount;
    }

    /** Flush any std140 writes the pass made, exactly as the hand-written draw path did. */
    public end(): void {
        if (this._ended) return;
        this._ended = true;
        this._pipeline?.module.shader.flushUniformBlocks();
    }
}

/**
 * Records a frame's work — immediately, because WebGL2 has no deferral.
 *
 * `finish()` is a no-op here and a real submission on WebGPU. Callers must be written for the deferred
 * model regardless, since it is the one that constrains.
 */
export class WebGL2CommandEncoder implements CommandEncoder {
    constructor(private readonly _beginPass: (target: RenderTarget, descriptor: any) => void) {}

    public beginRenderPass(target: RenderTarget, descriptor: any): RenderPassEncoder {
        this._beginPass(target, descriptor);
        return new WebGL2RenderPassEncoder();
    }

    public copyTextureToTexture(): void {
        throw new Error('WebGL2 RHI: use Framebuffer blit until copies are modelled');
    }

    public finish(): void { /* WebGL2 issued everything as it was recorded */ }
}

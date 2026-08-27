// The RHI command model on WebGL2: a pipeline bind becomes deduped `GLState` calls, a bind group
// becomes texture-unit assignment, and a draw binds a VAO built from the pipeline's layouts.
//
// Binding through `ShaderManager` rather than `Shader.use()` is load-bearing: it keeps `setUniform`'s
// `_boundShader` current and the harness's shader-coverage measurement intact.

import { gl } from '../../glContext';
import { GLState } from '../../systems/glState';
import { ShaderManager } from '../../systems/shaderManager';
import type { Shader } from '../../shader';
import {
    glCompare, glBlendFactor, glBlendOperation, glCullMode, glFrontFace,
    glTopology, glIndexType, indexByteSize,
} from './glEnums';
import { frameStats, setViewportSize } from '../../renderStats';
import { isTriangleTopology } from '../types';
import { glDevice } from './webgl2Device';
import type { WebGL2Texture, WebGL2Buffer, WebGL2Framebuffer } from './webgl2Device';
import type {
    RenderPipelineDescriptor, BindGroupDescriptor, ShaderModuleDescriptor,
    RenderPassEncoder, CommandEncoder, ComputePassEncoder,
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
 * A linked program, reached by the name it is registered under, plus its build-time reflection.
 * Resolution is LAZY, so creating a pipeline before or after program registration both work.
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

    /** The linked program as the concrete WebGL2 class. Safe: this is the WebGL2 backend. */
    public get shader(): Shader { return ShaderManager.Instance.getShader(this.program) as Shader; }

    /** The GLSL sampler name for a (group, binding). A texture and its sampler share one name. */
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
 * An immutable bundle of program plus render state. `apply()` goes through `GLState`, which dedupes,
 * so re-applying a current pipeline costs nothing.
 */
export class WebGL2RenderPipeline implements RenderPipeline {
    public readonly label: string;
    public readonly vertexLayouts: readonly VertexBufferLayout[];
    public readonly primitive: Readonly<PrimitiveState>;
    public readonly depthStencil?: Readonly<DepthStencilState>;
    public readonly colorTargets: readonly ColorTargetState[];
    public readonly bindGroupLayouts: readonly WebGL2BindGroupLayout[];
    public readonly module: WebGL2ShaderModule;
    /** See the interface. Forwarded from the module this pipeline was built with. */
    public get resources(): readonly ShaderResource[] { return this.module.resources; }

    constructor(descriptor: RenderPipelineDescriptor) {
        this.label = descriptor.label ?? 'pipeline';
        this.vertexLayouts = descriptor.vertexLayouts;
        this.primitive = descriptor.primitive;
        this.depthStencil = descriptor.depthStencil;
        this.colorTargets = descriptor.colorTargets;
        this.module = descriptor.vertex as WebGL2ShaderModule;

        // Groups come from what the shaders declare, so asking for an unused one is a mistake.
        const groups = [...new Set(this.module.resources.map(r => r.group))].sort((a, b) => a - b);
        this.bindGroupLayouts = groups.map(g => new WebGL2BindGroupLayout(g, this.module));
    }

    public layoutForGroup(group: number): WebGL2BindGroupLayout | undefined {
        return this.bindGroupLayouts.find(l => l.group === group);
    }

    public apply(): void {
        // Through ShaderManager, not Shader.use(): see the note at the top of this file.
        ShaderManager.Instance.bind(this.module.program);

        // `always` + no writes IS "no depth interaction". Must not issue `gl.depthFunc`: that is
        // CONTEXT state and would leak past this pipeline into the next legacy draw.
        const noDepth = !this.depthStencil
            || (this.depthStencil.depthCompare === 'always' && !this.depthStencil.depthWriteEnabled);
        if (!noDepth) {
            GLState.depthTest(true);
            GLState.depthMask(this.depthStencil!.depthWriteEnabled);
            gl.depthFunc(glCompare(this.depthStencil!.depthCompare));
        } else {
            // Mask as well as disable: DEPTH_TEST off still lets writes through on some drivers.
            GLState.depthTest(false);
            GLState.depthMask(false);
        }

        const cull = glCullMode(this.primitive.cullMode);
        if (cull === null) GLState.cull(false);
        else { GLState.cull(true); GLState.cullFace(cull); }
        gl.frontFace(glFrontFace(this.primitive.frontFace));

        // WebGL2 blends globally, so target 0 decides; a multi-target blend must fail loudly here.
        const blending = this.colorTargets.filter(t => t.blend);
        if (blending.length > 1)
            throw new Error(`${this.label}: WebGL2 cannot blend colour targets independently`);

        const blend = this.colorTargets[0]?.blend;
        if (blend) {
            GLState.blend(true);
            gl.blendFuncSeparate(
                glBlendFactor(blend.color.srcFactor), glBlendFactor(blend.color.dstFactor),
                glBlendFactor(blend.alpha.srcFactor), glBlendFactor(blend.alpha.dstFactor));
            gl.blendEquationSeparate(
                glBlendOperation(blend.color.operation), glBlendOperation(blend.alpha.operation));
        } else {
            GLState.blend(false);
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
 * A texture view as the WebGL2 backend sees one. There is no view object — binding a texture binds the
 * whole thing — so the mip/layer fields only satisfy the interface and are honoured at attachment time.
 */
export class WebGL2TextureView implements TextureView {
    public readonly label: string;
    constructor(public readonly texture: WebGL2Texture,
                public readonly baseMipLevel: number = 0,
                public readonly baseArrayLayer: number = 0) {
        this.label = `${texture.label}:view`;
        this.generation = texture.generation;
    }
    /** Constant here - this backend never replaces a texture object. See the interface. */
    public readonly generation: number;
    public bind(unit: number): void { this.texture.bind(unit); }
    public destroy(): void { /* the texture owns the storage */ }
}

/**
 * A sampler, recorded but NOT applied — this engine keeps filtering and wrapping on the texture. A
 * texture sampled two different ways by two passes therefore works on WebGPU and not here.
 */
export class WebGL2Sampler implements Sampler {
    public readonly label = 'sampler';
    constructor(public readonly descriptor: Readonly<SamplerDescriptor>) {}
    public destroy(): void { /* nothing allocated */ }
}

/**
 * A render target: a framebuffer plus its attached views, built through
 * {@link WebGL2Device.createRenderTarget}. A null `framebuffer` is the screen, the one target not `owned`.
 */
export class WebGL2RenderTarget implements RenderTarget {
    public readonly label: string;
    constructor(public readonly framebuffer: WebGL2Framebuffer | null,
                public readonly width: number,
                public readonly height: number,
                public readonly colorViews: readonly WebGL2TextureView[] = [],
                public readonly depthView: WebGL2TextureView | undefined = undefined,
                label: string = 'render-target',
                /** Whether destroying this target releases the framebuffer object underneath it. */
                private readonly _owned: boolean = false) {
        this.label = label;
    }

    /** What the pass should set draw buffers to. See WebGL2Device.beginRenderPass. */
    public get colorCount(): number { return this.colorViews.length; }

    /**
     * Raw handle of a LAYERED depth attachment, for a pass rendering into one of its layers. Null for a
     * plain 2D depth attachment, which has no layers to re-point.
     */
    public get depthTexture(): WebGLTexture | null {
        if (!this.depthView) return null;
        const dimension = this.depthView.texture.dimension;
        return dimension === '2d-array' || dimension === '3d' ? this.depthView.texture.handle : null;
    }

    /**
     * Make this the current draw target, viewport included. `setViewport: false` is for callers driving
     * a viewport of their own, like the cube convolutions drawing one mip at a time.
     */
    public bind(setViewport: boolean = true): void {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer ? this.framebuffer.handle : null);
        if (!setViewport) return;
        gl.viewport(0, 0, this.width, this.height);
        setViewportSize(this.width, this.height);
    }

    /** Releases the framebuffer object only. The attachments belong to whoever allocated the textures. */
    public destroy(): void {
        if (this._owned) this.framebuffer?.destroy();
    }
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

    /** Bind this group's textures and point the program's samplers at them. `allocate` hands out units. */
    public apply(shader: Shader, allocate: () => number): void {
        const module = this.layout.module;

        for (const entry of this._entries) {
            if ('sampler' in entry) continue;   // see WebGL2Sampler — the texture carries its own state
            if ('buffer' in entry) continue;    // uniform blocks still flow through Shader.setUniform
            // A storage texture is a WRITE binding with nothing on this backend to satisfy it. Assigning
            // it a unit would build a bind group that validates and writes nothing.
            if ('storageTextureView' in entry)
                throw new Error(`${this.label}: WebGL2 has no storage textures (binding ${entry.binding})`);

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

    // Hand out the next texture unit. Reset to 0 by every `setPipeline`, so units are a PASS's business.
    private _allocateUnit(): number {
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

    // Bind the VAO this draw needs and flush pending uniform writes. The VAO is built from the
    // PIPELINE's layouts over this encoder's buffers, and cached on the device.
    private _beginDraw(): number {
        if (!this._pipeline) throw new Error('draw before setPipeline');
        GLState.bindVAO(glDevice().vertexArrayFor(this._pipeline, this._vertexBuffers, this._indexBuffer));
        // Uniform writes upload once, immediately before the draw that reads them.
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
 * Records a frame's work immediately — WebGL2 has no deferral, so `finish()` is a no-op. Callers must
 * still be written for the deferred model.
 */
export class WebGL2CommandEncoder implements CommandEncoder {
    constructor(private readonly _beginPass: (target: RenderTarget, descriptor: any) => void) {}

    public beginRenderPass(target: RenderTarget, descriptor: any): RenderPassEncoder {
        this._beginPass(target, descriptor);
        return new WebGL2RenderPassEncoder();
    }

    /** Always throws: WebGL2 has no compute stage. Check `capabilities.hasCompute` first. */
    public beginComputePass(label?: string): ComputePassEncoder {
        throw new Error(`${label ?? 'compute pass'}: WebGL2 has no compute stage — ` +
                        'gate this path on capabilities.hasCompute');
    }

    public copyTextureToTexture(source: TextureView, destination: TextureView,
                                width: number, height: number): void {
        glDevice().copyTexture(source as WebGL2TextureView, destination as WebGL2TextureView, width, height);
    }

    public finish(): void { /* WebGL2 issued everything as it was recorded */ }
}

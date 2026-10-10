// The GPU half of the particle system: state textures, the simulation step on either backend, the
// optional back-to-front sort, and the billboard / mesh draws. The Renderer owns one of these and calls
// it at three points in the frame — `simulate` in the prologue (no pass open), `sort` just before the
// particle pass opens, `draw` inside it.
//
// The CPU half lives on `ParticleSystemNode` (its clock and spawn ring, in particles/particleRuntime.ts)
// and reaches this class only as queued `SimStep`s. Nothing is ever read back.

import { mat4, vec3 } from 'gl-matrix';
import { device } from '../rhi/deviceHandle';
import {
    BufferUsage, ShaderStage, DEFAULT_BLEND, type BlendState, type ShaderResource, type VertexBufferLayout,
} from '../rhi/types';
import type {
    BindGroup, Buffer as GpuBuffer, ComputePipeline, RenderPipeline, RenderTarget,
} from '../rhi/resources';
import type { CommandEncoder, RenderPassEncoder } from '../rhi/device';
import { UniformSet, type UniformBlockLayout } from '../rhi/uniformSet';
import { Texture } from '../texture';
import { TextureManager } from '../systems/textureManager';
import { ShaderManager } from '../systems/shaderManager';
import { Logger } from '../../core/logger';
import { frameStats } from '../renderStats';
import { LUT_ROWS, LUT_WIDTH } from '../../particles/curves';
import { DRAW, packEmitter, stepUniforms, type PackedEmitter } from '../../particles/particlePack';
import { builtinParticleMesh, interleaveParticleMesh } from '../../particles/particleMesh';
import { composeCustomSim } from '../../particles/particleCustomCode';
import type { EmitterRuntime, SimStep, SubEmitterLink } from '../../particles/particleRuntime';
import type { RenderSettings } from '../../particles/particleModules';
import type { ParticleSystemNode } from '../../core/scene/nodes/particleSystemNode';
import type { Scene } from '../../core/scene/scene';
// @ts-ignore -- WGSL modules, typed by the loader
import ParticleSimComputeProgram from '../shaders/wgsl/particleSimCompute.wgsl';
// @ts-ignore
import ParticleSimProgram from '../shaders/wgsl/particleSim.wgsl';
// @ts-ignore
import ParticleBillboardProgram from '../shaders/wgsl/particleBillboard.wgsl';
// @ts-ignore
import ParticleMeshProgram from '../shaders/wgsl/particleMesh.wgsl';
// @ts-ignore
import ParticleSortComputeProgram from '../shaders/wgsl/particleSortCompute.wgsl';
// @ts-ignore
import ParticleSortProgram from '../shaders/wgsl/particleSort.wgsl';

/** A `.wgsl` import, as far as this module reads one. */
interface ParticleProgram {
    readonly wgsl: string;
    readonly vertex?: string;
    readonly fragment?: string;
    readonly entryPoints: { vertex?: string; fragment?: string; compute?: string };
    readonly resources: readonly ShaderResource[];
    readonly vertexInputs: readonly { name: string; location: number; type: string }[];
    readonly uniformBlocks: readonly unknown[];
}

/** Program names in `ShaderManager`, with their imports. Registered by `Renderer._createPrograms`. */
export const PARTICLE_PROGRAMS: {
    readonly sim: readonly [string, ParticleProgram];
    readonly billboard: readonly [string, ParticleProgram];
    readonly mesh: readonly [string, ParticleProgram];
    readonly sort: readonly [string, ParticleProgram];
} = {
    sim: ['particleSim', ParticleSimProgram],
    billboard: ['particleBillboard', ParticleBillboardProgram],
    mesh: ['particleMesh', ParticleMeshProgram],
    sort: ['particleSort', ParticleSortProgram],
};

/** Additive colour, destination alpha (the bloom mask) untouched. */
const ADDITIVE_KEEP_ALPHA: BlendState = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};
/** Premultiplied over, destination alpha untouched. */
const PREMULTIPLIED_KEEP_ALPHA: BlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
};

/** The largest pool the sort runs on. Beyond it, `log2(N)^2 / 2` passes a frame stops being cheap. */
export const MAX_SORTED_PARTICLES = 65536;

/** What the simulation needs from the frame, all of it from the PREVIOUS frame's camera and depth. */
export interface ParticleSimFrame {
    encoder: CommandEncoder;
    /** Scene gravity, world space. */
    gravity: readonly number[];
    /** Opaque scene depth and the unjittered view-projection that produced it. Null before frame 1. */
    depth: Texture | null;
    viewProj: mat4 | null;
    cameraPosition: vec3;
    orthographic: boolean;
    /** Force fields, world space, four texels each. */
    fields: Float32Array;
    fieldCount: number;
}

export interface ParticleDrawFrame {
    pass: RenderPassEncoder;
    target: RenderTarget;
    /** The raster view-projection, in the backend's clip convention. */
    viewProj: mat4;
    view: mat4;
    cameraPosition: vec3;
    near: number;
    far: number;
    orthographic: boolean;
    /** This frame's opaque depth snapshot, for soft particles. Null when it was not taken. */
    depth: Texture | null;
    width: number;
    height: number;
    ambient: readonly number[];
    sunDirection: readonly number[];
    sunColor: readonly number[];
    /** Frustum test on a world AABB; a system wholly outside is not drawn (it still simulates). */
    visible?: (min: vec3, max: vec3) => boolean;
}

const stateTexture = (width: number, height: number): Texture => {
    const t = new Texture({
        format: 'rgba32float', unfiltered: true, storage: device.capabilities.hasCompute, size: { width, height },
        mipMap: false, minFilter: 'nearest', magFilter: 'nearest', mipMapFilter: 'nearest', wrapping: 'clamp',
    });
    t.create(null, width, height);
    return t;
};

/** The sort's working textures: (key, slot) pairs over the next power of two above capacity. */
class SortGpu {
    public readonly n: number;
    public readonly width: number;
    public readonly textures: [Texture, Texture];
    /** Which texture holds the finished order after the last sort. */
    public result = 0;
    constructor(capacity: number) {
        this.n = 1 << Math.ceil(Math.log2(Math.max(2, capacity)));
        this.width = Math.min(256, this.n);
        const height = this.n / this.width;
        this.textures = [stateTexture(this.width, height), stateTexture(this.width, height)];
    }
    public destroy(): void { for (const t of this.textures) t.delete(); }
}

class EmitterGpu {
    public readonly sets: Texture[][];
    public current = 0;
    public readonly lut: Texture;
    public packed: PackedEmitter;
    public sort: SortGpu | null = null;
    /** Whether `sort.result` holds this frame's order. Cleared every frame before sorting. */
    public sorted = false;
    private readonly _groups = new Map<string, BindGroup>();

    constructor(public readonly runtime: EmitterRuntime, flat2D: boolean) {
        const { width, height } = runtime;
        this.sets = [0, 1].map(() => [0, 1, 2, 3].map(() => stateTexture(width, height)));

        this.packed = packEmitter(runtime.def, flat2D);
        this.lut = new Texture({
            format: 'rgba32float', loadOnly: true, mipMap: false,
            minFilter: 'nearest', magFilter: 'nearest', mipMapFilter: 'nearest', wrapping: 'clamp',
        });
        this.lut.create(null, LUT_WIDTH, LUT_ROWS);
        device.writeTexture(this.lut.rhiTexture, this.packed.lut, LUT_WIDTH, LUT_ROWS);
    }

    /** Re-read the emitter's (edited) definition into uniforms and the LUT. The particles stay. */
    public repack(flat2D: boolean): void {
        this.packed = packEmitter(this.runtime.def, flat2D);
        device.writeTexture(this.lut.rhiTexture, this.packed.lut, LUT_WIDTH, LUT_ROWS);
    }

    public get read(): Texture[] { return this.sets[this.current]; }
    public get write(): Texture[] { return this.sets[this.current ^ 1]; }

    public ensureSort(): SortGpu {
        if (!this.sort) this.sort = new SortGpu(this.runtime.capacity);
        return this.sort;
    }

    /** A bind group cached on a key the caller makes complete. */
    public group(key: string, make: () => BindGroup): BindGroup {
        let g = this._groups.get(key);
        if (!g) {
            if (this._groups.size > 48) this._groups.clear();
            g = make();
            this._groups.set(key, g);
        }
        return g;
    }

    public destroy(): void {
        for (const set of this.sets) for (const t of set) t.delete();
        this.lut.delete();
        this.sort?.destroy();
        this._groups.clear();
    }
}

class SystemGpu {
    public lastSeen = 0;
    constructor(public readonly version: number, public paramsVersion: number,
                public flat2D: boolean, public readonly emitters: EmitterGpu[]) {}
    public destroy(): void { for (const e of this.emitters) e.destroy(); }
}

interface MeshGpu {
    vertices: GpuBuffer;
    indices: GpuBuffer;
    indexCount: number;
}

let textureIds = new WeakMap<Texture, number>();
let nextTextureId = 1;
function idOf(t: Texture): string {
    let id = textureIds.get(t);
    if (id === undefined) { id = nextTextureId++; textureIds.set(t, id); }
    return id + ':' + t.rhiTexture.generation;
}

// Part of every bind group's cache key: on WebGPU a bind group made against one pipeline's
// `layout: 'auto'` layout is invalid with any other pipeline, however identical the two look.
const pipelineIds = new WeakMap<object, number>();
let nextPipelineId = 1;
function pipelineId(p: RenderPipeline | ComputePipeline): number {
    let id = pipelineIds.get(p);
    if (id === undefined) { id = nextPipelineId++; pipelineIds.set(p, id); }
    return id;
}

export class ParticleRenderer {
    private readonly _systems = new Map<ParticleSystemNode, SystemGpu>();
    private readonly _meshes = new Map<string, MeshGpu>();
    private _frame = 0;
    private _computePipeline: ComputePipeline | null = null;
    private _simUniforms: UniformSet | null = null;
    private _simPipelineGL: RenderPipeline | null = null;
    private _sortComputePipeline: ComputePipeline | null = null;
    /** Simulation pipelines with an emitter's custom code spliced in, by source key. */
    private readonly _customPipelines = new Map<string, ComputePipeline | RenderPipeline>();
    private _sortUniforms: UniformSet | null = null;
    private _sortPipelineGL: RenderPipeline | null = null;
    private readonly _drawPipelines = new Map<string, RenderPipeline>();
    private _white: Texture | null = null;
    private _depthFallback: Texture | null = null;
    private _failed = false;
    private _warnedNoFloat = false;

    /** Steps run last frame, for the stats panel. */
    public stepsLastFrame = 0;

    /** Whether this device can run particles at all. */
    public get supported(): boolean {
        return device.capabilities.hasCompute || device.capabilities.floatRenderable;
    }

    // ---------------------------------------------------------------------------------------------
    // Resources
    // ---------------------------------------------------------------------------------------------

    private _gpuFor(node: ParticleSystemNode, flat2D: boolean): SystemGpu {
        let gpu = this._systems.get(node);
        if (!gpu || gpu.version !== node.version) {
            gpu?.destroy();
            gpu = new SystemGpu(node.version, node.paramsVersion, flat2D,
                                node.runtime.emitters.map(e => new EmitterGpu(e, flat2D)));
            this._systems.set(node, gpu);
        } else if (gpu.paramsVersion !== node.paramsVersion || gpu.flat2D !== flat2D) {
            for (const emitter of gpu.emitters) emitter.repack(flat2D);
            gpu.paramsVersion = node.paramsVersion;
            gpu.flat2D = flat2D;
        }
        gpu.lastSeen = this._frame;
        return gpu;
    }

    /** Drop GPU state for systems that have not been seen for a while (removed, or in another tab). */
    private _sweep(): void {
        for (const [node, gpu] of this._systems)
            if (this._frame - gpu.lastSeen > 240) { gpu.destroy(); this._systems.delete(node); }
    }

    public releaseAll(): void {
        for (const gpu of this._systems.values()) gpu.destroy();
        this._systems.clear();
        for (const mesh of this._meshes.values()) { mesh.vertices.destroy(); mesh.indices.destroy(); }
        this._meshes.clear();
    }

    private get _whiteTexture(): Texture {
        if (!this._white) {
            this._white = new Texture({ mipMap: false, wrapping: 'clamp' });
            this._white.createFromData(new Uint8Array([255, 255, 255, 255]), 1, 1);
        }
        return this._white;
    }

    /** A 1x1 depth texture at the far plane, bound when the frame has no depth to offer. */
    private _depthOr(depth: Texture | null): Texture {
        if (depth) return depth;
        if (!this._depthFallback) {
            this._depthFallback = new Texture({ usage: 'depth', mipMap: false });
            this._depthFallback.create(null, 1, 1);
        }
        return this._depthFallback;
    }

    /** Whether `node` is shown at all: in the editor, only while the scene previews particles. */
    private static _active(node: ParticleSystemNode): boolean {
        return !node.previewSuppressed;
    }

    // ---------------------------------------------------------------------------------------------
    // Simulation
    // ---------------------------------------------------------------------------------------------

    /**
     * Run every pending step of every particle system in `scene`. Call where no pass is open; WebGPU
     * records into the frame encoder so the steps run before this frame's draws read the results.
     */
    public simulate(scene: Scene, frame: ParticleSimFrame): void {
        this._frame++;
        this.stepsLastFrame = 0;
        // Every uniform slot the previous frame used has been submitted; start the arenas over.
        this._simUniforms?.resetCursor();
        this._sortUniforms?.resetCursor();
        if (this._failed) return;
        const systems = scene.particleSystems;
        if (systems.size === 0) { this._sweep(); return; }
        if (!this.supported) {
            if (!this._warnedNoFloat) {
                this._warnedNoFloat = true;
                Logger.print('warn', ['Particles disabled: this device can neither run compute shaders ' +
                    'nor render into float textures (EXT_color_buffer_float).'], 'Particles');
            }
            return;
        }
        const compute = device.capabilities.hasCompute;

        const flat2D = scene.activeCamera?.camera.type === 'orthographic' && scene.tilemaps.size > 0;
        try {
            for (const node of systems) {
                if (!ParticleRenderer._active(node)) continue;
                const gpu = this._gpuFor(node, flat2D);
                // INTERLEAVED by step, not emitter by emitter: a sub-emitter reads its parent's state
                // before and after the SAME step, so the parent must not run ahead of it.
                const queues: SimStep[][] = gpu.emitters.map((emitter, i) => {
                    emitter.sorted = false;
                    return node.runtime.drain(i);
                });
                const longest = Math.max(0, ...queues.map(q => q.length));
                for (let s = 0; s < longest; s++) {
                    gpu.emitters.forEach((emitter, i) => {
                        const step = queues[i][s];
                        if (!step) return;
                        const link = node.runtime.links[i];
                        const parent = link ? gpu.emitters[link.parent] ?? null : null;
                        const values = stepUniforms(emitter.packed, step, emitter.runtime.capacity,
                                                    emitter.runtime.width, frame.gravity, emitter.runtime.def.seed);
                        Object.assign(values, this._subUniforms(link, parent));
                        if (compute) this._stepCompute(emitter, values, frame, parent);
                        else this._stepRaster(emitter, values, frame, parent);
                        emitter.current ^= 1;
                        this.stepsLastFrame++;
                        frameStats.particleSteps++;
                    });
                }
            }
        } catch (error) {
            // One failure here is a shader or pipeline that will fail identically every frame. Stop
            // trying rather than flooding the console at 60 Hz.
            this._failed = true;
            Logger.print('error', ['Particle simulation failed; particles are disabled for this session:', error], 'Particles');
        }
        this._sweep();
    }

    /** A sub-emitter's link, as uniforms. All zero — "no parent" — for an ordinary emitter. */
    private _subUniforms(link: SubEmitterLink | null, parent: EmitterGpu | null): Record<string, number[]> {
        if (!link || !parent) return { u_sub: [0, 1, 0, 1], u_sub2: [0, 0, 0, 0] };
        return {
            u_sub: [link.event === 'collision' ? 2 : 1, link.count, link.inherit, parent.runtime.width],
            u_sub2: [parent.runtime.capacity, 0, 0, 0],
        };
    }

    /**
     * The sampled inputs of one step: this emitter's state, its LUT, the scene depth, and its parent's
     * state after and before the parent's own step — or its own state again when it has no parent.
     */
    private _simInputs(emitter: EmitterGpu, depth: Texture, parent: EmitterGpu | null) {
        // The parent has already stepped (and swapped), so its READ set is the new state and its WRITE
        // set the one it just replaced.
        const now = parent ? parent.read : emitter.read;
        const was = parent ? parent.write : emitter.read;
        return [
            ...emitter.read.map((t, i) => ({ binding: i, textureView: t.sampledView })),
            { binding: 4, textureView: emitter.lut.sampledView },
            { binding: 5, textureView: depth.sampledView },
            { binding: 7, textureView: now[0].sampledView },
            { binding: 8, textureView: now[1].sampledView },
            { binding: 9, textureView: now[2].sampledView },
            { binding: 10, textureView: was[0].sampledView },
            { binding: 11, textureView: was[1].sampledView },
        ];
    }

    /** The per-frame uniforms common to every step: collision camera and depth, force fields. */
    private _frameUniforms(frame: ParticleSimFrame, set: (name: string, value: unknown) => void): void {
        const depth = frame.depth;
        const valid = !!(depth && frame.viewProj);
        set('u_collideViewProj', valid ? frame.viewProj! : mat4.create());
        set('u_collideInvViewProj', valid ? (mat4.invert(mat4.create(), frame.viewProj!) ?? mat4.create()) : mat4.create());
        set('u_collideScreen', [depth?.width ?? 1, depth?.height ?? 1, device.backend === 'webgpu' ? 1 : 0, valid ? 1 : 0]);
        set('u_collideCam', [frame.cameraPosition[0], frame.cameraPosition[1], frame.cameraPosition[2], frame.orthographic ? 1 : 0]);
        set('u_fields', frame.fields);
    }

    /** Everything one step writes: the emitter's static uniforms, the step's, and the frame's. */
    private _writeStep(emitter: EmitterGpu, values: Record<string, unknown>, frame: ParticleSimFrame,
                       set: (name: string, value: unknown) => void): void {
        this._frameUniforms(frame, set);
        for (const [name, value] of Object.entries(emitter.packed.sim)) set(name, value);
        for (const [name, value] of Object.entries(values)) set(name, value);
        // Field influence is per emitter; the field list itself is per frame.
        const module = emitter.runtime.def.update.find(m => m.type === 'forceFields' && m.enabled);
        const influence = module ? Number(module.params.influence ?? 1) : 0;
        set('u_fieldInfo', [frame.fieldCount, Number.isFinite(influence) ? influence : 1, 0, 0]);
    }

    private _stepCompute(emitter: EmitterGpu, values: Record<string, unknown>, frame: ParticleSimFrame,
                         parent: EmitterGpu | null): void {
        const base = this._ensureComputePipeline();
        const pipeline = emitter.packed.custom ? this._customComputePipeline(emitter.packed.custom) : base;
        const pid = pipelineId(pipeline);
        const uniforms = this._simUniforms!;
        this._writeStep(emitter, values, frame, (name, value) => { uniforms.set(name, value); });
        uniforms.flush(device);

        const write = emitter.write;
        const depth = this._depthOr(frame.depth);
        const inputs = emitter.group(`c0:${pid}:${emitter.current}:${parent?.current ?? '-'}:${idOf(depth)}`,
            () => device.createBindGroup({
                label: 'particleSim.inputs',
                layout: pipeline.bindGroupLayouts.find(l => l.group === 0)!,
                entries: this._simInputs(emitter, depth, parent),
            }));
        const outputs = emitter.group(`c2:${pid}:${emitter.current}`, () => device.createBindGroup({
            label: 'particleSim.outputs',
            layout: pipeline.bindGroupLayouts.find(l => l.group === 2)!,
            entries: write.map((t, i) => ({ binding: i, storageTextureView: t.attachmentView })),
        }));

        const pass = frame.encoder.beginComputePass('particles.sim');
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, inputs);
        pass.setBindGroup(1, this._uniformGroup(pipeline, uniforms, 'particleSim.uniforms'));
        pass.setBindGroup(2, outputs);
        pass.dispatchWorkgroups(Math.ceil(emitter.runtime.width / 8), Math.ceil(emitter.runtime.height / 8));
        pass.end();
    }

    private _stepRaster(emitter: EmitterGpu, values: Record<string, unknown>, frame: ParticleSimFrame,
                        parent: EmitterGpu | null): void {
        const custom = emitter.packed.custom;
        const program = custom ? this._customRasterProgram(custom) : PARTICLE_PROGRAMS.sim[0];
        const pipeline = custom ? this._customRasterPipeline(program) : this._ensureRasterPipeline('sim', 4);
        const shaders = ShaderManager.Instance;
        const write = emitter.write;
        const target = device.createRenderTarget({
            label: 'particleSim.target', colorViews: write.map(t => t.attachmentView),
        });
        const pass = frame.encoder.beginRenderPass(target, {
            label: 'particles.sim',
            colorAttachments: write.map((_t, i) => ({ target: i, loadOp: 'load' as const, storeOp: 'store' as const })),
        });
        pass.setPipeline(pipeline);
        const depth = this._depthOr(frame.depth);
        pass.setBindGroup(0, emitter.group(
            `r0:${pipelineId(pipeline)}:${emitter.current}:${parent?.current ?? '-'}:${idOf(depth)}`,
            () => device.createBindGroup({
                label: 'particleSim.inputs',
                layout: pipeline.layoutForGroup(0)!,
                entries: this._simInputs(emitter, depth, parent),
            })));
        shaders.bind(program);
        this._writeStep(emitter, values, frame, (name, value) => shaders.setUniform(name, value));
        pass.setViewport(0, 0, emitter.runtime.width, emitter.runtime.height);
        pass.draw(3);
        pass.end();
    }

    /** The WebGPU simulation pipeline with `custom` spliced into the core. WGSL, compiled by the browser. */
    private _customComputePipeline(custom: NonNullable<PackedEmitter['custom']>): ComputePipeline {
        const key = 'c:' + custom.compiled.key;
        let pipeline = this._customPipelines.get(key) as ComputePipeline | undefined;
        if (!pipeline) {
            pipeline = this._computePipelineFor(`particleSim#${custom.compiled.key}`, {
                ...ParticleSimComputeProgram,
                wgsl: composeCustomSim(ParticleSimComputeProgram.wgsl, custom.source),
            });
            this._customPipelines.set(key, pipeline);
        }
        return pipeline;
    }

    /**
     * The WebGL2 program for `custom`, registered under its own name from the GLSL the editor compiled.
     * The uniform blocks are the base program's: the custom body reads only what the core already binds.
     */
    private _customRasterProgram(custom: NonNullable<PackedEmitter['custom']>): string {
        const name = `particleSim#${custom.compiled.key}`;
        if (!ShaderManager.Instance.find(name)) {
            const base = PARTICLE_PROGRAMS.sim[1];
            ShaderManager.Instance.addShader(name, device.createShaderProgram({
                label: name, vertex: custom.compiled.vertex, fragment: custom.compiled.fragment,
                wgsl: composeCustomSim(base.wgsl, custom.source),
                vertexInputs: base.vertexInputs, uniformBlocks: base.uniformBlocks,
            }));
        }
        return name;
    }

    private _customRasterPipeline(program: string): RenderPipeline {
        const key = 'r:' + program;
        let pipeline = this._customPipelines.get(key) as RenderPipeline | undefined;
        if (!pipeline) {
            const base = PARTICLE_PROGRAMS.sim[1];
            const module = device.createShaderModule({
                label: program, program, stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
                source: base.wgsl, entryPoints: base.entryPoints, resources: base.resources,
            });
            pipeline = device.createRenderPipeline({
                label: program, vertex: module, fragment: module, vertexLayouts: [],
                primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
                colorTargets: [0, 1, 2, 3].map(() => ({ format: 'rgba32float' as const })),
            });
            this._customPipelines.set(key, pipeline);
        }
        return pipeline;
    }

    /** A bind group over a compute uniform arena AT ITS CURRENT SLOT. Not cached: the slot moves per step. */
    private _uniformGroup(pipeline: ComputePipeline, uniforms: UniformSet, label: string): BindGroup {
        return device.createBindGroup({
            label,
            layout: pipeline.bindGroupLayouts.find(l => l.group === 1)!,
            entries: [{ binding: 0, buffer: uniforms.buffer, offset: uniforms.byteOffset, size: uniforms.layout.size }],
        });
    }

    private _ensureComputePipeline(): ComputePipeline {
        if (this._computePipeline) return this._computePipeline;
        this._computePipeline = this._computePipelineFor('particleSim', ParticleSimComputeProgram);
        this._simUniforms = this._uniformsFor(ParticleSimComputeProgram, 'particleSim');
        return this._computePipeline;
    }

    private _computePipelineFor(label: string, program: ParticleProgram): ComputePipeline {
        const module = device.createShaderModule({
            label, stage: ShaderStage.COMPUTE,
            source: program.wgsl, entryPoints: program.entryPoints, resources: program.resources,
        });
        return device.createComputePipeline({ label, compute: module });
    }

    private _uniformsFor(program: ParticleProgram, label: string): UniformSet {
        const block = (program.uniformBlocks as { group: number }[]).find(b => b.group === 1);
        return new UniformSet(block as unknown as UniformBlockLayout, device, 256, label);
    }

    /** The fullscreen ping-pong pipeline for `kind`, writing `targets` RGBA32F attachments. */
    private _ensureRasterPipeline(kind: 'sim' | 'sort', targets: number): RenderPipeline {
        const cached = kind === 'sim' ? this._simPipelineGL : this._sortPipelineGL;
        if (cached) return cached;
        const [name, program] = PARTICLE_PROGRAMS[kind];
        const module = device.createShaderModule({
            label: name, program: name, stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
            source: program.wgsl, entryPoints: program.entryPoints, resources: program.resources,
        });
        const pipeline = device.createRenderPipeline({
            label: name, vertex: module, fragment: module, vertexLayouts: [],
            primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
            colorTargets: Array.from({ length: targets }, () => ({ format: 'rgba32float' as const })),
        });
        if (kind === 'sim') this._simPipelineGL = pipeline; else this._sortPipelineGL = pipeline;
        return pipeline;
    }

    // ---------------------------------------------------------------------------------------------
    // Sorting
    // ---------------------------------------------------------------------------------------------

    /**
     * Order the alpha-blended emitters that asked for it, back to front from `cameraPosition`. Call
     * BEFORE opening the pass `draw` records into: the sort runs passes of its own.
     */
    public sort(nodes: Iterable<ParticleSystemNode>, encoder: CommandEncoder, cameraPosition: vec3): void {
        if (this._failed || !this.supported) return;
        try {
            for (const node of nodes) {
                const gpu = this._systems.get(node);
                if (!gpu || gpu.version !== node.version || !node.visible || !ParticleRenderer._active(node)) continue;
                for (const emitter of gpu.emitters) {
                    const r = emitter.runtime.def.render;
                    if (!r.sort || r.blend !== 'alpha' || emitter.runtime.capacity > MAX_SORTED_PARTICLES) continue;
                    this._sortEmitter(emitter, node, encoder, cameraPosition);
                }
            }
        } catch (error) {
            this._failed = true;
            Logger.print('error', ['Particle sort failed; particles are disabled for this session:', error], 'Particles');
        }
    }

    private _sortEmitter(emitter: EmitterGpu, node: ParticleSystemNode, encoder: CommandEncoder, cam: vec3): void {
        const sort = emitter.ensureSort();
        const local = emitter.packed.local;
        const common = {
            u_sortEmitter: node.worldTransform,
            u_sortSize: [sort.width, emitter.runtime.width, emitter.runtime.capacity, local ? 1 : 0],
            u_sortCam: [cam[0], cam[1], cam[2], 0],
        };
        // Pass 0 writes keys into textures[0]; every step then reads one texture and writes the other.
        let src = 1, dst = 0;
        const run = (j: number, k: number, kind: number) => {
            this._sortPass(emitter, sort, encoder, src, dst, { ...common, u_sortStep: [j, k, sort.n, kind] });
            src = dst; dst ^= 1;
        };
        run(0, 0, 0);
        for (let k = 2; k <= sort.n; k <<= 1)
            for (let j = k >> 1; j > 0; j >>= 1) run(j, k, 1);
        sort.result = src;
        emitter.sorted = true;
    }

    private _sortPass(emitter: EmitterGpu, sort: SortGpu, encoder: CommandEncoder, src: number, dst: number,
                      values: Record<string, unknown>): void {
        const inputs = (layout: () => ReturnType<RenderPipeline['layoutForGroup']>) =>
            emitter.group(`s0:${src}:${emitter.current}`, () => device.createBindGroup({
                label: 'particleSort.inputs', layout: layout()!,
                entries: [
                    { binding: 0, textureView: sort.textures[src].sampledView },
                    { binding: 1, textureView: emitter.read[0].sampledView },
                    { binding: 2, textureView: emitter.read[1].sampledView },
                ],
            }));
        if (device.capabilities.hasCompute) {
            if (!this._sortComputePipeline) {
                this._sortComputePipeline = this._computePipelineFor('particleSort', ParticleSortComputeProgram);
                this._sortUniforms = this._uniformsFor(ParticleSortComputeProgram, 'particleSort');
            }
            const pipeline = this._sortComputePipeline;
            const uniforms = this._sortUniforms!;
            for (const [name, value] of Object.entries(values)) uniforms.set(name, value);
            uniforms.flush(device);
            const pass = encoder.beginComputePass('particles.sort');
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, inputs(() => pipeline.bindGroupLayouts.find(l => l.group === 0)));
            pass.setBindGroup(1, this._uniformGroup(pipeline, uniforms, 'particleSort.uniforms'));
            pass.setBindGroup(2, emitter.group(`s2:${dst}`, () => device.createBindGroup({
                label: 'particleSort.output', layout: pipeline.bindGroupLayouts.find(l => l.group === 2)!,
                entries: [{ binding: 0, storageTextureView: sort.textures[dst].attachmentView }],
            })));
            pass.dispatchWorkgroups(Math.ceil(sort.n / 64));
            pass.end();
            return;
        }
        const pipeline = this._ensureRasterPipeline('sort', 1);
        const target = device.createRenderTarget({ label: 'particleSort.target', colorViews: [sort.textures[dst].attachmentView] });
        const pass = encoder.beginRenderPass(target, {
            label: 'particles.sort', colorAttachments: [{ target: 0, loadOp: 'load', storeOp: 'store' }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, inputs(() => pipeline.layoutForGroup(0)));
        const shaders = ShaderManager.Instance;
        shaders.bind(PARTICLE_PROGRAMS.sort[0]);
        for (const [name, value] of Object.entries(values)) shaders.setUniform(name, value);
        pass.setViewport(0, 0, sort.width, sort.n / sort.width);
        pass.draw(3);
        pass.end();
    }

    // ---------------------------------------------------------------------------------------------
    // Drawing
    // ---------------------------------------------------------------------------------------------

    /**
     * Draw every particle system in `nodes` into `frame.pass`, back to front by system. Within an
     * emitter, particles draw in slot order unless the emitter is sorted (see {@link sort}).
     */
    public draw(nodes: Iterable<ParticleSystemNode>, frame: ParticleDrawFrame): void {
        if (this._failed || !this.supported) return;
        const view = frame.view;
        const right = [view[0], view[4], view[8]];
        const up = [view[1], view[5], view[9]];
        const forward = [-view[2], -view[6], -view[10]];

        const list: { node: ParticleSystemNode; gpu: SystemGpu; distance: number }[] = [];
        for (const node of nodes) {
            if (!node.visible || !ParticleRenderer._active(node)) continue;
            const gpu = this._systems.get(node);
            if (!gpu || gpu.version !== node.version) continue;
            if (frame.visible) {
                const box = node.getBoundingBox();
                if (!frame.visible(box.min, box.max)) continue;
            }
            list.push({ node, gpu, distance: vec3.squaredDistance(node.worldPosition, frame.cameraPosition) });
        }
        if (list.length === 0) return;
        list.sort((a, b) => b.distance - a.distance);

        const shaders = ShaderManager.Instance;
        const depth = this._depthOr(frame.depth);
        try {
            for (const { node, gpu } of list) {
                const order = gpu.emitters.slice().sort((a, b) =>
                    a.runtime.def.render.sortingOrder - b.runtime.def.render.sortingOrder);
                for (const emitter of order) {
                    const render = emitter.runtime.def.render;
                    const mesh = render.mode === 'mesh' ? this._meshFor(render) : null;
                    const pipeline = this._drawPipeline(frame.target, render, !!mesh);
                    frame.pass.setPipeline(pipeline);

                    const sprite = (render.textureId && TextureManager.Instance.getTexture(render.textureId)) || null;
                    const spriteTex = sprite && sprite.sampledView ? sprite : this._whiteTexture;
                    const sorted = emitter.sorted && emitter.sort ? emitter.sort.textures[emitter.sort.result] : null;
                    const orderTex = sorted ?? this._whiteTexture;
                    frame.pass.setBindGroup(0, emitter.group(
                        `d0:${pipelineId(pipeline)}:${emitter.current}:${idOf(spriteTex)}:${idOf(depth)}:${idOf(orderTex)}`,
                        () => device.createBindGroup({
                            label: 'particleDraw',
                            layout: pipeline.layoutForGroup(0)!,
                            entries: [
                                ...emitter.read.map((t, i) => ({ binding: i, textureView: t.sampledView })),
                                { binding: 4, textureView: emitter.lut.sampledView },
                                { binding: 5, textureView: spriteTex.sampledView },
                                { binding: 7, textureView: depth.sampledView },
                                { binding: 9, textureView: orderTex.sampledView },
                            ],
                        })));

                    shaders.bind(mesh ? PARTICLE_PROGRAMS.mesh[0] : PARTICLE_PROGRAMS.billboard[0]);
                    const packed = emitter.packed;
                    const m = node.worldTransform;
                    const scale = packed.local ? Math.cbrt(Math.abs(mat4.determinant(m))) || 1 : 1;
                    const mask = packed.drawMask | (sorted ? DRAW.SORTED : 0);
                    shaders.setUniform('u_viewProj', frame.viewProj);
                    shaders.setUniform('u_emitter', m);
                    shaders.setUniform('u_camRight', [right[0], right[1], right[2], emitter.runtime.width]);
                    shaders.setUniform('u_camUp', [up[0], up[1], up[2], emitter.sort?.width ?? 1]);
                    shaders.setUniform('u_camPos', [frame.cameraPosition[0], frame.cameraPosition[1],
                                                     frame.cameraPosition[2], packed.draw.alignment[0]]);
                    shaders.setUniform('u_camForward', [forward[0], forward[1], forward[2], packed.draw.stretch[0]]);
                    shaders.setUniform('u_drawMask', [mask, scale, 0, 0]);
                    shaders.setUniform('u_tint', node.tint);
                    shaders.setUniform('u_flipbook', packed.draw.u_flipbook);
                    shaders.setUniform('u_flipbook2', packed.draw.u_flipbook2);
                    shaders.setUniform('u_speedRange', packed.draw.u_speedRange);
                    shaders.setUniform('u_fragParams', packed.frag.u_fragParams);
                    shaders.setUniform('u_depthParams', [frame.near, frame.far, frame.orthographic ? 1 : 0, frame.depth ? 1 : 0]);
                    shaders.setUniform('u_fragMask', [sprite ? 1 : 0, render.lit ? 1 : 0, 1 / frame.width, 1 / frame.height]);
                    shaders.setUniform('u_ambient', [frame.ambient[0], frame.ambient[1], frame.ambient[2], mesh ? 1 : 0]);
                    shaders.setUniform('u_sunDir', [frame.sunDirection[0], frame.sunDirection[1], frame.sunDirection[2], 0]);
                    shaders.setUniform('u_sunColor', [frame.sunColor[0], frame.sunColor[1], frame.sunColor[2], 0]);
                    if (mesh) {
                        frame.pass.setVertexBuffer(0, mesh.vertices);
                        frame.pass.setIndexBuffer(mesh.indices, 'uint32');
                        frame.pass.drawIndexed(mesh.indexCount, emitter.runtime.capacity);
                    } else {
                        frame.pass.draw(6, emitter.runtime.capacity);
                    }
                    frameStats.particlesDrawn += emitter.runtime.capacity;
                }
            }
        } catch (error) {
            this._failed = true;
            Logger.print('error', ['Particle draw failed; particles are disabled for this session:', error], 'Particles');
        }
    }

    /** The GPU buffers for an emitter's mesh, built once per shape (or per captured model). */
    private _meshFor(render: RenderSettings): MeshGpu | null {
        const data = render.mesh === 'model' ? render.meshData : null;
        if (render.mesh === 'model' && !data) return null;
        const key = data
            ? `model:${render.modelId ?? ''}:${data.positions.length}:${data.indices.length}:${data.positions[0] ?? 0}`
            : render.mesh;
        let mesh = this._meshes.get(key);
        if (mesh) return mesh;
        const source = data ?? builtinParticleMesh(render.mesh === 'model' ? 'cube' : render.mesh);
        const { vertices, indices } = interleaveParticleMesh(source);
        const vertexBuffer = device.reallocateBuffer(device.createBuffer({
            label: `particleMesh.${key}.vertices`, size: 0, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        }), vertices);
        const indexBuffer = device.reallocateBuffer(device.createBuffer({
            label: `particleMesh.${key}.indices`, size: 0, usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
        }), indices);
        mesh = { vertices: vertexBuffer, indices: indexBuffer, indexCount: indices.length };
        // A model swapped many times while authoring would otherwise keep every old copy alive.
        if (this._meshes.size > 32) {
            for (const old of this._meshes.values()) { old.vertices.destroy(); old.indices.destroy(); }
            this._meshes.clear();
        }
        this._meshes.set(key, mesh);
        return mesh;
    }

    /** Slot 0 for a mesh: position, normal, uv, 32 bytes — by the names the generated GLSL declares. */
    private static _meshLayout(): VertexBufferLayout[] {
        const inputs = PARTICLE_PROGRAMS.mesh[1].vertexInputs;
        const at = (location: number) => inputs.find(i => i.location === location)?.name ?? '';
        return [{
            arrayStride: 32, stepMode: 'vertex',
            attributes: [
                { name: at(0), shaderLocation: 0, offset: 0, format: 'float32x3' },
                { name: at(1), shaderLocation: 1, offset: 12, format: 'float32x3' },
                { name: at(2), shaderLocation: 2, offset: 24, format: 'float32x2' },
            ],
        }];
    }

    private _drawPipeline(target: RenderTarget, render: RenderSettings, mesh: boolean): RenderPipeline {
        const color = target.colorViews[0].texture.format;
        const depthFormat = target.depthView?.texture.format;
        // Opaque cutout meshes write depth, so they occlude each other like any solid; everything else
        // tests against the scene and leaves its depth alone.
        const writesDepth = mesh && render.blend === 'cutout';
        const key = `${mesh ? 'mesh' : 'billboard'}|${render.blend}|${color}|${depthFormat ?? '-'}|${writesDepth}`;
        let pipeline = this._drawPipelines.get(key);
        if (pipeline) return pipeline;
        const [name, program] = mesh ? PARTICLE_PROGRAMS.mesh : PARTICLE_PROGRAMS.billboard;
        const module = device.createShaderModule({
            label: name, program: name, stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
            source: program.wgsl, entryPoints: program.entryPoints, resources: program.resources,
        });
        pipeline = device.createRenderPipeline({
            label: `${name}.${render.blend}`, vertex: module, fragment: module,
            vertexLayouts: mesh ? ParticleRenderer._meshLayout() : [],
            primitive: { topology: 'triangle-list', cullMode: mesh ? 'back' : 'none', frontFace: 'ccw' },
            ...(depthFormat ? {
                depthStencil: { format: depthFormat, depthWriteEnabled: writesDepth, depthCompare: 'less-equal' as const },
            } : {}),
            colorTargets: [{
                format: color,
                blend: render.blend === 'additive' ? ADDITIVE_KEEP_ALPHA
                     : render.blend === 'cutout' ? DEFAULT_BLEND
                     : PREMULTIPLIED_KEEP_ALPHA,
            }],
        });
        this._drawPipelines.set(key, pipeline);
        return pipeline;
    }

    /** Drop pipelines, e.g. after the device is replaced. */
    public resetPipelines(): void {
        this._computePipeline = null;
        this._simUniforms?.destroy();
        this._simUniforms = null;
        this._sortComputePipeline = null;
        this._sortUniforms?.destroy();
        this._sortUniforms = null;
        this._simPipelineGL = null;
        this._sortPipelineGL = null;
        this._drawPipelines.clear();
        this._customPipelines.clear();
        this._failed = false;
        textureIds = new WeakMap();
        nextTextureId = 1;
    }
}

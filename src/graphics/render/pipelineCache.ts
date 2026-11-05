import { Logger } from '../../core/logger';
import { device } from '../rhi/deviceHandle';
import { ShaderStage } from '../rhi/types';
import type { ShaderResource, BlendState, DepthStencilState, CullMode, PrimitiveTopology, VertexBufferLayout, TextureFormat } from '../rhi/types';
import type { RenderPipeline, RenderTarget, ShaderModule } from '../rhi/resources';
import type { RenderPipelineDescriptor } from '../rhi/device';
import type { ShaderProgramDescriptor } from '../rhi/shaderProgram';
import { modelVertexLayout, instanceMatrixLayout, boneLayouts, screenQuadLayout, TILE_VERTEX_LAYOUT } from '../rhi/vertexLayouts';
import { ShaderManager } from '../systems/shaderManager';
import { EXTRA_LOGICAL_NAMES, type ShadowFilter } from '../programVariants';
import { serializeRecipe, recordStall, shaderOptimizerStats } from '../shaderOptimizer';
import type { PipelineRecipe } from '../shaderOptimizer';
import type { FrameView } from './frameView';
import type { PassEncoder } from './passEncoder';

/** What PipelineCache reads from the renderer's program registry. */
export interface PipelineCacheHost {
    /** Build-time program variants are in use (a published program list, or `config.shaderVariants`). */
    readonly variants: boolean;
    /** The shadow filter the variant aliases currently resolve to. */
    filter(): ShadowFilter;
    /** The program a logical name is served by right now. */
    physicalOf(name: string): string;
    /** The descriptor behind a program name, or null for one the table does not provide. */
    descriptorFor(name: string): Omit<ShaderProgramDescriptor, 'label'> | null;
}

/**
 * Render pipelines and shader modules, built once per program + state and cached: two draws that want the
 * same program and state get the same pipeline object. Records every pipeline it builds as a recipe a
 * publish can ship, and warms a published game's recipes ahead of use. Split out of Renderer.
 */
export class PipelineCache {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: PipelineCacheHost,
                private readonly _view: FrameView,
                private readonly _passes: PassEncoder,
                warmRecipes: PipelineRecipe[]) {
        this._warmRecipes = warmRecipes;
    }

    /** Every pipeline built, by its state key. See `get`. */
    private readonly _byKey = new Map<string, RenderPipeline>();

    /** Bumped whenever a cached pipeline (a shadow caster's) may no longer be the one `get` would build. */
    public epoch: number = 0;

    /** `get`'s logical -> variant resolution, valid for `_variantMemoFilter`. */
    private readonly _variantMemo = new Map<string, { program: string; wgsl?: string;
                                                      entryPoints?: { vertex?: string; fragment?: string; compute?: string } } | null>();

    private _variantMemoFilter: ShadowFilter | -1 = -1;

    /** Every pipeline built this session, as a recipe a publish can ship. See `recipes`. */
    private readonly _pipelineRecipes = new Map<string, PipelineRecipe>();

    /** Recipes handed in by the config, built ahead of use by {@link warm}. */
    private readonly _warmRecipes: PipelineRecipe[];

    /**
     * Shader modules by program and source: a program drawn under several pipeline states (cull modes,
     * targets, blends) compiles its module once. WebGPU parses and validates WGSL per module.
     */
    private readonly _moduleCache = new Map<string, Map<string, ShaderModule>>();

    /** A colour target's write mask with every channel off: a depth-only draw into a colour pass. */
    private static readonly _NO_COLOR_WRITE: [boolean, boolean, boolean, boolean] = [false, false, false, false];

    /**
     * The RHI pipeline for `program` under a particular render state, built once per combination and
     * cached on a string key: two draws wanting the same program and state must get the same object.
     */
    /**
     * The two halves of the pipeline key that used to go through `JSON.stringify`.
     *
     * `get` is called per submesh per draw, and per caster per cascade in the shadow pass, and
     * every caller hands it a freshly built state literal — so the serialisation could not be hoisted
     * and ran thousands of times a frame to produce a string the Map lookup below it uses once.
     * Concatenating the fields by hand is the same key at a fraction of the cost. EVERY field must
     * appear: a state that differs only in a field left out here would silently reuse the wrong
     * pipeline.
     */
    // _pipelineFor runs for every draw, and its key used to be rebuilt from scratch each time: the
    // formats array sliced and joined, the blend and depth states stringified. Most callers pass the same
    // state OBJECTS frame after frame, so each piece is memoised on its object — the strings are made once.
    private static readonly _depthKeys = new WeakMap<DepthStencilState, string>();

    private static readonly _blendKeys = new WeakMap<BlendState, string>();

    private readonly _formatKeys = new WeakMap<RenderTarget, string[]>();

    /**
     * The RHI pipeline for a fullscreen pass, built once per program + state combination. Every
     * fullscreen pass writes one target, never tests depth and never culls, so blend is the only
     * thing that varies.
     */
    public fullscreen(program: string,
                                reflection: { resources: readonly ShaderResource[]; wgsl?: string;
                                              entryPoints?: { vertex?: string; fragment?: string;
                                                              compute?: string } },
                                blend?: BlendState, depthStencil?: DepthStencilState,
                                target?: RenderTarget | null): RenderPipeline {
        // The shared screen quad is position + texCoord interleaved, 20 bytes — what
        // `packedModelLayout` produces for a program declaring those two, so `builtFor: program` fits.
        // It must not be left empty: a pipeline with no vertex layouts binds no attributes at all.
        return this.get(program, reflection,
                                 { blend, depthStencil, vertex: 'model', builtFor: program, target });
    }

    public get(program: string,
                         reflection: { resources: readonly ShaderResource[]; wgsl?: string;
                                       entryPoints?: { vertex?: string; fragment?: string;
                                                       compute?: string };
                                       /**
                                        * A SEPARATE module for the vertex stage, used only by custom
                                        * materials, whose WGSL is a translated fragment stage alone.
                                        * Both modules carry the same `program` name.
                                        */
                                       vertexWgsl?: { wgsl: string; entryPoint: string } },
                         options: { blend?: BlendState; depthStencil?: DepthStencilState;
                                    cullMode?: CullMode; targets?: number;
                                    topology?: PrimitiveTopology;
                                    vertex?: false | 'model' | 'model+instance' | 'model+skin' | 'tile';
                                    builtFor?: string | null;
                                    /**
                                     * The target this pipeline will draw into, required only when it is
                                     * built BEFORE the pass is opened; otherwise `_passes.target`.
                                     */
                                    target?: RenderTarget | null;
                                    /** False writes depth only: every colour target's write mask off. */
                                    colorWrite?: boolean } = {}): RenderPipeline {
        const { blend, depthStencil, cullMode = 'none', targets = 1,
                topology = 'triangle-list', vertex = false, builtFor = null, colorWrite = true } = options;
        // A logical name served by a variant (programVariants.ts): WebGPU compiles the WGSL handed in
        // here, not the program ShaderManager has, so the variant's own source has to replace the base
        // reflection the caller passed — and its name keys the cache, so a filter switch builds anew.
        //
        // NOT only with variants on: the `Pom` names resolve to their parallax variant in the editor too
        // (the base program has the march compiled out), so gating this on `_variants` left WebGPU
        // compiling the base WGSL for every height-mapped material — flat, while WebGL2, which binds the
        // linked program by name, showed the relief.
        if (this._host.variants || program in EXTRA_LOGICAL_NAMES) {
            // Memoized per logical name and filter: this runs for every draw, and resolving builds strings.
            const filter = this._host.filter();
            if (this._variantMemoFilter !== filter) {
                this._variantMemo.clear();
                this.epoch++;
                this._variantMemoFilter = filter;
            }
            let swap = this._variantMemo.get(program);
            if (swap === undefined) {
                const physical = this._host.physicalOf(program);
                const variant = physical !== program ? this._host.descriptorFor(physical) : null;
                swap = variant ? { program: physical, wgsl: variant.wgsl,
                                   entryPoints: (variant as { entryPoints?: typeof reflection.entryPoints }).entryPoints } : null;
                this._variantMemo.set(program, swap);
            }
            if (swap) {
                program = swap.program;
                reflection = { ...reflection, wgsl: swap.wgsl, entryPoints: swap.entryPoints };
            }
        }
        // `builtFor` is part of the key: one shadow program draws over buffers of several strides.
        // The ATTACHMENT FORMATS are part of the pipeline and WebGPU rejects a mismatch with its pass,
        // so they are derived from the target the caller is about to draw into.
        const target = options.target ?? this._passes.target;
        // A caller that named its own depth state keeps it; otherwise it comes from the target, because
        // `_passes.beginFullscreenPass` always declares a depth attachment and WebGPU requires the pipeline to
        // match one that exists.
        const depthFormat = target?.depthView?.texture.format;
        // The synthesised default is "no depth interaction", NOT the depth-test defaults — anything
        // else makes every fullscreen post pass depth-test and stamp the depth buffer. WebGPU requires
        // depth state whenever the pass has a depth attachment, and `_passes.beginFullscreenPass` always does.
        const resolvedDepth = depthStencil
            ?? (depthFormat ? { format: depthFormat, depthWriteEnabled: false,
                                depthCompare: 'always' as const } : undefined);

        // Only WebGPU has a front-face to get wrong here: WebGL2 keeps its own winding state and the
        // cube-face capture never changed it.
        const cubeFace = this._view.cubeFace && device.backend === 'webgpu';
        const key = program + '|' + cullMode + '|' + targets + '|' + topology + '|' + vertex
                            + '|' + (builtFor ?? '') + (cubeFace ? '|cw' : '')
                            + (reflection.vertexWgsl ? '|vs' : '')
                            + '|' + this._formatKey(target, targets)
                            + (blend ? '|' + PipelineCache._blendKey(blend) : '')
                            + (resolvedDepth ? '|' + PipelineCache._depthKey(resolvedDepth) : '')
                            + (colorWrite ? '' : '|nc');
        let pipeline = this._byKey.get(key);
        if (!pipeline) {
            const buildStart = performance.now();
            const colorFormats = target ? target.colorViews.slice(0, targets).map(v => v.texture.format) : [];
            // One module per program and source, shared by every pipeline state it is drawn under. Not for a
            // custom material's split vertex stage, whose resources are rebuilt per material.
            const module = this.shaderModuleFor(program, reflection, !reflection.vertexWgsl);
            const vertexModule = reflection.vertexWgsl
                ? device.createShaderModule({
                    label: program, program, stage: ShaderStage.VERTEX,
                    source: reflection.vertexWgsl.wgsl,
                    entryPoints: { vertex: reflection.vertexWgsl.entryPoint },
                    resources: reflection.resources,
                  })
                : module;
            pipeline = device.createRenderPipeline({
                label: program,
                vertex: vertexModule, fragment: module,
                // Slot 0 is the interleaved model vertex; slot 1 the per-instance model matrix across
                // four slots, neither API having a mat4 vertex format. With no `vertex` shape this is a
                // fullscreen pass and takes the SCREEN QUAD's layout — never `[]`, which is invalid.
                vertexLayouts: vertex
                    ? this.vertexLayoutsFor(program, vertex, builtFor)
                    : screenQuadLayout(this._shaderManager.getShader(program).attributes),
                // A Y-inverted projection reverses winding, so a cube-face capture calls the other
                // side the front. Part of the cache key below for the same reason the cull mode is.
                primitive: { topology, cullMode, frontFace: cubeFace ? 'cw' : 'ccw' },
                ...(resolvedDepth ? { depthStencil: resolvedDepth } : {}),
                colorTargets: Array.from({ length: targets }, (_unused, i) => ({
                    // `rgba8unorm` only when there is no target to ask - the legacy fallback, and the
                    // shape every one of these used to have unconditionally.
                    format: colorFormats[i] ?? ('rgba8unorm' as const),
                    ...(blend ? { blend } : {}),
                    ...(colorWrite ? {} : { writeMask: PipelineCache._NO_COLOR_WRITE }),
                })),
            });
            this._byKey.set(key, pipeline);
            shaderOptimizerStats.pipelinesBuilt++;
            if (device.backend === 'webgpu') recordStall(`pipeline ${program}`, performance.now() - buildStart);
            // Recorded for a publish to warm (shaderOptimizer/pipelineRecipes.ts) — never a custom material's,
            // whose program is assembled at runtime and has no name a later boot could look up.
            if (!reflection.vertexWgsl && !program.startsWith('custom') && !this._pipelineRecipes.has(key)) {
                this._pipelineRecipes.set(key, {
                    program, cullMode, targets, topology, vertex, builtFor, cubeFace,
                    colorFormats: colorFormats.slice(),
                    blend: blend ?? null,
                    depthStencil: resolvedDepth ?? null,
                    ...(colorWrite ? {} : { colorWrite: false }),
                });
                shaderOptimizerStats.recipesRecorded = this._pipelineRecipes.size;
            }
        }
        return pipeline;
    }

    private static _depthKey(d: DepthStencilState): string {
        let k = PipelineCache._depthKeys.get(d);
        if (k === undefined) {
            k = d.format + (d.depthWriteEnabled ? 'w' : '-') + d.depthCompare
                + ':' + (d.depthBias ?? 0) + ':' + (d.depthBiasSlopeScale ?? 0);
            PipelineCache._depthKeys.set(d, k);
        }
        return k;
    }

    private static _blendKey(b: BlendState): string {
        let k = PipelineCache._blendKeys.get(b);
        if (k === undefined) {
            k = b.color.srcFactor + b.color.dstFactor + b.color.operation
                + '/' + b.alpha.srcFactor + b.alpha.dstFactor + b.alpha.operation;
            PipelineCache._blendKeys.set(b, k);
        }
        return k;
    }

    /** The first `targets` colour formats of `target`, joined — memoised per target and count. */
    private _formatKey(target: RenderTarget | null | undefined, targets: number): string {
        if (!target) return '';
        let byCount = this._formatKeys.get(target);
        if (!byCount) { byCount = []; this._formatKeys.set(target, byCount); }
        let k = byCount[targets];
        if (k === undefined) {
            k = target.colorViews.slice(0, targets).map(v => v.texture.format).join(',');
            byCount[targets] = k;
        }
        return k;
    }

    /**
     * The shader module for `program`'s source, from the module cache when `cacheable`. WebGPU parses and
     * validates WGSL per module, so a program drawn under several pipeline states (both cull modes,
     * wireframe, a second target set) used to compile its module once per state.
     */
    public shaderModuleFor(program: string,
                             reflection: { resources: readonly ShaderResource[]; wgsl?: string;
                                           entryPoints?: { vertex?: string; fragment?: string; compute?: string } },
                             cacheable: boolean): ShaderModule {
        const source = reflection.wgsl ?? '';
        const entries = reflection.entryPoints;
        const entryKey = entries ? `${entries.vertex ?? ''}/${entries.fragment ?? ''}/${entries.compute ?? ''}` : '';
        let byProgram = cacheable ? this._moduleCache.get(program + '#' + entryKey) : undefined;
        const hit = byProgram?.get(source);
        if (hit) { shaderOptimizerStats.moduleReuses++; return hit; }
        const module = device.createShaderModule({
            label: program,
            program,
            stage: ShaderStage.VERTEX | ShaderStage.FRAGMENT,
            // WebGPU compiles the WGSL; WebGL2 reaches the linked program by name and uses only the
            // reflection. Optional — a runtime-assembled custom material has no WGSL at all.
            source,
            ...(entries ? { entryPoints: entries } : {}),
            resources: reflection.resources,
        });
        if (cacheable) {
            if (!byProgram) { byProgram = new Map(); this._moduleCache.set(program + '#' + entryKey, byProgram); }
            byProgram.set(source, module);
        }
        return module;
    }

    /**
     * Vertex layouts for a program, by the shape of mesh it will draw. Slot 0 is always the interleaved
     * model vertex; slot 1 is the per-instance matrix or the bone indices, slot 2 the bone weights.
     */
    public vertexLayoutsFor(program: string, shape: 'model' | 'model+instance' | 'model+skin' | 'tile',
                              builtFor?: string | null): VertexBufferLayout[] {
        // The tile vertex is genuinely its own format — position.xy | uv.xy | colour.rgba, 32 bytes —
        // and its locations are declared in the shader rather than reflected, so it needs none of the
        // model-attribute machinery below.
        if (shape === 'tile') return [TILE_VERTEX_LAYOUT];
        const attributes = this._shaderManager.getShader(program).attributes;
        // Offsets and stride come from the program the BUFFER was written for, locations from the one
        // about to draw it — `initializeModel` packs every vertex, skinned included, to its material
        // program's attributes. `builtFor: null` has no correct caller today.
        const model = modelVertexLayout(attributes,
            builtFor ? this._shaderManager.getShader(builtFor).attributes : null);
        if (shape === 'model+skin') {
            const bones = boneLayouts(attributes);
            return bones ? [model, bones[0], bones[1]] : [model];
        }
        return shape === 'model+instance' ? [model, instanceMatrixLayout(5)] : [model];
    }

    /**
     * Every pipeline this session has built, as recipes (shaderOptimizer/pipelineRecipes.ts). The editor
     * hands them to publish, which writes them into `config.graphics.pipelines` for the player to warm.
     */
    public recipes(): PipelineRecipe[] {
        return [...this._pipelineRecipes.values()].map(serializeRecipe);
    }

    /**
     * Build the config's recorded pipelines ahead of use, off the main thread (WebGPU's
     * `createRenderPipelineAsync`), so the first frame that draws each one finds it ready instead of
     * stalling to compile it. Resolves when all are done; a recipe whose program this build does not have
     * is skipped. A no-op on WebGL2, where a pipeline is a state bundle over an already-linked program.
     */
    public async warm(onProgress?: (done: number, total: number) => void): Promise<number> {
        const recipes = this._warmRecipes;
        if (!recipes.length || device?.backend !== 'webgpu') return 0;
        const create = device.createRenderPipelineAsync?.bind(device);
        if (!create) return 0;
        let done = 0, warmed = 0;
        const jobs = recipes.map(async (r) => {
            try {
                const built = this._recipePipeline(r, create);
                if (built) {
                    const [key, pipeline] = await built;
                    if (!this._byKey.has(key)) {
                        this._byKey.set(key, pipeline);
                        warmed++;
                    }
                }
            } catch (e) {
                Logger.warn(`[shaders] could not warm pipeline '${r.program}': ${e}`, 'Renderer');
            } finally {
                onProgress?.(++done, recipes.length);
            }
        });
        await Promise.all(jobs);
        shaderOptimizerStats.pipelinesWarmed += warmed;
        return warmed;
    }

    /**
     * Start building one recipe's pipeline, under exactly the key `get` would look it up by.
     * Null when this build has no program by that name (a recipe from an older or larger build).
     */
    private _recipePipeline(r: PipelineRecipe, create: (d: RenderPipelineDescriptor) => Promise<RenderPipeline>):
            Promise<[string, RenderPipeline]> | null {
        const descriptor = this._host.descriptorFor(r.program) ?? this._host.descriptorFor(this._host.physicalOf(r.program));
        if (!descriptor || !this._shaderManager.find(r.program) && !this._shaderManager.find(this._host.physicalOf(r.program)))
            return null;
        const reflection = descriptor as unknown as { resources: readonly ShaderResource[]; wgsl?: string;
                                                      entryPoints?: { vertex?: string; fragment?: string; compute?: string } };
        if (!reflection.wgsl) return null;
        const key = r.program + '|' + r.cullMode + '|' + r.targets + '|' + r.topology + '|' + r.vertex
                  + '|' + (r.builtFor ?? '') + (r.cubeFace ? '|cw' : '')
                  + '|' + r.colorFormats.join(',')
                  + (r.blend ? '|' + PipelineCache._blendKey(r.blend) : '')
                  + (r.depthStencil ? '|' + PipelineCache._depthKey(r.depthStencil) : '')
                  + (r.colorWrite === false ? '|nc' : '');
        if (this._byKey.has(key)) return null;
        const module = this.shaderModuleFor(r.program, reflection, true);
        return create({
            label: r.program,
            vertex: module, fragment: module,
            vertexLayouts: r.vertex
                ? this.vertexLayoutsFor(r.program, r.vertex, r.builtFor)
                : screenQuadLayout(this._shaderManager.getShader(r.program).attributes),
            primitive: { topology: r.topology, cullMode: r.cullMode, frontFace: r.cubeFace ? 'cw' : 'ccw' },
            ...(r.depthStencil ? { depthStencil: r.depthStencil } : {}),
            colorTargets: Array.from({ length: r.targets }, (_unused, i) => ({
                format: (r.colorFormats[i] ?? 'rgba8unorm') as TextureFormat,
                ...(r.blend ? { blend: r.blend } : {}),
                ...(r.colorWrite === false ? { writeMask: PipelineCache._NO_COLOR_WRITE } : {}),
            })),
        }).then(pipeline => [key, pipeline] as [string, RenderPipeline]);
    }
}

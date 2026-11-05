import { AnimatedModel } from '../../animation/animatedModel';
import { ModelNode } from '../../core/scene/nodes/modelNode';
import { Material, CustomMaterial } from '../material';
import type { RenderPassEncoder } from '../rhi/device';
import type { RenderPipeline } from '../rhi/resources';
import type { BlendState, CullMode, DepthStencilState } from '../rhi/types';
import { customPipelineReflection, customShaderReady } from '../systems/customShaders';
import type { Texture } from '../texture';
import type { FrameView } from './frameView';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache, PipelineMemo, PipelineReflection } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { MaterialBinder } from './materialBinder';
import type { ViewProjection } from './viewProjection';
import { ShaderManager } from '../systems/shaderManager';

/** `count` identity matrices, packed. */
function identityPalette(count: number): Float32Array {
    const out = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) out[i * 16] = out[i * 16 + 5] = out[i * 16 + 10] = out[i * 16 + 15] = 1;
    return out;
}

/**
 * How one call site draws a model's materials: the pipeline state its pass needs and how it binds the
 * frame's lighting. Persistent per call site and updated per draw, so a draw allocates nothing.
 */
export interface MaterialDrawState {
    /** Colour attachments of the pass: 3 for the G-buffer, 1 otherwise. */
    targets: number;
    /** A shared constant (DEPTH_WRITE, DEPTH_TEST): the pipeline memo compares it by identity. */
    depthStencil: DepthStencilState;
    blend: BlendState | undefined;
    /** Which prelude a custom material's resources come from; `forward` keeps only what its WGSL uses. */
    customMode: 'deferred' | 'forward';
    /** Bind group 3 — shadow maps and light grid — wherever the program declares it. */
    frameLighting: boolean;
    /**
     * Terrain writes the view position and sun direction into its OWN uniform block (TerrainUniforms) for
     * parallax and self-shadow. The G-buffer pass; the forward terrain twin reads the sun from its light list.
     */
    terrainSelfShadow: boolean;
    /** False draws through the legacy immediate path: nothing is recorded, materials bind by hand. */
    viaRHI: boolean;
    /** The reflection cube group 0 carries (forward only), or null. */
    envCube: Texture | null;
    readonly memo: PipelineMemo;
}

/**
 * The pieces every model draw shares, whichever pass it is in: the submesh loop that binds each
 * range's material, the skinning palette upload, the material-side to cull-mode mapping, and the
 * stable object ids the draw sort and instancing keys are built from. Split out of Renderer.
 */
export class ModelDraw {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _view: FrameView,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _materials: MaterialBinder,
                private readonly _projection: ViewProjection) {}

    // The draw `_bindMaterial` serves, set by `drawMaterials` around its submesh loop: one callback bound
    // for the object's life instead of a closure built per draw.
    private _drawPass: RenderPassEncoder | undefined = undefined;
    private _drawNode: ModelNode | null = null;
    private _drawShader = '';
    private _drawReflection: PipelineReflection | undefined = undefined;
    private _drawAnimated = false;
    private _drawState: MaterialDrawState | null = null;
    private readonly _bindMaterial = (mat: Material): boolean => this._bindModelMaterial(mat);

    public specularAaEnabled: boolean = true;

    // Reused scratch to avoid per-frame allocations
    public boneMatrixScratch: Float32Array = new Float32Array(100 * 16);
    /** Preallocated identity bone matrices, uploaded for an animated model that has no animator. */
    public readonly boneIdentityScratch: Float32Array = identityPalette(100);

    // Object -> stable id (for grouping identical mesh+material into instanced draws)
    private _objIds: WeakMap<object, number> = new WeakMap();
    private _objIdCounter: number = 0;

    /**
     * `Material.config.side` as a cull mode. The mapping INVERTS: `side: 'front'` means show the front
     * faces, so the BACK ones are culled.
     */
    public static cullFor(side: 'front' | 'back' | 'double' | undefined): CullMode {
        if (side === 'double') return 'none';
        return side === 'back' ? 'front' : 'back';
    }

    // Whether this material has a program behind it at all. Checked HERE rather than in a bind
    // callback: those return false to mean "use the legacy `mesh.draw()`", which is a raw `gl` call.
    private static _drawable(mat: Material): boolean {
        return !(mat instanceof CustomMaterial) || customShaderReady(mat);
    }

    // Draw a model's index buffer, applying `bindMaterial` before each range. The single-material case
    // takes the same path with one range.
    public drawSubmeshes(node: ModelNode, bindMaterial: (material: Material) => boolean | void,
                           pass?: RenderPassEncoder): void {
        const model = node.model;
        if (!model.hasSubmeshes) {
            const mat = model.material;
            if (!ModelDraw._drawable(mat)) return;
            // A callback that set a PIPELINE has already fixed the cull mode; calling _materials.applyCull after
            // it would be harmless today and wrong the moment the two disagree.
            const viaPipeline = !!bindMaterial(mat);
            if (!viaPipeline) this._materials.applyCull(mat.config.side);
            if (viaPipeline && pass && this._passes.recordDraw(pass, model.mesh, 0, 0)) return;
            model.mesh.draw(mat.config.wireframe ? 'line-list' : 'triangle-list');
            return;
        }
        const submeshes = model.submeshes;
        for (let i = 0; i < submeshes.length; i++) {
            // `materials` is parallel to `submeshes` by construction, but indexing it unguarded turns any
            // future disagreement into a mid-frame TypeError rather than a wrong colour. Slot 0 always exists.
            const mat = model.materials[i] ?? model.materials[0];
            if (!ModelDraw._drawable(mat)) continue;
            const viaPipeline = !!bindMaterial(mat);
            if (!viaPipeline) this._materials.applyCull(mat.config.side);
            if (viaPipeline && pass
                && this._passes.recordDraw(pass, model.mesh, submeshes[i].start, submeshes[i].count)) continue;
            model.mesh.drawRange(submeshes[i].start, submeshes[i].count,
                mat.config.wireframe ? 'line-list' : 'triangle-list');
        }
    }

    /**
     * Everything a model draw sets before its materials: the skinned VAO, the program, the camera and
     * world transforms, the despawn dissolve and the camera's see-through hole, and the bone palette.
     * The projection goes through `rasterProjection`, so it jitters exactly while TAA is collecting;
     * a `depthNudge` (an editor helper coplanar with the surface it describes) pulls it toward the
     * camera through `nudgedProjection`. Returns whether the model is animated.
     */
    public beginModel(node: ModelNode, shaderType: string, depthNudge: number = 0): boolean {
        const animated = node.model instanceof AnimatedModel;
        if (animated)
            (node.model as AnimatedModel).initializeVAO(this._shaderManager.getShader(shaderType).attributes);
        this._shaderManager.bind(shaderType);
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', depthNudge
            ? this._projection.nudgedProjection(this._view.camera.projectionMatrix, depthNudge)
            : this._projection.rasterProjection(this._view.camera.projectionMatrix));
        this._shaderManager.setUniform('u_model', node.worldTransform);
        this._materials.setDissolve(node.effectiveFade);
        this._materials.setCameraHole(node.cameraDither);
        if (animated) this.uploadBoneMatrices(shaderType, node);
        return animated;
    }

    /**
     * Draw `node`'s index buffer, one range per submesh, sharing everything `beginModel` set: a merged
     * model has one vertex buffer, one world transform and one bone upload, and differs only in which
     * material each range uses (submeshes share one material type, so the program stays right). Each
     * range's material goes through ONE binder — terrain, custom or standard — with the pipeline state
     * `state` describes, or the legacy immediate path when the draw is not recorded.
     */
    public drawMaterials(pass: RenderPassEncoder | undefined, node: ModelNode, shaderType: string,
                         reflection: PipelineReflection | undefined, animated: boolean,
                         state: MaterialDrawState): void {
        this._drawPass = pass;
        this._drawNode = node;
        this._drawShader = shaderType;
        this._drawReflection = reflection;
        this._drawAnimated = animated;
        this._drawState = state;
        this.drawSubmeshes(node, this._bindMaterial, pass);
        this._drawPass = undefined;
        this._drawNode = null;
        this._drawState = null;
    }

    /** Bind one submesh range's material for `drawMaterials`, whose inputs are in the `_draw*` fields. */
    private _bindModelMaterial(mat: Material): boolean {
        const pass = this._drawPass, node = this._drawNode!, shaderType = this._drawShader;
        const reflection = this._drawReflection, animated = this._drawAnimated, state = this._drawState!;
        const topology = mat.config.wireframe ? 'line-list' : 'triangle-list';
        // Terrain and custom materials bind only the textures they have; a bind group must fill every
        // binding the shader declares, so each has a group builder of its own.
        if (mat.type === 'terrain') {
            if (state.terrainSelfShadow) {
                // u_viewPos again, and deliberately: terrain reads it from its OWN uniform block, not the
                // transform block `beginModel` wrote. Two blocks, two writes.
                this._shaderManager.setUniform('u_viewPos', this._view.camera.position); // parallax V + specular V
                this._shaderManager.setUniform('u_sunDirection', this._view.sunDirection); // self-shadow
            }
            // The roughness filter, in both passes: a probe capture must shade terrain with the same NDF
            // width as the frame it is a probe for.
            this._shaderManager.setUniform('u_specularAA', this.specularAaEnabled);
            for (const [name, value] of mat.properties) this._shaderManager.setUniform(name, value);
            if (!state.viaRHI) { this._materials.applyTerrain(mat); return false; }
            const pipeline = this._pipelines.memoized(state.memo, mat, shaderType, reflection!, {
                cullMode: ModelDraw.cullFor(mat.config.side),
                depthStencil: state.depthStencil,
                blend: state.blend,
                targets: state.targets,
                topology,
                vertex: 'model',
                // The buffer was written for the `terrain` program, which is registered as an alias
                // of this one precisely so ModelNode.initializeModel could reflect its attributes.
                builtFor: 'terrain',
            });
            pass!.setPipeline(pipeline);
            pass!.setBindGroup(0, this._bindGroups.terrainGroup(pipeline, mat));
            this._bindFrameLighting(pass!, pipeline, state);
            return true;
        }
        if (mat instanceof CustomMaterial) {
            if (!state.viaRHI) { this._materials.applyCustom(mat); return false; }
            this._materials.applyCustom(mat, true);   // u_time, u_viewPos + user VALUE uniforms
            // See `PostEffects.screenMaterialPass` for what the WGSL is and why the vertex stage is a
            // separate module (absent on WebGL2 and for a material that could not translate). The
            // reflection is kept per material, so the same object comes back and the memo hits.
            const pipeline = this._pipelines.memoized(state.memo, mat, shaderType,
                                                      customPipelineReflection(mat, state.customMode), {
                cullMode: ModelDraw.cullFor(mat.config.side),
                depthStencil: state.depthStencil,
                blend: state.blend,
                targets: state.targets,
                topology,
                vertex: animated ? 'model+skin' : 'model',
                // `material.type` even when the mesh is SKINNED: `initializeModel` packs every mesh
                // to its material program's attributes, so a Basic skinned model is 20 bytes.
                builtFor: node.model.material.type,
            });
            pass!.setPipeline(pipeline);
            pass!.setBindGroup(0, this._bindGroups.customGroup(pipeline, mat, state.envCube));
            this._bindFrameLighting(pass!, pipeline, state);
            return true;
        }
        if (!state.viaRHI || !reflection) { this._materials.apply(mat); return false; }
        const pipeline = this._pipelines.memoized(state.memo, mat, shaderType, reflection, {
            cullMode: ModelDraw.cullFor(mat.config.side),
            // Depth writes follow the CALLER's state, not the material's, and come in rather than from
            // GLState — the descriptor must be a pure function of its arguments or the cache key is wrong.
            depthStencil: state.depthStencil,
            blend: state.blend,
            targets: state.targets,
            topology,
            vertex: animated ? 'model+skin' : 'model',
            builtFor: node.model.material.type,   // skinned too — see the custom branch
        });
        pass!.setPipeline(pipeline);
        this._materials.applyProperties(mat);
        pass!.setBindGroup(0, this._bindGroups.materialGroup(pipeline, mat, state.envCube));
        this._bindFrameLighting(pass!, pipeline, state);
        return true;
    }

    /**
     * Group 3 when the call site wants it and the program declares it. The unlit Basic family samples no
     * shadows at all, so asking for a group it never declared is an error rather than an empty bind — the
     * same rule WebGPU enforces through `layout: 'auto'`.
     */
    private _bindFrameLighting(pass: RenderPassEncoder, pipeline: RenderPipeline, state: MaterialDrawState): void {
        if (state.frameLighting && this._bindGroups.declaresFrameLighting(pipeline))
            pass.setBindGroup(3, this._bindGroups.frameLightingGroup(pipeline));
    }

    public objectId(obj: object): number {
        let id = this._objIds.get(obj);
        if (id === undefined) { id = this._objIdCounter++; this._objIds.set(obj, id); }
        return id;
    }

    /**
     * Upload the skinning palette. By NAME, never a cached location: `getUniformLocation` returns null
     * for a std140 block member, which is indistinguishable from "this shader has no bones".
     */
    public uploadBoneMatrices(shaderType: string, node: ModelNode): void {
        const animatedModel = node.model as AnimatedModel;
        if (animatedModel.hasSkin && node.animator) {
            const boneMatrices = node.animator.getFinalBoneMatrices();
            const scratch = this.boneMatrixScratch;
            const n = Math.min(100, boneMatrices.length);
            for (let i = 0; i < n; i++) scratch.set(boneMatrices[i], i * 16);
            this._shaderManager.setUniform('u_boneMatrices', scratch.subarray(0, 100 * 16));
        } else {
            this._shaderManager.setUniform('u_boneMatrices', this.boneIdentityScratch);
        }
    }
}

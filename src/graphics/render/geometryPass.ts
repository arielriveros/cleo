import { vec3 } from 'gl-matrix';
import { AnimatedModel } from '../../animation/animatedModel';
import { isEditorOnlyNode } from '../../core/scene/editorNodes';
import { ModelNode } from '../../core/scene/nodes/modelNode';
import { Scene } from '../../core/scene/scene';
import { CustomMaterial } from '../material';
import { usesParallax, opaqueEligible } from '../programVariants';
import { frameStats } from '../renderStats';
import type { RenderPassEncoder } from '../rhi/device';
import { device } from '../rhi/deviceHandle';
import type { Buffer as RhiBuffer } from '../rhi/resources';
import { BufferUsage } from '../rhi/types';
import { DrawSortKeys } from '../shaderOptimizer';
import { customShaderModules, customShaderResources } from '../systems/customShaders';
import { FoliagePasses } from './foliage';
import { ModelDraw } from './modelDraw';
import { GEOMETRY_PROGRAMS } from './programs';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import { DEPTH_WRITE, PipelineMemo } from './pipelineCache';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { MaterialBinder } from './materialBinder';
import type { ViewProjection } from './viewProjection';
import type { Visibility } from './visibility';
import type { LightingPasses } from './lighting';
import { ShaderManager } from '../systems/shaderManager';

/**
 * The deferred geometry pass: which nodes the G-buffer holds, the opaque draw sort (program, then
 * material, then front to back), single and instanced draws into the G-buffer, then the foliage
 * pass and the GPU occlusion queries over the finished depth. Split out of Renderer.
 */
export class GeometryPass {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _materials: MaterialBinder,
                private readonly _projection: ViewProjection,
                private readonly _foliage: FoliagePasses,
                private readonly _visibility: Visibility,
                private readonly _lighting: LightingPasses,
                private readonly _modelDraw: ModelDraw) {}

    /** Interned program/material ids for the opaque draw sort. */
    private readonly _drawSortKeys = new DrawSortKeys();

    // One instance buffer PER GROUP, keyed by the mesh+material key. A single shared buffer would have
    // every group in the pass read the LAST matrices written, and a growth reallocation would destroy
    // a buffer earlier draws reference — on a recorded backend, nothing has executed until submit.
    private readonly _instanceBuffers: Map<string, RhiBuffer> = new Map();
    private _instanceScratch: Float32Array = new Float32Array(16 * 64);

    /** The last pipeline per material of the G-buffer draw and of the instanced draw. See PipelineMemo. */
    private readonly _pipelineMemo = new PipelineMemo();
    private readonly _instancedMemo = new PipelineMemo();

    /**
     * Whether this node's geometry is what the deferred G-buffer holds: the material-and-visibility
     * half of {@link geometryPass}'s accept test.
     *
     * The frustum cull is deliberately NOT part of it — `_visibility.culled` counts a stat and every node must
     * reach it at most once per frame — and neither is the lazy `initializeModel`.
     *
     * Shared with the object-velocity pass so the two agree exactly. A node they disagreed about would
     * either lose its motion vector or write one over a surface it does not own.
     */
    public inGBuffer(node: ModelNode): boolean {
        if (!node.visible) return false;
        // Editor chrome belongs to the overlay layer, which is composited after the post chain. Keeping
        // it out of the G-buffer is also what keeps it out of the DEPTH snapshot, and so out of god
        // rays, sky fog, depth of field and SSAO — a collider box used to punch a hole through all four.
        if (isEditorOnlyNode(node)) return false;
        if (node.model.material.config.transparent) return false;
        // Forward-rendered types are drawn in the overlay, not the G-buffer: Blinn-Phong and forward
        // custom materials (deferred custom, 'customGeom:', DOES rasterize there). Screen custom
        // materials are camera post passes and never rasterize as mesh geometry at all.
        const dtype = node.model.material.type;
        return !(dtype === 'blinn_phong' || dtype === 'blinn_phongSkinned'
                 || dtype === 'cel' || dtype === 'celSkinned'
                 || dtype.startsWith('custom:') || dtype.startsWith('customScreen:'));
    }

    /** Per-frame scratch for the opaque sort keys; reused so the sort allocates nothing. */
    private readonly _drawSortScratch = new Map<ModelNode, number>();

    public geometryPass(scene: Scene): void {
        // Refreshed here, at the one point in this pass that still has the scene. See `_view.sunDirection`.
        this._view.sunDirection = [0, 0, 0];
        for (const node of scene.lights) {
            if (node.type !== 'directional') continue;
            this._view.sunDirection = this._lighting.dirOf(node) as unknown as number[];
            break;
        }

        // One pass for every node: the target and its clear belong to the pass, while the per-draw
        // state (which program, which cull mode, which textures) belongs to the pipelines and bind
        // groups set inside it.
        const pass = this._passes.beginFullscreenPass(this._targets.gBuffer.renderTarget, 'geometry', true);

        // No unbind needed here: the geometry pass's bind group clears the units the previous frame's
        // lighting pass left the G-buffer textures on, which would otherwise be a feedback hazard.

        // Collect visible, opaque, non-gizmo models.
        const singles: ModelNode[] = [];
        const instanceGroups = new Map<string, ModelNode[]>();

        for (const node of scene.models) {
            // Default (Blinn-Phong) materials are forward-rendered in the overlay so their full feature
            // set (specular/ambient/reflectivity + maps) works; they never enter the deferred G-buffer.
            if (!this.inGBuffer(node)) continue;
            if (this._visibility.culled(node)) continue;
            if (!node.initialized) node.initializeModel();

            const mat = node.model.material;
            const animated = node.model instanceof AnimatedModel;
            // Only non-animated pbr/blinn_phong materials (14-float layout) can be instanced.
            // Multi-material models never instance: the key is one mesh + one material, and an
            // instanced draw covers the whole index buffer rather than a range.
            if (!animated && !node.model.hasSubmeshes && (mat.type === 'pbr' || mat.type === 'blinn_phong')) {
                const key = `${this._modelDraw.objectId(node.model.mesh)}|${this._modelDraw.objectId(mat)}`;
                let group = instanceGroups.get(key);
                if (!group) { group = []; instanceGroups.set(key, group); }
                group.push(node);
            } else {
                singles.push(node);
            }
        }

        // State first, then front to back (shaderOptimizer/drawSort.ts): program, then material — so a
        // run of one material re-sends nothing — then nearest first, so the `opaque` (no-discard) programs
        // reject hidden fragments at the early depth test. One number per node, computed once.
        const sortKey = this._drawSortScratch;
        sortKey.clear();
        const eye = this._view.camera.position, far = this._view.camera.far;
        for (const node of singles) {
            const s = node.getBoundingSphere();
            const depth = Math.max(0, vec3.distance(eye, s.center) - s.radius);
            sortKey.set(node, this._drawSortKeys.key(this._geometryShaderFor(node), node.model.material, depth, far));
        }
        singles.sort((a, b) => sortKey.get(a)! - sortKey.get(b)!);
        for (const node of singles) this._drawGeometryNode(pass, node);

        // Instanced groups (>=2 identical mesh+material), else fall back to a single draw.
        for (const [key, group] of instanceGroups) {
            if (group.length >= 2) this._drawInstancedGroup(pass, group, key);
            else this._drawGeometryNode(pass, group[0]);
        }
        this._passes.endFullscreenPass(pass);

        // Instanced foliage owned by landscapes (grass billboards + scattered mesh props).
        if (this._passes.beginPass('foliage')) {
            // Its own pass over the same G-buffer, opened after the geometry pass closed: foliage is
            // deferred-lit like everything else, it just arrives by a different route (per-cell
            // instance buffers rather than scene nodes).
            const foliage = this._passes.beginFullscreenPass(this._targets.gBuffer.renderTarget, 'foliage', false,
                                                      undefined, false);
            this._foliage.foliagePass(scene, foliage);
            this._passes.endFullscreenPass(foliage);
        }
        // The G-buffer depth is complete: ask the GPU which candidate nodes it hides.
        this._visibility.gpuOcclusionPass();
        this._passes.endScope();
    }

    private _geometryShaderFor(node: ModelNode): string {
        const type = node.model.material.type;
        // A deferred custom material is drawn with its own runtime-compiled G-buffer program.
        if (type.startsWith('customGeom:')) return type;
        const animated = node.model instanceof AnimatedModel;
        switch (type) {
            case 'blinn_phong': return animated ? 'blinn_phongGeometrySkinned' : 'blinn_phongGeometry';
            case 'basic': return animated ? 'basicGeometrySkinned' : 'basicGeometry';
            case 'terrain': return 'terrainGeometry';
            default: {
                // The parallax variant if ANY submesh marches: it keeps the runtime test, so it is
                // right for the ones that do not too. See programVariants.ts.
                const base = animated ? 'pbrGeometrySkinned' : 'pbrGeometry';
                if (usesParallax(node.model.materials)) return base + 'Pom';
                // No cutout on any submesh and no despawn dissolve under way: the no-discard program,
                // which keeps early-Z (chunks/pbrGBuffer.wgsl, CLEO_OPAQUE). A dissolving node falls
                // back to the plain one for the length of its fade.
                // Likewise a node the camera's see-through hole may cut into: it needs the discard.
                return opaqueEligible(node.model.materials) && node.effectiveFade >= 1 && !this._materials.cameraHoleOn(node.cameraDither)
                    ? base + 'Opaque' : base;
            }
        }
    }

    private _drawGeometryNode(pass: RenderPassEncoder, node: ModelNode): void {
        const shaderType = this._geometryShaderFor(node);
        const animated = node.model instanceof AnimatedModel;
        if (animated)
            (node.model as AnimatedModel).initializeVAO(this._shaderManager.getShader(shaderType).attributes);

        this._shaderManager.bind(shaderType);
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
        this._shaderManager.setUniform('u_model', node.worldTransform);
        this._materials.setDissolve(node.effectiveFade);
        this._materials.setCameraHole(node.cameraDither);

        if (animated) this._modelDraw.uploadBoneMatrices(shaderType, node);

        // One draw per submesh, sharing everything above: a merged model has one vertex buffer, one
        // world transform and one bone upload, and differs only in which material each index range uses.
        // Submeshes are constrained to a single material type, so the shader bound above stays correct.
        const reflection = GEOMETRY_PROGRAMS[shaderType];
        this._modelDraw.drawSubmeshes(node, (mat) => {
            // Custom materials keep the legacy path: their GLSL is assembled at runtime, so there is no
            // reflection and no bind-group layout. Terrain has both, but binds its samplers by hand.
            if (mat.type === 'terrain') {
                // u_viewPos again, and deliberately: terrain reads it from its OWN uniform block
                // (TerrainUniforms), not from the transform block set above. Two blocks, two writes.
                this._shaderManager.setUniform('u_viewPos', this._view.camera.position); // parallax V + specular V
                this._shaderManager.setUniform('u_sunDirection', this._view.sunDirection);      // self-shadow
                this._shaderManager.setUniform('u_specularAA', this._modelDraw.specularAaEnabled);   // roughness filter
                for (const [name, value] of mat.properties) this._shaderManager.setUniform(name, value);
                const terrainPipeline = this._pipelines.memoized(this._pipelineMemo, mat, shaderType, reflection, {
                    cullMode: ModelDraw.cullFor(mat.config.side),
                    depthStencil: DEPTH_WRITE,
                    targets: 3,
                    topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                    vertex: 'model',
                    // The buffer was written for the `terrain` program, which is registered as an alias
                    // of this one precisely so ModelNode.initializeModel could reflect its attributes.
                    builtFor: 'terrain',
                });
                pass.setPipeline(terrainPipeline);
                pass.setBindGroup(0, this._bindGroups.terrainGroup(terrainPipeline, mat));
                return true;
            }
            if (mat instanceof CustomMaterial) {
                this._materials.applyCustom(mat, true);   // u_time, u_viewPos + user VALUE uniforms
                // See `_post.screenMaterialPass` for what the WGSL is and why the vertex stage is a
                // separate module. Absent on WebGL2 and for a material that could not translate.
                const customWgsl = customShaderModules(mat);
                const customPipeline = this._pipelines.get(shaderType, {
                    resources: customShaderResources('deferred', mat.uniforms),
                    ...(customWgsl ? { wgsl: customWgsl.fragment, entryPoints: { fragment: 'main' },
                                       vertexWgsl: { wgsl: customWgsl.vertex,
                                                     entryPoint: customWgsl.vertexEntry } } : {}),
                }, {
                    cullMode: ModelDraw.cullFor(mat.config.side),
                    depthStencil: DEPTH_WRITE,
                    targets: 3,
                    topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                    vertex: animated ? 'model+skin' : 'model',
                    // `material.type` even when the mesh is SKINNED: `initializeModel` packs every mesh
                    // to its material program's attributes, so a Basic skinned model is 20 bytes.
                    builtFor: node.model.material.type,
                });
                pass.setPipeline(customPipeline);
                pass.setBindGroup(0, this._bindGroups.customGroup(customPipeline, mat));
                return true;
            }
            if (!reflection) { this._materials.apply(mat); return false; }

            const pipeline = this._pipelines.memoized(this._pipelineMemo, mat, shaderType, reflection, {
                cullMode: ModelDraw.cullFor(mat.config.side),
                depthStencil: DEPTH_WRITE,
                targets: 3,   // the G-buffer
                topology: mat.config.wireframe ? 'line-list' : 'triangle-list',
                vertex: animated ? 'model+skin' : 'model',
                builtFor: node.model.material.type,   // skinned too — see the note above
            });
            pass.setPipeline(pipeline);
            this._materials.applyProperties(mat);
            pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, mat));
            return true;
        }, pass);
        frameStats.objects++;
    }

    private _drawInstancedGroup(pass: RenderPassEncoder, group: ModelNode[], key: string): void {
        const first = group[0];
        const type = first.model.material.type;
        // Placed instanced copies never dissolve as a group or crossfade (u_lodCamera is turned off below),
        // so an opaque material takes the no-discard program outright.
        const shaderType = type === 'blinn_phong' ? 'blinn_phongGeometryInstanced'
            : usesParallax(first.model.materials) ? 'pbrGeometryInstancedPom'
            : opaqueEligible(first.model.materials) ? 'pbrGeometryInstancedOpaque' : 'pbrGeometryInstanced';

        // Pack per-instance model matrices into the shared instance buffer.
        const count = group.length;
        const needed = count * 16;
        if (this._instanceScratch.length < needed)
            this._instanceScratch = new Float32Array(needed);
        for (let i = 0; i < count; i++)
            this._instanceScratch.set(group[i].worldTransform, i * 16);

        const material = first.model.material;
        const reflection = GEOMETRY_PROGRAMS[shaderType];
        if (reflection) {
            const pipeline = this._pipelines.memoized(this._instancedMemo, material, shaderType, reflection, {
                cullMode: ModelDraw.cullFor(material.config.side),
                depthStencil: DEPTH_WRITE,
                targets: 3,
                topology: material.config.wireframe ? 'line-list' : 'triangle-list',
                vertex: 'model+instance',
                builtFor: material.type,
            });
            pass.setPipeline(pipeline);
            this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
            // Placed instanced models never crossfade, and the foliage pass may have left it on.
            this._shaderManager.setUniform('u_lodCamera', FoliagePasses.LOD_OFF);
            this._materials.setCameraHole(false);
            this._materials.applyProperties(material);
            pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, material));
        } else {
            this._shaderManager.bind(shaderType);
            this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
            this._shaderManager.setUniform('u_lodCamera', FoliagePasses.LOD_OFF);
            this._materials.setCameraHole(false);
            this._materials.apply(material);
            this._materials.applyCull(material.config.side);
        }

        const mesh = first.model.mesh;
        let instances = this._instanceBuffers.get(key)
            ?? device.createBuffer({ label: `renderer.instanceMatrices:${key}`, size: 0,
                                     usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
        instances = device.reallocateBuffer(instances, this._instanceScratch.subarray(0, needed));
        this._instanceBuffers.set(key, instances);
        const topology = first.model.material.config.wireframe ? 'line-list' : 'triangle-list';

        // Through the RHI when the mesh's whole layout fits on the pipeline. No divisor teardown is
        // needed: a VAO keyed by pipeline AND buffers gives the instanced draw its own.
        // `active*` rather than the base index buffer, and no `hasLods` bail — see _foliage.recordFoliageDraw.
        if (reflection && !mesh.isAnimated && mesh.activeIndexBuffer) {
            pass.setVertexBuffer(0, mesh.vertexBuffer);
            pass.setVertexBuffer(1, instances);
            pass.setIndexBuffer(mesh.activeIndexBuffer, mesh.activeIndexFormat);
            pass.drawIndexed(mesh.activeIndexCount, count);
        } else {
            mesh.setupInstanceMatrixBuffer(instances, 5);
            mesh.drawInstanced(count, topology);
            mesh.teardownInstanceMatrixBuffer(5);
        }
        frameStats.objects += count; // each batched node is a distinct scene object
    }
}

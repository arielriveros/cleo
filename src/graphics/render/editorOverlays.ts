import { mat4 } from 'gl-matrix';
import { Geometry } from '../../core/geometry';
import { isEditorOnlyNode } from '../../core/scene/editorNodes';
import { ModelNode } from '../../core/scene/nodes/modelNode';
import { SpriteNode } from '../../core/scene/nodes/spriteNode';
import { Scene } from '../../core/scene/scene';
import { gl } from '../glContext';
import { Mesh } from '../mesh';
import type { RenderPassEncoder } from '../rhi/device';
import { device } from '../rhi/deviceHandle';
import type { Buffer as RhiBuffer, RenderTarget } from '../rhi/resources';
import { OVERLAY_BLEND, OVERLAY_COMPOSITE_BLEND, BufferUsage } from '../rhi/types';
import type { DepthStencilState } from '../rhi/types';
import { GLState } from '../systems/glState';
import { ModelDraw } from './modelDraw';
import { GridProgram, OverlayCompositeProgram, OutlineProgram, FORWARD_PROGRAMS, BasicInstancedProgram } from './programs';
import type { SkeletonOverlay } from './settingsTypes';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { MaterialBinder } from './materialBinder';
import type { ViewProjection } from './viewProjection';
import type { PostEffects } from './postEffects';
import type { DecalPasses } from './decals';
import type { Sprite2DPasses } from './sprites2d';
import { ShaderManager } from '../systems/shaderManager';
import type { FullscreenPasses } from './fullscreenPasses';

/** What EditorOverlays reads from the renderer that owns it, while those members still live there. */
export interface EditorOverlaysHost {
    restoreDefaultBlend(): void;
    readonly thumbnailMode: boolean;
}

/**
 * The editor's chrome, drawn into its own overlay layer after the scene and composited after the
 * post chain, so no post pass ever sees it: the infinite grid, helper wireframes, gizmos, the
 * skeleton overlay, and the selection silhouette mask the outline pass reads. Split out of Renderer.
 */
export class EditorOverlays {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: EditorOverlaysHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _materials: MaterialBinder,
                private readonly _projection: ViewProjection,
                private readonly _post: PostEffects,
                private readonly _decals: DecalPasses,
                private readonly _sprites: Sprite2DPasses,
                private readonly _fullscreen: FullscreenPasses) {}

    // Set per frame by the first pass that opens the overlay layer (`_targets.overlay`): nothing drawn
    // means no clear and no composite, and a published build, which has no editor nodes, pays nothing.
    public overlayDrawn: boolean = false;

    // Editor infinite grid overlay (off in published builds; toggled by the editor)
    public gridEnabled: boolean = false;
    public gridPlane: 0 | 1 = 0; // 0 = XZ ground (3D), 1 = XY front (2D)

    // Editor skeleton overlay: drawn instanced + always-on-top in the gizmo pass (set by the editor).
    public skeletonOverlay: SkeletonOverlay | null = null;
    private _overlaySphereMesh: Mesh | null = null;
    private _overlayBoneMesh: Mesh | null = null;
    private _overlayRingMesh: Mesh | null = null;

    // One instance buffer PER draw set, never one shared by all four — `_drawSkeletonOverlay` records
    // bones, joints, markers and the highlight into the same pass. Same rule as `GeometryPass._instanceBuffers`.
    private _overlayInstanceBuffers: (RhiBuffer | null)[] = [];

    /**
     * Editor-only infinite reference grid: one fullscreen quad whose fragment shader intersects a
     * per-pixel world ray with the origin plane. Depth-tested via gl_FragDepth, never depth-written.
     */
    private _renderGrid(): void {
        if (!this.gridEnabled) return;

        // `depthCompare` must be 'less-equal': the engine sets `gl.depthFunc(LEQUAL)` once at init and
        // never changes it, so a pipeline claiming 'less' drops every coplanar fragment.
        //
        // This drew into the scene buffer with a split blend whose alpha half ERASED the bloom mask
        // under each line — the one trick that kept the grid from glowing. It is gone with the buffer:
        // the overlay's alpha is coverage, so erasing it would erase the grid. Nothing here can bloom
        // any more regardless, because nothing here is in the image bloom reads.
        const pass = this._beginOverlayPass('grid');
        const pipeline = this._pipelines.fullscreen('grid', GridProgram, OVERLAY_BLEND,
            { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' });
        pass.setPipeline(pipeline);
        // The STABLE inverse, not `_view.invViewProj`: this pass builds a world ray from the uv rather than
        // unprojecting the depth buffer, and it draws after the TAA resolve, so a jittered ray would
        // shimmer the grid rather than antialias it. `u_viewProj` is unjittered for the same reason.
        this._shaderManager.setUniform('u_invViewProj', this._view.invViewProjStable);
        this._shaderManager.setUniform('u_viewProj', this._view.viewProj);
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);
        this._shaderManager.setUniform('u_plane', this.gridPlane);

        // Fade radius scales with zoom so the grid always reads as infinite. In perspective
        // that tracks the camera's distance to the plane; in ortho it tracks the frustum extent.
        let fadeFar: number;
        if (this._view.camera.type === 'orthographic') {
            const width = Math.abs(this._view.camera.right - this._view.camera.left);
            const height = Math.abs(this._view.camera.top - this._view.camera.bottom);
            fadeFar = Math.max(40, Math.max(width, height) * 2.0);
        } else {
            const h = Math.abs(this.gridPlane === 0
                ? this._view.camera.position[1]
                : this._view.camera.position[2]);
            fadeFar = Math.max(40, h * 25.0);
        }
        this._shaderManager.setUniform('u_fadeFar', fadeFar);

        this._passes.drawFullscreenAndEnd(pass);

        // Still set by hand: the overlay passes that follow are on the legacy path and inherit blend
        // and depth-mask state rather than declaring their own. The OVERLAY pair, not the default one
        // — the buffer these are all writing needs its coverage alpha accumulated.
        this._setOverlayBlend();
        GLState.depthMask(true);
    }

    private _collectAllChildren(node: any, allNodes: any[]): void {
        allNodes.push(node);
        for (const child of node.children) {
            this._collectAllChildren(child, allNodes);
        }
    }

    /**
     * Put the editor overlay layer onto the resolved image.
     *
     * A SECOND pass on the surface target, with `clear: false` — the one genuinely new capability
     * here, and legal on both backends. WebGL2's surface target is a single reusable handle onto
     * framebuffer 0. WebGPU's `getCurrentTexture()` hands back the same texture for the rest of the
     * frame, the renderer holds one encoder for the whole frame, and two sequential render passes on
     * one colour attachment is ordinary. The surface has no depth view, so this is depth-less — the
     * same shape `_post.presentPass` is.
     *
     * The shader encodes to sRGB and nothing else. No exposure, no tone curve, no LUT: see the note
     * at the graph node in `_buildPostGraph`.
     */
    public overlayCompositePass(): void {
        const pass = this._passes.beginFullscreenPass(this._passes.screenTarget(), 'overlay.composite', false);
        this._fullscreen.bind(pass, 'overlayComposite', OverlayCompositeProgram, [this._targets.overlay.colors[0]], OVERLAY_COMPOSITE_BLEND);
        this._passes.drawFullscreenAndEnd(pass);
    }

    /**
     * The overlay layer's colour with the SCENE's live depth attached — the same borrowing trick as
     * `TemporalPasses._velocityObjectsTarget`, and for the same reason: helper wireframes and icons must still be
     * occluded by the geometry in front of them, and that answer already exists.
     *
     * `_targets.scene.depth`, not `_temporal.depthSource()`: this draws in the same part of the frame the grid and
     * transparents do, testing against the live attachment rather than the snapshot taken for the
     * fullscreen passes. Never cached on the renderer — a resize deletes both textures and the device
     * evicts every target naming them.
     */
    private _overlayTarget(): RenderTarget {
        return device.createRenderTarget({
            label: 'overlay+depth',
            colorViews: [this._targets.overlay.colors[0].attachmentView],
            depthView: this._targets.scene.depth.attachmentView,
        });
    }

    /**
     * Open one of the overlay layer's sub-passes, clearing the colour on the first of the frame.
     *
     * Lazy so a frame that draws no chrome never touches the buffer at all, which is every frame of a
     * published build. Depth is emphatically NOT cleared: the attachment is the scene's, and nothing
     * here may write to it either — game sprites are still depth-tested against it further down
     * `_forward.renderForwardOverlay`, so an overlay draw that wrote depth would occlude them.
     */
    private _beginOverlayPass(label: string): RenderPassEncoder {
        const clear = !this.overlayDrawn;
        this.overlayDrawn = true;
        return this._passes.beginFullscreenPass(this._overlayTarget(), label, clear, [0, 0, 0, 0], false);
    }

    /**
     * Draw the selected nodes' silhouettes as solid white into the outline mask FBO, which
     * `_post.outlinePass` turns into a screen-space border. No depth test or write, so an occluded
     * selection is still outlined. Sets `_post.outlineActive`.
     */
    public renderSelectionMask(models: ModelNode[], sprites: SpriteNode[]): void {
        this._post.outlineActive = models.length > 0 || sprites.length > 0;

        // Opened and cleared even with nothing selected, or a silhouette from the previous selection
        // survives. `clearValue`, not the standing clear colour: the mask wants transparent black.
        const pass = this._passes.beginFullscreenPass(this._post.outlineMaskFBO.renderTarget, 'outlineMask',
                                               true, [0, 0, 0, 0], false);
        if (this._post.outlineActive) {
            // Always on top and never blended: the silhouette must be visible through geometry that
            // occludes it, which is the whole point of an outline. Said as compare 'always' with writes
            // off, because WebGPU has no separate "depth test disabled".
            const depthAlways: DepthStencilState =
                { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' };
            this._shaderManager.bind('outline');
            this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
            this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));
            this._shaderManager.setUniform('u_outlineColor', [1.0, 1.0, 1.0]); // white silhouette

            // One pipeline per SOURCE material, never one for the pass: the buffer was interleaved for
            // whichever program the mesh was built for (Basic 20 bytes per vertex, PBR 56). `builtFor`
            // is `material.type` for SKINNED meshes too, not the `animated ? null` used elsewhere here.
            const drawWith = (mesh: Mesh, builtFor: string | null, model: mat4) => {
                const pipeline = this._pipelines.get('outline', OutlineProgram, {
                    depthStencil: depthAlways, vertex: 'model', builtFor,
                });
                pass.setPipeline(pipeline);
                this._shaderManager.setUniform('u_model', model);
                this._passes.recordDraw(pass, mesh, 0, 0);
            };

            // Selected models and their children.
            const modelNodes: any[] = [];
            for (const node of models) this._collectAllChildren(node, modelNodes);
            for (const node of modelNodes) {
                // Editor chrome parented under the selection is not part of its silhouette. A rigid
                // body's collider wireframe is a CHILD of the node it follows, so without this the
                // outline traced the collider instead of the mesh.
                if (isEditorOnlyNode(node)) continue;
                if (!node.initialized || !node.model) continue;
                drawWith(node.model.mesh, node.model.material.type, node.worldTransform);
            }

            // Selected sprites and their children (preserving billboard constraints).
            const spriteNodes: any[] = [];
            for (const node of sprites) this._collectAllChildren(node, spriteNodes);
            for (const node of spriteNodes) {
                if (isEditorOnlyNode(node)) continue;
                if (!node.initialized || !node.sprite) continue;
                drawWith(node.sprite.mesh, node.sprite.material.type, this._sprites.spriteBillboardMatrix(node));
            }
        }
        this._passes.endFullscreenPass(pass);

        // Restore the scene framebuffer for any subsequent draws.
        this._targets.scene.bind();
    }

    /**
     * One overlay-layer mesh, through its own material program.
     *
     * Shared by the gizmo and helper sub-passes, which differ only in depth state — factoring it out
     * is what stops the "always on top" and "occluded by geometry" halves from drifting apart. Blend
     * is always `OVERLAY_BLEND`: the overlay buffer's alpha is coverage, and a draw that used the
     * scene's mask-preserving default would leave it at zero and composite invisibly.
     */
    private _drawOverlayNode(pass: RenderPassEncoder, node: ModelNode,
                             depthStencil: DepthStencilState): void {
        if (!node.visible) return;
        if (!node.initialized) node.initializeModel();

        const type = node.model.material.type;
        const reflection = FORWARD_PROGRAMS[type];
        this._shaderManager.bind(type);
        const material = node.model.material;
        const pipeline = reflection ? this._pipelines.get(type, reflection, {
            cullMode: ModelDraw.cullFor(material.config.side),
            depthStencil,
            blend: OVERLAY_BLEND,
            topology: material.config.wireframe ? 'line-list' : 'triangle-list',
            vertex: 'model',
            builtFor: type,
        }) : null;
        if (pipeline) pass.setPipeline(pipeline);

        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        // `depthNudge` is folded into the projection rather than set as its own uniform: a helper that
        // is coplanar with the surface it describes needs pulling toward the camera in NDC, and doing
        // it here costs one added constant instead of a shader variant. Zero for every other helper,
        // which then gets the raster projection untouched.
        this._shaderManager.setUniform('u_projection',
            this._projection.nudgedProjection(this._view.camera.projectionMatrix, material.config.depthNudge ?? 0));
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);

        // Set Transform related uniforms
        this._shaderManager.setUniform('u_model', node.worldTransform);
        this._materials.setDissolve(node.effectiveFade);

        // Set Material related uniforms
        this._materials.applyProperties(node.model.material);

        // Textures: a bind group when the program has build-time reflection, otherwise the hand-
        // rolled slot table this used to carry — which was a third copy of `_textureSlot`, drifting
        // independently of the other two.
        if (pipeline) {
            pass.setBindGroup(0, this._bindGroups.materialGroup(pipeline, material));
            // A LIT helper (the camera gizmo is Blinn-Phong) reads the frame's lights and shadow maps
            // from group 3 like any forward draw; an unlit one never declares it.
            if (this._bindGroups.declaresFrameLighting(pipeline)) pass.setBindGroup(3, this._bindGroups.frameLightingGroup(pipeline));
        }
        else this._materials.apply(material);

        // Draw the mesh
        if (!pipeline || !this._passes.recordDraw(pass, node.model.mesh, 0, 0)) node.model.mesh.draw();
    }

    /**
     * The editor overlay layer: the grid, helper wireframes, helper icons, gizmos and the skeleton
     * overlay, all drawn into `_targets.overlay` instead of the scene buffer.
     *
     * This is the whole feature. None of it may reach the post chain — chrome that blooms, throws
     * lens-flare ghosts, blurs into depth of field or moves the auto-exposure meter is chrome that
     * lies about the image the artist is grading. Separating the buffer is the only way to say that
     * once, for every effect, rather than teaching each effect to recognise a gizmo.
     *
     * Three sub-passes on one target. Functionally one would do — depth state rides on the pipeline,
     * not the pass — but a GPU timestamp attaches to a pass, so collapsing them would erase the
     * `grid` and `gizmos` rows from the profiler.
     *
     * Order inside the buffer is back-to-front: grid, then helpers and icons over it, then gizmos on
     * top of everything.
     */
    public renderEditorOverlay(scene: Scene, helperNodes: ModelNode[], gizmoNodes: ModelNode[]): void {
        // A capture wants the asset and nothing else. `_applyPostProcessing` also returns before the
        // composite node is ever built, so this is belt and braces — but it is the cheap half.
        if (this._host.thumbnailMode) return;

        // Editor infinite grid, composited over the scene/skybox and occluded by geometry.
        if (this._passes.beginPass('grid')) this._renderGrid();

        const icons: SpriteNode[] = [];
        for (const node of scene.sprites) if (node.visible && isEditorOnlyNode(node)) icons.push(node);

        const overlayDecals = this._decals.overlayDecals.length > 0;
        if ((helperNodes.length > 0 || icons.length > 0 || overlayDecals) && this._passes.beginPass('overlay')) {
            // Editor-only decals (the landscape brush) first, so helper wireframes draw over them.
            // Reconstructed with the STABLE inverse: this layer sits after the TAA resolve, and the
            // jittered one would make a projected cursor shimmer by a sub-pixel every frame.
            if (overlayDecals) {
                const decalPass = this._beginOverlayPass('overlay.decals');
                this._decals.drawColorDecals(decalPass, this._decals.overlayDecals, OVERLAY_BLEND, this._view.invViewProjStable, 1);
                this._passes.endFullscreenPass(decalPass);
            }
            // Occluded by real geometry, exactly as these drew when they went through the G-buffer.
            // No depth writes: the attachment is the scene's own.
            const depthTested: DepthStencilState =
                { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' };
            const pass = this._beginOverlayPass('overlay.helpers');
            GLState.blend(true);
            this._setOverlayBlend();
            GLState.depthMask(false);
            for (const node of helperNodes) this._drawOverlayNode(pass, node, depthTested);
            // Re-asserted: a helper on the legacy path goes through `_materials.apply`, which sets its
            // own blend, and an icon that inherited THAT would stop accumulating coverage alpha.
            this._setOverlayBlend();
            // Icons are billboards and always transparent; `_sprites.renderSprite` handles the constraint.
            // `false` for manageDepth — this pass owns the depth state for the whole batch.
            for (const node of icons) this._sprites.renderSprite(node, false, pass, OVERLAY_BLEND);
            this._passes.endFullscreenPass(pass);
            GLState.depthMask(true);
        }

        // Gizmos on top (also draws the editor skeleton overlay when set).
        if ((gizmoNodes.length > 0 || this.skeletonOverlay) && this._passes.beginPass('gizmos'))
            this._renderGizmos(gizmoNodes);

        // Hand the scene buffer back: the selection mask and the legacy WebGL2 paths below assume it.
        this._targets.scene.bind();
        this._host.restoreDefaultBlend();
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    /**
     * `OVERLAY_BLEND` as raw GL state, for the legacy draws in the overlay that still inherit blend
     * rather than declaring it on a pipeline. Separate factors, never `blendFunc`: the alpha half is
     * the entire point here, and `tests/cloudTemporal` forbids the collapsed call outright.
     */
    private _setOverlayBlend(): void {
        if (gl) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    private _renderGizmos(gizmoNodes: ModelNode[]): void {
        // Always on top: depth test off. Depth WRITES are off too, and that is a change — the pass
        // used to write into `_targets.scene.depth`, which it shares with the scene, so a gizmo silently
        // occluded every game sprite drawn after it. Now that the overlay borrows the same attachment
        // the bug would be structural rather than incidental, so it goes. WebGPU has no separate
        // 'test off', hence compare 'always'.
        const pass = this._beginOverlayPass('gizmos');
        const depthAlways: DepthStencilState =
            { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' };

        for (const node of gizmoNodes) this._drawOverlayNode(pass, node, depthAlways);

        // Editor skeleton overlay (instanced), also always-on-top.
        this._drawSkeletonOverlay(pass, depthAlways);

        this._passes.endFullscreenPass(pass);
        // Depth testing back on for whatever draws next, which is still on the legacy path.
        GLState.depthTest(true);
    }

    private _ensureOverlayMeshes(): void {
        if (this._overlaySphereMesh && this._overlayBoneMesh) return;
        // Position-only base geometry: init the VAO with the single-attribute shadowMap shader (spheres/
        // cubes may lack tangents, so a 5-attr layout would mismatch). Instance matrices are wired
        // separately via setupInstanceMatrixBuffer (mirrors _foliage.foliagePass).
        const attrs = this._shaderManager.getShader('shadowMap').attributes;
        const build = (g: Geometry): Mesh => {
            const m = new Mesh();
            m.create(g.getData(['position']), g.vertexCount, g.indices);
            m.initializeVAO(attrs);
            return m;
        };
        if (!this._overlaySphereMesh) this._overlaySphereMesh = build(Geometry.Sphere(8, 1));
        if (!this._overlayBoneMesh) this._overlayBoneMesh = build(Geometry.Cube(1, 1, 1));
        if (!this._overlayRingMesh) this._overlayRingMesh = build(EditorOverlays._ringGeometry(0.72, 1, 40));
    }

    /** A flat annulus in the XY plane, wound both ways so it shows from either side under back-face culling. */
    private static _ringGeometry(inner: number, outer: number, segments: number): Geometry {
        const positions: [number, number, number][] = [];
        const indices: number[] = [];
        for (let i = 0; i < segments; i++) {
            const a = (i / segments) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
            positions.push([c * inner, s * inner, 0], [c * outer, s * outer, 0]);
        }
        for (let i = 0; i < segments; i++) {
            const a = i * 2, b = a + 1, c = ((i + 1) % segments) * 2, d = c + 1;
            indices.push(a, b, d, a, d, c);   // front
            indices.push(a, d, b, a, c, d);   // back
        }
        return new Geometry(positions, positions.map(() => [0, 0, 1] as [number, number, number]),
            positions.map(() => [0, 0] as [number, number]), undefined, undefined, indices, false);
    }

    private _drawSkeletonOverlay(pass?: RenderPassEncoder, depthStencil?: DepthStencilState): void {
        const o = this.skeletonOverlay;
        if (!o) return;
        this._ensureOverlayMeshes();
        const sphere = this._overlaySphereMesh, bone = this._overlayBoneMesh;
        if (!sphere || !bone) return;

        this._shaderManager.bind('basicInstanced');
        // The overlay meshes carry position ONLY (see _ensureOverlayMeshes), so the buffer they were
        // built with is `shadowMap`'s single-attribute layout, not `basicInstanced`'s. Naming that as
        // `builtFor` is what keeps the stride at 12 rather than the unlit 20.
        const pipeline = pass ? this._pipelines.get('basicInstanced', BasicInstancedProgram, {
            cullMode: 'back',
            depthStencil,
            vertex: 'model+instance',
            builtFor: 'shadowMap',
        }) : null;
        if (pipeline) pass!.setPipeline(pipeline);
        this._shaderManager.setUniform('u_view', this._view.camera.viewMatrix);
        this._shaderManager.setUniform('u_projection', this._projection.rasterProjection(this._view.camera.projectionMatrix));

        // `set` indexes this call's own buffer — see _overlayInstanceBuffers.
        const drawSet = (set: number, mesh: Mesh, matrices: Float32Array, count: number,
                         color: [number, number, number]) => {
            if (count <= 0) return;
            // Written by hand, not from a material: the block no longer holds what MaterialSync remembers.
            this._materials.sync.invalidate(this._shaderManager.bound);
            this._shaderManager.setUniform('u_material.color', color);
            this._shaderManager.setUniform('u_material.hasTexture', false);
            this._shaderManager.setUniform('u_material.opacity', 1.0);
            // Uniforms are sticky: whatever the last basic draw left in these would apply here too. An
            // unset `intensity` multiplies the colour by 0 -- the joints drew BLACK whatever colour the
            // editor asked for.
            this._shaderManager.setUniform('u_material.intensity', 1.0);
            this._shaderManager.setUniform('u_material.hasMaskMap', false);
            this._shaderManager.setUniform('u_material.alphaCutoff', 0.0);
            // Reassigned through the array, not a local: on WebGPU a grown buffer is a NEW one, and a
            // local alias would leave the next frame writing into a destroyed handle.
            let buf = this._overlayInstanceBuffers[set]
                ?? device.createBuffer({ label: `renderer.overlayInstances${set}`, size: 0,
                                         usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
            buf = this._overlayInstanceBuffers[set] =
                device.reallocateBuffer(buf, matrices.subarray(0, count * 16));
            if (pipeline && mesh.activeIndexBuffer) {
                // The overlay never sets `hasTexture`, so nothing here is actually sampled — but every
                // sampler the shader declares still has to reference a complete texture or the group
                // is rejected whole. The count comes from the PIPELINE rather than a literal: this
                // used to pass one fallback, and adding the cutout mask to the basic chunks turned
                // that into "Number of entries (2) did not match the expected number (4)", which
                // invalidated the group, then the command buffer, and rendered WebGPU entirely black.
                const overlayTextures = pipeline.resources
                    .filter(r => r.group === 0 && r.kind === 'texture')
                    .map(() => this._bindGroups.fallbackTexture);
                pass!.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, overlayTextures));
                pass!.setVertexBuffer(0, mesh.vertexBuffer);
                pass!.setVertexBuffer(1, buf!);
                pass!.setIndexBuffer(mesh.activeIndexBuffer, mesh.activeIndexFormat);
                pass!.drawIndexed(mesh.activeIndexCount, count);
            } else {
                mesh.setupInstanceMatrixBuffer(buf!, 5);
                mesh.drawInstanced(count, 'triangle-list');
                mesh.teardownInstanceMatrixBuffer(5);
            }
        };

        // Bones first, joints over them, role markers above those, and the selection highlight last of all —
        // depth test is off in the gizmo pass, so the later draw simply wins where they overlap, and the one
        // thing you are pointing at should never be hidden by a label.
        drawSet(0, bone, o.boneMatrices, o.boneCount, o.boneColor);
        const joint = o.jointShape === 'ring' && this._overlayRingMesh ? this._overlayRingMesh : sphere;
        drawSet(1, joint, o.jointMatrices, o.jointCount, o.jointColor);
        if (o.markerMatrices && o.markerColor) drawSet(2, joint, o.markerMatrices, o.markerCount ?? 0, o.markerColor);
        if (o.highlightMatrix && o.highlightColor) drawSet(3, joint, o.highlightMatrix, 1, o.highlightColor);
    }
}

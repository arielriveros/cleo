import { AnimatedModel } from "../../../graphics/animatedModel";
import { AnimationMapping, AnimationStateMachine, Animator } from "../../../graphics/animator";
import { Material } from "../../../graphics/material";
import { Model } from "../../../graphics/model";
import { ShaderManager } from "../../../graphics/systems/shaderManager";
import { geometryAttributesFor } from '../../../graphics/rhi/vertexLayouts';
import type { RagdollOptions } from "../../../physics/ragdoll";
import type { BVH } from "../../bvh";
import { Logger } from "../../logger";
import { sceneStats, sceneStatsDetail } from "../sceneStats";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/**
 * How far a skinned model's bind-pose bounds are inflated, as a CULLING margin: the mesh deforms on the
 * GPU, so its bind-pose extent understates where it can reach. It is an allowance, not a measurement —
 * anything asking how big a model actually is must divide it back out.
 */
export const SKINNED_BOUNDS_MARGIN = 1.75;

/**
 * The renderable node: a `Model` or `AnimatedModel` plus its animator, physics bounds and BVH.
 */

export class ModelNode extends Node {
    private _model: Model | AnimatedModel;
    private _initialized: boolean;
    // Material type the mesh VAO/vertex data were last built for. basic and default/pbr use different
    // vertex attribute layouts, so a type change forces a rebuild — see the `initialized` getter.
    private _initializedType: string | null = null;
    // The geometry the current upload came from. `_initializedType` alone cannot see a geometry swap —
    // the material type has not changed — and a terrain chunk changing density changes its vertex COUNT,
    // which `Mesh.updateVertexData` cannot express. Companion key, checked in the same place.
    private _initializedGeometry: number = -1;
    private _animator: Animator | null;
    private _movementDirection: vec3;
    /** Optional per-node ragdoll simulation config (skinned meshes). Persisted with the scene; read by Ragdoll. */
    private _ragdollConfig: RagdollOptions | null = null;

    constructor(name: string, model: Model | AnimatedModel, id: string = uuidv4()) {
        super(name, 'model', id);
        this._model = model;
        this._initialized = false;
        this._movementDirection = vec3.create();
        
        if (model instanceof AnimatedModel && model.hasSkin) {
            this._animator = new Animator(model, this);
        } else {
            this._animator = null;
        }
    }

    public initializeModel(): void {
        const shader = ShaderManager.Instance.getShader(this._model.material.type);
        this._model.mesh.initializeVAO(shader.attributes);
        // Extracted rather than inline so the packing rule has one home: the stride is not constant —
        // a position-and-uv program packs to 20 bytes and a full PBR one to 56.
        const attributes = geometryAttributesFor(shader.attributes);

        const geometry = this._model.geometry;
        this._model.mesh.create(geometry.getData(attributes), geometry.vertexCount, geometry.indices);
        this._initialized = true;
        this._initializedType = this._model.material.type;
        this._initializedGeometry = this._model.geometryVersion;
    }

    protected _serializePayload(): any {
            const model = this._model.serialize()
            let animationMappings: AnimationMapping[] | null = null;
            let stateMachine: AnimationStateMachine | null = null;
            if (this._animator) {
                animationMappings = this._animator.getAnimationMappings();
                stateMachine = this._animator.getStateMachine();
            }
        return {
                    model: model,
                    animationMappings: animationMappings,
                    stateMachine: stateMachine,
                    ragdoll: this._ragdollConfig,
        };
    }

    public static parse(parent: Node, json: any) {
        const isAnimated = json.model.skin || json.model.animations || json.model.jointIndices;
        const model = isAnimated ? AnimatedModel.parse(json.model) : Model.parse(json.model);
        const node = new ModelNode(json.name, model, json.id);
        
        if (json.animationMappings && node.animator) {
            node.animator.setAnimationMappings(json.animationMappings);
        }

        // A serialized state machine takes precedence over plain animation mappings.
        if (json.stateMachine && node.animator) {
            node.animator.setStateMachine(json.stateMachine);
        }

        if (json.ragdoll) node.ragdollConfig = json.ragdoll;

        Node.finishParse(node, parent, json);
    }

    public get model(): Model | AnimatedModel { return this._model; }
    // Reports uninitialized when the material type changed since the mesh was built, so the renderer
    // rebuilds the VAO for the new material's attribute layout.
    public get initialized(): boolean {
        return this._initialized && this._initializedType === this._model.material.type
            && this._initializedGeometry === this._model.geometryVersion;
    }
    public get animator(): Animator | null { return this._animator; }
    public get ragdollConfig(): RagdollOptions | null { return this._ragdollConfig; }
    public set ragdollConfig(config: RagdollOptions | null) { this._ragdollConfig = config; }
    public get movementDirection(): vec3 { return this._movementDirection; }
    public set movementDirection(direction: vec3) { 
        vec3.copy(this._movementDirection, direction);
    }
    public get visible(): boolean { return super.visible; }
    public set visible(value: boolean) {
      super.visible = value;
      // Every submesh, not just slot 0, or a merged model's other index ranges keep casting shadows.
      for (const material of this._model.materials) material.config.castShadow = value;
      for (const child of this._children)
        child.visible = value;
    }

    /**
     * World-space AABB of the model's geometry: the cached object-space box transformed by the world
     * matrix, so it is looser than the exact vertex hull for a rotated mesh. Cached against
     * `_worldBoxDirty`; the returned object is a live reference (see {@link Node.getBoundingBox}).
     */
    public getBoundingBox(): { min: vec3, max: vec3 } {
        if (!this._worldBoxDirty) return this._worldBox;

        const geometry = this._model.geometry;
        // No geometry → fall back to the base unit cube (which fills and un-dirties the same cache).
        if (geometry.positions.length === 0) return super.getBoundingBox();

        const local = geometry.boundingBox;
        const transform = this.worldTransform;
        const corner = ModelNode._boxScratch;

        const min = this._worldBox.min;
        const max = this._worldBox.max;
        vec3.set(min, Infinity, Infinity, Infinity);
        vec3.set(max, -Infinity, -Infinity, -Infinity);

        for (let i = 0; i < 8; i++) {
            vec3.set(corner,
                (i & 1) ? local.max[0] : local.min[0],
                (i & 2) ? local.max[1] : local.min[1],
                (i & 4) ? local.max[2] : local.min[2]);
            vec3.transformMat4(corner, corner, transform);

            for (let a = 0; a < 3; a++) {
                if (corner[a] < min[a]) min[a] = corner[a];
                if (corner[a] > max[a]) max[a] = corner[a];
            }
        }

        // Skinned meshes deform on the GPU, so inflate the bind-pose box about its centre by the same
        // factor getBoundingSphere uses, or a limb reaches outside it.
        if (this._model instanceof AnimatedModel) {
            for (let a = 0; a < 3; a++) {
                const centre = (min[a] + max[a]) * 0.5;
                const half = (max[a] - min[a]) * 0.5 * 1.75;
                min[a] = centre - half;
                max[a] = centre + half;
            }
        }

        this._worldBoxDirty = false;
        return this._worldBox;
    }

    // Reused across the 8 corners so the whole path stays allocation-free.
    private static readonly _boxScratch: vec3 = vec3.create();

    /**
     * Static meshes expose their geometry's cached BVH for exact picking. Skinned meshes deform on the
     * GPU, so an object-space BVH would not match the pose — those return `null` and pick by AABB.
     */
    public getBVH(): BVH | null {
        if (this._model instanceof AnimatedModel) return null;
        const bvh = this._model.geometry.bvh;
        // Geometry with no triangles → fall back to AABB picking.
        return bvh.triangleCount > 0 ? bvh : null;
    }

    /** The factor the culling sphere's radius is inflated by; see {@link SKINNED_BOUNDS_MARGIN}. */
    public get boundsMargin(): number { return this._model instanceof AnimatedModel ? SKINNED_BOUNDS_MARGIN : 1; }

    public getBoundingSphere(): { center: vec3; radius: number } {
        if (!this._worldSphereDirty) return this._worldSphere;

        const local = this._model.geometry.boundingSphere;
        vec3.transformMat4(this._worldSphere.center, local.center, this.worldTransform);

        const scale = this.worldScale;
        const maxScale = Math.max(Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2]));
        let radius = local.radius * maxScale;
        if (this._model instanceof AnimatedModel) radius *= SKINNED_BOUNDS_MARGIN;

        this._worldSphere.radius = radius;
        this._worldSphereDirty = false;
        return this._worldSphere;
    }

    public update(delta: number, time: number): void {
        super.update(delta, time);
        // Skip animator playback when the scene has animations disabled (editor scenes), so skinned
        // meshes hold their bind pose.
        if (this._animator && this._scene?.animationsEnabled !== false) {
            const start = sceneStatsDetail.enabled ? performance.now() : 0;
            this._animator.checkTriggers();
            this._animator.update(delta);
            if (sceneStatsDetail.enabled) sceneStats.animatorMs += performance.now() - start;
        }
    }
}

import { AnimatedModel } from "../../../graphics/animatedModel";
import { AnimationMapping, AnimationStateMachine, Animator } from "../../../graphics/animator";
import { Material } from "../../../graphics/material";
import { Model } from "../../../graphics/model";
import { ShaderManager } from "../../../graphics/systems/shaderManager";
import type { RagdollOptions } from "../../../physics/ragdoll";
import type { BVH } from "../../bvh";
import { Logger } from "../../logger";
import { sceneStats, sceneStatsDetail } from "../sceneStats";
import { vec3 } from "gl-matrix";
import { v4 as uuidv4 } from 'uuid';
import { Node } from "./node";

/**
 * How far a skinned model's bind-pose bounds are inflated, as a CULLING margin: the mesh deforms on the
 * GPU, so its bind-pose extent understates where it can actually reach and a tight bound pops.
 *
 * Named and exported because it is a culling allowance, not a measurement — anything asking "how big is
 * this model" (import size normalization, the import review's reported size) has to divide it back out,
 * and a bare 1.75 buried in a getter is impossible to notice from those call sites.
 */
export const SKINNED_BOUNDS_MARGIN = 1.75;

/**
 * The renderable node: a `Model` or `AnimatedModel` plus its animator, physics bounds and BVH.
 */

export class ModelNode extends Node {
    private _model: Model | AnimatedModel;
    private _initialized: boolean;
    // Material type the mesh VAO/vertex-data were last built for. If the material type changes
    // (e.g. the editor switches basic <-> default/pbr, which use different vertex attribute
    // layouts), the mesh must be rebuilt — see the `initialized` getter.
    private _initializedType: string | null = null;
    private _animator: Animator | null;
    private _movementDirection: vec3;
    /** Optional per-node ragdoll simulation config (skinned meshes). Persisted with the scene; read by Ragdoll. */
    private _ragdollConfig: RagdollOptions | null = null;

    constructor(name: string, model: Model | AnimatedModel, id: string = uuidv4()) {
        super(name, 'model', id);
        this._model = model;
        this._initialized = false;
        this._movementDirection = vec3.create();
        
        // Create animator for animated models
        if (model instanceof AnimatedModel && model.hasSkin) {
            this._animator = new Animator(model, this);
        } else {
            this._animator = null;
        }
    }

    public initializeModel(): void {
        const shader = ShaderManager.Instance.getShader(this._model.material.type);
        this._model.mesh.initializeVAO(shader.attributes);
        const attributes = [];

        for (const attr of shader.attributes) {
            switch (attr.name) {
                case 'position':
                case 'a_position':
                    attributes.push('position');
                    break;
                case 'normal':
                case 'a_normal':
                    attributes.push('normal');
                    break;
                case 'uv':
                case 'a_uv':
                case 'texCoord':
                case 'a_texCoord':
                    attributes.push('uv');
                    break;
                case 'tangent':
                case 'a_tangent':
                    attributes.push('tangent');
                    break;
                case 'bitangent':
                case 'a_bitangent':
                    attributes.push('bitangent');
                    break;
                default:
                    const errMsg = `Attribute ${attr.name} not supported`;
                    Logger.error(errMsg)
                    throw new Error(errMsg);
            }
        }

        this._model.mesh.create(this._model.geometry.getData(attributes), this._model.geometry.vertexCount, this._model.geometry.indices);
        this._initialized = true;
        this._initializedType = this._model.material.type;
    }

    protected _serializePayload(): any {
            const model = this._model.serialize()
            // Serialize animation mappings + state machine if animator exists
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
        // Check if this is an AnimatedModel by looking for animation/skin data
        const isAnimated = json.model.skin || json.model.animations || json.model.jointIndices;
        const model = isAnimated ? AnimatedModel.parse(json.model) : Model.parse(json.model);
        const node = new ModelNode(json.name, model, json.id);
        
        // Restore animation mappings if they exist
        if (json.animationMappings && node.animator) {
            node.animator.setAnimationMappings(json.animationMappings);
        }

        // Restore the animation state machine if present (takes precedence over mappings).
        if (json.stateMachine && node.animator) {
            node.animator.setStateMachine(json.stateMachine);
        }

        // Restore ragdoll config if present
        if (json.ragdoll) node.ragdollConfig = json.ragdoll;

        Node.finishParse(node, parent, json);
    }

    public get model(): Model | AnimatedModel { return this._model; }
    // Reports uninitialized when the material type changed since the mesh was built, so the
    // renderer's `if (!node.initialized) node.initializeModel()` guards rebuild the VAO/vertex
    // data for the new material's attribute layout (basic uses a different layout than default/pbr).
    public get initialized(): boolean {
        return this._initialized && this._initializedType === this._model.material.type;
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
      // Every submesh, not just slot 0: hiding a merged model used to leave its other index ranges still
      // casting shadows, so the character vanished but part of its silhouette did not.
      for (const material of this._model.materials) material.config.castShadow = value;
      for (const child of this._children)
        child.visible = value;
      // The base setter (super.visible) already emitted the visibility SCENE_CHANGED for this node.
    }

    /**
     * World-space AABB of the model's geometry: the geometry's cached object-space box transformed by
     * the world matrix. Cached against `_worldBoxDirty`, so it costs 8 corner transforms at most once
     * per frame, and the returned object is a live reference (see {@link Node.getBoundingBox}).
     *
     * This used to transform *every vertex of the mesh on every call*, allocating two vec3s each, with
     * no cache — and the raycaster calls it once per node per ray. A 5-ray camera-collision probe over
     * 40 mid-poly meshes meant ~1M transforms and ~2M allocations per frame (~18ms, most of it GC).
     *
     * Transforming the local box's corners gives a bound that is correct but looser than the exact
     * vertex hull for a rotated mesh — the standard trade (Unity/Unreal both do this). Precise picking
     * is unaffected: the raycaster refines AABB hits against the triangle BVH.
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

        // Skinned meshes deform on the GPU, so the bind-pose bound understates the animated extent.
        // Inflate about the centre by the same factor getBoundingSphere uses, to avoid a limb sticking
        // out of the box (which would make it unpickable and invisible to camera collision).
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
     * Static meshes expose their geometry's cached BVH for exact picking. Skinned/animated meshes
     * deform on the GPU, so an object-space BVH would not match the current pose — those return
     * `null` and fall back to AABB picking.
     */
    public getBVH(): BVH | null {
        if (this._model instanceof AnimatedModel) return null;
        const bvh = this._model.geometry.bvh;
        // Geometry with no triangles → fall back to AABB picking.
        return bvh.triangleCount > 0 ? bvh : null;
    }

    /**
     * World-space bounding sphere for frustum culling: the geometry's cached local sphere transformed
     * by the world matrix, radius scaled by the largest world-axis scale. Cached and invalidated with
     * the transform (`_worldSphereDirty`). Skinned/animated meshes deform on the GPU, so their bind-pose
     * bound understates the animated extent — inflate the radius to avoid popping.
     */
    /** The bind-pose radius the sphere above is inflated by; see {@link SKINNED_BOUNDS_MARGIN}. */
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
        // Skip animator playback when the scene has animations disabled (editor scenes) so skinned
        // meshes hold their bind pose; Play scenes leave it enabled, and the Animation Editor drives
        // its preview clone's animator directly (not via scene.update), so both still animate.
        if (this._animator && this._scene?.animationsEnabled !== false) {
            const start = sceneStatsDetail.enabled ? performance.now() : 0;
            this._animator.checkTriggers();
            this._animator.update(delta);
            if (sceneStatsDetail.enabled) sceneStats.animatorMs += performance.now() - start;
        }
    }
}

/**
 * Groups alternate LOD subtrees of one mesh asset: child i holds the whole level-i subtree and only
 * one level shows at a time, selected each frame by camera distance (Renderer._updateModelLOD →
 * updateLod). `distances[i]` is the distance at which child i becomes active (ascending,
 * distances[0] = 0). When `cullDistance > 0` the whole group hides past it; 0 = never cull.
 * Level switches use the event-less `setLodVisible` flag, never the `visible` setter (which emits
 * SCENE_CHANGED and, on ModelNode, clobbers material.config.castShadow).
 */

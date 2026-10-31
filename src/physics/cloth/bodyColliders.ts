import { mat4, quat, vec3 } from "gl-matrix";
import type { Skin } from "../../animation/animatedModel";
import { effectiveRagdollProfile, ragdollLayout, ragdollPartPose, type RagdollLayout } from "../ragdollProfile";
import type { ClothCapsule } from "./xpbdCloth";

/**
 * A character's body as cloth colliders: its ragdoll parts (the rig's profile, else the automatic
 * humanoid one) posed from the live animation, every one as a capsule — a box part (a chest, a pelvis)
 * stands in as one, a sphere is a capsule of no length. No physics bodies are made.
 *
 * Built once per skin (`layout`), posed per frame (`pose`).
 */
export class BodyColliders {
    private readonly _skin: Skin;
    private readonly _layout: RagdollLayout | null;
    private readonly _axis = vec3.create();

    constructor(skin: Skin) {
        this._skin = skin;
        const { profile } = effectiveRagdollProfile(skin);
        this._layout = profile ? ragdollLayout(skin, profile) : null;
    }

    /** Whether the skin has a body to collide with (a humanoid, or a rig with a ragdoll profile). */
    public get valid(): boolean { return !!this._layout && this._layout.parts.length > 0; }

    /** The capsules for this frame: `modelWorld` is the skinned node's world matrix, `bones` its final bone matrices. */
    public pose(modelWorld: mat4, bones: ArrayLike<mat4>, out: ClothCapsule[] = []): ClothCapsule[] {
        out.length = 0;
        if (!this._layout) return out;
        for (const lp of this._layout.parts) {
            const bone = bones[lp.joint];
            if (!bone) continue;
            const pose = ragdollPartPose(this._skin, lp, modelWorld, bone);
            const radius = lp.radius * pose.scale;
            const half = lp.part.shape === 'sphere' ? 0 : Math.max(0, lp.length * pose.scale / 2 - radius);
            const axis = vec3.transformQuat(this._axis, [0, 1, 0], pose.rotation as quat);
            const c = pose.center;
            out.push({
                a: [c[0] - axis[0] * half, c[1] - axis[1] * half, c[2] - axis[2] * half],
                b: [c[0] + axis[0] * half, c[1] + axis[1] * half, c[2] + axis[2] * half],
                radius,
            });
        }
        return out;
    }
}

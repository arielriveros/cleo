import type JoltNS from 'jolt-physics';
import type { ColliderDesc } from '../types';
import { ragdollJointPriorities, type RagdollPlan, type RagdollPlanInput } from '../ragdollPlan';
import type { Jolt } from './load';

// A ragdoll planned with Jolt's own ragdoll tools (pal/ragdollPlan.ts): a throwaway RagdollSettings of the parts
// (a Skeleton for the hierarchy, a RagdollPart per part with its shape, pose and mass) run through Stabilize()
// (mass ratios between parents and children kept small, a parent's inertia at least its children's: Strunk's
// "Stop my constraints from blowing up!") and DisableParentChildCollisions() (every parent and child, and every pair
// already touching in the pose, kept from colliding: read back from the GroupFilterTable it makes). Nothing is
// added to the world, and everything made is freed (Jolt's heap is a fixed 128 MB). The joints' solve order is
// RagdollSettings::CalculateConstraintPriorities' rule, ported (ragdollJointPriorities: by the chain each carries).

/** Parts a plan can filter by pairs (a GroupFilterTable's sub-groups, a bit each in BodyDesc.selfFilter.ignore). */
export const MAX_PLANNED_PARTS = 32;

export function planJoltRagdoll(J: Jolt, input: RagdollPlanInput, shapeOf: (colliders: readonly ColliderDesc[]) => JoltNS.Shape): RagdollPlan {
    const parts = input.parts, n = parts.length;
    const parents = parts.map(p => p.parent);
    const total = parts.reduce((s, p) => s + Math.max(0, p.mass), 0);
    const plan: RagdollPlan = {
        masses: parts.map(p => p.mass), inertia: parts.map(() => [0, 0, 0, 0, 0, 0]),
        ignore: parts.map(() => 0), priority: ragdollJointPriorities(parents, input.basePriority ?? 0),
    };
    if (n === 0) return plan;
    const settings = new J.RagdollSettings();
    const matrices = new J.ArrayMat44();
    const pos = new J.RVec3(0, 0, 0), rot = new J.Quat(0, 0, 0, 1), v = new J.Vec3(0, 0, 0);
    try {
        const skeleton = new J.Skeleton();
        for (let i = 0; i < n; i++) {
            const name = `part${i}`, s = new J.JPHString(name, name.length);
            skeleton.AddJoint(s, parents[i] >= 0 && parents[i] < i ? parents[i] : -1);
            J.destroy(s);
        }
        // The settings hold it (a reference): it goes with them.
        settings.mSkeleton = skeleton;
        settings.mParts.resize(n);
        for (let i = 0; i < n; i++) {
            const p = parts[i], part = settings.mParts.at(i);
            const shape = shapeOf(p.colliders);
            part.SetShape(shape);
            shape.Release();
            pos.Set(p.position[0], p.position[1], p.position[2]);
            rot.Set(p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3]);
            part.mPosition = pos;
            part.mRotation = rot;
            part.mMotionType = J.EMotionType_Dynamic;
            // Its mass as given, its inertia from its shape at that mass: what Stabilize starts from.
            part.mOverrideMassProperties = J.EOverrideMassProperties_CalculateInertia;
            const mp = new J.MassProperties();
            mp.mMass = Math.max(1e-3, p.mass);
            part.mMassPropertiesOverride = mp;
            J.destroy(mp);
            v.Set(p.position[0], p.position[1], p.position[2]);
            matrices.push_back(J.Mat44.prototype.sRotationTranslation(rot, v));
        }
        settings.Stabilize();
        settings.DisableParentChildCollisions(matrices.data(), Math.max(0, input.minSeparation ?? 0.03));
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const mp = settings.mParts.at(i).GetMassProperties();
            plan.masses[i] = mp.mMass;
            const x = mp.mInertia.GetAxisX(), y = mp.mInertia.GetAxisY(), z = mp.mInertia.GetAxisZ();
            // Columns of a symmetric matrix: Ixx Iyy Izz Ixy Ixz Iyz.
            plan.inertia[i] = [x.GetX(), y.GetY(), z.GetZ(), y.GetX(), z.GetX(), z.GetY()];
            sum += mp.mMass;
        }
        if (input.keepMasses) {
            // The masses as given; each inertia what Stabilize made it over its shape's at its own mass (a shape's
            // inertia goes with its mass), at the given mass.
            for (let i = 0; i < n; i++) {
                const m = Math.max(1e-3, parts[i].mass), k = plan.masses[i] > 0 ? m / plan.masses[i] : 1;
                plan.masses[i] = m;
                for (let c = 0; c < 6; c++) plan.inertia[i][c] *= k;
            }
        } else {
            // The profile's total, whatever Stabilize moved.
            const k = sum > 0 && total > 0 ? total / sum : 1;
            for (let i = 0; i < n; i++) {
                plan.masses[i] *= k;
                for (let c = 0; c < 6; c++) plan.inertia[i][c] *= k;
            }
        }
        const filter = settings.mParts.at(0).mCollisionGroup.GetGroupFilter();
        if (filter && J.getPointer(filter) !== 0) {
            const table = J.castObject(filter, J.GroupFilterTable);
            const m = Math.min(n, MAX_PLANNED_PARTS);
            for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
                if (table.IsCollisionEnabled(i, j)) continue;
                plan.ignore[i] |= 1 << j;
                plan.ignore[j] |= 1 << i;
            }
        }
    } finally {
        J.destroy(matrices);
        J.destroy(settings);
        J.destroy(pos); J.destroy(rot); J.destroy(v);
    }
    return plan;
}

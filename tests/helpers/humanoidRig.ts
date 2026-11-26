import { mat4, quat, vec3 } from 'gl-matrix';
import { AnimatedModel } from '../../src/animation/animatedModel';
import type { Animation, Skin } from '../../src/animation/animatedModel';
import { ModelNode } from '../../src/core/scene/nodes/modelNode';
import { PhysicsSystem } from '../../src/physics/physicsSystem';
import { makeBody, box } from './physicsBodies';
import { TEST_PHYSICS } from './testPhysics';
import type { PhysicsBackendKind } from '../../src/physics/pal/types';

// A procedural humanoid for engine tests that need a person (powered ragdolls, reactions) without an example's
// data packs: Mixamo bone names, a 1.8 m body standing at the origin facing +Z in a T-pose bind, bones turned
// identity (every local is a translation), so a clip's rotations read directly as bone turns.

/** [name, parent, bind position] */
const BONES: [string, string | null, [number, number, number]][] = [
    ['mixamorig:Hips', null, [0, 1.0, 0]],
    ['mixamorig:Spine', 'mixamorig:Hips', [0, 1.1, 0]],
    ['mixamorig:Spine1', 'mixamorig:Spine', [0, 1.22, 0]],
    ['mixamorig:Spine2', 'mixamorig:Spine1', [0, 1.34, 0]],
    ['mixamorig:Neck', 'mixamorig:Spine2', [0, 1.5, 0]],
    ['mixamorig:Head', 'mixamorig:Neck', [0, 1.58, 0.01]],
    ['mixamorig:HeadTop_End', 'mixamorig:Head', [0, 1.78, 0.01]],
    ...(['Left', 'Right'] as const).flatMap(side => {
        const s = side === 'Left' ? 1 : -1;
        const b = (n: string) => `mixamorig:${side}${n}`;
        return [
            [b('Shoulder'), 'mixamorig:Spine2', [0.05 * s, 1.45, 0]],
            [b('Arm'), b('Shoulder'), [0.18 * s, 1.45, 0]],
            [b('ForeArm'), b('Arm'), [0.46 * s, 1.45, 0]],
            [b('Hand'), b('ForeArm'), [0.72 * s, 1.45, 0]],
            [b('HandMiddle1'), b('Hand'), [0.81 * s, 1.45, 0]],
            [b('UpLeg'), 'mixamorig:Hips', [0.09 * s, 0.95, 0]],
            [b('Leg'), b('UpLeg'), [0.09 * s, 0.52, 0.01]],
            [b('Foot'), b('Leg'), [0.09 * s, 0.08, 0]],
            [b('ToeBase'), b('Foot'), [0.09 * s, 0.02, 0.14]],
            [b('Toe_End'), b('ToeBase'), [0.09 * s, 0.02, 0.2]],
        ] as [string, string, [number, number, number]][];
    }),
];

/** The skin: one joint per bone, node index = bone order. */
export function humanoidSkin(): Skin {
    const index = new Map(BONES.map(([name], i) => [name, i]));
    const nodeParents = new Map<number, number>(), nodeTransforms = new Map<number, mat4>(), nodeNames = new Map<number, string>();
    const joints = BONES.map(([name, parent, pos], i) => {
        const p = parent ? index.get(parent)! : -1;
        const local = vec3.sub(vec3.create(), pos, p >= 0 ? BONES[p][2] : [0, 0, 0]);
        nodeTransforms.set(i, mat4.fromTranslation(mat4.create(), local));
        nodeNames.set(i, name);
        if (p >= 0) nodeParents.set(i, p);
        return { nodeIndex: i, inverseBindMatrix: mat4.fromTranslation(mat4.create(), vec3.negate(vec3.create(), pos)), ...(p >= 0 ? { parentIndex: p } : {}) };
    });
    return { joints, nodeParents, nodeTransforms, nodeNames, skeleton: 0 };
}

/** The node index of a bone by its name without the namespace ('LeftForeArm'). */
export function boneIndex(name: string): number {
    const i = BONES.findIndex(([n]) => n === `mixamorig:${name}`);
    if (i < 0) throw new Error(`no bone ${name}`);
    return i;
}

/** A clip holding bones turned by `turns` (bone name → [axis, degrees]) from the bind pose, `seconds` long. */
export function poseClip(name: string, turns: Record<string, [[number, number, number], number]>, seconds = 1): Animation {
    const samplers: Animation['samplers'] = [], channels: Animation['channels'] = [];
    for (const [bone, [axis, deg]] of Object.entries(turns)) {
        const q = quat.setAxisAngle(quat.create(), axis, deg * Math.PI / 180);
        samplers.push({ input: [0, seconds], output: [...q, ...q], interpolation: 'LINEAR' });
        channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: boneIndex(bone), targetPath: 'rotation' });
    }
    return { name, samplers, channels };
}

/** Standing with the arms down along the body. */
export const IDLE = (): Animation => poseClip('Idle', {
    LeftArm: [[0, 0, 1], -75], RightArm: [[0, 0, 1], 75],
    LeftForeArm: [[0, 1, 0], 15], RightForeArm: [[0, 1, 0], -15],
});

/**
 * A ModelNode on the procedural skin, with `clips`, standing at `position`. An AnimatedModel without its mesh
 * (a real one builds a GPU mesh): what the animator and the ragdoll read is the skin and the clips.
 */
export function humanoidModel(clips: Animation[] = [IDLE()], position: [number, number, number] = [0, 0, 0]): ModelNode {
    const model = Object.create(AnimatedModel.prototype) as AnimatedModel;
    Object.assign(model, { _skin: humanoidSkin(), _animations: clips, _materials: [], _submeshes: [], skinnedCloth: null });
    const node = new ModelNode('person', model);
    node.setPosition(position);
    // In a scene, as far as the ragdoll's lifetime check cares (a node with no scene ends its ragdoll).
    node.scene = {} as any;
    if (clips.length) node.animator!.playAnimationByName(clips[0].name, true, false);
    node.animator!.update(0);
    return node;
}

/** A physics system on a 100 m ground box, its scene stubbed for stepping. */
export function groundWorld(backend: PhysicsBackendKind = TEST_PHYSICS): PhysicsSystem {
    const p = new PhysicsSystem({ gravity: [0, -9.82, 0], backend });
    p.initialize();
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
    p.addBody(makeBody(box(50, 0.5, 50), { position: [0, -0.5, 0] }));
    return p;
}

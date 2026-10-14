import { mat4, quat, vec3 } from 'gl-matrix';
import type { Skin, SkinSocket } from './animatedModel';
import { decomposeTRS } from '../core/math';
import { humanoidSlotOf } from './boneNames';

// Sockets: named attach points on a skeleton's bones.
//
// A socket names its bone, never indexes it. Node indices are stable only within one export, and a rig's
// name table is improved in place (`importSkeletonNames` backfills it) — so an index would silently point
// at the wrong bone the first time either happened. The name is resolved to a joint once per skin here.

interface ResolvedSocket {
    joint: number;
    offset: mat4;
}

// Keyed on the Skin object, and re-validated against the sockets ARRAY: the editor replaces the array
// wholesale on every edit, so identity is the whole invalidation rule.
const cache = new WeakMap<Skin, { sockets: SkinSocket[]; byName: Map<string, ResolvedSocket> }>();

function resolveAll(skin: Skin): Map<string, ResolvedSocket> {
    const sockets = skin.sockets ?? [];
    const hit = cache.get(skin);
    if (hit && hit.sockets === sockets) return hit.byName;

    // Bone name -> joint index, through the node index the name table is keyed by.
    const jointOfNode = new Map<number, number>();
    skin.joints.forEach((j, i) => jointOfNode.set(j.nodeIndex, i));
    const jointOfName = new Map<string, number>();
    for (const [nodeIndex, name] of skin.nodeNames ?? []) {
        const joint = jointOfNode.get(nodeIndex);
        if (joint !== undefined) jointOfName.set(name, joint);
    }

    const byName = new Map<string, ResolvedSocket>();
    for (const socket of sockets) {
        const joint = jointOfName.get(socket.bone);
        if (joint === undefined) continue; // a bone this skeleton does not have: the socket is inert
        byName.set(socket.name, { joint, offset: socketOffsetMatrix(socket) });
    }
    addImplicitSockets(byName, skin, jointOfNode);
    cache.set(skin, { sockets, byName });
    return byName;
}

/**
 * The sockets every HUMANOID skeleton has without authoring: its hands and head, named the way scripts
 * ask for them. Read through the same bone-name recogniser retargeting uses (`humanoidSlotOf`), so a
 * Mixamo, Unreal (`hand_r`), Unity or Blender (`hand.R`) rig all answer to `RightHand`.
 *
 * Without these, a character whose model was swapped for a rig with other bone names lost every socket
 * the scripts relied on: weapons had no hand to ride, and a caster fired from its chest. An AUTHORED
 * socket of the same name always wins — that is how a grip offset for a particular rig is given.
 */
export const IMPLICIT_SOCKETS: Readonly<Record<string, string>> = {
    RightHand: 'hand.R',
    LeftHand: 'hand.L',
    Head: 'head',
};

function addImplicitSockets(byName: Map<string, ResolvedSocket>, skin: Skin, jointOfNode: Map<number, number>): void {
    const wanted = Object.entries(IMPLICIT_SOCKETS).filter(([name]) => !byName.has(name));
    if (wanted.length === 0 || !skin.nodeNames) return;
    // The FIRST joint (skeleton order, root first) whose name reads as the slot: a rig with a helper bone
    // that also reads as a hand (an IK target, a twist bone) keeps the real one, which comes earlier.
    const slotJoint = new Map<string, number>();
    const ordered = Array.from(skin.nodeNames)
        .map(([nodeIndex, name]) => ({ joint: jointOfNode.get(nodeIndex), name }))
        .filter((e): e is { joint: number; name: string } => e.joint !== undefined)
        .sort((a, b) => a.joint - b.joint);
    for (const { joint, name } of ordered) {
        const slot = humanoidSlotOf(name);
        if (slot && !slotJoint.has(slot)) slotJoint.set(slot, joint);
    }
    for (const [name, slot] of wanted) {
        const joint = slotJoint.get(slot);
        if (joint !== undefined) byName.set(name, { joint, offset: mat4.create() });
    }
}

/** A socket's offset as a matrix in its bone's local space. */
export function socketOffsetMatrix(socket: SkinSocket): mat4 {
    const t = socket.offset?.t ?? [0, 0, 0];
    const r = socket.offset?.r ?? [0, 0, 0, 1];
    const s = socket.offset?.s ?? [1, 1, 1];
    return mat4.fromRotationTranslationScale(
        mat4.create(),
        quat.normalize(quat.create(), quat.fromValues(r[0], r[1], r[2], r[3])),
        vec3.fromValues(t[0], t[1], t[2]),
        vec3.fromValues(s[0], s[1], s[2]));
}

/** The joint a socket rides on, or -1 when the skin has no such socket (or no such bone). */
export function socketJoint(skin: Skin, name: string): number {
    return resolveAll(skin).get(name)?.joint ?? -1;
}

/** Names of the sockets this skin can actually resolve. */
export function socketNames(skin: Skin | null | undefined): string[] {
    return skin ? Array.from(resolveAll(skin).keys()) : [];
}

const jt = vec3.create();
const jr = quat.create();
const js = vec3.create();
const jointTR = mat4.create();

/**
 * A socket's MODEL-space transform: `TR(jointModel) x offset`. `jointModel` is the joint's current pose
 * relative to the model node (`Animator.getJointModelMatrix`). Null when the socket does not resolve.
 *
 * The joint's SCALE is dropped, keeping only where it is and which way it faces. An FBX rig sits under a
 * 0.01 armature, so a socket that inherited it would shrink a held sword to a centimetre; what a person
 * expects is the size the sword has as a plain child of the character. Scale comes from the offset only.
 */
export function socketModelMatrix(out: mat4, skin: Skin, name: string, jointModel: (joint: number) => mat4 | null): mat4 | null {
    const resolved = resolveAll(skin).get(name);
    if (!resolved) return null;
    const joint = jointModel(resolved.joint);
    if (!joint) return null;
    decomposeTRS(joint, jt, jr, js);
    mat4.fromRotationTranslation(jointTR, jr, jt);
    return mat4.multiply(out, jointTR, resolved.offset);
}

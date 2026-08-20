import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import {
    buildBoneMapping, applyManualMapping, mappingReport, retargetAnimation,
} from '../src/graphics/animationRetarget';
import type { Animation, Skin } from '../src/graphics/animatedModel';

// The retarget is only trustworthy if two identities hold: an identical rig must reproduce the clip
// unchanged, and feeding a rig its OWN bind pose must return the target's bind pose. If either fails the
// math is a fudge, not a retarget — so those are asserted directly, in addition to the naming/mapping logic.

/** A bone spec: name, parent index (into the same array, -1 for root), and local rest TRS. */
type BoneSpec = { name: string; parent: number; t?: [number, number, number]; r?: [number, number, number, number] };

/** Build a Skin from a flat bone list. Node index == array index, so parents refer by index. */
function skinOf(bones: BoneSpec[]): Skin {
    const nodeNames = new Map<number, string>();
    const nodeParents = new Map<number, number>();
    const nodeTransforms = new Map<number, mat4>();
    bones.forEach((b, i) => {
        nodeNames.set(i, b.name);
        if (b.parent >= 0) nodeParents.set(i, b.parent);
        const m = mat4.create();
        mat4.fromRotationTranslation(m, (b.r ?? [0, 0, 0, 1]) as any, (b.t ?? [0, 0, 0]) as any);
        nodeTransforms.set(i, m);
    });
    const joints = bones.map((b, i) => ({ nodeIndex: i, inverseBindMatrix: mat4.create(), parentIndex: b.parent >= 0 ? b.parent : undefined }));
    return { joints, nodeNames, nodeParents, nodeTransforms };
}

/**
 * Build a Skin whose joints carry REAL inverse bind matrices computed from the bind pose, and whose
 * `nodeTransforms` can be a DIFFERENT ("frame-0") pose. This is the Mixamo situation reduced: the true bind
 * is in the IBMs, while the animation file's node transforms hold frame 0.
 */
function skinWithIBM(bind: BoneSpec[], frame0?: BoneSpec[]): Skin {
    const nt = frame0 ?? bind;
    const nodeNames = new Map<number, string>();
    const nodeParents = new Map<number, number>();
    const nodeTransforms = new Map<number, mat4>();
    const worldBind: mat4[] = [];
    bind.forEach((b, i) => {
        nodeNames.set(i, b.name);
        if (b.parent >= 0) nodeParents.set(i, b.parent);
        const local = mat4.fromRotationTranslation(mat4.create(), (b.r ?? [0, 0, 0, 1]) as any, (b.t ?? [0, 0, 0]) as any);
        worldBind[i] = b.parent >= 0 ? mat4.multiply(mat4.create(), worldBind[b.parent], local) : local;
        // nodeTransforms come from the (possibly different) frame-0 spec.
        const f = nt[i];
        nodeTransforms.set(i, mat4.fromRotationTranslation(mat4.create(), (f.r ?? [0, 0, 0, 1]) as any, (f.t ?? [0, 0, 0]) as any));
    });
    const joints = bind.map((b, i) => ({
        nodeIndex: i,
        inverseBindMatrix: mat4.invert(mat4.create(), worldBind[i])!,
        parentIndex: b.parent >= 0 ? b.parent : undefined,
    }));
    return { joints, nodeNames, nodeParents, nodeTransforms };
}

/** A one-keyframe clip: each entry drives a bone's rotation with the given quaternion. */
function clipOf(name: string, channels: { node: number; rot: number[] }[]): Animation {
    const samplers = channels.map(c => ({ input: [0], output: c.rot.slice(), interpolation: 'LINEAR' as const }));
    return { name, samplers, channels: channels.map((c, i) => ({ samplerIndex: i, targetNodeIndex: c.node, targetPath: 'rotation' as const })) };
}

const qy = (deg: number) => Array.from(quat.setAxisAngle(quat.create(), [0, 1, 0], deg * Math.PI / 180));

// A minimal humanoid: hips → spine → neck, plus one arm chain. Enough to exercise matching + the delta math.
const rig = (prefix: string): BoneSpec[] => [
    { name: `${prefix}Hips`, parent: -1, t: [0, 1, 0] },
    { name: `${prefix}Spine`, parent: 0, t: [0, 0.2, 0] },
    { name: `${prefix}Neck`, parent: 1, t: [0, 0.2, 0] },
    { name: `${prefix}LeftArm`, parent: 1, t: [0.1, 0, 0] },
    { name: `${prefix}LeftForeArm`, parent: 3, t: [0.2, 0, 0] },
];

describe('buildBoneMapping — matching', () => {
    it('matches an identical rig exactly and flags it same-rig', () => {
        const s = skinOf(rig(''));
        const m = buildBoneMapping([clipOf('a', [{ node: 4, rot: qy(30) }])], s, s);
        expect(m.sameRig).toBe(true);
        expect(m.entries[0].kind).toBe('exact');
        expect(m.entries[0].targetNode).toBe(4);
    });

    // Same names and orientations, different proportions: a raw copy would keep the source's bone lengths,
    // so this must NOT read as same-rig even though every bone matches exactly. Guards the rest-translation
    // half of the sameRig test.
    it('is not same-rig when proportions differ, even with identical names', () => {
        const source = skinOf(rig(''));
        const tall = (() => { const b = rig(''); b[4] = { name: 'LeftForeArm', parent: 3, t: [0.5, 0, 0] }; return skinOf(b); })();
        const m = buildBoneMapping([clipOf('a', [{ node: 4, rot: qy(30) }])], source, tall);
        expect(m.entries[0].kind).toBe('exact');
        expect(m.sameRig).toBe(false);
    });

    it('matches across naming conventions via the humanoid dictionary', () => {
        const source = skinOf([
            { name: 'mixamorig:Hips', parent: -1, t: [0, 1, 0] },
            { name: 'mixamorig:Spine', parent: 0, t: [0, 0.2, 0] },
            { name: 'mixamorig:Neck', parent: 1, t: [0, 0.2, 0] },
            { name: 'mixamorig:LeftArm', parent: 1, t: [0.1, 0, 0] },
            { name: 'mixamorig:LeftForeArm', parent: 3, t: [0.2, 0, 0] },
        ]);
        const target = skinOf([
            { name: 'pelvis', parent: -1, t: [0, 1, 0] },
            { name: 'spine_01', parent: 0, t: [0, 0.2, 0] },
            { name: 'neck_01', parent: 1, t: [0, 0.2, 0] },
            { name: 'arm_upper_l', parent: 1, t: [0.1, 0, 0] },
            { name: 'arm_lower_l', parent: 3, t: [0.2, 0, 0] },
        ]);
        const m = buildBoneMapping([clipOf('a', [{ node: 4, rot: qy(30) }])], source, target);
        const forearm = m.entries.find(e => e.sourceNode === 4)!;
        expect(forearm.targetNode).toBe(4); // arm_lower_l
        expect(forearm.kind).toBe('humanoid');
        // Different names but IDENTICAL bind poses → geometrically the same rig → sameRig (raw copy is exact).
        // This is the mixamorig:/mixamorig1: case: sameRig is judged on bind orientation, not name equality.
        expect(m.sameRig).toBe(true);
    });

    it('prefers exact over normalized over humanoid', () => {
        const source = skinOf([{ name: 'mixamorig:Hips', parent: -1 }]);
        // Target has an exact 'mixamorig:Hips' AND a 'Hips' (normalized match) AND 'pelvis' (humanoid).
        const target = skinOf([
            { name: 'pelvis', parent: -1 },
            { name: 'Hips', parent: -1 },
            { name: 'mixamorig:Hips', parent: -1 },
        ]);
        const m = buildBoneMapping([clipOf('a', [{ node: 0, rot: qy(0) }])], source, target);
        expect(m.entries[0].targetNode).toBe(2); // the exact one
        expect(m.entries[0].kind).toBe('exact');
    });

    it('falls back to index matching when names are absent', () => {
        const bare = (n: number): Skin => ({
            joints: Array.from({ length: n }, (_, i) => ({ nodeIndex: i, inverseBindMatrix: mat4.create() })),
        });
        const m = buildBoneMapping([clipOf('a', [{ node: 1, rot: qy(10) }])], bare(3), bare(3));
        expect(m.matchMode).toBe('index');
        expect(m.canRetarget).toBe(false);
        expect(m.entries[0].targetNode).toBe(1);
        expect(m.entries[0].kind).toBe('index');
    });

    it('pairs spine chains of unequal length by order', () => {
        const source = skinOf([
            { name: 'Hips', parent: -1 }, { name: 'Spine', parent: 0 }, { name: 'Neck', parent: 1 },
        ]);
        // Target spine has TWO bones between hips and neck.
        const target = skinOf([
            { name: 'Hips', parent: -1 }, { name: 'Spine1', parent: 0 }, { name: 'Spine2', parent: 1 }, { name: 'Neck', parent: 2 },
        ]);
        const m = buildBoneMapping([clipOf('a', [{ node: 1, rot: qy(5) }])], source, target);
        const spine = m.entries.find(e => e.sourceNode === 1)!;
        expect(spine.kind).toBe('spine');
        expect([1, 2]).toContain(spine.targetNode); // paired into the target chain, not left unmatched
    });
});

describe('bind pose comes from the inverse bind matrices', () => {
    // The Mixamo bug, reduced: both skins have the SAME bind pose (same IBMs), but the SOURCE's node
    // transforms are a different, animated frame-0 pose. Reading node transforms made this look like a
    // different rig and twisted every bone; reading IBMs must see it as same-rig.
    it('detects same-rig when node transforms differ but IBMs agree', () => {
        const bind = rig('');
        // Source frame-0: the arm rotated 40° — as if the animation's first frame is not the bind pose.
        const frame0 = rig('');
        frame0[3] = { name: 'LeftArm', parent: 1, t: [0.1, 0, 0], r: qy(40) as any };
        frame0[4] = { name: 'LeftForeArm', parent: 3, t: [0.2, 0, 0], r: qy(40) as any };

        const source = skinWithIBM(bind, frame0); // IBMs = bind, nodeTransforms = frame0
        const target = skinWithIBM(bind);          // both = bind

        const m = buildBoneMapping([clipOf('a', [{ node: 4, rot: qy(30) }])], source, target);
        expect(m.sameRig).toBe(true); // the frame-0 node transforms must NOT fool this

        const out = retargetAnimation(clipOf('a', [{ node: 4, rot: qy(30) }]), source, target, m);
        const sampler = out.samplers[out.channels.find(c => c.targetNodeIndex === 4)!.samplerIndex];
        expect(Array.from(sampler.output)).toEqual(qy(30)); // raw copy — exact
    });

    // The fallback must survive: an animation-only glTF has identity IBMs, so bind must come from node
    // transforms as before.
    it('falls back to node transforms when IBMs are identity', () => {
        const s = skinOf(rig('')); // skinOf uses identity IBMs
        const m = buildBoneMapping([clipOf('a', [{ node: 4, rot: qy(30) }])], s, s);
        expect(m.sameRig).toBe(true); // identical rig, identity IBMs, node-transform bind — still same-rig
    });

    // The exact reported case, reduced: the Mixamo ANIMATION has no IBMs (bind lives in its node transforms),
    // the Mixamo MODEL has IBMs but garbage (frame-0) node transforms, and the namespaces differ
    // (mixamorig: vs mixamorig1:). Same skeleton → must be same-rig → raw copy → limbs untouched.
    it('is same-rig for a Mixamo animation (no IBM) onto its model (IBM, garbage node transforms)', () => {
        const bind = rig('mixamorig:');
        const source = skinOf(bind); // animation: identity IBMs, node transforms = bind

        // model: same bind in the IBMs, but node transforms are a different (frame-0) pose, and renamed.
        const frame0 = rig('mixamorig1:');
        frame0[3] = { name: 'mixamorig1:LeftArm', parent: 1, t: [0.1, 0, 0], r: qy(55) as any };
        frame0[4] = { name: 'mixamorig1:LeftForeArm', parent: 3, t: [0.2, 0, 0], r: qy(55) as any };
        const target = skinWithIBM(rig('mixamorig1:'), frame0);

        const m = buildBoneMapping([clipOf('a', [{ node: 4, rot: qy(30) }])], source, target);
        expect(m.sameRig).toBe(true);

        const out = retargetAnimation(clipOf('a', [{ node: 4, rot: qy(30) }]), source, target, m);
        const sampler = out.samplers[out.channels.find(c => c.targetNodeIndex === 4)!.samplerIndex];
        expect(Array.from(sampler.output)).toEqual(qy(30)); // limb copied straight through, not twisted
    });

    // Even when the rig genuinely differs, a difference confined to the ARMATURE (the non-joint root above
    // the hips) must not reach the limbs — the local-delta approach keeps a limb bone's correction ~identity.
    it('does not twist limbs when only the root frame differs', () => {
        const bind = rig('');
        // Target hips bind rotated 40° (as if the model import rotated the armature); limbs unchanged.
        const tbind = rig('');
        tbind[0] = { name: 'Hips', parent: -1, t: [0, 1, 0], r: qy(40) as any };
        const source = skinWithIBM(bind);
        const target = skinWithIBM(tbind);

        const clip = clipOf('a', [{ node: 4, rot: qy(25) }]); // forearm only
        const m = buildBoneMapping([clip], source, target);
        const out = retargetAnimation(clip, source, target, m);
        const sampler = out.samplers[out.channels.find(c => c.targetNodeIndex === 4)!.samplerIndex];
        // Forearm local bind is identical on both rigs, so its correction is identity — untouched by the hips.
        expect(Array.from(sampler.output)).toEqual(qy(25));
    });

    // The root/armature correction, isolated: two rigs identical except a non-joint ARMATURE node above the
    // hips is rotated 90° on the target (the classic Mixamo armature difference — "lying down instead of
    // upright"). The retargeted hips must cancel it so the DISPLAYED world orientation matches the source.
    it('cancels an armature difference at the root so the world pose matches the source', () => {
        // node 0 = armature (non-joint), node 1 = Hips (joint), node 2 = LeftForeArm (joint).
        const skinArm = (armature: quat): Skin => ({
            joints: [
                { nodeIndex: 1, inverseBindMatrix: mat4.create(), parentIndex: 0 },
                { nodeIndex: 2, inverseBindMatrix: mat4.create(), parentIndex: 1 },
            ],
            nodeNames: new Map([[1, 'Hips'], [2, 'LeftForeArm']]),
            nodeParents: new Map([[1, 0], [2, 1]]),
            nodeTransforms: new Map([
                [0, mat4.fromQuat(mat4.create(), armature)],
                [1, mat4.create()],
                [2, mat4.fromTranslation(mat4.create(), [0.2, 0, 0])],
            ]),
        });
        const qx90 = quat.setAxisAngle(quat.create(), [1, 0, 0], Math.PI / 2);
        const source = skinArm(quat.create()); // armature identity
        const target = skinArm(qx90);           // armature rotated 90° about X

        const As = quat.normalize(quat.create(), qy(30) as any); // a hips rotation
        const clip = clipOf('a', [{ node: 1, rot: Array.from(As) }]);
        const m = buildBoneMapping([clip], source, target);
        expect(m.sameRig).toBe(false); // the armature differs → not a raw copy

        const out = retargetAnimation(clip, source, target, m);
        const At = out.samplers[out.channels.find(c => c.targetNodeIndex === 1)!.samplerIndex].output;
        const atQ = quat.fromValues(At[0], At[1], At[2], At[3]);

        // Displayed world = armature · localHips. Target must display the same world orientation as source.
        const displayedSource = As; // source armature is identity
        const displayedTarget = quat.multiply(quat.create(), qx90, atQ);
        expect(Math.abs(quat.dot(displayedTarget, displayedSource))).toBeCloseTo(1, 5);
    });
});

describe('retargetAnimation — identities', () => {
    // The clip must come back unchanged when the rig is its own.
    it('reproduces the clip on an identical rig', () => {
        const s = skinOf(rig(''));
        const clip = clipOf('a', [{ node: 4, rot: qy(37) }]);
        const m = buildBoneMapping([clip], s, s);
        const out = retargetAnimation(clip, s, s, m);
        const sampler = out.samplers[out.channels.find(c => c.targetNodeIndex === 4)!.samplerIndex];
        expect(Array.from(sampler.output)).toEqual(qy(37)); // raw copy, byte-identical
    });

    // Two differently-oriented rigs: feeding the SOURCE bind rotation must yield the TARGET bind rotation.
    // Both skins carry REAL inverse bind matrices (skinWithIBM) — the delta path only runs when a reliable
    // source bind exists; a source with no IBM is copied straight through instead (tested below).
    it('maps the source bind pose onto the target bind pose', () => {
        // Source forearm rests rotated 90° about Y vs the target's — different bind poses, same names.
        const source = rig('');
        source[4] = { name: 'LeftForeArm', parent: 3, t: [0.2, 0, 0], r: qy(90) as any };
        const target = rig('');
        const ss = skinWithIBM(source);
        const ts = skinWithIBM(target);

        // A clip that holds the SOURCE forearm at its own bind rotation (qy(90)).
        const clip = clipOf('a', [{ node: 4, rot: qy(90) }]);
        const m = buildBoneMapping([clip], ss, ts);
        expect(m.sameRig).toBe(false); // bind poses differ despite identical names
        const out = retargetAnimation(clip, ss, ts, m);
        const sampler = out.samplers[out.channels.find(c => c.targetNodeIndex === 4)!.samplerIndex];
        // Target forearm bind rotation is identity — so the retargeted keyframe must be identity too.
        const got = quat.normalize(quat.create(), quat.fromValues(sampler.output[0], sampler.output[1], sampler.output[2], sampler.output[3]));
        const idn = quat.create();
        expect(Math.abs(quat.dot(got, idn))).toBeCloseTo(1, 5);
    });

    // Pins the "no source bind -> raw" guard. NOTE the premise this fixture encodes — that a bind-less
    // source's node transforms are a mid-swing FRAME-0 pose — is NOT what assimp writes: tools/dump-rig.mjs
    // measured the authored TRS to equal the local bind on every joint of both real Mixamo files. The guard
    // is kept because a bind-less import is the same skeleton either way, not because a delta is unsound.
    // See the regime notes on boneCorrection before changing this.
    it('copies a limb straight through when the source has no bind (frame-0 node transforms)', () => {
        // Source: identity IBMs (animation-only), and the forearm's node transform is a swung frame-0 pose.
        const src = rig('');
        src[4] = { name: 'LeftForeArm', parent: 3, t: [0.2, 0, 0], r: qy(70) as any }; // frame-0, NOT bind
        const source = skinOf(src); // identity IBMs → no usable source bind
        const target = skinWithIBM(rig('')); // model has a real bind

        const clip = clipOf('a', [{ node: 4, rot: qy(30) }]);
        const m = buildBoneMapping([clip], source, target);
        const out = retargetAnimation(clip, source, target, m);
        const sampler = out.samplers[out.channels.find(c => c.targetNodeIndex === 4)!.samplerIndex];
        // The 70° frame-0 pose must NOT leak into the correction — the keyframe passes through as qy(30).
        expect(Array.from(sampler.output)).toEqual(qy(30));
    });
});

describe('retargetAnimation — translation handling', () => {
    const source = skinOf(rig(''));
    // Target hips rest twice as high → height ratio 2 on the hips.
    const tallTarget = (() => { const b = rig(''); b[0] = { name: 'Hips', parent: -1, t: [0, 2, 0] }; return skinOf(b); })();

    function hipsClip(): Animation {
        return {
            name: 'walk',
            samplers: [
                { input: [0], output: [0, 1.5, 0], interpolation: 'LINEAR' },   // hips translation
                { input: [0], output: [0.3, 0, 0], interpolation: 'LINEAR' },    // forearm translation (should be dropped)
            ],
            channels: [
                { samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' },
                { samplerIndex: 1, targetNodeIndex: 4, targetPath: 'translation' },
            ],
        };
    }

    it('scales the hips translation by the height ratio and drops other bone translations', () => {
        const clip = hipsClip();
        const m = buildBoneMapping([clip], source, tallTarget);
        const out = retargetAnimation(clip, source, tallTarget, m);

        // The forearm translation channel is gone.
        expect(out.channels.some(c => c.targetNodeIndex === 4 && c.targetPath === 'translation')).toBe(false);

        // The hips translation is re-based onto the target rest and its MOTION scaled by 2.
        const hipsCh = out.channels.find(c => c.targetNodeIndex === 0 && c.targetPath === 'translation')!;
        const out0 = out.samplers[hipsCh.samplerIndex].output;
        // source rest y = 1, motion = 1.5 - 1 = 0.5; ×2 = 1.0; + target rest y 2 = 3.0
        expect(out0[1]).toBeCloseTo(3.0, 5);
    });

    it('drops scale channels entirely', () => {
        // The clip must animate the bone that DIFFERS (the hips) for the rig to read as cross-rig — sameRig
        // is judged over the animated set, and a clip touching only identical bones is legitimately same-rig
        // (a raw copy is exact for it). On the delta path a scale channel is dropped; on a raw copy it would
        // be kept, which is correct — the drop is a cross-rig behaviour.
        const clip: Animation = {
            name: 's',
            samplers: [
                { input: [0], output: [0, 1, 0], interpolation: 'LINEAR' },   // hips translation (differs)
                { input: [0], output: [2, 2, 2], interpolation: 'LINEAR' },   // forearm scale
            ],
            channels: [
                { samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' },
                { samplerIndex: 1, targetNodeIndex: 4, targetPath: 'scale' },
            ],
        };
        const m = buildBoneMapping([clip], source, tallTarget);
        expect(m.sameRig).toBe(false);
        const out = retargetAnimation(clip, source, tallTarget, m);
        expect(out.channels.some(c => c.targetPath === 'scale')).toBe(false);
    });
});

describe('applyManualMapping + mappingReport', () => {
    const source = skinOf(rig(''));
    const target = skinOf(rig(''));

    it('re-points a bone and marks it manual, dropping the raw fast-path', () => {
        const clip = clipOf('a', [{ node: 4, rot: qy(10) }]);
        let m = buildBoneMapping([clip], source, target);
        expect(m.sameRig).toBe(true);
        m = applyManualMapping(m, 4, 2); // forearm → neck, deliberately wrong
        expect(m.sameRig).toBe(false);
        const e = m.entries.find(x => x.sourceNode === 4)!;
        expect(e.targetNode).toBe(2);
        expect(e.kind).toBe('manual');
    });

    it('unmapping a bone removes it from the retarget and the report', () => {
        const clip = clipOf('a', [{ node: 4, rot: qy(10) }]);
        let m = buildBoneMapping([clip], source, target);
        m = applyManualMapping(m, 4, null);
        expect(mappingReport(clip, source, target, m).matchedBones).toBe(0);
        const out = retargetAnimation(clip, source, target, m);
        expect(out.channels.length).toBe(0); // nothing driven
    });

    it('reports matched/missing counts', () => {
        const clip = clipOf('a', [{ node: 3, rot: qy(10) }, { node: 4, rot: qy(20) }]);
        const m = buildBoneMapping([clip], source, target);
        const r = mappingReport(clip, source, target, m);
        expect(r.matchedBones).toBe(2);
        expect(r.animatedBones).toBe(2);
        expect(r.compatible).toBe(true);
    });
});

// ---------------------------------------------------------------------------------------------------
// Pivot rigs.
//
// Every fixture above is bone-parented-to-bone, which is exactly why this file passed while a converted
// FBX was badly broken. Assimp's importer preserves FBX pivots, so a real Mixamo rig has a
// `Bone_$AssimpFbx$_Rotation` node between every pair of bones, and the bone's ROTATION CURVE targets
// that pivot rather than the bone.
//
// The one-level `joints.find(j => j.nodeIndex === joint.parentIndex)` this file's subject used made
// every bone report as a root, so each got the armature-difference correction — an accumulated world
// delta applied as if it were local, growing with depth. Arms and hips-to-toes were the visible failures.
// ---------------------------------------------------------------------------------------------------

/**
 * The same humanoid, with a non-joint pivot inserted above every non-root bone. Pivots are real glTF
 * nodes (named, parented, with a rest transform) but are NOT in `joints`.
 */
function pivotRig(prefix: string) { return pivotRigOf(rig(prefix)); }

/**
 * `pivotRest` gives every pivot a non-identity rest rotation, and `identityIBMs` reproduces a SKINLESS
 * source (Mixamo "Without Skin"): gltfLoader synthesizes joints from the animated nodes with identity
 * inverse bind matrices, and the node transforms are the clip's frame 0 rather than any rest pose.
 *
 * Both matter. With identity pivot rests on both sides — which is what this fixture used to do — a
 * correction of `targetRest x sourceRest^-1` is trivially identity, so the tests passed no matter what
 * boneCorrection computed.
 */
function pivotRigOf(
    bones: BoneSpec[],
    opts: { pivotRest?: [number, number, number, number]; identityIBMs?: boolean } = {},
): { skin: Skin; boneNode: number[]; pivotNode: (number | null)[] } {
    const nodeNames = new Map<number, string>();
    const nodeParents = new Map<number, number>();
    const nodeTransforms = new Map<number, mat4>();
    const boneNode: number[] = [];
    const pivotNode: (number | null)[] = [];
    const worldBind: mat4[] = [];
    let next = 0;

    bones.forEach((b, i) => {
        let parentNode: number | undefined;
        if (b.parent >= 0) {
            // The pivot carries no rotation of its own here; its job is to break the parent link.
            const pivot = next++;
            nodeNames.set(pivot, `${b.name}_$AssimpFbx$_Rotation`);
            nodeParents.set(pivot, boneNode[b.parent]);
            nodeTransforms.set(pivot, mat4.fromQuat(mat4.create(), (opts.pivotRest ?? [0, 0, 0, 1]) as any));
            pivotNode.push(pivot);
            parentNode = pivot;
        } else {
            pivotNode.push(null);
        }
        const node = next++;
        boneNode.push(node);
        nodeNames.set(node, b.name);
        if (parentNode !== undefined) nodeParents.set(node, parentNode);
        const local = mat4.fromRotationTranslation(mat4.create(), (b.r ?? [0, 0, 0, 1]) as any, (b.t ?? [0, 0, 0]) as any);
        nodeTransforms.set(node, local);
        worldBind[i] = b.parent >= 0 ? mat4.multiply(mat4.create(), worldBind[b.parent], local) : local;
    });

    const joints = bones.map((b, i) => ({
        nodeIndex: boneNode[i],
        inverseBindMatrix: opts.identityIBMs ? mat4.create() : mat4.invert(mat4.create(), worldBind[i])!,
        parentIndex: nodeParents.get(boneNode[i]),   // the PIVOT, as assimp leaves it
    }));
    return { skin: { joints, nodeNames, nodeParents, nodeTransforms }, boneNode, pivotNode };
}

describe('retarget across an assimp pivot rig', () => {
    it('keeps a rest difference LOCAL to the bone it belongs to', () => {
        // The discriminating case for isRootJoint. Two pivot rigs differing ONLY in the spine's rest
        // rotation; the forearm's own rest is identical in both, so its correction must be identity.
        //
        // While every bone reported as a root, boneCorrection took the armature branch for the forearm
        // too — an accumulated world delta that picks up the spine's difference and every other ancestor's,
        // growing with depth. That is precisely what twisted the arms and the hips-to-toes chain.
        const twisted = (prefix: string) => {
            const bones = rig(prefix);
            bones[1] = { ...bones[1], r: qy(35) as any };   // spine only
            return bones;
        };
        const a = pivotRigOf(rig('mixamorig:'));
        const b = pivotRigOf(twisted('mixamorig:'));

        const clip = clipOf('a', [{ node: a.boneNode[4], rot: qy(20) }]);
        const m = buildBoneMapping([clip], a.skin, b.skin);
        const out = retargetAnimation(clip, a.skin, b.skin, m);

        // The forearm's rotation passes through untouched: its own rest matches, the spine's does not.
        for (let i = 0; i < 4; i++) expect(out.samplers[0].output[i]).toBeCloseTo(qy(20)[i], 4);
    });

    it('maps a channel that targets a PIVOT node, not the bone', () => {
        // This is what a real converted FBX clip looks like: the curve is on the pivot.
        const { skin, pivotNode } = pivotRig('mixamorig:');
        const m = buildBoneMapping([clipOf('a', [{ node: pivotNode[4]!, rot: qy(30) }])], skin, skin);

        const entry = m.entries.find(e => e.sourceNode === pivotNode[4]);
        expect(entry?.targetNode).toBe(pivotNode[4]);  // matched to the target's identical pivot
        expect(entry?.kind).toBe('exact');
        expect(m.sameRig).toBe(true);                  // ...so the verbatim copy path is reachable
    });

    it('copies a pivot-targeted clip through unchanged on an identical rig', () => {
        const { skin, pivotNode } = pivotRig('mixamorig:');
        const rot = qy(41);
        const clip = clipOf('a', [{ node: pivotNode[4]!, rot }]);
        const m = buildBoneMapping([clip], skin, skin);
        const out = retargetAnimation(clip, skin, skin, m);

        expect(out.channels).toHaveLength(1);
        expect(out.channels[0].targetNodeIndex).toBe(pivotNode[4]);
        for (let i = 0; i < 4; i++) expect(out.samplers[0].output[i]).toBeCloseTo(rot[i], 5);
    });

    it('retargets between two pivot rigs under different namespaces', () => {
        // `mixamorig:` vs `mixamorig1:` is the same skeleton renamed — the normalized tier must still
        // pair the bones, and the corrections must stay identity rather than accumulating down the arm.
        const a = pivotRig('mixamorig:');
        const b = pivotRig('mixamorig1:');
        const clip = clipOf('a', [{ node: a.boneNode[4], rot: qy(33) }]);
        const m = buildBoneMapping([clip], a.skin, b.skin);

        const entry = m.entries.find(e => e.sourceNode === a.boneNode[4]);
        expect(entry?.targetNode).toBe(b.boneNode[4]);
        const out = retargetAnimation(clip, a.skin, b.skin, m);
        for (let i = 0; i < 4; i++) expect(out.samplers[0].output[i]).toBeCloseTo(qy(33)[i], 4);
    });
});

/**
 * The reported bug, reduced.
 *
 * A Mixamo "Without Skin" clip has NO skin, so gltfLoader synthesizes its joints from the animated nodes
 * with identity inverse bind matrices, and those animated nodes are the `$AssimpFbx$` pivots. The
 * long-standing rule for that case is stated in boneCorrection: a source with no usable bind is copied
 * straight through, because its node transforms are the clip FRAME 0, not a rest pose, and deltaing
 * against them "mis-rotates exactly the limbs that move most".
 *
 * A correction branch that keys only on the TARGET being a non-joint bypasses that rule for 100% of such
 * a clip, and deltas the character file's bind against the animation file's frame-0 value — two unrelated
 * quantities. Playing Mixamo's own T-Pose clip, which should be a visual no-op, then twists every limb.
 */
describe('retarget from a SKINLESS animation source (Mixamo "Without Skin")', () => {
    // Distinct pivot rests: the character file's bind vs the animation file's frame-0. Any correction
    // derived from these two disagrees with itself, which is the whole point.
    const target = () => pivotRigOf(rig('mixamorig:'), { pivotRest: qy(15) as any });
    const source = () => pivotRigOf(rig('mixamorig:'), { pivotRest: qy(-40) as any, identityIBMs: true });

    it('copies a pivot channel through untouched', () => {
        const t = target(), s = source();
        const rot = qy(28);
        const clip = clipOf('a', [{ node: s.pivotNode[4]!, rot }]);
        const m = buildBoneMapping([clip], s.skin, t.skin);
        const out = retargetAnimation(clip, s.skin, t.skin, m);

        expect(out.channels[0].targetNodeIndex).toBe(t.pivotNode[4]);
        for (let i = 0; i < 4; i++) expect(out.samplers[0].output[i]).toBeCloseTo(rot[i], 5);
    });

    it('leaves a T-pose clip a visual no-op on every bone', () => {
        // The clip holds each pivot at the SOURCE file's own value. Nothing may be layered on top of it.
        const t = target(), s = source();
        const rest = qy(-40);
        const clip = clipOf('tpose', [1, 2, 3, 4].map(i => ({ node: s.pivotNode[i]!, rot: rest })));
        const m = buildBoneMapping([clip], s.skin, t.skin);
        const out = retargetAnimation(clip, s.skin, t.skin, m);

        for (const sampler of out.samplers)
            for (let i = 0; i < 4; i++) expect(sampler.output[i]).toBeCloseTo(rest[i], 5);
    });

    it('reports every correction as identity, so the clip stays on the verbatim path', () => {
        const t = target(), s = source();
        const clip = clipOf('a', [{ node: s.pivotNode[4]!, rot: qy(28) }]);
        const m = buildBoneMapping([clip], s.skin, t.skin);
        expect(m.entries.every(e => e.targetNode !== null)).toBe(true);
        expect(m.sameRig).toBe(true);
    });
});

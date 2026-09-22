import { describe, it, expect, beforeEach } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import {
    applyClipEdits, mirrorClip, bakeInPlace, applyPoseOffset, trimClip, timeScaleClip,
    mirrorPairs, mirrorAxisOf, rootMotionNodeOf, clipDuration, resetClipEditWarnings,
    type ClipEdit,
} from '../src/animation/clipEdit';
import type { Animation, Skin } from '../src/animation/animatedModel';

// The clip edit stack is applied on EVERY resolve, in the editor and in the published game, and its
// output is what the artist sees rather than anything they typed. So the properties worth pinning are the
// ones that fail silently: a mirror that is subtly wrong looks like a bad source clip, and an in-place
// bake that leaves residual travel only shows up as drift after a hundred loops.

type BoneSpec = { name: string; parent: number; t?: [number, number, number]; r?: number[] };

/** A Skin from a flat bone list; node index == array index. Identity IBMs, so bind comes from nodeTransforms. */
function skinOf(bones: BoneSpec[]): Skin {
    const nodeNames = new Map<number, string>();
    const nodeParents = new Map<number, number>();
    const nodeTransforms = new Map<number, mat4>();
    bones.forEach((b, i) => {
        nodeNames.set(i, b.name);
        if (b.parent >= 0) nodeParents.set(i, b.parent);
        nodeTransforms.set(i, mat4.fromRotationTranslation(mat4.create(), (b.r ?? [0, 0, 0, 1]) as any, (b.t ?? [0, 0, 0]) as any));
    });
    const joints = bones.map((b, i) => ({ nodeIndex: i, inverseBindMatrix: mat4.create(), parentIndex: b.parent >= 0 ? b.parent : undefined }));
    return { joints, nodeNames, nodeParents, nodeTransforms };
}

const qy = (deg: number) => Array.from(quat.setAxisAngle(quat.create(), [0, 1, 0], deg * Math.PI / 180));
const qz = (deg: number) => Array.from(quat.setAxisAngle(quat.create(), [0, 0, 1], deg * Math.PI / 180));

/** Quaternions compare up to double cover: q and -q are the same rotation. */
function expectQuat(got: number[], want: number[], digits = 5) {
    const a = quat.normalize(quat.create(), quat.fromValues(got[0], got[1], got[2], got[3]));
    const b = quat.normalize(quat.create(), quat.fromValues(want[0], want[1], want[2], want[3]));
    expect(Math.abs(quat.dot(a, b))).toBeCloseTo(1, digits);
}

function quatsDiffer(got: number[], want: number[]) {
    const a = quat.normalize(quat.create(), quat.fromValues(got[0], got[1], got[2], got[3]));
    const b = quat.normalize(quat.create(), quat.fromValues(want[0], want[1], want[2], want[3]));
    expect(Math.abs(quat.dot(a, b))).toBeLessThan(0.99);
}

/** A symmetric humanoid: hips/spine/neck plus mirrored arm chains. Every rest rotation is identity. */
const SYMMETRIC: BoneSpec[] = [
    { name: 'Hips', parent: -1, t: [0, 1, 0] },
    { name: 'Spine', parent: 0, t: [0, 0.2, 0] },
    { name: 'Neck', parent: 1, t: [0, 0.2, 0] },
    { name: 'LeftArm', parent: 1, t: [0.2, 0, 0] },
    { name: 'LeftForeArm', parent: 3, t: [0.3, 0, 0] },
    { name: 'RightArm', parent: 1, t: [-0.2, 0, 0] },
    { name: 'RightForeArm', parent: 5, t: [-0.3, 0, 0] },
];

const NODE = { hips: 0, spine: 1, neck: 2, lArm: 3, lForeArm: 4, rArm: 5, rForeArm: 6 };

/** One channel per entry; times default to a single key at t=0. */
function clipOf(name: string, chans: { node: number; path: 'rotation' | 'translation' | 'scale'; input?: number[]; output: number[] }[]): Animation {
    return {
        name,
        samplers: chans.map(c => ({ input: c.input ?? [0], output: c.output.slice(), interpolation: 'LINEAR' as const })),
        channels: chans.map((c, i) => ({ samplerIndex: i, targetNodeIndex: c.node, targetPath: c.path })),
    };
}

const outputFor = (clip: Animation, node: number, path: string): number[] => {
    const ch = clip.channels.find(c => c.targetNodeIndex === node && c.targetPath === path);
    expect(ch, `no ${path} channel for node ${node}`).toBeTruthy();
    return clip.samplers[ch!.samplerIndex].output;
};

beforeEach(() => resetClipEditWarnings());

describe('mirrorPairs / mirrorAxisOf', () => {
    it('pairs sided bones through the humanoid dictionary and centres onto themselves', () => {
        const pairs = mirrorPairs(skinOf(SYMMETRIC));
        expect(pairs.get(NODE.lArm)).toBe(NODE.rArm);
        expect(pairs.get(NODE.rArm)).toBe(NODE.lArm);
        expect(pairs.get(NODE.lForeArm)).toBe(NODE.rForeArm);
        // A centre bone mirrors in place — it has no partner, and dropping it would drop the whole spine.
        expect(pairs.get(NODE.hips)).toBe(NODE.hips);
        expect(pairs.get(NODE.spine)).toBe(NODE.spine);
    });

    it('pairs bones the humanoid dictionary does not know, by swapping the name side token', () => {
        // Twist/roll bones are the common case: no humanoid slot, but unmistakably sided.
        const skin = skinOf([...SYMMETRIC,
            { name: 'LeftArmTwist01', parent: NODE.lArm },
            { name: 'RightArmTwist01', parent: NODE.rArm },
        ]);
        const pairs = mirrorPairs(skin);
        expect(pairs.get(7)).toBe(8);
        expect(pairs.get(8)).toBe(7);
    });

    it('leaves a sided bone with no partner UNMAPPED rather than mapping it to itself', () => {
        // Self-mirroring a sided bone reflects a left-arm curve back onto the left arm: a plausible pose
        // that is simply wrong. No entry means the channel is dropped, which is visibly wrong and reported.
        const pairs = mirrorPairs(skinOf([...SYMMETRIC, { name: 'LeftPropHolder', parent: NODE.lArm }]));
        expect(pairs.has(7)).toBe(false);
    });

    it('measures the left/right axis from the rig instead of assuming X', () => {
        expect(mirrorAxisOf(skinOf(SYMMETRIC))).toBe('x');
        // The same skeleton laid out along Z: the arms differ in Z, so Z is the mirror normal. A hardcoded
        // X would mirror this rig about its depth axis and produce nonsense that still looks like motion.
        const alongZ = SYMMETRIC.map(b => ({ ...b, t: b.t ? [b.t[2], b.t[1], b.t[0]] as [number, number, number] : undefined }));
        expect(mirrorAxisOf(skinOf(alongZ))).toBe('z');
    });
});

describe('mirrorClip', () => {
    it('moves a left-arm curve onto the right arm and negates the reflected components', () => {
        const skin = skinOf(SYMMETRIC);
        const out = mirrorClip(clipOf('wave', [{ node: NODE.lArm, path: 'rotation', output: qz(30) }]), skin, 'x');
        // Every rest rotation here is identity, so the robust sandwich collapses to plain reflection:
        // a +30 degree roll on the left arm is a -30 degree roll on the right.
        expectQuat(outputFor(out, NODE.rArm, 'rotation'), qz(-30));
        // ...and the left arm is no longer driven. Mirroring MOVES a curve; it does not duplicate it.
        expect(out.channels.some(c => c.targetNodeIndex === NODE.lArm)).toBe(false);
    });

    it('reflects a translation WITHOUT negating it', () => {
        // The asymmetry between rotation (reflect AND negate) and translation (reflect only) is the classic
        // mirror bug: get it wrong and the hips slide the wrong way while the pelvis rotation looks right.
        const skin = skinOf(SYMMETRIC);
        const out = mirrorClip(clipOf('lean', [{ node: NODE.hips, path: 'translation', output: [0.5, 1.2, 0.1] }]), skin, 'x');
        const t = outputFor(out, NODE.hips, 'translation');
        expect(t[0]).toBeCloseTo(-0.5, 5); // reflected about the rest offset, which is x=0 for the hips
        expect(t[1]).toBeCloseTo(1.2, 5);  // untouched
        expect(t[2]).toBeCloseTo(0.1, 5);  // untouched
    });

    it('is its own inverse', () => {
        const skin = skinOf(SYMMETRIC);
        const clip = clipOf('wave', [
            { node: NODE.lArm, path: 'rotation', input: [0, 1], output: [...qz(30), ...qy(15)] },
            { node: NODE.hips, path: 'translation', output: [0.5, 1.2, 0.1] },
        ]);
        const back = mirrorClip(mirrorClip(clip, skin, 'x'), skin, 'x');
        expectQuat(outputFor(back, NODE.lArm, 'rotation').slice(0, 4), qz(30));
        expectQuat(outputFor(back, NODE.lArm, 'rotation').slice(4, 8), qy(15));
        const t = outputFor(back, NODE.hips, 'translation');
        expect([t[0], t[1], t[2]]).toEqual([expect.closeTo(0.5, 5), expect.closeTo(1.2, 5), expect.closeTo(0.1, 5)]);
    });

    // THE case the robust formula exists for. Most real rigs — Rigify, Unreal, hand-authored FBX — have
    // per-side bone roll, so the left and right rest orientations are NOT mirror images of one another.
    // Naive component negation copies the left curve onto the right as if they were, and the arm ends up
    // twisted by exactly the bind discrepancy. Re-seating the pose DELTA on the partner's own rest is what
    // makes it correct, and this rig is built so the two answers differ by a visible 40 degrees.
    describe('on a rig whose sides are not mirror images', () => {
        const ASYMMETRIC: BoneSpec[] = SYMMETRIC.map(b =>
            b.name === 'LeftArm' ? { ...b, r: qy(20) }
            : b.name === 'RightArm' ? { ...b, r: qy(20) }   // a true mirror would be qy(-20)
            : b);

        it('re-seats the pose on the partner bone\'s own rest', () => {
            const skin = skinOf(ASYMMETRIC);
            // A clip holding the left arm at ITS OWN rest: the pose delta is identity, so the mirrored
            // right arm must sit at ITS own rest — whatever that happens to be.
            const out = mirrorClip(clipOf('rest', [{ node: NODE.lArm, path: 'rotation', output: qy(20) }]), skin, 'x');
            const got = outputFor(out, NODE.rArm, 'rotation');
            expectQuat(got, qy(20));       // the right arm's own rest
            quatsDiffer(got, qy(-20));     // ...which is NOT what negating the components would have given
        });

        it('carries a real pose delta across unchanged in magnitude', () => {
            const skin = skinOf(ASYMMETRIC);
            // Left arm 30 degrees of roll away from its rest. The right arm must end up 30 degrees of roll
            // away from ITS rest, in the mirrored direction.
            const posed = quat.multiply(quat.create(), qz(30) as any, qy(20) as any);
            const out = mirrorClip(clipOf('roll', [{ node: NODE.lArm, path: 'rotation', output: Array.from(posed) }]), skin, 'x');
            const want = quat.multiply(quat.create(), qz(-30) as any, qy(20) as any);
            expectQuat(outputFor(out, NODE.rArm, 'rotation'), Array.from(want));
        });

        it('still round-trips', () => {
            const skin = skinOf(ASYMMETRIC);
            const clip = clipOf('roll', [{ node: NODE.lArm, path: 'rotation', output: qz(30) }]);
            expectQuat(outputFor(mirrorClip(mirrorClip(clip, skin, 'x'), skin, 'x'), NODE.lArm, 'rotation'), qz(30));
        });
    });

    it('drops a sided bone that has no partner, and keeps the rest of the clip', () => {
        const skin = skinOf([...SYMMETRIC, { name: 'LeftPropHolder', parent: NODE.lArm }]);
        const out = mirrorClip(clipOf('hold', [
            { node: NODE.lArm, path: 'rotation', output: qz(30) },
            { node: 7, path: 'rotation', output: qz(45) },
        ]), skin, 'x');
        expect(out.channels).toHaveLength(1);
        expect(out.channels[0].targetNodeIndex).toBe(NODE.rArm);
    });

    it('returns the clip untouched when the rig has no bone names to tell sides apart', () => {
        const skin = skinOf(SYMMETRIC);
        skin.nodeNames = new Map();
        const clip = clipOf('wave', [{ node: NODE.lArm, path: 'rotation', output: qz(30) }]);
        expect(mirrorClip(clip, skin, 'x')).toBe(clip);
    });
});

describe('bakeInPlace', () => {
    // A walk that travels 2m in +Z over 1s while bobbing 0.1m in Y.
    const walk = () => clipOf('walk', [{
        node: NODE.hips, path: 'translation', input: [0, 0.5, 1],
        output: [0, 1, 0, /**/ 0, 1.1, 1, /**/ 0, 1, 2],
    }]);

    it('finds the root bone the runtime would have driven', () => {
        // The highest joint the clip animates — the same rule Animator._findRootMotionBone applies. If the
        // two ever disagreed, the bake would leave travel the editor preview cannot show.
        expect(rootMotionNodeOf(walk(), skinOf(SYMMETRIC))).toBe(NODE.hips);
        // A clip that drives only an arm has its own root: nothing above it is animated.
        expect(rootMotionNodeOf(clipOf('wave', [{ node: NODE.lForeArm, path: 'rotation', output: qz(10) }]), skinOf(SYMMETRIC)))
            .toBe(NODE.lForeArm);
    });

    it('removes horizontal travel while keeping the vertical bob', () => {
        const out = bakeInPlace(walk(), skinOf(SYMMETRIC));
        const t = outputFor(out, NODE.hips, 'translation');
        expect(t[2]).toBeCloseTo(0, 6);   // key 0 Z
        expect(t[5]).toBeCloseTo(0, 6);   // key 1 Z — the 1m of travel is gone
        expect(t[8]).toBeCloseTo(0, 6);   // key 2 Z — and so are the 2m
        expect(t[1]).toBeCloseTo(1, 6);   // ...but the bob survives, which is what keeps a jump an arc
        expect(t[4]).toBeCloseTo(1.1, 6);
        expect(t[7]).toBeCloseTo(1, 6);
    });

    it('leaves the clip looping: the last key lands back on the first', () => {
        const t = outputFor(bakeInPlace(walk(), skinOf(SYMMETRIC)), NODE.hips, 'translation');
        expect([t[6], t[7], t[8]]).toEqual([expect.closeTo(t[0], 6), expect.closeTo(t[1], 6), expect.closeTo(t[2], 6)]);
    });

    it("strip:'all' also removes the vertical, and strip:'y' removes only it", () => {
        const all = outputFor(bakeInPlace(walk(), skinOf(SYMMETRIC), { strip: 'all' }), NODE.hips, 'translation');
        expect([all[3], all[4], all[5]]).toEqual([expect.closeTo(0, 6), expect.closeTo(1, 6), expect.closeTo(0, 6)]);
        const y = outputFor(bakeInPlace(walk(), skinOf(SYMMETRIC), { strip: 'y' }), NODE.hips, 'translation');
        expect(y[4]).toBeCloseTo(1, 6);   // vertical flattened to the reference
        expect(y[5]).toBeCloseTo(1, 6);   // horizontal kept
    });

    it('removes the yaw a turn accumulates, and keeps it when asked', () => {
        const turn = clipOf('turn', [{ node: NODE.hips, path: 'rotation', input: [0, 1], output: [...qy(0), ...qy(90)] }]);
        const stripped = outputFor(bakeInPlace(turn, skinOf(SYMMETRIC)), NODE.hips, 'rotation');
        expectQuat(stripped.slice(4, 8), qy(0));      // the 90 degrees of turn is gone
        const kept = outputFor(bakeInPlace(turn, skinOf(SYMMETRIC), { keepYaw: true }), NODE.hips, 'rotation');
        expectQuat(kept.slice(4, 8), qy(90));
    });

    it('keeps a lean, which is not yaw', () => {
        // Swing/twist, not "zero the rotation": a character that leans into a turn must keep leaning.
        const lean = clipOf('lean', [{ node: NODE.hips, path: 'rotation', input: [0, 1], output: [...qy(0), ...qz(20)] }]);
        expectQuat(outputFor(bakeInPlace(lean, skinOf(SYMMETRIC)), NODE.hips, 'rotation').slice(4, 8), qz(20));
    });

    it('clears rootMotion — the two are the same decision made opposite ways', () => {
        const clip: Animation = { ...walk(), rootMotion: true };
        expect(bakeInPlace(clip, skinOf(SYMMETRIC)).rootMotion).toBeUndefined();
    });

    it('returns the clip untouched when it animates no joint of the rig', () => {
        const clip = clipOf('none', [{ node: 99, path: 'rotation', output: qz(10) }]);
        expect(bakeInPlace(clip, skinOf(SYMMETRIC))).toBe(clip);
    });
});

describe('applyPoseOffset', () => {
    const pose = [{ name: 'LeftArm', rotation: qz(10) }];

    it('LEFT-multiplies onto a bone the clip already drives', () => {
        // Parent-frame, so "hold the arm out" stays fixed relative to the shoulder while the swing rides on
        // top. Right-multiplying would express it in the bone's own animated frame and read as a twist.
        const out = applyPoseOffset(clipOf('walk', [{ node: NODE.lArm, path: 'rotation', output: qy(20) }]), skinOf(SYMMETRIC), pose);
        expectQuat(outputFor(out, NODE.lArm, 'rotation'), Array.from(quat.multiply(quat.create(), qz(10) as any, qy(20) as any)));
    });

    it('adds a TWO-key channel for a bone the clip never drove', () => {
        // Two keys, never one: Bone._getRotationIndex returns length-2, which is -1 for a single-key
        // sampler, and a negative index reads undefined out of `output` and poses the bone with NaNs.
        const clip = clipOf('walk', [{ node: NODE.hips, path: 'translation', input: [0, 1], output: [0, 1, 0, 0, 1, 0] }]);
        const out = applyPoseOffset(clip, skinOf(SYMMETRIC), pose);
        const ch = out.channels.find(c => c.targetNodeIndex === NODE.lArm && c.targetPath === 'rotation');
        expect(ch).toBeTruthy();
        const sampler = out.samplers[ch!.samplerIndex];
        expect(sampler.input).toEqual([0, 1]);            // spans the clip
        expect(sampler.output).toHaveLength(8);
        expectQuat(sampler.output.slice(0, 4), qz(10));   // the offset on the bone's identity rest
        expect(sampler.output.slice(0, 4)).toEqual(sampler.output.slice(4, 8)); // held, not ramped
    });

    it('scales by weight along the arc, not by scaling components', () => {
        // Scaling xyzw would de-normalize the quaternion and shear the bone; slerp from identity does not.
        const out = applyPoseOffset(clipOf('a', [{ node: NODE.lArm, path: 'rotation', output: qy(0) }]), skinOf(SYMMETRIC), pose, { weight: 0.5 });
        expectQuat(outputFor(out, NODE.lArm, 'rotation'), qz(5));
    });

    it('applies nothing at weight 0, returning the very same clip', () => {
        const clip = clipOf('a', [{ node: NODE.lArm, path: 'rotation', output: qy(20) }]);
        expect(applyPoseOffset(clip, skinOf(SYMMETRIC), pose, { weight: 0 })).toBe(clip);
    });

    it('a mask selects a bone and everything under it', () => {
        const skin = skinOf(SYMMETRIC);
        const wide = [{ name: 'LeftArm', rotation: qz(10) }, { name: 'LeftForeArm', rotation: qz(10) }, { name: 'Neck', rotation: qz(10) }];
        const clip = clipOf('a', [{ node: NODE.hips, path: 'translation', output: [0, 1, 0] }]);
        const out = applyPoseOffset(clip, skin, wide, { mask: ['LeftArm'] });
        // 'LeftArm' names the arm AND the forearm below it — posing a limb, not one bone.
        expect(out.channels.some(c => c.targetNodeIndex === NODE.lArm)).toBe(true);
        expect(out.channels.some(c => c.targetNodeIndex === NODE.lForeArm)).toBe(true);
        expect(out.channels.some(c => c.targetNodeIndex === NODE.neck)).toBe(false);
    });

    it('resolves a bone by humanoid slot as well as by name', () => {
        const out = applyPoseOffset(clipOf('a', [{ node: NODE.hips, path: 'translation', output: [0, 1, 0] }]),
            skinOf(SYMMETRIC), [{ name: 'upperArm.R', rotation: qz(10) }]);
        expect(out.channels.some(c => c.targetNodeIndex === NODE.rArm)).toBe(true);
    });

    it('skips a bone the rig does not have, keeping the rest', () => {
        const clip = clipOf('a', [{ node: NODE.lArm, path: 'rotation', output: qy(20) }]);
        const out = applyPoseOffset(clip, skinOf(SYMMETRIC), [{ name: 'Tail', rotation: qz(10) }, ...pose]);
        expectQuat(outputFor(out, NODE.lArm, 'rotation'), Array.from(quat.multiply(quat.create(), qz(10) as any, qy(20) as any)));
    });
});

describe('trimClip', () => {
    const ramp = () => clipOf('ramp', [{ node: NODE.hips, path: 'translation', input: [0, 0.5, 1], output: [0, 0, 0, 10, 0, 0, 20, 0, 0] }]);

    it('inserts boundary keys by sampling, so the trim does not snap to a neighbouring key', () => {
        const out = trimClip(ramp(), 0.25, 0.75);
        const s = out.samplers[out.channels[0].samplerIndex];
        expect(s.input).toEqual([0, 0.25, 0.5]);              // rebased to zero
        expect(s.output[0]).toBeCloseTo(5, 5);                // sampled at 0.25, not snapped back to 0
        expect(s.output[3]).toBeCloseTo(10, 5);               // the original middle key
        expect(s.output[6]).toBeCloseTo(15, 5);               // sampled at 0.75, not snapped on to 20
    });

    it('keeps the original times when rebase is off', () => {
        expect(trimClip(ramp(), 0.25, 0.75, false).samplers[0].input).toEqual([0.25, 0.5, 0.75]);
    });

    it('refuses an empty range rather than producing a zero-length clip', () => {
        const clip = ramp();
        expect(trimClip(clip, 0.5, 0.5)).toBe(clip);
    });

    it('clamps a range that runs past the end of the clip', () => {
        expect(clipDuration(trimClip(ramp(), 0.5, 99))).toBeCloseTo(0.5, 6);
    });
});

describe('timeScaleClip', () => {
    it('moves the times and leaves the values alone, so root-motion speed scales with it', () => {
        const clip = clipOf('a', [{ node: NODE.hips, path: 'translation', input: [0, 1], output: [0, 0, 0, 0, 0, 2] }]);
        const out = timeScaleClip(clip, 2);
        expect(out.samplers[0].input).toEqual([0, 2]);
        expect(out.samplers[0].output).toEqual([0, 0, 0, 0, 0, 2]);
    });

    it('is the same object at scale 1', () => {
        const clip = clipOf('a', [{ node: NODE.hips, path: 'translation', output: [0, 0, 0] }]);
        expect(timeScaleClip(clip, 1)).toBe(clip);
    });
});

describe('applyClipEdits', () => {
    const ctx = () => ({ skin: skinOf(SYMMETRIC) });
    const clip = () => clipOf('walk', [{ node: NODE.lArm, path: 'rotation', input: [0, 2], output: [...qz(0), ...qz(30)] }]);

    it('returns the SAME OBJECT when there is nothing to do', () => {
        // Object identity is what the resolve cache and Animator._fieldClip compare on. Rebuilding an
        // unedited clip would silently invalidate both for every clip in every existing project.
        const c = clip();
        expect(applyClipEdits(c, undefined, ctx())).toBe(c);
        expect(applyClipEdits(c, [], ctx())).toBe(c);
        expect(applyClipEdits(c, [{ kind: 'mirror', enabled: false }], ctx())).toBe(c);
    });

    it('applies edits in canonical order, not array order', () => {
        // Trim then scale on a 2s clip gives 2s; scale then trim gives 1s. The artist reorders this list
        // freely, so a result that depended on the order would change when nothing about it changed.
        const edits: ClipEdit[] = [{ kind: 'timeScale', scale: 2 }, { kind: 'trim', start: 0, end: 1 }];
        expect(clipDuration(applyClipEdits(clip(), edits, ctx()))).toBeCloseTo(2, 6);
        expect(clipDuration(applyClipEdits(clip(), [...edits].reverse(), ctx()))).toBeCloseTo(2, 6);
    });

    it('mirrors before offsetting a pose, so a right-arm pose lands on the right arm', () => {
        const edits: ClipEdit[] = [
            { kind: 'poseOffset', bones: [{ name: 'RightArm', rotation: qz(10) }] },
            { kind: 'mirror', axis: 'x' },
        ];
        const out = applyClipEdits(clip(), edits, ctx());
        // The clip's left-arm curve mirrors onto the right arm FIRST, and the pose then lands on top of it.
        const got = outputFor(out, NODE.rArm, 'rotation');
        expectQuat(got.slice(0, 4), qz(10));
        expectQuat(got.slice(4, 8), Array.from(quat.multiply(quat.create(), qz(10) as any, qz(-30) as any)));
    });

    it('resolves a shared pose by id, and lets inline bones override it per bone', () => {
        const poses = new Map([['torch', [{ name: 'LeftArm', rotation: qz(10) }, { name: 'Neck', rotation: qz(4) }]]]);
        const out = applyClipEdits(clip(), [{ kind: 'poseOffset', poseId: 'torch', bones: [{ name: 'LeftArm', rotation: qz(90) }] }],
            { skin: skinOf(SYMMETRIC), poses });
        expectQuat(outputFor(out, NODE.lArm, 'rotation').slice(0, 4), qz(90));  // inline wins
        expectQuat(outputFor(out, NODE.neck, 'rotation').slice(0, 4), qz(4));   // ...only for that bone
    });

    it('skips a poseOffset whose shared pose no longer exists, without dropping the clip', () => {
        const out = applyClipEdits(clip(), [{ kind: 'poseOffset', poseId: 'gone' }], ctx());
        expectQuat(outputFor(out, NODE.lArm, 'rotation').slice(4, 8), qz(30));
    });

    it('accepts a target duration as well as a scale', () => {
        expect(clipDuration(applyClipEdits(clip(), [{ kind: 'timeScale', duration: 5 }], ctx()))).toBeCloseTo(5, 6);
    });

    it('never mutates the clip it was given', () => {
        // Sampler `output` arrays are shared with the resolve cache and with every retargeted copy, so one
        // in-place write would corrupt every cached resolve of the asset — and show up on ANOTHER character.
        const c = clip();
        const before = JSON.parse(JSON.stringify(c));
        applyClipEdits(c, [
            { kind: 'mirror', axis: 'x' },
            { kind: 'poseOffset', bones: [{ name: 'RightArm', rotation: qz(10) }] },
            { kind: 'inPlace' },
            { kind: 'trim', start: 0, end: 1 },
            { kind: 'timeScale', scale: 2 },
        ], ctx());
        expect(JSON.parse(JSON.stringify(c))).toEqual(before);
    });

    it('gives an edited clip exactly one sampler per channel', () => {
        // glTF lets two channels share a sampler and the loader copies the indices verbatim; editing one
        // in place would silently change a curve the artist was not looking at.
        const shared: Animation = {
            name: 'shared',
            samplers: [{ input: [0], output: qz(30), interpolation: 'LINEAR' }],
            channels: [
                { samplerIndex: 0, targetNodeIndex: NODE.lArm, targetPath: 'rotation' },
                { samplerIndex: 0, targetNodeIndex: NODE.lForeArm, targetPath: 'rotation' },
            ],
        };
        const out = applyClipEdits(shared, [{ kind: 'mirror', axis: 'x' }], ctx());
        expect(new Set(out.channels.map(c => c.samplerIndex)).size).toBe(out.channels.length);
    });
});

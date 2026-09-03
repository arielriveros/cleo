import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import type { IkRig } from '../src/animation/ik';

// Foot IK inside the Animator: the ground query, the pelvis drop, and the leg solve wired to a real skeleton.
// solveTwoBone is covered on its own in ik.test.ts; what is tested here is everything around it — which is
// where a foot ends up in the wrong space, or IK fires when it should not.
//
// A real AnimatedModel builds a GPU Mesh in its constructor, so this uses the same duck-typed stand-in the
// field tests do. Physics is stubbed to a plane at a chosen height, which is enough for every claim below and
// keeps the test independent of cannon.

// A leg hanging down +Y: hips at y=2, thigh at 2, knee at 1, ankle at 0, toe at 0 (offset +Z).
const HIPS = 0, THIGH = 1, SHIN = 2, FOOT = 3, TOE = 4;
// A second, identical leg, offset in X. APPENDED rather than interleaved, so joint index still equals node
// index and every existing single-leg test reads the same matrices it always did.
const THIGH_R = 5, SHIN_R = 6, FOOT_R = 7, TOE_R = 8;

function boneMatrix(x: number, y: number, z: number): mat4 {
    return mat4.fromTranslation(mat4.create(), [x, y, z]);
}

/** A skeleton whose joints are declared in LOCAL space, parented in a chain. */
function makeSkin(rig?: IkRig): Skin {
    // local offsets: hips at (0,2,0); thigh 0 below hips; knee 1 below thigh; ankle 1 below knee; toe forward.
    const locals: Record<number, mat4> = {
        [HIPS]: boneMatrix(0, 2, 0),
        [THIGH]: boneMatrix(0, 0, 0),
        [SHIN]: boneMatrix(0, -1, 0),
        [FOOT]: boneMatrix(0, -1, 0),
        [TOE]: boneMatrix(0, 0, 0.2),
        // Same geometry, offset in X, so the two ankles rest at exactly the same height and any difference
        // between them in a test is the thing the test is about.
        [THIGH_R]: boneMatrix(0.2, 0, 0),
        [SHIN_R]: boneMatrix(0, -1, 0),
        [FOOT_R]: boneMatrix(0, -1, 0),
        [TOE_R]: boneMatrix(0, 0, 0.2),
    };
    const parents: Record<number, number | undefined> = {
        [HIPS]: undefined, [THIGH]: HIPS, [SHIN]: THIGH, [FOOT]: SHIN, [TOE]: FOOT,
        [THIGH_R]: HIPS, [SHIN_R]: THIGH_R, [FOOT_R]: SHIN_R, [TOE_R]: FOOT_R,
    };
    return {
        joints: [HIPS, THIGH, SHIN, FOOT, TOE, THIGH_R, SHIN_R, FOOT_R, TOE_R].map(n => ({
            nodeIndex: n, inverseBindMatrix: mat4.create(), parentIndex: parents[n],
        })),
        nodeTransforms: new Map(Object.entries(locals).map(([k, v]) => [Number(k), v])),
        nodeNames: new Map([
            [HIPS, 'Hips'], [THIGH, 'LeftUpLeg'], [SHIN, 'LeftLeg'], [FOOT, 'LeftFoot'], [TOE, 'LeftToeBase'],
            [THIGH_R, 'RightUpLeg'], [SHIN_R, 'RightLeg'], [FOOT_R, 'RightFoot'], [TOE_R, 'RightToeBase'],
        ]),
        ikRig: rig,
    };
}

/** A clip that animates nothing, so the pose is the rest pose and any change is IK's doing. */
function idleClip(): Animation {
    return {
        name: 'idle',
        samplers: [{ input: [0, 1], output: [0, 2, 0, 0, 2, 0], interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: HIPS, targetPath: 'translation' }],
    };
}

/**
 * The rest pose with the RIGHT leg raised `h` — one foot mid-stride while the other stands.
 *
 * Lifts the THIGH, not the ankle, so the whole leg rises with its bone lengths intact and the only thing that
 * differs between the two legs is ankle height. Giving the right leg shorter rest offsets instead would
 * conflate "lifted" with "shorter", and the solver cares about both.
 */
function liftedClip(h: number): Animation {
    return {
        name: 'idle',
        samplers: [
            { input: [0, 1], output: [0, 2, 0, 0, 2, 0], interpolation: 'LINEAR' },
            { input: [0, 1], output: [0.2, h, 0, 0.2, h, 0], interpolation: 'LINEAR' },
        ],
        channels: [
            { samplerIndex: 0, targetNodeIndex: HIPS, targetPath: 'translation' },
            { samplerIndex: 1, targetNodeIndex: THIGH_R, targetPath: 'translation' },
        ],
    };
}

/** Physics stubbed to a horizontal plane at `groundY`. `null` means the ray finds nothing at all. */
function stubPhysics(groundY: number | null, normal: vec3 = vec3.fromValues(0, 1, 0)) {
    const calls: { from: vec3; to: vec3 }[] = [];
    return {
        calls,
        physics: {
            up: vec3.fromValues(0, 1, 0),
            raycast(from: vec3, to: vec3) {
                calls.push({ from: vec3.clone(from), to: vec3.clone(to) });
                if (groundY === null) return null;
                // Only report a hit when the segment actually spans the plane, so traceUp/traceDown matter.
                if (from[1] < groundY || to[1] > groundY) return null;
                return {
                    point: vec3.fromValues(from[0], groundY, from[2]),
                    normal: vec3.clone(normal),
                    distance: from[1] - groundY,
                    body: null as any,
                    node: null,
                };
            },
        },
    };
}

function makeAnimator(rig: IkRig | undefined, groundY: number | null, opts: {
    nodeWorld?: mat4; normal?: vec3; clip?: Animation;
} = {}) {
    const skin = makeSkin(rig);
    const model = { skin, animations: [opts.clip ?? idleClip()] } as unknown as AnimatedModel;
    const a = new Animator(model);
    const stub = stubPhysics(groundY, opts.normal);
    // What the Animator reaches for on its node: `worldTransform` and `scene.physics` for IK, `body`/`parent`
    // for the bodied-ancestor walk, and `position` for the legacy speed trigger that runs every frame.
    const node: any = {
        worldTransform: opts.nodeWorld ?? mat4.create(),
        scene: { physics: stub.physics },
        body: null,
        parent: null,
        position: vec3.create(),
    };
    a.setNode(node);
    return { animator: a, stub, skin };
}

/** World position of a joint, read back out of the final bone matrices (inverse binds are identity here). */
function jointPos(a: Animator, jointIndex: number): vec3 {
    return mat4.getTranslation(vec3.create(), a.getFinalBoneMatrices()[jointIndex]);
}

const RIG: IkRig = {
    hips: HIPS,
    feet: [{ thigh: THIGH, shin: SHIN, foot: FOOT, toe: TOE }],
    footHeight: 0.1,
    traceUp: 0.5,
    traceDown: 0.6,
    smoothing: 0,   // off, so a single frame settles and the assertions are about geometry not timing
};

/** Both legs, for everything about the stance/swing split — which needs a second foot to have an opinion. */
const RIG2: IkRig = {
    ...RIG,
    feet: [
        { thigh: THIGH, shin: SHIN, foot: FOOT, toe: TOE },
        { thigh: THIGH_R, shin: SHIN_R, foot: FOOT_R, toe: TOE_R },
    ],
    swingRelease: 0.2,
};

/**
 * Advance one frame of raw-clip playback.
 *
 * Deliberately does NOT call checkTriggers: with no state machine and no mappings it drops straight to
 * _setTPose, which computes bind-pose matrices by its own route and never reaches _recomputePose — so the IK
 * pass would never run and every assertion below would pass vacuously.
 */
const step = (a: Animator, dt = 1 / 60) => { a.update(dt); };

/** Advance one frame the way ModelNode.update does, for the tests that drive a state machine. */
const stepSm = (a: Animator, dt = 1 / 60) => { a.checkTriggers(); a.update(dt); };

describe('Animator — foot IK', () => {
    it('does nothing at all without a rig', () => {
        const { animator } = makeAnimator(undefined, 0);
        animator.playAnimationByName('idle', true, false);
        step(animator);
        // The ankle stays where the animation put it: 2 (hips) - 1 - 1 = 0.
        expect(jointPos(animator, FOOT)[1]).toBeCloseTo(0, 6);
    });

    it('does nothing when nothing is under the foot', () => {
        const { animator, stub } = makeAnimator(RIG, null);
        animator.playAnimationByName('idle', true, false);
        step(animator);
        expect(stub.calls.length).toBeGreaterThan(0);          // it did look
        expect(jointPos(animator, FOOT)[1]).toBeCloseTo(0, 6);  // and found nothing, so left the pose alone
    });

    it('lifts the foot onto ground that is above the animated pose', () => {
        // Ground at +0.2. The ankle sits footHeight above the surface, so it wants y = 0.3.
        const { animator } = makeAnimator(RIG, 0.2);
        animator.playAnimationByName('idle', true, false);
        step(animator);
        expect(jointPos(animator, FOOT)[1]).toBeCloseTo(0.3, 4);
    });

    it('lowers the pelvis when the foot has to reach DOWN', () => {
        // Ground at -0.3: the ankle wants y = -0.2, which is 0.2 below where the animation put it.
        const { animator } = makeAnimator(RIG, -0.3);
        animator.playAnimationByName('idle', true, false);
        step(animator);
        expect(jointPos(animator, HIPS)[1]).toBeLessThan(2 - 1e-4);
        // Two decimals, not four: with the pelvis dropped exactly far enough the leg is at full stretch, and
        // the solver deliberately stops a hair short of locking straight (maxReach) so the knee keeps a
        // defined bend direction. That leaves ~2mm on a 2-unit leg, which is the intended trade.
        expect(jointPos(animator, FOOT)[1]).toBeCloseTo(-0.2, 2);
    });

    /**
     * The pelvis must only ever go DOWN. A foot that needs to RISE is a step the knee bends for; raising the
     * hips to meet it would lift the whole character off the ground it is standing on.
     */
    it('never raises the pelvis', () => {
        const { animator } = makeAnimator(RIG, 0.2);
        animator.playAnimationByName('idle', true, false);
        for (let i = 0; i < 30; i++) step(animator);
        expect(jointPos(animator, HIPS)[1]).toBeLessThanOrEqual(2 + 1e-5);
    });

    it('clamps how far the pelvis may drop', () => {
        // Ground at -0.5 wants the ankle at -0.4, a drop of 0.4 — but only 0.1 is permitted. Kept inside
        // traceDown, or the ray would miss the ground entirely and there would be nothing to clamp.
        const { animator } = makeAnimator({ ...RIG, maxHipDrop: 0.1 }, -0.5);
        animator.playAnimationByName('idle', true, false);
        step(animator);
        expect(jointPos(animator, HIPS)[1]).toBeCloseTo(1.9, 4);
    });

    it('keeps the bones their original lengths', () => {
        const { animator } = makeAnimator(RIG, 0.25);
        animator.playAnimationByName('idle', true, false);
        step(animator);
        const thigh = jointPos(animator, THIGH), shin = jointPos(animator, SHIN), foot = jointPos(animator, FOOT);
        expect(vec3.distance(thigh, shin)).toBeCloseTo(1, 4);
        expect(vec3.distance(shin, foot)).toBeCloseTo(1, 4);
    });

    /**
     * ikWeight = 0 has to reproduce the un-IK'd pose EXACTLY, not approximately — it is the escape hatch, and
     * an escape hatch that still moves the character by a millimetre is not one.
     */
    it('reproduces the animated pose bit for bit at zero weight', () => {
        const withoutRig = makeAnimator(undefined, -0.3).animator;
        withoutRig.playAnimationByName('idle', true, false);
        step(withoutRig);
        const expected = withoutRig.getFinalBoneMatrices().map(m => Array.from(m));

        const { animator } = makeAnimator(RIG, -0.3);
        animator.setStateMachine({
            parameters: [],
            states: [{ name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true, ikWeight: 0 }],
            transitions: [], events: [],
        });
        stepSm(animator);

        const actual = animator.getFinalBoneMatrices().map(m => Array.from(m));
        for (let j = 0; j < expected.length; j++) {
            for (let i = 0; i < 16; i++) expect(actual[j][i]).toBeCloseTo(expected[j][i], 9);
        }
    });

    it('reads its weight from a parameter when one is bound', () => {
        const { animator } = makeAnimator(RIG, 0.2);
        animator.setStateMachine({
            parameters: [{ name: 'Grounded', type: 'float', default: 0 }],
            states: [{ name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true, ikWeightParam: 'Grounded' }],
            transitions: [], events: [],
        });
        stepSm(animator);
        expect(jointPos(animator, FOOT)[1]).toBeCloseTo(0, 4);   // weight 0 — untouched

        animator.setFloat('Grounded', 1);
        step(animator);
        expect(jointPos(animator, FOOT)[1]).toBeCloseTo(0.3, 4); // weight 1 — planted
    });

    it('eases part-way at a partial weight', () => {
        const { animator } = makeAnimator(RIG, 0.2);
        animator.setStateMachine({
            parameters: [],
            states: [{ name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true, ikWeight: 0.5 }],
            transitions: [], events: [],
        });
        stepSm(animator);
        // Half way between the animated 0 and the planted 0.3.
        expect(jointPos(animator, FOOT)[1]).toBeCloseTo(0.15, 3);
    });

    it('fades in over the smoothing time rather than snapping', () => {
        const { animator } = makeAnimator({ ...RIG, smoothing: 0.2 }, 0.2);
        animator.playAnimationByName('idle', true, false);
        step(animator);
        const first = jointPos(animator, FOOT)[1];
        // One frame of a 0.2s time constant is a fraction of the way, not all of it.
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThan(0.15);

        let prev = first;
        for (let i = 0; i < 60; i++) {
            step(animator);
            const y = jointPos(animator, FOOT)[1];
            expect(y).toBeGreaterThanOrEqual(prev - 1e-6);   // monotone, no overshoot
            prev = y;
        }
        expect(prev).toBeCloseTo(0.3, 2);
    });

    it('traces from above the foot to below it, by the authored distances', () => {
        const { animator, stub } = makeAnimator(RIG, 0.2);
        animator.playAnimationByName('idle', true, false);
        step(animator);
        const { from, to } = stub.calls[0];
        expect(from[1]).toBeCloseTo(0 + 0.5, 5);    // ankle + traceUp
        expect(to[1]).toBeCloseTo(0 - 0.6, 5);      // ankle - traceDown
    });

    it('rolls the foot onto a slope, and leaves it alone past the limit', () => {
        const tilted = vec3.normalize(vec3.create(), vec3.fromValues(0, 1, 0.5));  // ~26 degrees
        const rolled = makeAnimator({ ...RIG, maxSlopeDeg: 45 }, 0.2, { normal: tilted }).animator;
        rolled.playAnimationByName('idle', true, false);
        step(rolled);
        const toeRolled = jointPos(rolled, TOE);

        const flat = makeAnimator({ ...RIG, maxSlopeDeg: 45 }, 0.2).animator;
        flat.playAnimationByName('idle', true, false);
        step(flat);
        expect(vec3.distance(toeRolled, jointPos(flat, TOE))).toBeGreaterThan(1e-3);

        // Same slope, but now beyond what the ankle is allowed to match: the foot keeps its animated roll.
        const refused = makeAnimator({ ...RIG, maxSlopeDeg: 10 }, 0.2, { normal: tilted }).animator;
        refused.playAnimationByName('idle', true, false);
        step(refused);
        expect(vec3.distance(jointPos(refused, TOE), jointPos(flat, TOE))).toBeLessThan(1e-6);
    });

    /**
     * The failure that prompted validation: a rig whose bones all exist and read perfectly in the panel, but
     * which is not a connected leg. The solver would happily produce a pose from it — one with no relation to
     * the character, which on screen reads as thrashing rather than as an error. It must be refused, and the
     * pose must come out byte-identical to having no rig at all.
     */
    it('refuses a chain that is not a connected leg, leaving the pose untouched', () => {
        const plain = makeAnimator(undefined, 0.2).animator;
        plain.playAnimationByName('idle', true, false);
        step(plain);
        const expected = plain.getFinalBoneMatrices().map(m => Array.from(m));

        // TOE as the shin: a real bone, in the skeleton, but below the foot rather than above it.
        const { animator } = makeAnimator({ hips: HIPS, feet: [{ thigh: THIGH, shin: TOE, foot: FOOT }] }, 0.2);
        animator.playAnimationByName('idle', true, false);
        step(animator);

        const actual = animator.getFinalBoneMatrices().map(m => Array.from(m));
        for (let j = 0; j < expected.length; j++) {
            for (let i = 0; i < 16; i++) expect(actual[j][i]).toBeCloseTo(expected[j][i], 9);
        }
    });

    it('keeps a valid leg when another leg in the same rig is invalid', () => {
        const { animator } = makeAnimator({
            hips: HIPS,
            feet: [
                { thigh: THIGH, shin: SHIN, foot: FOOT, toe: TOE },
                { thigh: FOOT, shin: THIGH, foot: SHIN },   // nonsense ordering
            ],
            footHeight: 0.1, traceUp: 0.5, traceDown: 0.6, smoothing: 0,
        }, 0.2);
        animator.playAnimationByName('idle', true, false);
        step(animator);
        expect(jointPos(animator, FOOT)[1]).toBeCloseTo(0.3, 4);   // the good leg still plants
    });

    // Half-assigned chains are the normal state of affairs while someone is picking bones in the editor.
    it('skips a chain naming a joint the skeleton does not have', () => {
        const { animator } = makeAnimator({ hips: HIPS, feet: [{ thigh: 99, shin: SHIN, foot: FOOT }] }, 0.2);
        animator.playAnimationByName('idle', true, false);
        expect(() => step(animator)).not.toThrow();
        expect(jointPos(animator, FOOT)[1]).toBeCloseTo(0, 6);
    });

    /**
     * A jump: the pelvis was dropped for a foot that could reach the ground, then no foot can. It has to RISE
     * back over the smoothing time. Returning early once no foot finds ground would leave the drop cached for
     * the whole of the jump and resume from it on landing — a pop at exactly the moment IK should be invisible.
     */
    it('releases the pelvis when every foot leaves the ground', () => {
        const { animator, stub } = makeAnimator({ ...RIG, smoothing: 0.1 }, -0.4);
        animator.playAnimationByName('idle', true, false);
        for (let i = 0; i < 60; i++) step(animator);
        const dropped = jointPos(animator, HIPS)[1];
        expect(dropped).toBeLessThan(2 - 0.05);

        // Ground gone. The pelvis must come back up, and get all the way back, not asymptote short.
        (stub.physics as any).raycast = () => null;
        let prev = dropped;
        for (let i = 0; i < 10; i++) {
            step(animator);
            const y = jointPos(animator, HIPS)[1];
            expect(y).toBeGreaterThanOrEqual(prev - 1e-6);   // monotone rise, no snap-back-down
            prev = y;
        }
        for (let i = 0; i < 90; i++) step(animator);
        expect(jointPos(animator, HIPS)[1]).toBeCloseTo(2, 4);
    });

    /**
     * `outsideSkin` caches the skin's rest matrices for nodes that are NOT joints. Cached by reference, a
     * solve writing through that cache would corrupt `skin.nodeTransforms` — the bind-pose fallback for every
     * unanimated joint and the source `_setTPose` reads — cumulatively, every frame, for the model's lifetime.
     */
    it('never writes into the skin’s rest transforms', () => {
        const { animator, skin } = makeAnimator(RIG, 0.2);
        const before = new Map(
            Array.from(skin.nodeTransforms!.entries()).map(([k, v]) => [k, Array.from(v)]),
        );
        animator.playAnimationByName('idle', true, false);
        for (let i = 0; i < 30; i++) step(animator);

        for (const [node, original] of before) {
            expect(Array.from(skin.nodeTransforms!.get(node)!)).toEqual(original);
        }
    });

    /**
     * A self-parented bone is a one-node cycle, which skeletonTopology reports as a ROOT while leaving its
     * parent-node index pointing at itself. Resolving that during re-accumulation multiplies the joint's
     * global by its own global — squaring it — and a leg solve re-accumulates up to eight times a frame, so
     * it compounds rather than merely being wrong once.
     */
    it('does not compound a self-parented root across re-solves', () => {
        const skin = makeSkin(RIG);
        skin.joints[0].parentIndex = HIPS;   // hips parented to itself
        const model = { skin, animations: [idleClip()] } as unknown as AnimatedModel;
        const a = new Animator(model);
        const stub = stubPhysics(0.2);
        a.setNode({
            worldTransform: mat4.create(), scene: { physics: stub.physics },
            body: null, parent: null, position: vec3.create(),
        } as any);

        a.playAnimationByName('idle', true, false);
        step(a);
        const first = jointPos(a, HIPS)[1];
        for (let i = 0; i < 20; i++) step(a);

        // Squaring a translation of 2 would reach ~2 million within a handful of frames.
        expect(jointPos(a, HIPS)[1]).toBeCloseTo(first, 4);
        expect(Number.isFinite(jointPos(a, FOOT)[1])).toBe(true);
    });

    it('works when the character is moved and turned in the world', () => {
        // The solve happens in MODEL space while the ray is in WORLD space; a missing conversion shows up
        // here and nowhere else, because at the identity transform the two spaces are the same.
        const nodeWorld = mat4.create();
        mat4.translate(nodeWorld, nodeWorld, [10, 5, -3]);
        mat4.rotateY(nodeWorld, nodeWorld, Math.PI / 3);

        const { animator, stub } = makeAnimator(RIG, 5.2, { nodeWorld });
        animator.playAnimationByName('idle', true, false);
        step(animator);

        // The ray must start above the foot in WORLD space (the character stands at world y = 5).
        expect(stub.calls[0].from[1]).toBeCloseTo(5 + 0.5, 4);
        // And the ankle must end up footHeight above the world ground, expressed back in model space.
        const ankleWorld = vec3.transformMat4(vec3.create(), jointPos(animator, FOOT), nodeWorld);
        expect(ankleWorld[1]).toBeCloseTo(5.3, 3);
    });
});

/**
 * The stance/swing split.
 *
 * The ground ray reaches 0.6 below the ankle while a stride lifts it about 0.35, so a swinging foot always
 * finds ground under it. Planting it there destroys the animated lift for the whole swing AND — because that
 * foot then demands the most reach of any — dips the pelvis by the stride height once per step. Both read on
 * screen as the animation fighting the IK, and both scale with how high a given clip lifts the feet, which is
 * why a character can look right walking one way and wrong walking another.
 */
describe('Animator — foot IK, stance vs swing', () => {
    it('leaves a lifted foot at the height the animation put it', () => {
        // Left ankle rests at 0 (0.1 below its target), right is lifted 0.35 — a clear swing.
        const { animator } = makeAnimator(RIG2, 0, { clip: liftedClip(0.35) });
        animator.playAnimationByName('idle', true, false);
        step(animator);

        // Released: 0.35 above the planted foot is past swingRelease, so the animation keeps the foot.
        expect(jointPos(animator, FOOT_R)[1]).toBeCloseTo(0.35, 6);
    });

    it('still pushes a foot that is through the ground back up', () => {
        // Same frame as above: releasing the swing foot must not stop the stance foot being planted.
        const { animator } = makeAnimator(RIG2, 0, { clip: liftedClip(0.35) });
        animator.playAnimationByName('idle', true, false);
        step(animator);

        expect(jointPos(animator, FOOT)[1]).toBeCloseTo(0.1, 6);
    });

    it('does not drop the pelvis for a foot it has released', () => {
        // Ground at -0.3, right foot lifted 0.25 — still inside traceDown, so it does find ground and would
        // be planted (and would drag the pelvis to its own depth) if nothing released it.
        const { animator } = makeAnimator(RIG2, -0.3, { clip: liftedClip(0.25) });
        animator.playAnimationByName('idle', true, false);
        step(animator);

        // The pelvis follows the PLANTED foot only: 2 - 0.2. Unweighted it would follow the swing foot to
        // 2 - 0.45 instead, which is the once-per-step bob.
        expect(jointPos(animator, HIPS)[1]).toBeGreaterThan(1.7);
        expect(jointPos(animator, HIPS)[1]).toBeCloseTo(1.8, 6);

        // The released foot rides DOWN with the pelvis, and that is right: the whole body was lowered, so the
        // swing foot should keep its height relative to the body rather than its height in the world. What it
        // must not do is get solved onto the ground at -0.2. Stated as the offset from the pelvis, which is
        // the quantity the animation actually authored.
        expect(jointPos(animator, FOOT_R)[1] - jointPos(animator, HIPS)[1]).toBeCloseTo(0.25 - 2, 6);
    });

    it('still lowers the pelvis when the whole character is standing low', () => {
        // The case the release must NOT break: both feet equally far above their ground is not a stride, it
        // is a character standing on ground lower than the animation assumed. Guards the reference against
        // regressing to an absolute clearance, which would release both feet here.
        const { animator } = makeAnimator(RIG2, -0.3);
        animator.playAnimationByName('idle', true, false);
        step(animator);

        expect(jointPos(animator, HIPS)[1]).toBeCloseTo(1.8, 6);
        // 2 dp: reaching down to -0.2 extends the leg, and DEFAULT_MAX_REACH holds it 0.1% short on purpose
        // (a perfectly straight limb has no bend plane), which is ~2mm on this 2-unit leg.
        expect(jointPos(animator, FOOT)[1]).toBeCloseTo(-0.2, 2);
        expect(jointPos(animator, FOOT_R)[1]).toBeCloseTo(-0.2, 2);
    });

    it('turns the release off at 0, restoring the old always-planted behaviour', () => {
        const { animator } = makeAnimator({ ...RIG2, swingRelease: 0 }, 0, { clip: liftedClip(0.35) });
        animator.playAnimationByName('idle', true, false);
        step(animator);

        // The escape hatch, and what this did before the release existed: the swing foot is planted anyway.
        // 2 dp — planting it from 0.35 extends the leg into the DEFAULT_MAX_REACH shortfall.
        expect(jointPos(animator, FOOT_R)[1]).toBeCloseTo(0.1, 2);
    });
});

describe('Animator — foot IK, losing the ground', () => {
    it('fades out over the smoothing time instead of popping in one frame', () => {
        // The damped weight alone cannot do this: with no hit there is no target to ease towards, so without
        // remembering the last surface the correction is simply absent on the frame the ray first misses.
        const { animator, stub } = makeAnimator({ ...RIG, smoothing: 0.3 }, 0.2);
        animator.playAnimationByName('idle', true, false);
        for (let i = 0; i < 120; i++) step(animator);
        expect(jointPos(animator, FOOT)[1]).toBeCloseTo(0.3, 2);   // settled, planted

        (stub.physics as any).raycast = () => null;
        step(animator);
        // One frame at a 0.3s time constant sheds ~5% of the weight, not 100%.
        expect(jointPos(animator, FOOT)[1]).toBeGreaterThan(0.27);

        let prev = jointPos(animator, FOOT)[1];
        for (let i = 0; i < 180; i++) {
            step(animator);
            const y = jointPos(animator, FOOT)[1];
            expect(y).toBeLessThanOrEqual(prev + 1e-9);   // monotone, never a bounce
            prev = y;
        }
        expect(prev).toBeCloseTo(0, 3);                    // and all the way back to the animated pose
    });
});

// ---------------------------------------------------------------------------------------------------
// A foot easing onto a step is reacting to the GROUND, not playing an animation. Its smoothing therefore runs
// on wall-clock time, not on the state's playback rate — a slow-motion state must not also slow the foot
// settling, and a state whose rate has been clamped to 0 (a Speed parameter bound to a signed built-in, going
// negative) must not stop it settling altogether. Same root cause as the field-filter tests in
// animatorField.test.ts; this is the third filter that shared the scaled dt.
// ---------------------------------------------------------------------------------------------------

describe('Animator — foot IK smoothing is wall-clock, not playback-scaled', () => {
    /** Ankle height after `frames` of settling, with playback running at `playbackSpeed`. */
    function footAfter(playbackSpeed: number, frames: number): number {
        const { animator } = makeAnimator({ ...RIG, smoothing: 0.3 }, 0.2);
        animator.playAnimationByName('idle', true, false);
        animator.speed = playbackSpeed;
        for (let i = 0; i < frames; i++) step(animator);
        return jointPos(animator, FOOT)[1];
    }

    it('settles by the same amount in the same wall-clock time at any playback speed', () => {
        const atNormal = footAfter(1, 18);   // 0.3s of a 0.3s time constant: partway, not settled
        expect(atNormal).toBeGreaterThan(0.1);
        expect(atNormal).toBeLessThan(0.28);

        expect(footAfter(0.5, 18)).toBeCloseTo(atNormal, 6);
        expect(footAfter(2, 18)).toBeCloseTo(atNormal, 6);
    });

    // The frozen-playback case. `speed = 0` used to hand the damp a dt of 0, which it reads as "do not
    // filter" — so the foot correction stopped easing entirely for as long as the rate stayed clamped.
    it('keeps easing the foot in while playback is stopped', () => {
        const stopped = footAfter(0, 18);
        expect(stopped).toBeGreaterThan(0.1);
        expect(stopped).toBeCloseTo(footAfter(1, 18), 6);
    });
});

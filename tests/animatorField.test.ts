import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Animator } from '../src/graphics/animator';
import type { AnimatedModel, Animation, Skin } from '../src/graphics/animatedModel';
import type { AnimationField } from '../src/graphics/animationField';

// Field playback inside the Animator: weighted N-clip posing, the shared phase, and the weighted duration.
// fieldWeights is covered on its own in animationField.test.ts; what is tested here is everything the
// Animator layers on top — which is where the foot-sliding and the collapsed-skeleton bugs would live.
//
// A real AnimatedModel builds a GPU Mesh in its constructor, so this uses a duck-typed stand-in. The
// Animator only ever reads `skin` and `animations` off it, which is exactly what is provided.

/** One clip translating a single bone along +X from 0 to `toX` over `duration` seconds. */
function slideClip(name: string, toX: number, duration: number): Animation {
    return {
        name,
        samplers: [{ input: [0, duration], output: [0, 0, 0, toX, 0, 0], interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
    };
}

const SKIN: Skin = {
    joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }],
    nodeTransforms: new Map([[0, mat4.create()]]),
};

function makeAnimator(animations: Animation[]): Animator {
    const model = { skin: SKIN, animations } as unknown as AnimatedModel;
    return new Animator(model);
}

/** X translation of the single bone in the current pose. Inverse bind is identity, so this is the local X. */
function boneX(animator: Animator): number {
    const t = vec3.create();
    mat4.getTranslation(t, animator.getFinalBoneMatrices()[0]);
    return t[0];
}

// walk: 10 units over 1s. run: 20 units over 2s. Deliberately DIFFERENT lengths — that is the whole
// reason a blend space needs a shared phase rather than a shared clock.
const walk = () => slideClip('walk', 10, 1);
const run = () => slideClip('run', 20, 2);

const field1D = (): AnimationField => ({
    mode: '1d',
    xAxis: { name: 'Speed', min: 0, max: 100 },
    samples: [{ clipName: 'walk', x: 0 }, { clipName: 'run', x: 100 }],
});

describe('Animator — field playback', () => {
    it('plays a single-sample field as that clip', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField(field1D(), 0); // pinned to 'walk'
        expect(a.isPlayingField).toBe(true);
        expect(a.activeFieldWeights).toEqual([{ clipName: 'walk', weight: 1 }]);
        expect(a.duration).toBeCloseTo(1);

        a.seek(0.5);
        expect(boneX(a)).toBeCloseTo(5); // halfway through walk
    });

    it('reports the WEIGHTED duration, not the dominant clip’s', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField(field1D(), 50); // 50/50
        expect(a.duration).toBeCloseTo(1.5); // (1 + 2) / 2

        a.setFieldProbe(25); // 75% walk, 25% run
        expect(a.duration).toBeCloseTo(0.75 * 1 + 0.25 * 2);
    });

    /**
     * The anti-foot-slide property, stated as a test: at a shared phase p, every contributing clip is posed
     * at p through ITS OWN length. At p = 0.5 walk is at 0.5s (x = 5) and run is at 1.0s (x = 10), so an
     * even mix is 7.5 — NOT what you would get by posing both at the same wall-clock time.
     */
    it('poses every contributing clip at the same normalized phase', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField(field1D(), 50);
        a.seek(a.duration / 2); // phase 0.5
        expect(boneX(a)).toBeCloseTo(7.5);

        a.seek(a.duration); // phase 1.0: walk at 10, run at 20
        expect(boneX(a)).toBeCloseTo(15);
    });

    /**
     * A sample sitting alone at the probe plays at its OWN natural rate, whatever the other samples'
     * durations are. Sounds obvious, but it is the property that breaks first if the weighted duration is
     * ever computed against the wrong clip: the symptom is "idle and walk look right, run plays far too
     * fast", because the error scales with how far that clip's length is from its neighbours'.
     */
    it('plays the far sample at its natural rate, not the near one’s', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField(field1D(), 100); // pinned to 'run': 20 units over 2s
        expect(a.duration).toBeCloseTo(2); // run's own length, NOT walk's 1s and not a mix
        a.play();
        a.update(0.5); // a quarter of the way through run
        expect(boneX(a)).toBeCloseTo(5);
        a.update(0.5); // halfway
        expect(boneX(a)).toBeCloseTo(10);
    });

    it('weights the mix by the probe position', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField(field1D(), 25); // 75% walk, 25% run
        a.seek(a.duration); // both at the end of their own cycle
        expect(boneX(a)).toBeCloseTo(0.75 * 10 + 0.25 * 20);
    });

    it('advances the shared phase over time and loops', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField(field1D(), 0); // walk only, 1s long
        a.play();
        a.update(0.25);
        expect(boneX(a)).toBeCloseTo(2.5);
        a.update(0.5);
        expect(boneX(a)).toBeCloseTo(7.5);
        // Past the end: a looping field wraps rather than holding.
        a.update(0.5);
        expect(a.currentTime).toBeLessThan(1);
        expect(boneX(a)).toBeCloseTo(2.5);
    });

    // A rate scale shortens a sample's contribution to the blended cycle; the clip still plays one full
    // cycle within it, which is what "play this sample twice as fast" has to mean under a shared phase.
    it('honours per-sample rate scale in the weighted duration', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField({
            mode: '1d',
            xAxis: { name: 'Speed', min: 0, max: 100 },
            samples: [{ clipName: 'walk', x: 0 }, { clipName: 'run', x: 100, rateScale: 2 }],
        }, 100);
        expect(a.duration).toBeCloseTo(1); // run's 2s played at 2x
    });

    it('ignores samples whose clip the model does not have, renormalizing the rest', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField({
            mode: '1d',
            xAxis: { name: 'Speed', min: 0, max: 100 },
            samples: [{ clipName: 'walk', x: 0 }, { clipName: 'ghost', x: 100 }],
        }, 50);
        // 'ghost' resolves to nothing, so walk carries the whole pose rather than fading it towards bind.
        expect(a.activeFieldWeights).toEqual([{ clipName: 'walk', weight: 1 }]);
        a.seek(a.duration);
        expect(boneX(a)).toBeCloseTo(10);
    });

    it('holds the bind pose for a field with no usable samples', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField({ mode: '1d', xAxis: { name: 'Speed', min: 0, max: 100 }, samples: [] }, 50);
        a.play();
        a.update(0.1);
        expect(a.activeFieldWeights).toEqual([]);
        expect(boneX(a)).toBeCloseTo(0); // the joint's bind transform, not NaN or a stale pose
    });

    it('produces finite matrices throughout the probe range', () => {
        const a = makeAnimator([walk(), run()]);
        const f = field1D();
        a.playField(f, 0);
        for (let x = -20; x <= 120; x += 7) {
            a.setFieldProbe(x);
            a.seek(a.duration * 0.37);
            expect(Number.isFinite(boneX(a))).toBe(true);
            for (const v of a.getFinalBoneMatrices()[0]) expect(Number.isFinite(v)).toBe(true);
        }
    });
});

describe('Animator — leaving a field', () => {
    // A stale field would keep overwriting the bind pose on the next _recomputePose, so the model would
    // never actually return to rest.
    it('showBindPose clears the field', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField(field1D(), 50);
        a.seek(a.duration);
        expect(boneX(a)).toBeCloseTo(15);

        a.showBindPose();
        expect(a.isPlayingField).toBe(false);
        expect(boneX(a)).toBeCloseTo(0);
    });

    it('switching to a single clip takes over the pose', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField(field1D(), 50);
        a.playAnimationByName('run', true, false); // no blend: an instant switch
        expect(a.isPlayingField).toBe(false);
        a.seek(2);
        expect(boneX(a)).toBeCloseTo(20); // pure run, no field residue
    });

    // Cross-fading OUT of a field is the path where the outgoing side needs bone maps of its own; sharing
    // them with the incoming clip would have the two overwrite each other every frame.
    it('cross-fades from a field into a clip without corrupting either side', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField(field1D(), 50);
        a.play();
        a.update(0.1);

        a.blendTime = 0.4;
        a.playAnimationByName('run', true, true);
        expect(a.isBlending).toBe(true);
        a.update(0.1);
        const mid = boneX(a);
        expect(Number.isFinite(mid)).toBe(true);

        // Once the blend completes only the clip remains, at its own time.
        a.update(0.5);
        expect(a.isBlending).toBe(false);
        a.seek(2);
        expect(boneX(a)).toBeCloseTo(20);
    });
});

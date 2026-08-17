import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Animator } from '../src/graphics/animator';
import type { AnimatedModel, Animation, Skin } from '../src/graphics/animatedModel';
import type { AnimationField } from '../src/graphics/animationField';
import type { AnimationParameter, AnimationState, AnimationStateMachine } from '../src/graphics/animator';

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

// ---- Temporal stability -------------------------------------------------------------------------------
//
// Everything above drives the probe DIRECTLY, the way the field editor does — deliberately unfiltered, so the
// preview shows exactly what a probe position produces. A running game instead drives the axes from machine
// parameters, and those come from measurement: noisy. This block covers the filtering that only exists on
// that path, which is the difference between a steady blend and the vibration this was written to fix.

/** A machine with one field state whose X axis reads the parameter `Speed`. */
function speedMachine(field: AnimationField, over?: Partial<AnimationState>) {
    return {
        parameters: [{ name: 'Speed', type: 'float', default: 0 } as AnimationParameter],
        states: [{
            name: 'Locomotion', clipName: '', loop: true, speed: 1, isEntry: true,
            field, fieldInputs: { x: 'Speed' }, ...over,
        } as AnimationState],
        transitions: [],
        events: [],
    } as AnimationStateMachine;
}

/** Run the machine for `seconds` at a fixed step, exactly as ModelNode.update does each frame. */
function step(a: Animator, seconds: number, dt = 1 / 60) {
    for (let t = 0; t < seconds - 1e-9; t += dt) {
        a.checkTriggers();
        a.update(dt);
    }
}

const weightOf = (a: Animator, clip: string) =>
    a.activeFieldWeights.find(w => w.clipName === clip)?.weight ?? 0;

describe('Animator — field probe filtering', () => {
    it('eases the probe towards a stepped parameter instead of jumping to it', () => {
        const a = makeAnimator([walk(), run()]);
        a.setStateMachine(speedMachine({ ...field1D(), xAxis: { name: 'Speed', min: 0, max: 100, smoothing: 0.2 } }));

        // Seeded at 0 => pure walk. Now demand full speed in one frame.
        expect(weightOf(a, 'walk')).toBeCloseTo(1);
        a.setFloat('Speed', 100);

        a.checkTriggers();
        a.update(1 / 60);
        const afterOneFrame = weightOf(a, 'run');
        // A step input must NOT arrive as a step: one frame of a 0.2s time constant is ~8% of the way.
        expect(afterOneFrame).toBeGreaterThan(0);
        expect(afterOneFrame).toBeLessThan(0.2);

        // ...and must converge, monotonically, without overshooting.
        let prev = afterOneFrame;
        for (let i = 0; i < 60; i++) {
            a.checkTriggers();
            a.update(1 / 60);
            const cur = weightOf(a, 'run');
            expect(cur).toBeGreaterThanOrEqual(prev - 1e-9);
            expect(cur).toBeLessThanOrEqual(1 + 1e-9);
            prev = cur;
        }
        expect(prev).toBeGreaterThan(0.95);
    });

    it('rejects a parameter that alternates inside the deadzone', () => {
        const a = makeAnimator([walk(), run()]);
        a.setStateMachine(speedMachine({
            ...field1D(),
            // Both filters off isolates the deadband: anything that gets past it lands in the pose at once,
            // and — the point of this test — anything it stops shows up as a weight that does not move AT ALL.
            // Leaving weight smoothing on would leave the weights still asymptotically converging, which reads
            // as the deadband leaking when it is doing its job.
            xAxis: { name: 'Speed', min: 0, max: 100, smoothing: 0, deadzone: 5 },
            weightSmoothing: 0,
        }));
        a.setFloat('Speed', 50);
        step(a, 0.5);
        const settled = weightOf(a, 'run');

        // Noise of +/-2 around 50 is inside the 5-unit band, so the pose must not move at all.
        for (const noise of [2, -2, 1.5, -1.5, 2, -2]) {
            a.setFloat('Speed', 50 + noise);
            a.checkTriggers();
            a.update(1 / 60);
            expect(weightOf(a, 'run')).toBeCloseTo(settled, 10);
        }

        // A move that clears the band does get through — a deadband that never releases is just a freeze.
        a.setFloat('Speed', 60);
        a.checkTriggers();
        a.update(1 / 60);
        expect(weightOf(a, 'run')).toBeGreaterThan(settled);
    });

    it('seeds the probe on the first frame rather than damping up from zero', () => {
        const a = makeAnimator([walk(), run()]);
        const machine = speedMachine({ ...field1D(), xAxis: { name: 'Speed', min: 0, max: 100, smoothing: 0.3 } });
        machine.parameters[0].default = 100;
        a.setStateMachine(machine);

        // Entering a state at full speed must pose the run immediately. Damping in from 0 would walk the
        // character up through every gait between the origin and where it actually is.
        expect(weightOf(a, 'run')).toBeCloseTo(1);
    });

    it('fades a clip out of the mix rather than dropping it between frames', () => {
        const a = makeAnimator([walk(), run()]);
        a.setStateMachine(speedMachine({
            ...field1D(),
            // No probe lag, so the WEIGHT damping is the only filter in play.
            xAxis: { name: 'Speed', min: 0, max: 100, smoothing: 0 },
            weightSmoothing: 0.15,
        }));
        a.setFloat('Speed', 50);
        step(a, 1);
        expect(weightOf(a, 'walk')).toBeGreaterThan(0.4);

        // Snap the probe onto 'run'. fieldWeights now returns run alone — but walk must still be posed,
        // decaying, because a clip vanishing from the set in one frame is a discontinuity in the pose.
        a.setFloat('Speed', 100);
        a.checkTriggers();
        a.update(1 / 60);
        const fading = weightOf(a, 'walk');
        expect(fading).toBeGreaterThan(0.1);

        let prev = fading;
        for (let i = 0; i < 10; i++) {
            a.checkTriggers();
            a.update(1 / 60);
            const cur = weightOf(a, 'walk');
            expect(cur).toBeLessThanOrEqual(prev + 1e-9);
            prev = cur;
        }
        // And it does leave eventually — a fade that never completes poses every clip forever.
        step(a, 2);
        expect(a.activeFieldWeights.map(w => w.clipName)).toEqual(['run']);
        expect(weightOf(a, 'run')).toBeCloseTo(1);
    });

    it('keeps the weights rigid when the field asks for no smoothing', () => {
        const a = makeAnimator([walk(), run()]);
        a.setStateMachine(speedMachine({
            ...field1D(),
            xAxis: { name: 'Speed', min: 0, max: 100, smoothing: 0 },
            weightSmoothing: 0,
        }));
        a.setFloat('Speed', 50);
        a.checkTriggers();
        a.update(1 / 60);
        // The knobs have to be real in both directions, or "turn it off to compare" is not available.
        expect(weightOf(a, 'walk')).toBeCloseTo(0.5);
        expect(weightOf(a, 'run')).toBeCloseTo(0.5);
    });

    /**
     * The pose must not depend on what order the contributing clips happen to be in.
     *
     * It used to. `_mixTransforms` folded rotations with a sequential slerp, which is not commutative, and
     * the entries are sorted by weight — so any two weights crossing reordered the fold and moved the pose.
     * Measured before the fix: 0.119 degrees from a single swap, 0.267 across all orderings, every frame,
     * on a bone near the root of the limb. That is a blend humming rather than a blend blending.
     */
    it('produces the same pose whatever order the contributions arrive in', () => {
        const clips = [
            slideClip('a', 10, 1), slideClip('b', 20, 2), slideClip('c', 30, 1.5), slideClip('d', 40, 1.2),
        ];
        const samples = [
            { clipName: 'a', x: 0 }, { clipName: 'b', x: 33 }, { clipName: 'c', x: 66 }, { clipName: 'd', x: 100 },
        ];

        // Same four samples, four different authoring orders. fieldWeights preserves sample order, so this is
        // exactly the reordering a weight crossing produces at runtime.
        const poseFor = (order: number[]) => {
            const a = makeAnimator(clips.map(c => ({ ...c })));
            a.playField({ mode: '1d', xAxis: { name: 'Speed', min: 0, max: 100 }, samples: order.map(i => samples[i]) }, 50);
            a.seek(a.duration * 0.4);
            return Array.from(a.getFinalBoneMatrices()[0]);
        };

        const base = poseFor([0, 1, 2, 3]);
        for (const order of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
            const other = poseFor(order);
            // Float summation is not associative, so this is a tight tolerance rather than exact equality —
            // the artefact being guarded against was four orders of magnitude larger than this.
            for (let i = 0; i < base.length; i++) expect(other[i]).toBeCloseTo(base[i], 9);
        }
    });

    it('carries the phase when the SAME field state is re-entered', () => {
        const a = makeAnimator([walk(), run()]);
        const machine = speedMachine(field1D());
        // Two transitions either side of one threshold: the classic ping-pong. Here it is provoked directly by
        // re-entering the state, which is what that pair does every frame.
        a.setStateMachine(machine);
        step(a, 0.5);
        const phased = boneX(a);
        expect(phased).toBeGreaterThan(0);

        a.resetStateMachine();   // re-enters the entry state, same embedded field object
        // Restarting the cycle from 0 here is the stutter: the pose must be where it was, not back at frame 0.
        expect(boneX(a)).toBeCloseTo(phased, 5);
    });
});

// A field poses every clip at ONE shared phase, which is what stops the feet sliding — but it also assumes
// every clip starts at the same point in its gait. Clips from different sources routinely do not, and two
// walk cycles half a lap apart put the legs in opposition rather than in step.
describe('Animator — per-sample phase offset', () => {
    it('shifts a clip around its own cycle by the authored fraction', () => {
        const a = makeAnimator([walk(), run()]);
        // Walk alone, offset by a quarter. Walk slides 0 -> 10 over 1s, so phase 0 now poses it at 2.5.
        a.playField({
            mode: '1d', xAxis: { name: 'Speed', min: 0, max: 100 },
            samples: [{ clipName: 'walk', x: 0, phaseOffset: 0.25 }],
        }, 0);
        a.seek(0);
        expect(boneX(a)).toBeCloseTo(2.5);

        a.seek(a.duration * 0.5);   // phase 0.5 + 0.25 = 0.75
        expect(boneX(a)).toBeCloseTo(7.5);
    });

    it('wraps rather than clamping at the end of the cycle', () => {
        const a = makeAnimator([walk(), run()]);
        a.playField({
            mode: '1d', xAxis: { name: 'Speed', min: 0, max: 100 },
            samples: [{ clipName: 'walk', x: 0, phaseOffset: 0.5 }],
        }, 0);
        // Phase 0.8 + 0.5 = 1.3 -> 0.3 into the NEXT lap, not held at the end of this one.
        a.seek(a.duration * 0.8);
        expect(boneX(a)).toBeCloseTo(3);
    });

    it('puts two clips half a cycle apart back in step', () => {
        const a = makeAnimator([walk(), run()]);
        const at = (offset: number) => {
            a.playField({
                mode: '1d', xAxis: { name: 'Speed', min: 0, max: 100 },
                samples: [{ clipName: 'walk', x: 0 }, { clipName: 'run', x: 100, phaseOffset: offset }],
            }, 50);
            a.seek(a.duration * 0.25);
            return boneX(a);
        };
        // walk at phase .25 is x=2.5; run at phase .25 is x=5 -> even mix 3.75.
        expect(at(0)).toBeCloseTo(3.75);
        // Offset run by half: it now poses at phase .75, x=15 -> even mix 8.75. The offset must MOVE the pose,
        // or it is not doing anything.
        expect(at(0.5)).toBeCloseTo(8.75);
    });

    it('treats a negative or out-of-range offset as the cycle position it names', () => {
        const a = makeAnimator([walk(), run()]);
        const at = (offset: number) => {
            a.playField({
                mode: '1d', xAxis: { name: 'Speed', min: 0, max: 100 },
                samples: [{ clipName: 'walk', x: 0, phaseOffset: offset }],
            }, 0);
            a.seek(0);
            return boneX(a);
        };
        // The quantity is cyclic, so there is no invalid input — only one to wrap.
        expect(at(-0.75)).toBeCloseTo(at(0.25));
        expect(at(1.25)).toBeCloseTo(at(0.25));
    });

    it('keeps a fading-out clip on its offset instead of snapping it back to zero', () => {
        const a = makeAnimator([walk(), run()]);
        a.setStateMachine(speedMachine({
            mode: '1d', xAxis: { name: 'Speed', min: 0, max: 100, smoothing: 0 },
            samples: [{ clipName: 'walk', x: 0 }, { clipName: 'run', x: 100, phaseOffset: 0.5 }],
            weightSmoothing: 0.15,
        }));
        a.setFloat('Speed', 50);
        step(a, 1);

        // Snap onto walk. 'run' leaves the field's own weight set, so its SAMPLE — and with it the offset — is
        // gone; only the remembered meta keeps it posed where it was. Losing that would jog it half a cycle on
        // the very frame it starts fading, which is a pop in the middle of the fade meant to prevent one.
        a.setFloat('Speed', 0);
        a.checkTriggers();
        a.update(1 / 60);
        const fading = a.fieldDebug.weights.find(w => w.clipName === 'run');
        expect(fading).toBeDefined();
        expect(fading!.weight).toBeGreaterThan(0.1);
        expect(fading!.phaseOffset).toBeCloseTo(0.5);
    });
});

// ---------------------------------------------------------------------------------------------------
// Playback rate vs filter response.
//
// Two unrelated quantities that used to share one variable. `_deltaTime` is frame time scaled by the state's
// playback speed, which is right for advancing phase and wrong for everything damped: axis smoothing, weight
// smoothing and the IK foot weights are all authored in SECONDS, so scaling their dt made a state at half
// speed take twice as long to settle.
//
// At speed 0 it stopped being a stretch and became a hole: each filter reads `dt <= 0` as "do not filter" and
// returns its target raw. A Speed parameter bound to a SIGNED built-in — forwardSpeed, lateralSpeed,
// planarAngle — clamps to exactly 0 the moment it goes negative, so the clips froze while the blend went on
// being recomputed every frame from an unsmoothed probe. On screen: the whole pose vibrating, on one side of
// the axis only, which is what made it read as anything but a playback-speed problem.
// ---------------------------------------------------------------------------------------------------

/** A machine whose field state reads its rate from a second parameter, the way a signed built-in would. */
function ratedMachine(field: AnimationField) {
    return {
        parameters: [
            { name: 'Speed', type: 'float', default: 0 } as AnimationParameter,
            { name: 'Rate', type: 'float', default: 1 } as AnimationParameter,
        ],
        states: [{
            name: 'Locomotion', clipName: '', loop: true, speed: 1, isEntry: true,
            field, fieldInputs: { x: 'Speed' }, speedParam: 'Rate',
        } as AnimationState],
        transitions: [],
        events: [],
    } as AnimationStateMachine;
}

const smoothedField = (): AnimationField => ({
    ...field1D(), xAxis: { name: 'Speed', min: 0, max: 100, smoothing: 0.2 },
});

describe('Animator — filtering is wall-clock, not playback-scaled', () => {
    /** Probe position after `seconds` of a step input, with the state running at `playbackSpeed`. */
    function probeAfter(playbackSpeed: number, seconds: number): number {
        const a = makeAnimator([walk(), run()]);
        a.setStateMachine(speedMachine(smoothedField(), { speed: playbackSpeed }));
        a.setFloat('Speed', 100);
        step(a, seconds);
        return a.fieldDebug.probeX;
    }

    it('closes the same fraction of the gap in the same wall-clock time at any playback speed', () => {
        const atNormal = probeAfter(1, 0.2);
        // A 0.2s time constant over 0.2s is ~63% of the way. Sanity, so the comparison below is not vacuous.
        expect(atNormal).toBeGreaterThan(50);
        expect(atNormal).toBeLessThan(80);

        // Previously these were a factor of four apart: half speed halved the dt fed to the damp.
        expect(probeAfter(0.5, 0.2)).toBeCloseTo(atNormal, 6);
        expect(probeAfter(2, 0.2)).toBeCloseTo(atNormal, 6);
        expect(probeAfter(0.25, 0.2)).toBeCloseTo(atNormal, 6);
    });

    /**
     * The reported bug, reduced. A negative Speed parameter pins playback to 0; the probe must still ease.
     * Before the fix `_dampAxis` saw `dt <= 0` and returned the target, so this read 100 on the first frame.
     */
    it('still eases the probe when a negative Speed parameter has frozen playback', () => {
        const a = makeAnimator([walk(), run()]);
        a.setStateMachine(ratedMachine(smoothedField()));
        a.setFloat('Rate', -3);          // e.g. forwardSpeed while backpedalling
        a.setFloat('Speed', 100);

        a.checkTriggers();
        a.update(1 / 60);
        expect(a.speed).toBe(0);                         // the clamp still holds: no reverse playback
        expect(a.fieldDebug.probeX).toBeGreaterThan(0);  // ...but the filter is still running
        expect(a.fieldDebug.probeX).toBeLessThan(20);

        step(a, 0.2);
        expect(a.fieldDebug.probeX).toBeCloseTo(probeAfter(1, 0.2 + 1 / 60), 6);
    });

    it('still fades weights out when a negative Speed parameter has frozen playback', () => {
        const a = makeAnimator([walk(), run()]);
        a.setStateMachine(ratedMachine({
            mode: '1d', xAxis: { name: 'Speed', min: 0, max: 100, smoothing: 0 },
            samples: [{ clipName: 'walk', x: 0 }, { clipName: 'run', x: 100 }],
            weightSmoothing: 0.15,
        }));
        a.setFloat('Speed', 100);
        step(a, 1);
        expect(weightOf(a, 'run')).toBeCloseTo(1);

        a.setFloat('Rate', -3);
        a.setFloat('Speed', 0);          // snap the probe; only the weight damping can soften this
        a.checkTriggers();
        a.update(1 / 60);

        expect(a.speed).toBe(0);
        // 'walk' is what the field now asks for; 'run' must still be fading rather than gone in one frame.
        expect(weightOf(a, 'run')).toBeGreaterThan(0.5);
        expect(weightOf(a, 'walk')).toBeLessThan(0.5);
    });

    it('leaves a state whose rate parameter is positive completely alone', () => {
        const a = makeAnimator([walk(), run()]);
        a.setStateMachine(ratedMachine(smoothedField()));
        a.setFloat('Rate', 2);
        a.setFloat('Speed', 100);
        step(a, 0.2);
        expect(a.speed).toBe(2);
        expect(a.fieldDebug.probeX).toBeCloseTo(probeAfter(1, 0.2), 6);
    });
});

import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import type { AnimationStateMachine } from '../src/animation/animator';

// The two gates that stop a state machine changing its mind every frame.
//
// A threshold on a MEASURED parameter chatters: a speed hovering at 0.1 satisfies `> 0.1` and `< 0.1` on
// alternating frames, so a machine with one of each re-enters a state every frame — restarting its clip,
// re-arming its cross-fade from a pose that has barely moved, and reading on screen as a spasm rather than as
// an animation. `minDwell` refuses to leave a state at all for a while; `hysteresis` makes the comparison
// itself stop flip-flopping. Neither needs a GL context.

const SKIN: Skin = {
    joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }],
    nodeTransforms: new Map([[0, mat4.create()]]),
};

function clip(name: string): Animation {
    return {
        name,
        samplers: [{ input: [0, 1], output: [0, 0, 0, 1, 0, 0], interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
    };
}

function makeAnimator(): Animator {
    const model = { skin: SKIN, animations: [clip('idle'), clip('run')] } as unknown as AnimatedModel;
    return new Animator(model);
}

/** Advance the machine by `seconds`, exactly as ModelNode.update does: triggers first, then playback. */
function step(a: Animator, seconds: number, dt = 1 / 60) {
    for (let t = 0; t < seconds - 1e-9; t += dt) {
        a.checkTriggers();
        a.update(dt);
    }
}

describe('AnimationTransition.minDwell', () => {
    /** Idle -> Run with nothing gating it but the dwell time. */
    const machine = (minDwell?: number): AnimationStateMachine => ({
        parameters: [],
        states: [
            { name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true },
            { name: 'Run', clipName: 'run', loop: true, speed: 1 },
        ],
        transitions: [{ from: 'Idle', to: 'Run', conditions: [], minDwell }],
        events: [],
    });

    it('fires immediately when no dwell is set', () => {
        const a = makeAnimator();
        a.setStateMachine(machine());
        step(a, 1 / 60);
        expect(a.currentStateName).toBe('Run');
    });

    it('holds the state until the dwell has elapsed, then fires', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(0.5));

        step(a, 0.3);
        expect(a.currentStateName).toBe('Idle');

        step(a, 0.3);   // 0.6s total, past the gate
        expect(a.currentStateName).toBe('Run');
    });

    it('restarts the clock on every entry, not just the first', () => {
        const a = makeAnimator();
        const sm = machine(0.4);
        // The way back is gated on a bool rather than left open, so the test drives one Idle -> Run -> Idle
        // round trip deliberately. Leaving it ungated would have the pair bounce every frame — which is what
        // minDwell exists to stop, and would tell us nothing about where the clock starts.
        sm.parameters.push({ name: 'Back', type: 'bool', default: false });
        sm.transitions.push({
            from: 'Run', to: 'Idle', conditions: [{ param: 'Back', op: 'true' }],
        });
        a.setStateMachine(sm);

        step(a, 0.5);
        expect(a.currentStateName).toBe('Run');

        a.setBool('Back', true);
        step(a, 1 / 60);
        expect(a.currentStateName).toBe('Idle');
        a.setBool('Back', false);

        // A fresh 0.4s gate, counted from THIS entry — not from the 0.5s already spent in the first Idle.
        step(a, 0.2);
        expect(a.currentStateName).toBe('Idle');
        step(a, 0.3);
        expect(a.currentStateName).toBe('Run');
    });

    /**
     * A non-looping state that has finished sets `_playing` false, and `update()` returns early from then on.
     * If the dwell clock lived below that return it would freeze, and a transition waiting on it could never
     * fire — locking the machine into that state permanently.
     */
    it('keeps counting after a non-looping clip has finished', () => {
        const a = makeAnimator();
        const sm = machine(0.5);
        sm.states[0].loop = false;   // idle is 1s long; the dwell is well inside it, so force it shorter
        sm.transitions[0].minDwell = 2;
        a.setStateMachine(sm);

        step(a, 1.5);
        expect(a.isPlaying).toBe(false);            // the clip is over and holding its last frame
        expect(a.currentStateName).toBe('Idle');
        step(a, 1);                                 // 2.5s total
        expect(a.currentStateName).toBe('Run');
    });
});

describe('AnimationCondition.hysteresis', () => {
    /**
     * `Idle -> Run` needs BOTH `Speed > 1` and `Go`. The bool is what lets the band be observed: the threshold
     * is evaluated (and so latches) on frames where the transition cannot fire, which is exactly how it
     * behaves in a real machine — it tracks the signal, not the transition.
     */
    const machine = (hysteresis?: number): AnimationStateMachine => ({
        parameters: [
            { name: 'Speed', type: 'float', default: 0 },
            { name: 'Go', type: 'bool', default: false },
        ],
        states: [
            { name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true },
            { name: 'Run', clipName: 'run', loop: true, speed: 1 },
        ],
        transitions: [{
            from: 'Idle', to: 'Run', conditions: [],
            condition: {
                op: 'and',
                children: [
                    { param: 'Speed', op: 'gt', value: 1, hysteresis },
                    { param: 'Go', op: 'true' },
                ],
            },
        }],
        events: [],
    });

    it('without a band, the threshold is all that matters', () => {
        const a = makeAnimator();
        a.setStateMachine(machine());
        a.setFloat('Speed', 0.8);
        a.setBool('Go', true);
        step(a, 0.5);
        expect(a.currentStateName).toBe('Idle');
    });

    // A band of 0.5 on `> 1` engages at 1.25 and releases at 0.75.
    it('waits for the top of the band before engaging', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(0.5));
        a.setFloat('Speed', 1.1);   // past the threshold, but not past the engage point
        a.setBool('Go', true);
        step(a, 0.5);
        expect(a.currentStateName).toBe('Idle');
    });

    it('keeps matching below the threshold once it has engaged', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(0.5));

        // Clear the engage point while the other half of the gate blocks the transition. The band latches.
        a.setFloat('Speed', 1.4);
        step(a, 0.2);
        expect(a.currentStateName).toBe('Idle');

        // Now 0.8: below the threshold entirely, but still above the release point, so it remains met.
        a.setFloat('Speed', 0.8);
        a.setBool('Go', true);
        step(a, 1 / 60);
        expect(a.currentStateName).toBe('Run');
    });

    it('does not match below the threshold if it never engaged', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(0.5));
        // Same 0.8 and same band as above — the only difference is that the signal never got up to 1.25.
        a.setFloat('Speed', 0.8);
        a.setBool('Go', true);
        step(a, 0.5);
        expect(a.currentStateName).toBe('Idle');
    });

    it('releases once the parameter falls all the way back through the band', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(0.5));

        a.setFloat('Speed', 1.4);   // engage
        step(a, 0.2);
        a.setFloat('Speed', 0.4);   // below the 0.75 release point — the latch must drop
        step(a, 0.2);

        a.setBool('Go', true);
        step(a, 0.5);
        expect(a.currentStateName).toBe('Idle');
    });

    /**
     * The case the whole feature exists for, and the reason the band is CENTRED rather than one-sided.
     *
     * `Speed > 1` / `Speed < 1` either side of one threshold is what a locomotion machine is authored as, and
     * a measured speed hovering at 1.0 satisfies both on alternating frames. Widening only each condition's
     * release would not help: 0.95 genuinely is `< 1` and 1.05 genuinely is `> 1`, so both would still engage
     * and the machine would still flip every frame. Centring pushes the engage points to 1.2 and 0.8.
     */
    it('stops a parameter oscillating on the threshold from flipping the machine', () => {
        const a = makeAnimator();
        const sm = machine(0.4);
        sm.transitions[0].condition = { op: 'and', children: [{ param: 'Speed', op: 'gt', value: 1, hysteresis: 0.4 }] };
        sm.transitions.push({
            from: 'Run', to: 'Idle', conditions: [],
            condition: { op: 'and', children: [{ param: 'Speed', op: 'lt', value: 1, hysteresis: 0.4 }] },
        });
        a.setStateMachine(sm);

        const churn = (from: number, to: number, frames: number) => {
            let entries = 0;
            let prev = a.currentStateName;
            for (let i = 0; i < frames; i++) {
                a.setFloat('Speed', i % 2 === 0 ? from : to);
                a.checkTriggers();
                a.update(1 / 60);
                if (a.currentStateName !== prev) { entries++; prev = a.currentStateName; }
            }
            return entries;
        };

        // Four seconds of noise straddling the threshold: nothing moves at all.
        expect(churn(1.05, 0.95, 240)).toBe(0);
        expect(a.currentStateName).toBe('Idle');

        // But the pair is not deaf — a genuine swing past the engage point still works, in both directions.
        a.setFloat('Speed', 1.5);
        step(a, 1 / 60);
        expect(a.currentStateName).toBe('Run');

        // And it stays in Run through the same noise, now from the other side.
        expect(churn(1.05, 0.95, 240)).toBe(0);
        expect(a.currentStateName).toBe('Run');

        a.setFloat('Speed', 0.5);
        step(a, 1 / 60);
        expect(a.currentStateName).toBe('Idle');
    });
});

// ---------------------------------------------------------------------------------------------------
// The band has to advance every frame, not only while its own state is active.
//
// `_evaluateStateMachine` walks the transitions leaving the CURRENT state and nothing else, so a band was
// only advanced while its source state happened to be active — and the pair this feature exists for lives on
// two different states. `Speed > 0.1 +-0.1` sits on `Idle -> Locomotion`; `Speed < 0.1 +-0.1` on
// `Locomotion -> Idle`. Each was frozen exactly while the other was being consulted, so both could latch ON,
// and a latched condition tests its RELEASE point: `>` read true down to 0.05 while `<` read true up to 0.15.
// Everything in between satisfied both and the machine flipped every frame — a ping-pong at precisely the
// values the band was added to prevent, with the fix apparently already applied.
// ---------------------------------------------------------------------------------------------------

describe('hysteresis across a state pair', () => {
    /** The locomotion gate exactly as the example README documents it. */
    const gate = (hysteresis?: number): AnimationStateMachine => ({
        parameters: [{ name: 'Speed', type: 'float', default: 0 }],
        states: [
            { name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true },
            { name: 'Locomotion', clipName: 'run', loop: true, speed: 1 },
        ],
        transitions: [
            { from: 'Idle', to: 'Locomotion', conditions: [{ param: 'Speed', op: 'gt', value: 0.1, hysteresis }] },
            { from: 'Locomotion', to: 'Idle', conditions: [{ param: 'Speed', op: 'lt', value: 0.1, hysteresis }] },
        ],
        events: [],
    } as unknown as AnimationStateMachine);

    /** State changes over `seconds` while `Speed` is held at `speed`. */
    function flipsWhileHeld(a: Animator, speed: number, seconds: number): number {
        a.setFloat('Speed', speed);
        let flips = 0;
        let last = a.currentStateName;
        for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
            a.checkTriggers();
            a.update(1 / 60);
            if (a.currentStateName !== last) { flips++; last = a.currentStateName; }
        }
        return flips;
    }

    /**
     * The regression, driven the way a real character does it: cross UP through the band, back DOWN through
     * it, then settle in the middle. Both latches are engaged by that round trip, which is what used to leave
     * the pair permanently satisfiable.
     */
    it('settles inside the band after a round trip through it', () => {
        const a = makeAnimator();
        a.setStateMachine(gate(0.1));

        expect(flipsWhileHeld(a, 0.2, 0.3)).toBe(1);       // up through 0.15: Idle -> Locomotion, once
        expect(a.currentStateName).toBe('Locomotion');

        expect(flipsWhileHeld(a, 0.04, 0.3)).toBe(1);      // down through 0.05: back to Idle, once
        expect(a.currentStateName).toBe('Idle');

        // Now sit in the middle of the band. Neither engage point is reached, so nothing may happen at all.
        expect(flipsWhileHeld(a, 0.1, 2)).toBe(0);
        expect(a.currentStateName).toBe('Idle');
    });

    it('holds the other way round too — settling inside the band from above', () => {
        const a = makeAnimator();
        a.setStateMachine(gate(0.1));

        flipsWhileHeld(a, 0.04, 0.2);
        flipsWhileHeld(a, 0.2, 0.2);
        expect(a.currentStateName).toBe('Locomotion');

        // Dropping only to mid-band must NOT release: `< 0.1 +-0.1` does not engage until 0.05.
        expect(flipsWhileHeld(a, 0.1, 2)).toBe(0);
        expect(a.currentStateName).toBe('Locomotion');
    });

    it('still responds when the signal genuinely swings past an engage point', () => {
        const a = makeAnimator();
        a.setStateMachine(gate(0.1));
        expect(flipsWhileHeld(a, 0.2, 0.2)).toBe(1);
        expect(flipsWhileHeld(a, 0.0, 0.2)).toBe(1);
        expect(flipsWhileHeld(a, 0.2, 0.2)).toBe(1);
        expect(a.currentStateName).toBe('Locomotion');
    });

    /**
     * A DITHERING signal, which is what a measured speed actually is — the character's own `planarSpeed`
     * comes off a smoothed position delta and is never perfectly still. A constant value only ever satisfies
     * one side of the pair; it takes noise straddling the threshold to make both fire, and that is the real
     * case both the band and the ping-pong report exist for.
     */
    function flipsWhileDithering(a: Animator, centre: number, amplitude: number, seconds: number): number {
        let flips = 0;
        let last = a.currentStateName;
        for (let i = 0; i < seconds * 60; i++) {
            a.setFloat('Speed', centre + (i % 2 === 0 ? amplitude : -amplitude));
            a.checkTriggers();
            a.update(1 / 60);
            if (a.currentStateName !== last) { flips++; last = a.currentStateName; }
        }
        return flips;
    }

    it('chatters on a dithering signal without a band — the case the band exists for', () => {
        const a = makeAnimator();
        a.setStateMachine(gate());
        expect(flipsWhileDithering(a, 0.1, 0.001, 1)).toBeGreaterThan(10);
    });

    // ...and the same signal, with a band, must not move the machine at all. This is the user-facing claim.
    it('absorbs that same dithering signal once the band is authored', () => {
        const a = makeAnimator();
        a.setStateMachine(gate(0.1));
        flipsWhileHeld(a, 0.2, 0.2);                       // start in Locomotion, band engaged
        flipsWhileHeld(a, 0.04, 0.2);                      // round-trip back to Idle, both latches touched
        expect(a.currentStateName).toBe('Idle');
        expect(flipsWhileDithering(a, 0.1, 0.001, 2)).toBe(0);
    });

    // Noise larger than the band is not noise any more, and must still be obeyed.
    it('still fires when the dither is wider than the band', () => {
        const a = makeAnimator();
        a.setStateMachine(gate(0.1));
        expect(flipsWhileDithering(a, 0.1, 0.2, 1)).toBeGreaterThan(10);
    });
});

/**
 * The case that actually discriminates: a signal that dips through the LOWER engage point and recovers into
 * the band within a frame or two — a character brushing a wall, or the tail of a root-motion step.
 *
 * Both bands must never be latched ON at once. If they are, each one tests its RELEASE point (`> 0.1` reads
 * true down to 0.05, `< 0.1` true up to 0.15) and the whole band satisfies both, so the machine flips every
 * frame at exactly the values the band was authored to protect.
 *
 * That is only avoidable if `> 0.1` is advanced on the frame the value dips — and that frame is spent in
 * Locomotion, where nothing would ever look at a condition belonging to `Idle -> Locomotion`. Hence the
 * per-frame refresh over EVERY transition.
 */
describe('hysteresis — both bands must not latch at once', () => {
    const gate = (): AnimationStateMachine => ({
        parameters: [{ name: 'Speed', type: 'float', default: 0 }],
        states: [
            { name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true },
            { name: 'Locomotion', clipName: 'run', loop: true, speed: 1 },
        ],
        transitions: [
            { from: 'Idle', to: 'Locomotion', conditions: [{ param: 'Speed', op: 'gt', value: 0.1, hysteresis: 0.1 }] },
            { from: 'Locomotion', to: 'Idle', conditions: [{ param: 'Speed', op: 'lt', value: 0.1, hysteresis: 0.1 }] },
        ],
        events: [],
    } as unknown as AnimationStateMachine);

    /** Drive one explicit value per frame, counting state changes. */
    function drive(a: Animator, values: number[]): number {
        let flips = 0;
        let last = a.currentStateName;
        for (const v of values) {
            a.setFloat('Speed', v);
            a.checkTriggers();
            a.update(1 / 60);
            if (a.currentStateName !== last) { flips++; last = a.currentStateName; }
        }
        return flips;
    }

    it('settles after a one-frame dip through the lower engage point', () => {
        const a = makeAnimator();
        a.setStateMachine(gate());

        drive(a, Array(10).fill(0.3));            // solidly in Locomotion; the '>' band is engaged
        expect(a.currentStateName).toBe('Locomotion');

        // One frame at 0.04 engages '< 0.1 +-0.1' and drops to Idle. That same frame must RELEASE the '>'
        // band — it is the only moment the value is low enough to do so.
        drive(a, [0.04]);
        expect(a.currentStateName).toBe('Idle');

        // Recover into the middle of the band and stay there. Neither engage point (0.15 / 0.05) is reached,
        // so the machine must not move again. Previously '>' was still latched from before the dip and read
        // true at 0.10, so this flipped every frame for as long as the character kept moving slowly.
        expect(drive(a, Array(120).fill(0.1))).toBe(0);
        expect(a.currentStateName).toBe('Idle');
    });

    it('holds symmetrically after a one-frame spike through the upper engage point', () => {
        const a = makeAnimator();
        a.setStateMachine(gate());

        drive(a, Array(10).fill(0.0));            // solidly Idle; the '<' band is engaged
        drive(a, [0.2]);                          // one frame over 0.15 -> Locomotion
        expect(a.currentStateName).toBe('Locomotion');

        expect(drive(a, Array(120).fill(0.1))).toBe(0);
        expect(a.currentStateName).toBe('Locomotion');
    });
});

import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { Animator } from '../src/graphics/animator';
import type { AnimatedModel, Animation, Skin } from '../src/graphics/animatedModel';
import type { AnimationStateMachine } from '../src/graphics/animator';

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

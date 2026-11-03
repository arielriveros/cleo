import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimationStateMachine, AnimationState } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';

// Controller layers, bone masks, pose states, action slots and clip-owned events.
//
// The rig is a two-bone chain, Hips (node 0) -> Spine (node 1), both at rest identity. Every clip rotates
// about +Y, so each bone's pose reads as one signed angle — and a mask that leaks shows up as the wrong
// bone moving.

const SKIN: Skin = {
    joints: [
        { nodeIndex: 0, inverseBindMatrix: mat4.create() },
        { nodeIndex: 1, inverseBindMatrix: mat4.create(), parentIndex: 0 },
    ],
    nodeParents: new Map([[1, 0]]),
    nodeTransforms: new Map([[0, mat4.create()], [1, mat4.create()]]),
    nodeNames: new Map([[0, 'Hips'], [1, 'Spine']]),
};

const qy = (deg: number) => quat.setAxisAngle(quat.create(), [0, 1, 0], deg * Math.PI / 180);

/** A clip turning BOTH bones from `fromDeg` to `toDeg` over `duration` seconds. */
function clip(name: string, fromDeg: number, toDeg: number, duration = 1, events?: Animation['events']): Animation {
    const a = qy(fromDeg), b = qy(toDeg);
    const out = [a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]];
    return {
        name,
        samplers: [
            { input: [0, duration], output: out.slice(), interpolation: 'LINEAR' },
            { input: [0, duration], output: out.slice(), interpolation: 'LINEAR' },
        ],
        channels: [
            { samplerIndex: 0, targetNodeIndex: 0, targetPath: 'rotation' },
            { samplerIndex: 1, targetNodeIndex: 1, targetPath: 'rotation' },
        ],
        ...(events ? { events } : {}),
    } as Animation;
}

const CLIPS: Animation[] = [
    clip('Base', 30, 30),          // both bones held at +30
    clip('Hold', -40, -40),        // both bones held at -40
    clip('Nod', 0, 60),            // 0 -> 60 over a second: an ADDITIVE source, referenced to its first frame
    clip('Swing', 10, 10, 0.5, [{ time: 0.25, name: 'hit' }]),
];

function makeAnimator(): Animator {
    const node = {
        position: vec3.create(), quaternion: quat.create(), worldQuaternion: quat.create(),
        setPosition() {}, setQuaternion() {}, parent: null, body: null, currentSpeed: 0,
    };
    return new Animator({ skin: SKIN, animations: CLIPS } as unknown as AnimatedModel, node as any);
}

const state = (name: string, clipName: string, extra: Partial<AnimationState> = {}): AnimationState =>
    ({ name, clipName, loop: true, speed: 1, ...extra });

function machine(over: Partial<AnimationStateMachine> = {}): AnimationStateMachine {
    return {
        parameters: [{ name: 'Aim', type: 'float', default: 1 }],
        states: [state('Base', 'Base', { isEntry: true })],
        transitions: [],
        events: [],
        ...over,
    };
}

/** A bone's LOCAL rotation about +Y in degrees, read from the posed model-space joints. */
function localAngle(a: Animator, joint: 0 | 1): number {
    const model = a.getJointModelMatrix(joint)!;
    const local = joint === 0
        ? model
        : mat4.multiply(mat4.create(), mat4.invert(mat4.create(), a.getJointModelMatrix(0)!)!, model);
    const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), local));
    const axis = vec3.create();
    const angle = quat.getAxisAngle(axis, q) * 180 / Math.PI;
    return axis[1] < 0 ? -angle : angle;
}

const frame = (a: Animator, dt = 1 / 60) => { a.checkTriggers(); a.update(dt); };

describe('Animator — layers', () => {
    it('plays a machine with no layers exactly as before', () => {
        const a = makeAnimator();
        a.setStateMachine(machine());
        frame(a);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);
        expect(localAngle(a, 1)).toBeCloseTo(30, 3);
        expect(a.layerNames).toEqual([]);
    });

    it('overrides only the masked bones', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({
            layers: [{ name: 'Upper', states: [state('Hold', 'Hold', { isEntry: true })], transitions: [], mask: { Spine: 1 } }],
        }));
        frame(a);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);   // Hips: not in the mask, still the base
        expect(localAngle(a, 1)).toBeCloseTo(-40, 3);  // Spine: the layer
        expect(a.layerStateName('Upper')).toBe('Hold');
    });

    it('mixes by weight, and reads it from a parameter when one is named', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({
            parameters: [{ name: 'Aim', type: 'float', default: 0.5 }],
            layers: [{ name: 'Upper', states: [state('Hold', 'Hold', { isEntry: true })], transitions: [], weightParam: 'Aim' }],
        }));
        frame(a);
        expect(localAngle(a, 0)).toBeCloseTo(-5, 2);   // halfway between +30 and -40
        a.setFloat('Aim', 0);
        frame(a);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);
    });

    it('mixes by a fixed weight below 1', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({
            layers: [{ name: 'Upper', states: [state('Hold', 'Hold', { isEntry: true })], transitions: [], weight: 0.5 }],
        }));
        frame(a);
        expect(localAngle(a, 0)).toBeCloseTo(-5, 2);
    });

    // In the editor nothing moves, so a parameter LINKED to the character's speed reads 0 and a layer gated
    // on it can never be previewed. A preview override pins it until cleared.
    it('lets the preview pin a linked parameter, and follow the link again', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({
            parameters: [{ name: 'Aim', type: 'variable', default: 0, variable: { nodeRef: 'self', varName: 'planarSpeed', varType: 'number', source: 'builtin' } }],
            layers: [{ name: 'Upper', states: [state('Hold', 'Hold', { isEntry: true })], transitions: [], weightParam: 'Aim' }],
        }));
        a.setParamOverride('Aim', 1);
        frame(a);
        expect(a.getParam('Aim')).toBe(1);
        expect(localAngle(a, 0)).toBeCloseTo(-40, 2);
        a.setParamOverride('Aim', null);
        frame(a);
        expect(a.getParam('Aim')).not.toBe(1);
    });

    it('adds an additive layer relative to its clip’s first frame', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({
            layers: [{ name: 'Breathe', blend: 'additive', states: [state('Nod', 'Nod', { isEntry: true })], transitions: [] }],
        }));
        frame(a, 0);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);   // the first frame IS the reference: nothing added
        frame(a, 0.5);
        expect(localAngle(a, 0)).toBeCloseTo(60, 2);   // +30 base, +30 of nod added on top
    });

    it('contributes nothing from an empty state, and fades in when it leaves it', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({
            parameters: [{ name: 'Armed', type: 'bool', default: false }],
            layers: [{
                name: 'Upper',
                states: [state('Empty', '', { isEntry: true }), state('Hold', 'Hold')],
                transitions: [{ from: 'Empty', to: 'Hold', conditions: [{ param: 'Armed', op: 'true' }], blendTime: 0.2 }],
            }],
        }));
        frame(a);
        expect(localAngle(a, 1)).toBeCloseTo(30, 3);
        a.setBool('Armed', true);
        frame(a, 0.1);
        const mid = localAngle(a, 1);
        expect(mid).toBeLessThan(30);
        expect(mid).toBeGreaterThan(-40);              // part-way through the fade
        for (let i = 0; i < 10; i++) frame(a, 0.05);
        expect(localAngle(a, 1)).toBeCloseTo(-40, 2);
    });
});

describe('Animator — pose states', () => {
    it('holds a pose — delta x rest — on just the bones it lists', () => {
        const a = makeAnimator();
        const d = qy(25);
        a.setStateMachine(machine({
            layers: [{
                name: 'Grip',
                states: [state('Grip', '', { isEntry: true, pose: { name: 'Grip', bones: [{ name: 'Spine', rotation: [d[0], d[1], d[2], d[3]] }] } })],
                transitions: [],
            }],
        }));
        frame(a);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);   // Hips not in the pose: the base shows through
        expect(localAngle(a, 1)).toBeCloseTo(25, 3);   // Spine: rest (identity) x 25
    });
});

describe('Animator — actions', () => {
    it('fades an action in over the base, then out again on its own', async () => {
        const a = makeAnimator();
        a.setStateMachine(machine());
        frame(a);
        const handle = a.playAction('Swing', { blendIn: 0.1, blendOut: 0.1 });
        frame(a, 0.05);
        const fadingIn = localAngle(a, 0);
        expect(fadingIn).toBeLessThan(30);
        expect(fadingIn).toBeGreaterThan(10);
        frame(a, 0.1);
        expect(localAngle(a, 0)).toBeCloseTo(10, 2);   // fully in
        expect(a.isActionPlaying()).toBe(true);
        for (let i = 0; i < 20; i++) frame(a, 0.05);
        expect(handle.done).toBe(true);
        await handle.finished;
        expect(a.isActionPlaying()).toBe(false);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);   // back on the base
    });

    it('stops on request, and keeps the legs through a masked slot', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({ slots: [{ name: 'UpperBody', mask: { Spine: 1 } }] }));
        frame(a);
        const handle = a.playAction('Hold', { loop: true, blendIn: 0.01 });
        frame(a, 0.05);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);   // Hips: outside the slot's mask
        expect(localAngle(a, 1)).toBeCloseTo(-40, 3);
        handle.stop(0.05);
        for (let i = 0; i < 3; i++) frame(a, 0.05);
        expect(handle.done).toBe(true);
        expect(localAngle(a, 1)).toBeCloseTo(30, 3);
    });

    it('resolves at once for a clip that does not exist', async () => {
        const a = makeAnimator();
        const handle = a.playAction('Nope');
        expect(handle.done).toBe(true);
        await handle.finished;
    });
});

describe('Animator — clip-owned events', () => {
    it('fires a clip’s own marker from an action slot', () => {
        const a = makeAnimator();
        a.setStateMachine(machine());
        const fired: string[] = [];
        a.onAnimationEvent(name => fired.push(name));
        frame(a);
        a.playAction('Swing');
        frame(a, 0.2);
        expect(fired).toEqual([]);
        frame(a, 0.1);                                 // crosses t = 0.25
        expect(fired).toEqual(['hit']);
    });

    it('fires a clip’s own marker from the base state too', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({ states: [state('Swing', 'Swing', { isEntry: true })] }));
        const fired: string[] = [];
        a.onAnimationEvent(name => fired.push(name));
        frame(a, 0.2);
        frame(a, 0.1);
        expect(fired).toEqual(['hit']);
    });
});

describe('Animator — an Actions layer: one-shots entered from Any State on a trigger', () => {
    const trig = (param: string) => ({ op: 'and' as const, children: [{ param, op: 'trigger' as const }] });
    /** Base 'Base'; a full-body Actions layer resting in an empty Off, with Hold and Swing one-shots. */
    function actions(over: { hold?: Partial<AnimationState>; anyHold?: object; extra?: any[]; base?: any[] } = {}): AnimationStateMachine {
        return machine({
            parameters: [
                { name: 'Hold', type: 'trigger', default: false },
                { name: 'Swing', type: 'trigger', default: false },
                { name: 'Died', type: 'trigger', default: false },
                { name: 'Rate', type: 'float', default: 1 },
            ],
            states: [state('Base', 'Base', { isEntry: true }), state('Dead', 'Hold')],
            transitions: [{ from: 'Base', to: 'Dead', conditions: [], condition: trig('Died'), blendTime: 0 }, ...(over.base ?? [])],
            layers: [{
                name: 'Actions',
                states: [
                    state('Off', '', { isEntry: true }),
                    state('Hold', 'Hold', { loop: false, ...over.hold }),
                    state('Swing', 'Swing', { loop: false }),
                ],
                transitions: [
                    { from: '*', to: 'Off', conditions: [], condition: trig('Died'), blendTime: 0.1 },
                    { from: '*', to: 'Hold', conditions: [], condition: trig('Hold'), blendTime: 0.1, ...over.anyHold },
                    { from: '*', to: 'Swing', conditions: [], condition: trig('Swing'), blendTime: 0.1 },
                    { from: 'Hold', to: 'Off', conditions: [], hasExitTime: true, exitTime: 1, blendTime: 0.2 },
                    { from: 'Swing', to: 'Off', conditions: [], hasExitTime: true, exitTime: 1, blendTime: 0.2 },
                    ...(over.extra ?? []),
                ],
            }],
        });
    }

    it('rests adding nothing, plays a one-shot over everything on its trigger, and fades back out at its end', () => {
        const a = makeAnimator();
        a.setStateMachine(actions());
        frame(a);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);         // Off: the base shows
        a.setTrigger('Hold');
        frame(a, 0.05);
        expect(a.layerStateName('Actions')).toBe('Hold');
        expect(localAngle(a, 0)).toBeCloseTo(-5, 1);         // halfway through its 0.1 s blend in
        frame(a, 0.1);
        expect(localAngle(a, 0)).toBeCloseTo(-40, 3);
        expect(a.layerStateTime('Actions')).toBeCloseTo(0.15, 6);
        expect(a.layerStateDuration('Actions')).toBeCloseTo(1, 6);
        frame(a, 0.9);                                       // the clip's end
        frame(a, 0.1);                                       // exit fires, fading over 0.2 s
        expect(a.layerStateName('Actions')).toBe('Off');
        expect(localAngle(a, 0)).toBeCloseTo(-5, 1);
        frame(a, 0.15);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);
        expect(a.layerStateTime('Actions')).toBe(0);
    });

    it('cross-fades from the pose still fading out when a one-shot interrupts the fade', () => {
        const a = makeAnimator();
        a.setStateMachine(actions());
        frame(a);
        a.setTrigger('Hold');
        frame(a, 0.2);
        frame(a, 0.85);
        frame(a, 0.05);                                      // Hold ended: fading to Off over 0.2 s
        frame(a, 0.05);                                      // half faded: (30 + -40) / 2
        const before = localAngle(a, 0);
        expect(before).toBeCloseTo(-5, 1);
        a.setTrigger('Swing');
        frame(a, 1 / 60);
        // From the pose on screen toward Swing's +10 as the layer comes back in (about 6° in a frame), not a
        // jump to Swing's first frame at the half-faded presence (about 22°).
        expect(Math.abs(localAngle(a, 0) - before)).toBeLessThan(10);
        expect(a.layerStateName('Actions')).toBe('Swing');
    });

    it('fires a trigger on every layer that reads it in the frame, then lowers it', () => {
        const a = makeAnimator();
        a.setStateMachine(actions());
        frame(a);
        a.setTrigger('Hold');
        frame(a, 0.2);
        a.setTrigger('Died');
        frame(a);
        expect(a.currentStateName).toBe('Dead');               // the base fell...
        expect(a.layerStateName('Actions')).toBe('Off');       // ... and the layer left its one-shot
        expect(a.getParam('Died')).toBe(false);
    });

    it('restarts a state from Any State only when the transition may go to itself', () => {
        const a = makeAnimator();
        a.setStateMachine(actions({ anyHold: { canTransitionToSelf: true } }));
        frame(a);
        a.setTrigger('Hold');
        frame(a, 0.5);
        expect(a.layerStateTime('Actions')).toBeCloseTo(0.5, 6);
        a.setTrigger('Hold');
        frame(a, 0.1);
        expect(a.layerStateTime('Actions')).toBeCloseTo(0.1, 6);

        const b = makeAnimator();
        b.setStateMachine(actions());
        frame(b);
        b.setTrigger('Hold');
        frame(b, 0.5);
        b.setTrigger('Hold');
        frame(b, 0.1);
        expect(b.layerStateTime('Actions')).toBeCloseTo(0.6, 6);   // left alone; the trigger waits
        expect(b.getParam('Hold')).toBe(true);
    });

    it('starts a state part-way into its clip, and its events only from there', () => {
        const a = makeAnimator();
        a.setStateMachine(actions({ hold: { clipName: 'Swing', startTime: 0.3 } }));
        const fired: string[] = [];
        a.onAnimationEvent(name => fired.push(name));
        frame(a);
        a.setTrigger('Hold');
        frame(a, 0.1);
        expect(a.layerStateTime('Actions')).toBeCloseTo(0.4, 6);
        expect(fired).toEqual([]);                             // the 0.25 s `hit` is before the start
    });

    it('hands a segment over to the next on its trigger at the segment\'s end, the clip playing on', () => {
        const a = makeAnimator();
        a.setStateMachine(actions({
            hold: { clipName: 'Nod' },
            extra: [],
        }));
        const sm = a.getStateMachine()!;
        const layer = sm.layers![0];
        // Reached only from Hold: an Any-State entry on the same trigger would cut the segment short.
        sm.parameters.push({ name: 'Next', type: 'trigger', default: false });
        layer.states.push(state('Second', 'Nod', { loop: false, startTime: 0.5 }));
        layer.transitions.unshift({ from: 'Hold', to: 'Second', conditions: [], condition: trig('Next'), hasExitTime: true, exitTime: 0.5, blendTime: 0 });
        a.setStateMachine(sm);
        frame(a);
        a.setTrigger('Hold');
        frame(a, 0.2);
        a.setTrigger('Next');                                  // queued early...
        frame(a, 0.2);
        expect(a.layerStateName('Actions')).toBe('Hold');      // ... it waits for the segment's end
        frame(a, 0.15);                                        // 0.55 s: past it
        frame(a, 1 / 60);
        expect(a.layerStateName('Actions')).toBe('Second');
        expect(a.layerStateTime('Actions')).toBeCloseTo(0.5 + 1 / 60, 4);
    });

    it('multiplies a state\'s speed by its speed-multiplier parameter, live', () => {
        const a = makeAnimator();
        a.setStateMachine(actions({ hold: { speed: 2, speedScaleParam: 'Rate' } }));
        frame(a);
        a.setTrigger('Hold');
        frame(a, 0.1);
        expect(a.layerStateTime('Actions')).toBeCloseTo(0.2, 6);
        a.setFloat('Rate', 1.5);
        frame(a, 0.1);
        expect(a.layerStateTime('Actions')).toBeCloseTo(0.5, 6);
    });
});

describe('Animator — states entered directly by a trigger, by name', () => {
    const trig = (param: string) => ({ op: 'and' as const, children: [{ param, op: 'trigger' as const }] });
    const params = ['Hold', 'Swing', 'Next', 'Died', 'Stop'].map(name => ({ name, type: 'trigger' as const, default: false }));
    /** A full-body layer resting in Off; Hold and Swing entered by their own triggers, Off by Died and Stop. */
    function layered(over: { hold?: Partial<AnimationState>; transitions?: any[]; states?: AnimationState[] } = {}): AnimationStateMachine {
        return machine({
            parameters: [...params, { name: 'Rate', type: 'float', default: 2 }],
            layers: [{
                name: 'Actions',
                states: [
                    state('Off', '', { isEntry: true, triggers: [{ trigger: 'Died', blendTime: 0 }, { trigger: 'Stop', blendTime: 0.2 }] }),
                    state('Hold', 'Hold', { loop: false, triggers: [{ trigger: 'Hold', blendTime: 0.1 }], ...over.hold }),
                    state('Swing', 'Swing', { loop: false, triggers: [{ trigger: 'Swing', blendTime: 0.1 }] }),
                    ...(over.states ?? []),
                ],
                transitions: [
                    ...(over.transitions ?? []),
                    { from: 'Hold', to: 'Off', conditions: [], hasExitTime: true, exitTime: 1, blendTime: 0.2 },
                    { from: 'Swing', to: 'Off', conditions: [], hasExitTime: true, exitTime: 1, blendTime: 0.2 },
                ],
            }],
        });
    }

    it('enters the state its trigger names from wherever the layer is, with no transition, and lowers it', () => {
        const a = makeAnimator();
        a.setStateMachine(layered());
        frame(a);
        a.setTrigger('Hold');
        frame(a, 0.2);
        expect(a.layerStateName('Actions')).toBe('Hold');
        expect(localAngle(a, 0)).toBeCloseTo(-40, 3);
        expect(a.getParam('Hold')).toBe(false);
        a.setTrigger('Swing');                                 // from Hold too: nothing connects them
        frame(a, 0.05);
        expect(a.layerStateName('Actions')).toBe('Swing');
        a.setTrigger('Stop');
        frame(a);
        expect(a.layerStateName('Actions')).toBe('Off');
    });

    it('restarts a state its trigger fires again, unless told not to (then the trigger waits)', () => {
        const a = makeAnimator();
        a.setStateMachine(layered());
        frame(a);
        a.setTrigger('Hold');
        frame(a, 0.5);
        a.setTrigger('Hold');
        frame(a, 0.1);
        expect(a.layerStateTime('Actions')).toBeCloseTo(0.1, 6);

        const b = makeAnimator();
        b.setStateMachine(layered({ hold: { triggers: [{ trigger: 'Hold', blendTime: 0.1, restart: false }] } }));
        frame(b);
        b.setTrigger('Hold');
        frame(b, 0.5);
        b.setTrigger('Hold');
        frame(b, 0.1);
        expect(b.layerStateTime('Actions')).toBeCloseTo(0.6, 6);
        expect(b.getParam('Hold')).toBe(true);
    });

    it('checks Any State first, then state triggers in state order, then the state\'s own transitions', () => {
        const a = makeAnimator();
        // An Any State transition on Swing to Hold beats Swing's own trigger.
        a.setStateMachine(layered({ transitions: [{ from: '*', to: 'Hold', conditions: [], condition: trig('Swing'), blendTime: 0 }] }));
        frame(a);
        a.setTrigger('Swing');
        frame(a);
        expect(a.layerStateName('Actions')).toBe('Hold');

        // A death fired with a one-shot in the same frame: Off is listed first, so it wins.
        const b = makeAnimator();
        b.setStateMachine(layered());
        frame(b);
        b.setTrigger('Swing');
        b.setTrigger('Died');
        frame(b);
        expect(b.layerStateName('Actions')).toBe('Off');

        // A state trigger interrupts the current state's own way out waiting on the same frame.
        const c = makeAnimator();
        c.setStateMachine(layered());
        frame(c);
        c.setTrigger('Hold');
        frame(c, 1.2);                                         // Hold's clip is over: its exit is due
        c.setTrigger('Swing');
        frame(c);
        expect(c.layerStateName('Actions')).toBe('Swing');
    });

    it('tells which trigger a layer plays, through a trigger-less hand-over, until it rests', () => {
        const a = makeAnimator();
        a.setStateMachine(layered({
            states: [state('After', 'Nod', { loop: false })],
            transitions: [{ from: 'Hold', to: 'After', conditions: [], hasExitTime: true, exitTime: 1, blendTime: 0 }],
        }));
        frame(a);
        expect(a.activeTrigger('Actions')).toBeNull();
        a.setTrigger('Hold');
        frame(a, 0.5);
        expect(a.activeTrigger('Actions')).toBe('Hold');
        frame(a, 0.6);
        frame(a);
        expect(a.layerStateName('Actions')).toBe('After');
        expect(a.activeTrigger('Actions')).toBe('Hold');      // the sequence it started goes on
        a.setTrigger('Stop');
        frame(a);
        expect(a.activeTrigger('Actions')).toBeNull();
        expect(a.activeTrigger()).toBeNull();                  // the base was never triggered
    });

    it('answers what a trigger plays: its layer, state, clip, rate and real length', () => {
        const a = makeAnimator();
        a.setStateMachine(layered({
            hold: { speed: 2, speedScaleParam: 'Rate' },
            states: [state('After', 'Swing', { loop: false })],
            transitions: [
                { from: 'Hold', to: 'After', conditions: [], hasExitTime: true, exitTime: 1, blendTime: 0 },
                { from: 'Swing', to: 'Hold', conditions: [], condition: trig('Next'), hasExitTime: true, exitTime: 0.5, blendTime: 0 },
            ],
        }));
        const hold = a.triggerInfo('Hold')!;
        expect(hold).toMatchObject({ layer: 'Actions', state: 'Hold', clip: 'Hold', clipLength: 1, speed: 4, fromAnywhere: true });
        // 1 s of clip at 2 x Rate 2, then After's 0.5 s Swing it goes on into by itself.
        expect(hold.seconds).toBeCloseTo(0.25 + 0.5, 6);
        // Swing hands over on a trigger at half its clip: its own part ends there.
        expect(a.triggerInfo('Swing')!.seconds).toBeCloseTo(0.25, 6);
        // Next is read only by a transition from Swing: entered from there, not from anywhere.
        expect(a.triggerInfo('Next')).toMatchObject({ state: 'Hold', fromAnywhere: false });
        expect(a.triggerInfo('Stop')).toMatchObject({ state: 'Off', layer: 'Actions' });
        expect(a.triggerInfo('Nope')).toBeNull();
    });
});

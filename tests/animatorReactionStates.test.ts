import { describe, it, expect } from 'vitest';
import { mat4, quat } from 'gl-matrix';
import type { AnimationStateMachine, AnimationState, AnimationLayer, AnimatorReactionLink, AnimationRagdollStart } from '../src/animation/animator';
import type { Animation } from '../src/animation/animatedModel';
import type { AnimationField } from '../src/animation/animationField';
import { Node } from '../src/core/scene/nodes/node';
import type { ModelNode } from '../src/core/scene/nodes/modelNode';
import { humanoidModel, IDLE, poseClip, boneIndex } from './helpers/humanoidRig';

// Ragdoll and Get Up states, and the reaction effects every state carries (animator.ts, reactionLink.ts), against a
// stand-in for the character's reactions: what the graph tells them, when, and what it plays meanwhile. The real
// reactions taking the body are in tests/reactions.test.ts ("graph-driven").

const H = 1 / 60;

/** A stand-in for the reactions (ReactionController implements the same link). */
function fakeLink(): AnimatorReactionLink & { calls: string[]; set(p: Partial<AnimatorReactionLink>): void } {
    const state = {
        ragdolled: false, canGetUp: false, faceUp: false, reacting: false, hasControl: true, staggering: false,
        hitCount: 0, hitAngle: 0, hitHeight: 0.5, hitStrength: 0, getUpClips: { faceDown: 'Rig Get Up' } as { faceUp?: string; faceDown?: string },
    };
    const calls: string[] = [];
    return Object.assign(state, {
        calls,
        graphRagdoll(start: AnimationRagdollStart) { calls.push(`ragdoll:${start}`); },
        graphGetUp() { calls.push('getUp'); },
        set(p: Partial<AnimatorReactionLink>) { Object.assign(state, p); },
    });
}

const clipOf = (name: string, deg: number, seconds = 1) => poseClip(name, { Spine: [[1, 0, 0], deg] }, seconds);

function machine(extra: Partial<AnimationStateMachine> = {}, states: AnimationState[] = []): AnimationStateMachine {
    return {
        parameters: [
            { name: 'Down', type: 'trigger', default: false },
            { name: 'Up', type: 'trigger', default: false },
            { name: 'Enter', type: 'trigger', default: false },
            ...(extra.parameters ?? []),
        ],
        states: [
            { name: 'Idle', clipName: 'Idle', loop: true, speed: 1, isEntry: true },
            { name: 'Ragdoll', clipName: '', loop: true, speed: 1, ragdoll: { start: 'trip' } },
            { name: 'Get Up', clipName: '', loop: false, speed: 1, getUp: { faceUp: 'Up Back' } },
            { name: 'Car', clipName: 'Car', loop: true, speed: 1, triggers: [{ trigger: 'Enter', blendTime: 0 }] },
            ...states,
        ],
        transitions: [
            { from: '*', to: 'Ragdoll', conditions: [{ param: 'Down', op: 'trigger' }], blendTime: 0.1 },
            { from: '*', to: 'Car', conditions: [{ param: 'Enter', op: 'trigger' }], blendTime: 0 },
            { from: 'Ragdoll', to: 'Get Up', conditions: [{ param: 'Up', op: 'trigger' }], blendTime: 0.5 },
            { from: 'Get Up', to: 'Idle', conditions: [], hasExitTime: true, exitTime: 0.95, blendTime: 0.2 },
        ],
        events: [],
        ...extra,
        layers: extra.layers ?? [],
    } as AnimationStateMachine;
}

function setup(sm: AnimationStateMachine, clips: Animation[] = []) {
    const node = humanoidModel([IDLE(), clipOf('Car', 30), clipOf('Up Back', -60, 2), clipOf('Rig Get Up', 60, 2), ...clips]);
    const link = fakeLink();
    Object.defineProperty(node, 'reactions', { get: () => link, configurable: true });
    const a = node.animator!;
    a.setStateMachine(sm);
    const frame = (n = 1) => { for (let i = 0; i < n; i++) { a.checkTriggers(); a.update(H); } };
    frame();
    return { node, a, link, frame };
}

const bones = (node: ModelNode) => node.animator!.getFinalBoneMatrices().map(m => Array.from(m as Float32Array));
const spineTurn = (node: ModelNode) => {
    const m = node.animator!.getFinalBoneMatrices()[boneIndex('Spine')] as mat4;
    const q = mat4.getRotation(quat.create(), m);
    return 2 * Math.atan2(q[0], q[3]) * 180 / Math.PI;
};

describe('Ragdoll and Get Up states', () => {
    it('tell the reactions as the state is entered, once, at the end of checkTriggers', () => {
        const { a, link, frame } = setup(machine());
        a.setTrigger('Down');
        a.checkTriggers();
        expect(a.currentStateName).toBe('Ragdoll');
        expect(a.reactionKind).toBe('ragdoll');
        expect(link.calls).toEqual(['ragdoll:trip']);
        a.update(H);
        frame(10);
        expect(link.calls).toEqual(['ragdoll:trip']);
    });

    it('a Ragdoll state with no clip holds the pose it was entered with, never the bind pose', () => {
        const { node, a, frame } = setup(machine());
        frame(5);
        const before = bones(node);
        a.setTrigger('Down');
        a.checkTriggers();
        // Nothing written on entering: the body is made from what is on screen.
        expect(bones(node)).toEqual(before);
        frame(20);
        const after = bones(node);
        for (let i = 0; i < before.length; i++) for (let k = 0; k < 16; k++) expect(after[i][k]).toBeCloseTo(before[i][k], 4);
    });

    it('a Get Up state rises from the body: no cross-fade, no root motion, its first frame held until the body is down', () => {
        const up = clipOf('Up Back', -60, 2);
        (up as any).rootMotion = true;
        const { node, a, link, frame } = setup(machine(), []);
        // Replace the model's clip with the root-motion one.
        const anims = (node.model as any)._animations as Animation[];
        anims[anims.findIndex(c => c.name === 'Up Back')] = up;
        a.setTrigger('Down');
        frame();
        link.set({ ragdolled: true, faceUp: true });
        a.setTrigger('Up');
        a.checkTriggers();
        expect(a.currentStateName).toBe('Get Up');
        expect(link.calls).toEqual(['ragdoll:trip', 'getUp']);
        const anyA = a as any;
        expect(anyA._isBlending).toBe(false);
        expect(anyA._currentAnimation?.name).toBe('Up Back');
        expect(anyA._rootMotionActive).toBe(false);
        a.update(H);
        frame(30);
        // Waiting: still on its first frame.
        expect(anyA._currentTime).toBe(0);
        // The reactions start the rise: the clip plays on from its first frame.
        const clock = a.playGetUp(true, link.getUpClips)!;
        expect(clock).not.toBeNull();
        frame(30);
        expect(clock.time).toBeCloseTo(0.5, 2);
        expect(clock.duration).toBeCloseTo(2, 3);
        expect(clock.done).toBe(false);
        // Knocked down again: back on the first frame.
        clock.stop();
        frame(10);
        expect(clock.time).toBe(0);
        // The graph leaves the state: the clock is over.
        a.setTrigger('Down');
        frame();
        expect(clock.done).toBe(true);
        expect(clock.duration).toBe(0);
    });

    it('joins its clip where the body in it starts to rise, unless it says from its first frame', () => {
        // Lying still for a second, then up over the next.
        const lieThenRise = (): Animation => {
            const flat = quat.create(), up = quat.setAxisAngle(quat.create(), [1, 0, 0], -60 * Math.PI / 180);
            return { name: 'Up Back', samplers: [{ input: [0, 1, 2], output: [...flat, ...flat, ...up], interpolation: 'LINEAR' }],
                channels: [{ samplerIndex: 0, targetNodeIndex: boneIndex('Spine'), targetPath: 'rotation' }] };
        };
        for (const fromFirstFrame of [false, true]) {
            const sm = machine();
            sm.states.find(s => s.name === 'Get Up')!.getUp = { faceUp: 'Up Back', ...(fromFirstFrame ? { fromFirstFrame } : {}) };
            const { node, a, link, frame } = setup(sm);
            const anims = (node.model as any)._animations as Animation[];
            anims[anims.findIndex(c => c.name === 'Up Back')] = lieThenRise();
            a.setTrigger('Down');
            frame();
            link.set({ ragdolled: true, faceUp: true });
            a.setTrigger('Up');
            frame(10);
            // Waiting for the body on the frame it joins.
            const at = (a as any)._currentTime;
            const clock = a.playGetUp(true, link.getUpClips)!;
            if (fromFirstFrame) {
                expect(at).toBe(0);
                expect(clock.duration).toBeCloseTo(2, 3);
            } else {
                expect(at).toBeGreaterThan(0.9);
                expect(at).toBeLessThan(1.05);
                // Its clock counts from there: what is left of the clip.
                expect(clock.time).toBe(0);
                expect(clock.duration).toBeCloseTo(2 - at, 3);
                frame(30);
                expect(clock.time).toBeCloseTo(0.5, 2);
                clock.stop();
                frame(5);
                expect((a as any)._currentTime).toBeCloseTo(at, 6);
            }
        }
    });

    it("chooses its clip by the side the body lies on, else the rig's for that side", () => {
        const { a, link, frame } = setup(machine());
        a.setTrigger('Down');
        frame();
        link.set({ ragdolled: true, faceUp: false });
        a.setTrigger('Up');
        frame();
        // Face down, the state names none: the rig's.
        expect((a as any)._currentAnimation?.name).toBe('Rig Get Up');
        expect(a.playGetUp(true, link.getUpClips)).not.toBeNull();
        expect((a as any)._currentAnimation?.name).toBe('Up Back');
    });

    it('with no body to rise from, a Get Up state is an ordinary clip state', () => {
        const { a, link, frame } = setup(machine());
        a.setTrigger('Down');
        frame();
        a.setTrigger('Up');
        frame(30);
        expect(a.currentStateName).toBe('Get Up');
        expect((a as any)._currentTime).toBeGreaterThan(0.4);
        expect(link.ragdolled).toBe(false);
    });

    it('enters only another reaction state from anywhere while in one: a trigger into an ordinary state is taken and waits for nothing', () => {
        const { a, frame } = setup(machine());
        a.setTrigger('Down');
        frame();
        a.setTrigger('Enter');
        frame();
        expect(a.currentStateName).toBe('Ragdoll');
        expect(a.getParam('Enter')).toBe(false);
        // Out of it, the trigger does not fire later out of the blue.
        a.endReactionStates();
        frame(3);
        expect(a.currentStateName).toBe('Idle');
    });

    it('holds the character still, plants no feet, and ends back at the entry', () => {
        const { node, a, frame } = setup(machine());
        const character = new Node('character');
        (character as any).animationHold = false;
        node.parent = character;
        a.setTrigger('Down');
        frame();
        expect((character as any).animationHold).toBe(true);
        expect((a as any)._stateIkWeightOfState()).toBe(0);
        a.endReactionStates();
        frame();
        expect(a.currentStateName).toBe('Idle');
        expect((character as any).animationHold).toBe(false);
    });

    it('mutes the layers over the transition in, unless a layer plays over reactions, and never a slot', () => {
        const arm = (name: string) => ({
            name, blend: 'override', weight: 1, mask: { 'mixamorig:Spine': 1 },
            states: [{ name: 'Lean', clipName: 'Lean', loop: true, speed: 1, isEntry: true }], transitions: [],
        }) as AnimationLayer;
        const sm = machine({ layers: [arm('Muted'), { ...arm('Over'), overReactions: true }] });
        const { a, frame } = setup(sm, [clipOf('Lean', 40)]);
        const overlays = (a as any)._overlays as any[];
        const weight = (name: string) => (a as any)._overlayWeight(overlays.find(o => o.name === name));
        expect(weight('Muted')).toBe(1);
        a.setTrigger('Down');
        frame(3);
        expect(weight('Muted')).toBeGreaterThan(0);
        expect(weight('Muted')).toBeLessThan(1);
        frame(10);
        expect(weight('Muted')).toBe(0);
        expect(weight('Over')).toBe(1);
        a.endReactionStates();
        frame(30);
        expect(weight('Muted')).toBe(1);
    });
});

describe('reaction effects', () => {
    it('merge the base state with the layers: the strictest react, every busy hand, force and shove multiplied', () => {
        const layer = (weight: number) => ({
            name: 'Arms', blend: 'override', weight, mask: { 'mixamorig:Spine': 1 },
            states: [{ name: 'Carry', clipName: 'Lean', loop: true, speed: 1, isEntry: true, reactions: { busyHands: 'right', shove: 2, react: 'none' } }],
            transitions: [],
        }) as AnimationLayer;
        const states: AnimationState[] = [{ name: 'Crouch', clipName: 'Idle', loop: true, speed: 1, reactions: { react: 'flinch', force: 0.5 } }];
        const sm = machine({ layers: [layer(1)] }, states);
        sm.states.forEach(s => { s.isEntry = s.name === 'Crouch'; });
        const { a, frame } = setup(sm, [clipOf('Lean', 40)]);
        frame(2);
        expect(a.reactionEffects).toEqual({ react: 'none', busyHands: { L: false, R: true }, force: 0.5, shove: 2 });
        // A layer at a quarter: its hands and its react do not count, its shove a quarter of the way.
        const b = setup(machine({ layers: [layer(0.25)] }, states.map(s => ({ ...s, isEntry: true }))), [clipOf('Lean', 40)]);
        b.a.getStateMachine()!.states.forEach(s => { s.isEntry = s.name === 'Crouch'; });
        b.a.resetStateMachine();
        b.frame(2);
        expect(b.a.reactionEffects.react).toBe('flinch');
        expect(b.a.reactionEffects.busyHands).toBeNull();
        expect(b.a.reactionEffects.shove).toBeCloseTo(1.25, 5);
    });
});

describe('reaction parameters', () => {
    it("read the character's reactions whatever node they name, and a default where it has none", () => {
        const sm = machine({ parameters: [
            { name: 'Ragdolled', type: 'variable', default: false, variable: { nodeRef: 'parent', varName: 'ragdolled', varType: 'boolean', source: 'builtin' } },
            { name: 'HasControl', type: 'variable', default: false, variable: { nodeRef: 'parent', varName: 'hasControl', varType: 'boolean', source: 'builtin' } },
            { name: 'HitAngle', type: 'variable', default: 0, variable: { nodeRef: 'self', varName: 'hitAngle', varType: 'number', source: 'builtin' } },
        ] });
        const { a, link, frame } = setup(sm);
        link.set({ ragdolled: true, hasControl: false, hitAngle: -90 });
        frame();
        expect([a.getParam('Ragdolled'), a.getParam('HasControl'), a.getParam('HitAngle')]).toEqual([true, false, -90]);
        // No reactions (another backend, reactions off): HasControl reads true, the rest their defaults.
        const node = humanoidModel([IDLE()]);
        Object.defineProperty(node, 'reactions', { get: () => null });
        node.animator!.setStateMachine(sm);
        node.animator!.checkTriggers();
        expect([node.animator!.getParam('Ragdolled'), node.animator!.getParam('HasControl'), node.animator!.getParam('HitAngle')]).toEqual([false, true, 0]);
    });

    it('a trigger linked to a counter fires once each time it rises, and a raise nothing took comes down', () => {
        const sm = machine({ parameters: [
            { name: 'Hit', type: 'trigger', default: false, variable: { nodeRef: 'parent', varName: 'hitCount', varType: 'number', source: 'builtin' } },
        ] });
        const { a, link, frame } = setup(sm);
        // Learnt, not fired: hits counted before the machine (re)started are not news.
        link.set({ hitCount: 3 });
        a.resetStateMachine();
        frame();
        expect(a.getParam('Hit')).toBe(false);
        link.set({ hitCount: 4 });
        a.checkTriggers();
        expect(a.getParam('Hit')).toBe(true);
        a.update(H);
        a.checkTriggers();
        expect(a.getParam('Hit')).toBe(false);
        // Taken by a state entered on it.
        sm.states.push({ name: 'Flinch', clipName: 'Car', loop: false, speed: 1, triggers: [{ trigger: 'Hit', blendTime: 0 }] });
        link.set({ hitCount: 5 });
        frame();
        expect(a.currentStateName).toBe('Flinch');
        expect(a.getParam('Hit')).toBe(false);
        // A script's own setTrigger still latches.
        a.setTrigger('Hit');
        a.update(H);
        expect(a.getParam('Hit')).toBe(true);
    });
});

describe('a one-shot blend space entered again', () => {
    it('starts over, its probe on the new value: a second hit flinches from the start', () => {
        const field: AnimationField = {
            mode: '1d', xAxis: { name: 'Angle', min: -90, max: 90, smoothing: 0 },
            samples: [{ clipName: 'Left', x: 90 }, { clipName: 'Right', x: -90 }],
        } as AnimationField;
        const layer: AnimationLayer = {
            name: 'Hit', blend: 'additive', weight: 1,
            states: [
                { name: 'Off', clipName: '', loop: true, speed: 1, isEntry: true },
                { name: 'Hit', clipName: '', loop: false, speed: 1, field, fieldInputs: { x: 'Angle' }, triggers: [{ trigger: 'Flinch', blendTime: 0 }] },
            ],
            transitions: [{ from: 'Hit', to: 'Off', conditions: [], hasExitTime: true, exitTime: 0.9, blendTime: 0.1 }],
        };
        const sm = machine({ layers: [layer], parameters: [{ name: 'Flinch', type: 'trigger', default: false }, { name: 'Angle', type: 'float', default: 90 }] });
        const { a, frame } = setup(sm, [clipOf('Left', 30, 0.5), clipOf('Right', -30, 0.5)]);
        const child = ((a as any)._overlays as any[]).find(o => o.name === 'Hit').animator;
        a.setTrigger('Flinch');
        frame(10);
        expect(child._fieldPhase).toBeGreaterThan(0.2);
        a.setFloat('Angle', -90);
        a.setTrigger('Flinch');
        a.checkTriggers();
        expect(child.currentStateName).toBe('Hit');
        expect(child._fieldPhase).toBe(0);
        a.update(H);
        // The probe snapped to the new side (axis smoothing would have eased it there from the old one).
        expect(child._fieldX).toBe(-90);
        void spineTurn;
    });
});

import { describe, it, expect, vi } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimationStateMachine, AnimationState } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { LightNode } from '../src/core/scene/nodes/lightNode';
import { PointLight } from '../src/graphics/lighting';
import {
    actionsFor, drawnWorldPosition, parseEventActions, resolveTarget, runEventActions, type EventActionBinding,
} from '../src/animation/eventActions';

// Event Actions: what a clip event does, as data on the machine. The clip says when, the machine says what.

class Sound extends Node {
    plays = 0;
    playing = false;
    mode = 'spatial'; sampleId: string | null = 's'; volume = 1; loopMode = 'inherit';
    distanceModel = 'inverse'; refDistance = 1; maxDistance = 100; rolloffFactor = 1;
    constructor(name: string, _options: Record<string, unknown> = {}) { super(name, 'sound'); }
    play() { this.plays++; this.playing = true; }
    get isPlaying() { return this.playing; }
}

class Particles extends Node {
    calls: any[] = [];
    constructor(name: string) { super(name, 'particleSystem'); }
    play() { this.calls.push(['play']); }
    stop() { this.calls.push(['stop']); }
    burst(count: number, emitter?: string) { this.calls.push(['burst', count, emitter]); }
}

const tree = () => {
    const scene = new Scene();
    const owner = new Node('Weapon');
    const sounds = new Node('Sounds');
    const shot = new Sound('Shot');
    sounds.addChild(shot);
    owner.addChild(sounds);
    scene.root.addChild(owner);
    return { scene, owner, shot };
};

describe('parseEventActions', () => {
    it('reads what it knows and drops what it does not', () => {
        const parsed = parseEventActions([
            { event: 'shot', clip: 'Fire', actions: [
                { kind: 'sound', target: 'Sounds/Shot' },
                { kind: 'particles', target: 'Flash', mode: 'burst', count: 12.7 },
                { kind: 'light', target: 'Muzzle/Light', intensity: 9000, seconds: 0.06 },
                { kind: 'spawn', template: 'FPS Muzzle Flash', at: 'Muzzle', rotation: 'camera', follow: true },
                { kind: 'teleport', target: 'x' },
                { kind: 'sound' },
            ] },
            { actions: [] },
            'junk',
        ]);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].actions.map(a => a.kind)).toEqual(['sound', 'particles', 'light', 'spawn']);
        expect((parsed[0].actions[1] as any).count).toBe(12);
        expect(parseEventActions(undefined)).toEqual([]);
    });

    it('picks the actions bound to an event, honouring a clip filter', () => {
        const bindings: EventActionBinding[] = [
            { event: 'shot', actions: [{ kind: 'sound', target: 'A' }] },
            { event: 'shot', clip: 'AimFire', actions: [{ kind: 'sound', target: 'B' }] },
        ];
        expect(actionsFor(bindings, 'shot', 'Fire').map((a: any) => a.target)).toEqual(['A']);
        expect(actionsFor(bindings, 'shot', 'AimFire').map((a: any) => a.target)).toEqual(['A', 'B']);
        expect(actionsFor(bindings, 'reload', 'Fire')).toEqual([]);
    });
});

describe('resolveTarget', () => {
    it('finds a path below the node, and prefers it to the same path further up', () => {
        const { owner, shot } = tree();
        expect(resolveTarget(owner, 'Sounds/Shot')).toBe(shot);
        // The weapon carries its own Sounds group; it wins over the character's.
        const character = new Node('Character');
        const outer = new Node('Sounds');
        const outerShot = new Sound('Shot');
        outer.addChild(outerShot);
        character.addChild(outer);
        const weapon = new Node('Weapon');
        const inner = new Node('Sounds');
        const innerShot = new Sound('Shot');
        inner.addChild(innerShot);
        weapon.addChild(inner);
        character.addChild(weapon);
        expect(resolveTarget(weapon, 'Sounds/Shot')).toBe(innerShot);
        const bare = new Node('Bare');
        character.addChild(bare);
        expect(resolveTarget(bare, 'Sounds/Shot')).toBe(outerShot);
    });

    it('is null, not a throw, for a path nothing has', () => {
        const { owner } = tree();
        expect(resolveTarget(owner, 'Nope/Nothing')).toBeNull();
    });
});

describe('runEventActions', () => {
    it('plays a sound, overlapping an earlier one up to a cap', () => {
        const { owner, shot } = tree();
        runEventActions(owner, [{ kind: 'sound', target: 'Sounds/Shot' }]);
        expect(shot.plays).toBe(1);
        for (let i = 0; i < 12; i++) runEventActions(owner, [{ kind: 'sound', target: 'Sounds/Shot' }]);
        // The first plays on the cue; the rest ring on spares, at most six of them, then restart the cue.
        const spares = shot.parent!.children.filter(c => c.name === 'Shot (overlap)');
        expect(spares).toHaveLength(6);
        runEventActions(owner, [{ kind: 'sound', target: 'Sounds/Shot', overlap: false }]);
        expect(shot.plays).toBeGreaterThan(1);
    });

    it('drives a particle system', () => {
        const { owner } = tree();
        const flash = new Particles('Flash');
        owner.addChild(flash);
        runEventActions(owner, [
            { kind: 'particles', target: 'Flash', mode: 'burst', count: 8, emitter: 'Sparks' },
            { kind: 'particles', target: 'Flash', mode: 'play' },
            { kind: 'particles', target: 'Flash', mode: 'stop' },
        ]);
        expect(flash.calls).toEqual([['burst', 8, 'Sparks'], ['play'], ['stop']]);
    });

    it('flashes a light and puts it away, ending at no intensity and no reach', () => {
        const { scene, owner } = tree();
        const light = new LightNode('Light', new PointLight({ diffuse: [1, 1, 1] }));
        (light.light as any).range = 9;
        (light.light as any).intensity = 0;
        owner.addChild(light);
        runEventActions(owner, [{ kind: 'light', target: 'Light', intensity: 8000, seconds: 0.1, falloff: 2 }]);
        expect((light.light as any).intensity).toBe(8000);
        expect((light.light as any).range).toBe(9);
        scene.update(0.05, 0.05, false);
        const mid = (light.light as any).intensity;
        expect(mid).toBeGreaterThan(0);
        expect(mid).toBeLessThan(8000);
        scene.update(0.06, 0.11, false);
        expect((light.light as any).intensity).toBe(0);
        expect((light.light as any).range).toBeCloseTo(0.01, 5);
        // And it flashes again at its authored reach.
        runEventActions(owner, [{ kind: 'light', target: 'Light', intensity: 8000, seconds: 0.1 }]);
        expect((light.light as any).range).toBe(9);
    });

    it('spawns a template where its target is, turned as asked', () => {
        const { scene, owner } = tree();
        const muzzle = new Node('Muzzle');
        muzzle.setPosition([1, 2, 3]);
        owner.addChild(muzzle);
        owner.updateTransforms();
        const instantiate = vi.spyOn(scene, 'instantiate').mockReturnValue(null);
        runEventActions(owner, [{ kind: 'spawn', template: 'Flash', at: 'Muzzle', offset: [0, 1, 0], rotation: [10, 20, 30] }]);
        expect(instantiate).toHaveBeenCalledTimes(1);
        const [name, options] = instantiate.mock.calls[0] as [string, any];
        expect(name).toBe('Flash');
        expect(options.position[0]).toBeCloseTo(1, 5);
        expect(options.position[1]).toBeCloseTo(3, 5);
        expect(options.position[2]).toBeCloseTo(3, 5);
        expect(options.rotation).toEqual([10, 20, 30]);
        expect(options.parent).toBeUndefined();
    });

    it('keeps a spawned node on its target while it lives, and lets go when it is removed', () => {
        const { scene, owner } = tree();
        const muzzle = new Node('Muzzle');
        muzzle.setPosition([1, 2, 3]);
        owner.addChild(muzzle);
        owner.updateTransforms();
        const effect = new Node('Effect');
        scene.root.addChild(effect);
        vi.spyOn(scene, 'instantiate').mockReturnValue(effect);
        runEventActions(owner, [{ kind: 'spawn', template: 'Flash', at: 'Muzzle', follow: true }]);
        muzzle.setPosition([4, 5, 6]);
        owner.updateTransforms();
        scene.update(0.016, 0.016, false);
        expect(effect.position[0]).toBeCloseTo(4, 5);
        expect(effect.position[1]).toBeCloseTo(5, 5);
        effect.remove({ immediate: true });
        muzzle.setPosition([7, 8, 9]);
        owner.updateTransforms();
        expect(() => scene.update(0.016, 0.032, false)).not.toThrow();
    });

    it('survives a missing target and runs the rest', () => {
        const { owner, shot } = tree();
        runEventActions(owner, [{ kind: 'sound', target: 'Nothing/Here' }, { kind: 'sound', target: 'Sounds/Shot' }]);
        expect(shot.plays).toBe(1);
    });
});

describe('drawnWorldPosition', () => {
    it('is where the node is, unless it is a viewmodel; then it is squeezed the way the renderer squeezes it', () => {
        const { scene, owner } = tree();
        const muzzle = new Node('Muzzle');
        muzzle.setPosition([0.2, -0.1, 2]);
        owner.addChild(muzzle);
        owner.updateTransforms();
        const plain = drawnWorldPosition(muzzle);
        expect(plain[0]).toBeCloseTo(0.2, 5);
        expect(plain[2]).toBeCloseTo(2, 5);

        const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, 1], [0, 1, 0]);
        const squeeze = mat4.fromScaling(mat4.create(), [0.5, 0.5, 0.25]);
        vi.spyOn(scene, 'activeCamera', 'get').mockReturnValue({ camera: { viewMatrix: view, viewmodelMatrix: squeeze } } as any);
        (owner as any)._viewmodel = true;
        const drawn = drawnWorldPosition(muzzle);
        const expected = vec3.transformMat4(vec3.create(), vec3.transformMat4(vec3.create(), muzzle.worldPosition, view), squeeze);
        vec3.transformMat4(expected, expected, mat4.invert(mat4.create(), view));
        expect(drawn[0]).toBeCloseTo(expected[0], 5);
        expect(drawn[1]).toBeCloseTo(expected[1], 5);
        expect(drawn[2]).toBeCloseTo(expected[2], 5);
        expect(drawn[2]).not.toBeCloseTo(2, 3);
    });
});

// ---- the animator ------------------------------------------------------------------------------------------

const SKIN: Skin = {
    joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }],
    nodeParents: new Map(),
    nodeTransforms: new Map([[0, mat4.create()]]),
    nodeNames: new Map([[0, 'Hips']]),
};
const clip = (name: string, duration: number, events?: Animation['events']): Animation => ({
    name,
    samplers: [{ input: [0, duration], output: [0, 0, 0, 1, 0, 0, 0, 1], interpolation: 'LINEAR' }],
    channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'rotation' }],
    ...(events ? { events } : {}),
} as Animation);
const CLIPS = [clip('Idle', 1), clip('Fire', 0.5, [{ time: 0, name: 'shot' }, { time: 0.25, name: 'mid' }])];

const state = (name: string, clipName: string, extra: Partial<AnimationState> = {}): AnimationState => ({ name, clipName, loop: true, speed: 1, ...extra });

function rig(eventActions: EventActionBinding[], layered = false) {
    const { owner, shot } = tree();
    const animator = new Animator({ skin: SKIN, animations: CLIPS } as unknown as AnimatedModel, owner as any);
    const idle = state('Idle', 'Idle', { isEntry: true });
    const fire = state('Fire', 'Fire', { loop: false });
    const trig = (param: string) => ({ op: 'and' as const, children: [{ param, op: 'trigger' as const }] });
    const machine: AnimationStateMachine = layered
        ? {
            parameters: [{ name: 'Fire', type: 'trigger', default: false }],
            states: [idle], transitions: [], events: [], eventActions,
            layers: [{
                name: 'Actions',
                states: [state('Off', '', { isEntry: true }), fire],
                transitions: [{ from: '*', to: 'Fire', conditions: [], condition: trig('Fire'), blendTime: 0, canTransitionToSelf: true }],
            }],
        }
        : { parameters: [], states: [idle, fire], transitions: [], events: [], eventActions };
    animator.setStateMachine(machine);
    const frame = (dt = 1 / 60) => { animator.checkTriggers(); animator.update(dt); };
    return { animator, shot, frame };
}

describe('Animator event actions', () => {
    const bind: EventActionBinding[] = [{ event: 'shot', actions: [{ kind: 'sound', target: 'Sounds/Shot', overlap: false }] }];

    it('runs the bound actions when fired, with no onAnimationEvent listener at all', () => {
        const { animator, shot, frame } = rig(bind);
        frame();
        expect(shot.plays).toBe(0);
        animator.fireEvent('shot');
        expect(shot.plays).toBe(1);
    });

    it('fires a marker at time 0 when a clip starts, and again when it restarts', () => {
        const { animator, shot, frame } = rig(bind, true);
        frame();
        animator.setTrigger('Fire' as any);
        frame();
        expect(shot.plays).toBe(1);
        frame(0.1);
        expect(shot.plays).toBe(1);
        animator.setTrigger('Fire' as any);
        frame();
        expect(shot.plays).toBe(2);
    });

    it('runs actions once for a layer\'s event, and still tells a listener', () => {
        const { animator, shot, frame } = rig(bind, true);
        const heard: string[] = [];
        animator.onAnimationEvent(n => heard.push(n));
        frame();
        animator.setTrigger('Fire' as any);
        frame();
        frame(0.3);
        expect(shot.plays).toBe(1);
        expect(heard).toEqual(['shot', 'mid']);
    });

    it('keeps the bindings on the machine it hands back', () => {
        const { animator } = rig(bind);
        expect(animator.getStateMachine()!.eventActions).toEqual(bind);
    });
});

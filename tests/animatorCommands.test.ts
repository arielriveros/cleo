import { describe, it, expect, afterEach } from 'vitest';
import { mat4 } from 'gl-matrix';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { attachScriptFactory } from '../src/core/scene/nodes/nodeScripting';
import { compileScript } from '../src/core/scripting/scriptRuntime';
import { Animator } from '../src/animation/animator';
import type { AnimatedModel, Animation, AnimationStateMachine } from '../src/animation/animator';
import { bindAnimatorCommands, ANIMATOR_CHANNEL } from '../src/animation/animatorCommands';
import { Events, getChannel, hasScriptListeners, resetScriptChannels, scriptListenerCount, addTargetListener } from '../src/core/events';
import '../src/cleo';

// Commands TO animators on the event system: sent DOWN from a script's node to every animator beneath it, the
// decorators that send them (@animTrigger, @animAction, @animParam), and what an animator now tells about its
// triggers (TriggerStarted, TriggerEnded).

const scenes: Scene[] = [];
afterEach(() => { for (const s of scenes.splice(0)) s.dispose(); resetScriptChannels(); });

const SKIN = { joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }], nodeTransforms: new Map([[0, mat4.create()]]) };
const clip = (name: string, length = 1): Animation => ({
    name,
    samplers: [{ input: [0, length], output: [0, 0, 0, 1, 0, 0], interpolation: 'LINEAR' }],
    channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
} as Animation);
const MODEL = { skin: SKIN, animations: [clip('idle'), clip('jump', 0.5), clip('wave', 0.4)] } as unknown as AnimatedModel;
const MACHINE: AnimationStateMachine = {
    parameters: [{ name: 'Jump', type: 'trigger', default: false }, { name: 'Speed', type: 'float', default: 0 }, { name: 'Armed', type: 'bool', default: false }] as any,
    states: [
        { name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true },
        { name: 'Jumping', clipName: 'jump', loop: false, speed: 1, exitTime: 1 } as any,
    ],
    transitions: [
        { from: 'Idle', to: 'Jumping', conditions: [{ param: 'Jump', op: 'trigger' }] },
        { from: 'Jumping', to: 'Idle', conditions: [], hasExitTime: true, exitTime: 1 } as any,
    ],
    events: [],
} as any;
const step = (a: Animator, seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { a.checkTriggers(); a.update(1 / 60); } };

/** A character: its root (where the script goes) over a model node with a real Animator. */
function character(source?: string) {
    const scene = new Scene(); scenes.push(scene);
    const root = new Node('hero'), model = new Node('model');
    root.addChild(model);
    scene.addNode(root);
    if (source) attachScriptFactory(root, compileScript(`import { Node, Events } from 'cleo'\nimport { animTrigger, animAction, animParam, eventListener } from 'cleo/decorators'\n${source}`));
    const animator = new Animator(MODEL, model);
    animator.setStateMachine(MACHINE);
    scene.start();
    return { scene, root: root as any, model, animator };
}

describe('commands sent down', () => {
    it('reach the animator under a character, from the character itself', () => {
        const { root, animator } = character();
        root.dispatchDown('animator:SetTrigger', 'Jump');
        step(animator, 1 / 30);
        expect(animator.currentStateName).toBe('Jumping');
        root.dispatchDown('animator:SetParam', 'Speed', 3);
        root.dispatchDown('animator:SetParam', 'Armed', true);
        expect([animator.getParam('Speed'), animator.getParam('Armed')]).toEqual([3, true]);
        expect(root.dispatchDown('animator:ForceState', 'Idle').results).toEqual([true]);
        expect(animator.currentStateName).toBe('Idle');
        const handle = root.dispatchDown('animator:PlayAction', 'wave').results[0] as any;
        expect(handle?.clipName).toBe('wave');
    });

    it('go down every branch, depth first, and only down', () => {
        const top = new Node('top'), a = new Node('a'), a1 = new Node('a1'), b = new Node('b');
        top.addChild(a); a.addChild(a1); top.addChild(b);
        const order: string[] = [];
        for (const n of [top, a, a1, b]) n.addEventListener('cmd:Go', () => order.push(`${n.name} ${Events.current!.phase}`));
        a.dispatchDown('cmd:Go');
        expect(order).toEqual(['a target', 'a1 descend']);
        order.length = 0;
        top.dispatchDown('cmd:Go');
        expect(order).toEqual(['top target', 'a descend', 'a1 descend', 'b descend']);
        // stopPropagation ends the walk.
        a.addEventListener('cmd:Go', () => Events.current!.stopPropagation());
        order.length = 0;
        top.dispatchDown('cmd:Go');
        expect(order).toEqual(['top target', 'a descend']);
    });

    it('a sprite takes them through its own names, never the node’s physics setTrigger', async () => {
        const { AnimatedSpriteNode } = await import('../src/core/scene/nodes/animatedSpriteNode');
        const { Sprite } = await import('../src/graphics/sprite');
        const sprite = new AnimatedSpriteNode('s', new Sprite(null as any)) as any;
        const calls: string[] = [];
        sprite.fireTrigger = (n: string) => calls.push(`trigger ${n}`);
        sprite.setParam = (n: string, v: unknown) => calls.push(`param ${n}=${v}`);
        sprite.play = (c: string, r: boolean) => calls.push(`play ${c} ${r}`);
        sprite.resumeMachine = () => calls.push('resume');
        const holder = new Node('holder');
        holder.addChild(sprite);
        holder.dispatchDown('animator:SetTrigger', 'jumped');
        holder.dispatchDown('animator:SetParam', 'dashing', true);
        holder.dispatchDown('animator:PlayAction', 'attack1', { restart: true });
        holder.dispatchDown('animator:Resume');
        expect(calls).toEqual(['trigger jumped', 'param dashing=true', 'play attack1 true', 'resume']);
        expect(sprite.trigger).toBeFalsy();     // no physics trigger was made
    });

    it('animators listen as the engine, not as scripts: the per-frame gates stay closed', () => {
        resetScriptChannels();
        const before = scriptListenerCount();
        character();
        character();
        expect(scriptListenerCount()).toBe(before);
        expect(hasScriptListeners()).toBe(before > 0);
        expect(getChannel(ANIMATOR_CHANNEL).hasListeners('SetTrigger')).toBe(true);
    });

    it('a stub animator on a plain node takes them too (bindAnimatorCommands)', () => {
        const node = new Node('model');
        const fired: string[] = [];
        const off = bindAnimatorCommands(node, { setTrigger: (n) => fired.push(n), resetTrigger: (n) => fired.push(`-${n}`) });
        const parent = new Node('p'); parent.addChild(node);
        parent.dispatchDown('animator:SetTrigger', 'Roll');
        parent.dispatchDown('animator:ResetTrigger', 'Roll');
        off();
        parent.dispatchDown('animator:SetTrigger', 'Gone');
        expect(fired).toEqual(['Roll', '-Roll']);
    });
});

describe('TriggerStarted and TriggerEnded', () => {
    it('tell when a trigger’s states begin and are over, at the frame’s flush', () => {
        const { model, animator, scene } = character();
        const told: string[] = [];
        const offs = [
            addTargetListener(model, 'animation:TriggerStarted', (i: any) => told.push(`started ${i.trigger} in ${i.state}`)),
            addTargetListener(model, 'animation:TriggerEnded', (i: any) => told.push(`ended ${i.trigger}`)),
        ];
        try {
            animator.setTrigger('Jump' as any);
            step(animator, 1 / 30);
            expect(told).toEqual([]);
            scene.update(1 / 60, 0, false);
            expect(told).toEqual(['started Jump in Jumping']);
            step(animator, 1);
            scene.update(1 / 60, 0, false);
            expect(told).toEqual(['started Jump in Jumping', 'ended Jump']);
        } finally { for (const off of offs) off(); }
    });
});

describe('the animator decorators', () => {
    it('@animTrigger fires the named trigger, or the one the method returns, and not on cancel', () => {
        const { root, animator } = character(`
            export default class Hero extends Node {
              grounded = true
              which = 'Jump'
              @animTrigger('Jump') jump() { if (!this.grounded) return Events.cancel; return 'jumped' }
              @animTrigger() named() { return this.which }
              @animTrigger() none() { return null }
            }`);
        root.grounded = false;
        expect(root.jump()).toBeUndefined();
        expect(animator.getParam('Jump')).toBeFalsy();
        root.grounded = true;
        expect(root.jump()).toBe('jumped');
        expect(animator.getParam('Jump')).toBe(true);
        animator.resetTrigger('Jump' as any);
        expect(root.named()).toBe('Jump');
        expect(animator.getParam('Jump')).toBe(true);
        animator.resetTrigger('Jump' as any);
        root.none();
        expect(animator.getParam('Jump')).toBeFalsy();
    });

    it('@animTrigger awaits an async method first', async () => {
        const { root, animator } = character(`
            export default class Hero extends Node {
              @animTrigger() async later() { await null; return 'Jump' }
            }`);
        const pending = root.later();
        expect(animator.getParam('Jump')).toBeFalsy();
        expect(await pending).toBe('Jump');
        expect(animator.getParam('Jump')).toBe(true);
    });

    it('@animAction plays a one-shot, by name or by what the method returns', () => {
        const { root, animator } = character(`
            export default class Hero extends Node {
              @animAction('wave') greet() {}
              @animAction() pick() { return { clip: 'wave', slot: 'Upper' } }
            }`);
        const played: any[] = [];
        const original = animator.playAction.bind(animator);
        (animator as any).playAction = (c: string, o: any) => { played.push([c, o]); return original(c, o); };
        root.greet();
        root.pick();
        expect(played).toEqual([['wave', {}], ['wave', { slot: 'Upper' }]]);
    });

    it('@animParam sends the value at spawn, then each change only', () => {
        const { root, animator } = character(`
            export default class Hero extends Node {
              @animParam('Speed') speed = 2
              @animParam armed = false
            }`);
        expect(animator.getParam('Speed')).toBe(2);
        const sent: unknown[] = [];
        const original = animator.setFloat.bind(animator);
        (animator as any).setFloat = (n: string, v: number) => { sent.push(v); original(n, v); };
        root.speed = 2;
        root.speed = 5;
        root.speed = 5;
        expect(sent).toEqual([5]);
        expect(animator.getParam('Speed')).toBe(5);
        root.armed = true;
        expect(animator.getParam('armed')).toBe(true);
    });
});

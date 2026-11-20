import { describe, it, expect, afterEach } from 'vitest';
import { mat4 } from 'gl-matrix';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { attachScriptFactory, observableOf } from '../src/core/scene/nodes/nodeScripting';
import { compileScript } from '../src/core/scripting/scriptRuntime';
import { eventDispatch, eventListener, observable, membersOfNode } from '../src/core/scripting/decorators';
import { Events, resetScriptChannels } from '../src/core/events';
import { GameEvents } from '../src/core/scripting/scriptEvents';
import { Animator } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import type { AnimationStateMachine } from '../src/animation/animator';
import '../src/cleo';

// The event decorators: @eventDispatch, @eventListener, @onEvent's options, @observable and @onClipEvent, through
// Cleo's own script compile (how the editor and the player run scripts) and, where it differs, a standard compiler.

/** Every scene a test made: disposed after it, which releases its nodes' listeners as a Stop does. */
const scenes: Scene[] = [];
function newScene(): Scene { const s = new Scene(); scenes.push(s); return s; }
afterEach(() => { for (const s of scenes.splice(0)) s.dispose(); resetScriptChannels(); });

const IMPORTS = `import { Node, Events } from 'cleo'\nimport { eventDispatch, eventListener, onEvent, observable, onClipEvent } from 'cleo/decorators'\n`;

/** `parent > node` in a started scene, with `source` attached to `node` (and `parentSource`, if given, to the parent). */
function setup(source: string, parentSource?: string) {
    const scene = newScene();
    const parent = new Node('parent');
    const node = new Node('node');
    parent.addChild(node);
    scene.addNode(parent);
    attachScriptFactory(node, compileScript(IMPORTS + source));
    if (parentSource) attachScriptFactory(parent, compileScript(IMPORTS + parentSource));
    scene.start();
    return { scene, parent: parent as any, node: node as any };
}

describe('@eventDispatch', () => {
    it('sends what the method returns, then the literal extras, at the node: it bubbles, then broadcasts', () => {
        const { node, parent } = setup(`
            export default class Gun extends Node {
              @eventDispatch('Shot', 'pistol') fire(power) { return { damage: power * 2 } }
            }`, `
            export default class Owner extends Node {
              heard = []
              @eventListener('Shot') shot(result, kind) { this.heard.push([result.damage, kind]) }
            }`);
        const anywhere: unknown[] = [];
        Events.on('Shot', (r: any, kind: string) => anywhere.push([r.damage, kind, (Events.current!.target as Node).name]));
        expect(node.fire(5)).toEqual({ damage: 10 });   // the caller still gets the result
        expect(parent.heard).toEqual([[10, 'pistol']]);
        expect(anywhere).toEqual([[10, 'pistol', 'node']]);
    });

    it('sends nothing when the method returns Events.cancel, and the caller gets undefined', () => {
        const { node } = setup(`
            export default class Gun extends Node {
              ready = false
              @eventDispatch('Shot') fire() { if (!this.ready) return Events.cancel; return 1 }
            }`);
        const got: unknown[] = [];
        Events.on('Shot', (v: unknown) => got.push(v));
        expect(node.fire()).toBeUndefined();
        node.ready = true;
        expect(node.fire()).toBe(1);
        expect(got).toEqual([1]);
    });

    it('awaits an async method, and with mode async resolves after the listeners', async () => {
        const { node } = setup(`
            export default class Saver extends Node {
              @eventDispatch('Loaded') async load() { await null; return 'data' }
              @eventDispatch({ name: 'Saved', mode: 'async' }) save() { return 'slot1' }
            }`);
        const got: string[] = [];
        Events.on('Loaded', (v: string) => got.push(`loaded ${v}`));
        Events.on('Saved', async (v: string) => { await new Promise(r => setTimeout(r, 2)); got.push(`saved ${v}`); });
        expect(await node.load()).toBe('data');
        expect(got).toEqual(['loaded data']);
        const pending = node.save();
        expect(got).toEqual(['loaded data']);
        expect(await pending).toBe('slot1');
        expect(got).toEqual(['loaded data', 'saved slot1']);
    });

    it('with mode deferred, is heard at the frame’s event flush', () => {
        const { node, scene } = setup(`
            export default class Ticker extends Node {
              @eventDispatch({ name: 'ui:Score', mode: 'deferred' }) score() { return 3 }
            }`);
        const got: number[] = [];
        Events.on('ui:Score', (v: number) => got.push(v));
        node.score();
        expect(got).toEqual([]);
        scene.update(1 / 60, 0, false);
        expect(got).toEqual([3]);
    });

    it('works under a standard compiler too', () => {
        class Native extends Node {
            @eventDispatch('Opened') open() { return this.name; }
        }
        const door = new Native('door');
        const got: string[] = [];
        Events.on('Opened', (v: string) => got.push(v));
        expect(door.open()).toBe('door');
        expect(got).toEqual(['door']);
        expect(membersOfNode(door).find(m => m.kind === 'dispatch')).toMatchObject({ method: 'open', name: 'Opened', channel: 'game' });
    });
});

describe('@eventListener', () => {
    it('hears only its own subtree, and stops while asleep', () => {
        const scene = newScene();
        const listen = `
            export default class Owner extends Node {
              heard = 0
              @eventListener('Ping') ping() { this.heard++ }
            }`;
        const a = new Node('a'), b = new Node('b');
        const aChild = new Node('aChild');
        a.addChild(aChild);
        scene.addNode(a); scene.addNode(b);
        attachScriptFactory(a, compileScript(IMPORTS + listen));
        attachScriptFactory(b, compileScript(IMPORTS + listen));
        scene.start();
        aChild.dispatchEvent('Ping');
        expect([(a as any).heard, (b as any).heard]).toEqual([1, 0]);
        a.despawn({ immediate: true });
        a.spawn();
        aChild.dispatchEvent('Ping');
        expect((a as any).heard, 'bound once again after a respawn, not twice').toBe(2);
        a.despawn({ immediate: true });
        aChild.dispatchEvent('Ping');
        expect((a as any).heard).toBe(2);
    });

    it('capture hears it before the target, and can stop it there', () => {
        const { node, parent } = setup(`
            export default class Target extends Node {
              hit = 0
              @eventListener('Damage') damage() { this.hit++ }
            }`, `
            export default class Shield extends Node {
              blocked = 0
              @eventListener('Damage', { capture: true }) block(amount) { if (amount < 5) { this.blocked++; Events.current.stopPropagation() } }
            }`);
        node.dispatchEvent('Damage', 3);
        node.dispatchEvent('Damage', 9);
        expect([parent.blocked, node.hit]).toEqual([1, 1]);
    });
});

describe('@onEvent options', () => {
    it('once per life, where, priority and a qualified channel', () => {
        const { node } = setup(`
            export default class L extends Node {
              log = []
              @onEvent('Died', { once: true }) first(who) { this.log.push('first ' + who.name) }
              @onEvent('Died', { where: { team: 'red' } }) red(who) { this.log.push('red ' + who.name) }
              @onEvent('combat:Hit', { priority: 5 }) early() { this.log.push('early') }
              @onEvent('Hit', { channel: 'combat' }) late() { this.log.push('late') }
            }`);
        GameEvents.emit('Died', { name: 'a', team: 'blue' });
        GameEvents.emit('Died', { name: 'b', team: 'red' });
        Events.emit('combat:Hit');
        Events.emit('Hit');                          // the game channel: nobody
        expect(node.log).toEqual(['first a', 'red b', 'early', 'late']);
        node.despawn({ immediate: true });
        node.spawn();
        GameEvents.emit('Died', { name: 'c', team: 'red' });
        expect(node.log.slice(4), 'once is per life').toEqual(['first c', 'red c']);
    });

    it('a listener’s return value is what Events.request gets', () => {
        setup(`
            export default class Shop extends Node {
              @onEvent('Price') price(item) { return item === 'sword' ? 30 : undefined }
            }`);
        expect(Events.request('Price', 'sword')).toBe(30);
    });
});

describe('@observable', () => {
    it('sends <field>Changed at the node on a new value, with the old one', () => {
        const { node, parent } = setup(`
            export default class Hp extends Node {
              @observable hp = 100
              @observable('ui:Score') score = 0
            }`, `
            export default class Bar extends Node {
              seen = []
              @eventListener('hpChanged') bar(now, was) { this.seen.push([now, was]) }
            }`);
        const scores: number[] = [];
        Events.on('ui:Score', (v: number) => scores.push(v));
        expect(node.hp).toBe(100);
        node.hp = 80;
        node.hp = 80;                                // the same: not sent
        node.score = 7;
        expect(parent.seen).toEqual([[80, 100]]);
        expect(scores).toEqual([7]);
        const subject = observableOf(node, 'hp')!;
        const watched: number[] = [];
        subject.subscribe(v => watched.push(v as number));
        node.hp = 1;
        expect(watched).toEqual([80, 1]);
        expect(Object.keys(node)).toContain('hp');
    });

    it('keeps a per-node value the scene gave it', () => {
        const scene = newScene();
        const node = new Node('n') as any;
        node.hp = 5;                                  // as _commonParse restores scriptVars, before the script binds
        scene.addNode(node);
        attachScriptFactory(node, compileScript(IMPORTS + `export default class Hp extends Node { @observable hp = 100 }`));
        scene.start();
        expect(node.hp).toBe(5);
    });

    it('works under a standard compiler too', () => {
        class Native extends Node { @observable level = 1; }
        const scene = newScene();
        const node = new Native('n');
        scene.addNode(node);
        scene.start();
        const got: number[] = [];
        node.addEventListener('levelChanged', (v: number) => got.push(v));
        node.level = 2;
        expect(got).toEqual([2]);
    });
});

describe('@onClipEvent and the animator', () => {
    const SKIN: Skin = { joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }], nodeTransforms: new Map([[0, mat4.create()]]) };
    const clip = (name: string, events?: Animation['events']): Animation => ({
        name, events,
        samplers: [{ input: [0, 1], output: [0, 0, 0, 1, 0, 0], interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
    });
    const machine: AnimationStateMachine = {
        parameters: [{ name: 'go', type: 'trigger', defaultValue: false } as any],
        states: [
            { name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true },
            { name: 'Swing', clipName: 'swing', loop: false, speed: 1 },
        ],
        transitions: [{ from: 'Idle', to: 'Swing', conditions: [{ param: 'go', op: 'trigger' } as any] }],
        events: [],
    };
    const step = (a: Animator, seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { a.checkTriggers(); a.update(1 / 60); } };

    /** A character root with the script, and its model node, which the animator belongs to. */
    function character(source: string) {
        const scene = newScene();
        const root = new Node('hero'), model = new Node('model');
        root.addChild(model);
        scene.addNode(root);
        attachScriptFactory(root, compileScript(IMPORTS + source));
        scene.start();
        const animatedModel = { skin: SKIN, animations: [clip('idle', [{ time: 0.5, name: 'step' }]), clip('swing', [{ time: 0.3, name: 'hit' }, { time: 0.4, name: 'combat:contact' }])] } as unknown as AnimatedModel;
        const animator = new Animator(animatedModel, model);
        animator.setStateMachine(machine);
        return { scene, root: root as any, animator };
    }

    it('hears the markers its own model’s animator reaches, by name and clip, with no subscribing', () => {
        const { root, animator } = character(`
            export default class Hero extends Node {
              log = []
              @onClipEvent('step') step(info) { this.log.push(info.event + '@' + info.clip + ':' + info.state) }
              @onClipEvent('hit', 'swing') hit(info) { this.log.push('hit ' + info.layer) }
              @onClipEvent('hit', 'other') never() { this.log.push('wrong clip') }
              @eventListener('combat:contact') contact(info) { this.log.push('contact ' + info.clip) }
            }`);
        step(animator, 0.6);
        animator.setTrigger('go');
        step(animator, 0.5);
        expect(root.log).toEqual(['step@idle:Idle', 'hit null', 'contact swing']);
    });

    it('still calls the legacy onAnimationEvent listener and the event system once each', () => {
        const { root, animator } = character(`
            export default class Hero extends Node {
              n = 0
              @onClipEvent('step') step() { this.n++ }
            }`);
        const legacy: string[] = [];
        animator.onAnimationEvent(name => legacy.push(name));
        step(animator, 0.6);
        expect([root.n, legacy]).toEqual([1, ['step']]);
    });

    it('posts StateEnter / StateExit for the frame’s flush, not inside the transition', () => {
        const { root, animator, scene } = character(`
            export default class Hero extends Node {
              log = []
              @eventListener('animation:StateEnter') enter(info) { this.log.push('enter ' + info.state + ' from ' + info.from) }
              @eventListener('animation:StateExit') exit(info) { this.log.push('exit ' + info.state) }
            }`);
        step(animator, 0.1);
        animator.setTrigger('go');
        step(animator, 1 / 60);
        expect(root.log, 'nothing yet: delivered at the flush').toEqual([]);
        scene.update(1 / 60, 0, false);
        // The entry state was entered too, when the machine was set.
        expect(root.log).toEqual(['enter Idle from null', 'exit Idle', 'enter Swing from Idle']);
    });

    it('posts ActionFinished when an action is over', async () => {
        const { root, animator, scene } = character(`
            export default class Hero extends Node {
              done = []
              @eventListener('animation:ActionFinished') finished(info) { this.done.push(info.clip + ' in ' + info.layer) }
            }`);
        const handle = animator.playAction('swing', { slot: 'Upper', blendOut: 0.05 });
        step(animator, 1.3);
        await handle.finished;
        scene.update(1 / 60, 0, false);
        expect(root.done).toEqual(['swing in Upper']);
    });

    it('does nothing extra when nobody listens', () => {
        const scene = newScene();
        const model = new Node('model');
        scene.addNode(model);
        const animatedModel = { skin: SKIN, animations: [clip('idle', [{ time: 0.5, name: 'step' }])] } as unknown as AnimatedModel;
        const animator = new Animator(animatedModel, model);
        animator.setStateMachine({ ...machine, states: [machine.states[0]], transitions: [] });
        expect(() => step(animator, 1)).not.toThrow();
        expect(Events.channel('animation').queued).toBe(0);
    });
});

describe('the decorators’ records', () => {
    it('keep the channel, so a derived class re-decorating one event does not hide another', () => {
        class Base extends Node {
            @eventListener('Ping') a() {}
            @eventListener('ui:Ping') b() {}
        }
        const kinds = membersOfNode(new Base('n')).filter(m => m.kind === 'targetEvent').map((m: any) => `${m.channel}:${m.name}:${m.method}`).sort();
        expect(kinds).toEqual(['game:Ping:a', 'ui:Ping:b']);
    });
});

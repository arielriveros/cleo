import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { attachScriptFactory } from '../src/core/scene/nodes/nodeScripting';
import { compileScript, SCRIPT_HANDLERS } from '../src/core/scripting/scriptRuntime';
import '../src/cleo';   // registers the 'cleo' module a script's `import ... from 'cleo'` resolves to
import { InputSystem } from '../src/input/inputSystem';
import { idleState } from '../src/input/actionMap';
import type { ActionState } from '../src/input/actionMap';

// `onAction` is the replacement for registerKeyPress, and it inherits two properties that callback had
// to be given by hand: it cannot throw out of the frame, and it needs no unregister. Both come from
// being listed in SCRIPT_HANDLERS rather than special-cased, which is what the first test pins.
//
// The scene half is dispatch: only nodes that actually override the handler are called, and the call
// lands before that node's onUpdate so a handler and the same frame's poll agree about the world.

/** A state that reads as a fresh press, without standing up a device snapshot to produce one. */
function pressed(): ActionState {
    return { ...idleState('button'), value: 1, vector: [1, 0], pressed: true, started: true, phase: 'performed', device: 'key' };
}

/** Feed the running InputSystem a change list, the way beginFrame would. */
function stageChanges(changes: { map: string; action: string; state: ActionState }[]): void {
    (InputSystem.instance as unknown as { _changed: unknown })._changed = changes;
}

let errors: string[] = [];
let restoreLogger: (() => void) | null = null;

beforeEach(async () => {
    errors = [];
    const { Logger } = await import('../src/core/logger');
    const original = Logger.error;
    Logger.error = ((message: unknown) => { errors.push(String(message)); }) as typeof Logger.error;
    restoreLogger = () => { Logger.error = original; };
});

afterEach(() => {
    stageChanges([]);
    restoreLogger?.();
});

describe('the onAction handler contract', () => {
    it('is listed in SCRIPT_HANDLERS, so it gets onUpdate\'s throw guarding', () => {
        // Listed rather than special-cased. A handler driven by a device event that could throw out of
        // the frame is exactly how the old registerKeyPress callbacks escaped to the page.
        expect(SCRIPT_HANDLERS).toContain('onAction');
    });

    it('exists on every Node as a no-op, so a script may simply not have one', () => {
        expect(typeof new Node('n').onAction).toBe('function');
        expect(new Node('n').onAction('Jump', pressed())).toBeUndefined();
    });

    it('is bound by the legacy `this.onX = ...` script path, node-first like its siblings', () => {
        // The legacy convention prepends the proxied self to every handler's arguments; onAction is
        // listed alongside the others rather than special-cased, so it follows the same shape.
        const node = new Node('legacy');
        attachScriptFactory(node, compileScript(`this.onAction = (self, action) => { self.name = 'saw:' + action }`));
        node.onAction('Jump', pressed());
        expect(node.name).toBe('saw:Jump');
    });

    it('is bound by the class script path', () => {
        const node = new Node('classy');
        attachScriptFactory(node, compileScript(`
            import { Node } from 'cleo'
            export default class Handler extends Node {
              onAction(action, state) { this.name = action + ':' + state.phase }
            }
        `));
        node.onAction('Fire', pressed());
        expect(node.name).toBe('Fire:performed');
    });

    it('catches a throwing handler instead of letting it escape the frame', () => {
        const node = new Node('thrower');
        attachScriptFactory(node, compileScript(`this.onAction = () => { throw new Error('boom') }`));
        expect(() => node.onAction('Jump', pressed())).not.toThrow();
        expect(errors.join('\n')).toContain('boom');
    });

    it('catches a rejected async handler', async () => {
        const node = new Node('async');
        attachScriptFactory(node, compileScript(`this.onAction = async () => { throw new Error('late boom') }`));
        node.onAction('Jump', pressed());
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(errors.join('\n')).toContain('late boom');
    });
});

describe('scene dispatch', () => {
    class Recorder extends Node {
        public seen: string[] = [];
        public updates = 0;
        public onAction(action: string, state: ActionState): void {
            this.seen.push(`${action}:${state.phase}`);
        }
        public onUpdate(): void { this.updates++; }
    }

    function startedScene() {
        const scene = new Scene();
        const node = new Recorder('recorder');
        scene.addNode(node);
        scene.start();
        return { scene, node };
    }

    it('delivers every change that fired this frame', () => {
        const { scene, node } = startedScene();
        stageChanges([
            { map: 'Gameplay', action: 'Jump', state: pressed() },
            { map: 'Gameplay', action: 'Fire', state: pressed() },
        ]);
        scene.update(1 / 60, 0, false);
        expect(node.seen).toEqual(['Jump:performed', 'Fire:performed']);
    });

    it('delivers nothing on a frame where no action changed phase', () => {
        const { scene, node } = startedScene();
        stageChanges([]);
        scene.update(1 / 60, 0, false);
        expect(node.seen).toEqual([]);
        expect(node.updates).toBe(1);
    });

    it('runs the handler BEFORE that frame\'s onUpdate', () => {
        // So a handler and the poll in onUpdate agree about what happened, rather than the handler
        // landing one frame behind what the script just read.
        const scene = new Scene();
        const order: string[] = [];
        class Ordered extends Node {
            public onAction(): void { order.push('action'); }
            public onUpdate(): void { order.push('update'); }
        }
        scene.addNode(new Ordered('ordered'));
        scene.start();
        stageChanges([{ map: 'Gameplay', action: 'Jump', state: pressed() }]);
        scene.update(1 / 60, 0, false);
        expect(order).toEqual(['action', 'update']);
    });

    it('does not deliver while the game is paused', () => {
        const { scene, node } = startedScene();
        stageChanges([{ map: 'Gameplay', action: 'Jump', state: pressed() }]);
        scene.update(1 / 60, 0, true);
        expect(node.seen).toEqual([]);
    });

    it('survives a node whose handler throws, and keeps going', () => {
        const scene = new Scene();
        class Thrower extends Node {
            public onAction(): void { throw new Error('handler exploded'); }
        }
        const after = new Recorder('after');
        scene.addNode(new Thrower('thrower'));
        scene.addNode(after);
        scene.start();
        stageChanges([{ map: 'Gameplay', action: 'Jump', state: pressed() }]);
        expect(() => scene.update(1 / 60, 0, false)).not.toThrow();
        expect(after.seen).toEqual(['Jump:performed']);
        expect(errors.join('\n')).toContain('handler exploded');
    });
});

describe('InputSystem subscriptions', () => {
    it('notifies by bare name, by qualified name and by wildcard', () => {
        const system = InputSystem.instance;
        const seen: string[] = [];
        const off = [
            system.onAction('Jump', () => seen.push('bare')),
            system.onAction('Gameplay/Jump', () => seen.push('qualified')),
            system.onAction('*', () => seen.push('wildcard')),
        ];
        (system as unknown as { _dispatch(c: unknown): void })
            ._dispatch({ map: 'Gameplay', action: 'Jump', state: pressed() });
        expect(seen.sort()).toEqual(['bare', 'qualified', 'wildcard']);
        for (const cancel of off) cancel();
    });

    it('stops notifying once unsubscribed — no name to remember, unlike registerKeyPress', () => {
        const system = InputSystem.instance;
        let count = 0;
        const off = system.onAction('Jump', () => { count++; });
        const dispatch = (system as unknown as { _dispatch(c: unknown): void })._dispatch.bind(system);
        dispatch({ map: 'Gameplay', action: 'Jump', state: pressed() });
        off();
        dispatch({ map: 'Gameplay', action: 'Jump', state: pressed() });
        expect(count).toBe(1);
    });

    it('lets several listeners share one action', () => {
        // The old system had exactly one onPress slot per key, so a second script silently replaced the
        // first. Two nodes wanting the same action is entirely ordinary.
        const system = InputSystem.instance;
        let a = 0, b = 0;
        const offA = system.onAction('Fire', () => { a++; });
        const offB = system.onAction('Fire', () => { b++; });
        (system as unknown as { _dispatch(c: unknown): void })
            ._dispatch({ map: 'Gameplay', action: 'Fire', state: pressed() });
        expect([a, b]).toEqual([1, 1]);
        offA(); offB();
    });
});

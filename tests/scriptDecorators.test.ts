import { describe, it, expect, afterEach, vi } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { attachScriptFactory, routeTrigger } from '../src/core/scene/nodes/nodeScripting';
import { GameEvents } from '../src/core/scripting/scriptEvents';
import { buildFactoryBody, compileScript, listScriptImports } from '../src/core/scripting/scriptRuntime';
import { lowerScriptDecorators } from '../src/core/scripting/scriptDecoratorLowering';
import { child, find, onAction, save, options, pick, attribute, scriptMembersOf, membersOfNode } from '../src/core/scripting/decorators';
import { Logger } from '../src/core/logger';
import '../src/cleo';   // registers the 'cleo' module a script's `import ... from 'cleo'` resolves to
import { InputSystem } from '../src/input/inputSystem';
import { idleState } from '../src/input/actionMap';
import type { ActionState } from '../src/input/actionMap';

// Script decorators (`@child`, `@find`, `@onAction`, `@save`, `@options`, `@pick`) reach the engine two
// ways, and both must agree: Cleo's own script compile, which lowers them into a static block before Sucrase
// (which cannot handle decorators) and V8 (which cannot parse them); and a compiler implementing the
// standard — esbuild compiles THIS file's classes, as it does the example scripts the Souls tests import.

function edge(over: Partial<ActionState>): ActionState {
    return { ...idleState('button'), device: 'key', ...over };
}
const PRESS = edge({ value: 1, pressed: true, started: true, phase: 'performed' });
const RELEASE = edge({ released: true, phase: 'canceled' });

function stageChanges(changes: { map: string; action: string; state: ActionState }[]): void {
    (InputSystem.instance as unknown as { _changed: unknown })._changed = changes;
}

afterEach(() => { stageChanges([]); vi.restoreAllMocks(); });

/** A node tree from `{ name: [children...] }`-ish specs: `tree('Root', tree('A', tree('B')))`. */
function tree(name: string, ...children: Node[]): Node {
    const node = new Node(name);
    for (const c of children) node.addChild(c);
    return node;
}

/** Attach a class script to `node` (already in `scene`), the way the editor's Play does, then start. */
function scripted(source: string, node = new Node('subject'), scene = new Scene(), others: Node[] = []): any {
    scene.addNode(node);
    for (const o of others) scene.addNode(o);
    attachScriptFactory(node, compileScript(source));
    scene.start();
    return node;
}

describe('lowering', () => {
    it('leaves a source without decorators exactly as it is', () => {
        const src = `import { Node } from 'cleo'\n/** @save is only a comment here */\nexport default class A extends Node { x = 'a@b' }\n`;
        expect(lowerScriptDecorators(src)).toBe(src);
    });

    it('keeps every line and column of the author\'s source', () => {
        const src = [
            `import { Node, child, save } from 'cleo'`,
            `export default class A extends Node {`,
            `  @child('Muzzle') muzzle?: Node`,
            `  @save`,
            `  kills = 0`,
            `}`,
        ].join('\n');
        const out = lowerScriptDecorators(src).split('\n');
        expect(out).toHaveLength(6);
        expect(out[2].indexOf('muzzle')).toBe(src.split('\n')[2].indexOf('muzzle'));
        expect(out[3].trim()).toBe('');
        expect(out[5]).toMatch(/^;static\{__cleoImport\("cleo"\)\.applyScriptDecorators\(this,\[.*\]\)\}\}$/);
        expect(out[5]).toContain(`[[child('Muzzle')],"field","muzzle",1]`);
        expect(out[5]).toContain(`[[save],"field","kills",0]`);
    });

    it('does not mistake an @ in a string, template, regex or comment for a decorator', () => {
        const src = [
            `export default class A {`,
            `  a = 'x@y'; b = \`@\${1}\`; c = /@z/g`,
            `  // @child('nope')`,
            `  /** @save */ d = 1`,
            `}`,
        ].join('\n');
        expect(lowerScriptDecorators(src)).toBe(src);
    });

    it('gives each decorated class its own block, nested ones included', () => {
        const src = `class Outer { @save a = 1\n  make() { return class Inner { @save b = 2 } } }`;
        const out = lowerScriptDecorators(src);
        expect(out).toContain(`[[save],"field","b",0]`);
        expect(out.match(/static\{/g)).toHaveLength(2);
        expect(out.indexOf('"b"')).toBeLessThan(out.indexOf('"a"'));   // Inner's block closes Inner
    });

    it('does not take a brace in the heritage clause for the class body', () => {
        const src = `class A extends Base<{ x: number }> { @save a = 1 }`;
        expect(lowerScriptDecorators(src)).toContain(`[[save],"field","a",0]`);
    });

    it.each([
        [`@PROPERTY let x: number = 0`, 'not valid here', 1],
        [`const a = 1\n@sealed export default class A {}`, 'decorates a class', 2],
        [`class A {\n  @save static n = 1 }`, 'static', 2],
        [`class A { @save #n = 1 }`, '#private', 1],
        [`class A { @save ['n'] = 1 }`, 'computed', 1],
        [`class A { @save get n() { return 1 } }`, 'accessor', 1],
    ])('rejects %j at its line', (src, message, line) => {
        let error: any;
        try { lowerScriptDecorators(src); } catch (e) { error = e; }
        expect(error?.message).toContain(message);
        expect(error?.loc?.line).toBe(line);
    });

    it('compiles for publishing (buildFactoryBody) into plain JS', () => {
        const body = buildFactoryBody(`import { Node, child, onAction } from 'cleo'
export default class A extends Node {
  @child('X') x?: Node
  @onAction('Jump') jump() {}
}`);
        expect(() => new Function('__cleoImport', '__cleoExports', body)).not.toThrow();
        expect(body).not.toMatch(/@(child|onAction)\b/);
    });

    it('still lists a decorated script\'s imports', () => {
        expect(listScriptImports(`import { Node, save } from 'cleo'\nimport { m } from '@/Shared/Math'\nexport default class A extends Node { @save x = m }`))
            .toEqual(['/Shared/Math']);
    });
});

describe('@child and @find through the script runtime', () => {
    it('fills a direct child before onConstruct', () => {
        const node = scripted(`
            import { Node, child } from 'cleo'
            export default class A extends Node {
              @child('Muzzle') muzzle?: Node
              seen = ''
              onConstruct() { this.seen = this.muzzle?.name ?? 'none' }
            }`, tree('Gun', tree('Muzzle')));
        expect(node.seen).toBe('Muzzle');
        expect(node.muzzle).toBe(node.children[0]);
    });

    it('takes the nearest match, breadth-first, and follows a path', () => {
        const near = tree('Fill');
        const deep = tree('Fill');
        const node = scripted(`
            import { Node, child } from 'cleo'
            export default class A extends Node {
              @child('Fill') fill?: Node
              @child('Bar/Fill') barFill?: Node
              @child('Deep') deep?: Node
            }`, tree('Root', tree('Panel', tree('Bar', tree('Frame', deep))), near, tree('X', tree('Y', tree('Deep')))));
        expect(node.fill).toBe(near);
        expect(node.barFill).toBe(deep);
        expect(node.deep?.name).toBe('Deep');
    });

    it('finds a node anywhere in the scene with @find', () => {
        const gm = new Node('GameManager');
        const node = scripted(`
            import { Node, find } from 'cleo'
            export default class A extends Node { @find('GameManager') private _gm: Node | null = null }`,
            new Node('subject'), new Scene(), [tree('World', gm)]);
        expect(node._gm).toBe(gm);
    });

    it('keeps a value already in the field', () => {
        const scene = new Scene();
        const node = tree('Gun', tree('Muzzle'));
        scene.addNode(node);
        attachScriptFactory(node, compileScript(`
            import { Node, child } from 'cleo'
            export default class A extends Node { @child('Muzzle') muzzle?: Node }`));
        const mine = new Node('Mine');
        (node as any).muzzle = mine;
        scene.start();
        expect((node as any).muzzle).toBe(mine);
    });

    it('fills, before onStart, what another node spawned after onConstruct', () => {
        const scene = new Scene();
        const spawner = new Node('Spawner');
        spawner.onConstruct = () => { scene.addNode(new Node('Late')); };
        scene.addNode(spawner);
        const node = new Node('subject');
        scene.addNode(node);
        attachScriptFactory(node, compileScript(`
            import { Node, find } from 'cleo'
            export default class A extends Node {
              @find('Late') late?: Node
              atStart = ''
              onStart() { this.atStart = this.late?.name ?? 'none' }
            }`));
        scene.start();
        expect((node as any).atStart).toBe('Late');
    });

    it('reports a missing reference once, unless the field is declared optional', () => {
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        const source = `
            import { Node, child, find } from 'cleo'
            export default class A extends Node {
              @child('MissingRequired') required!: Node
              @child('MissingOptional') maybe?: Node
              @find('NoSuchManager') manager: Node | null = null
            }`;
        scripted(source);
        scripted(source);
        const said = warn.mock.calls.map(c => String(c[0]));
        expect(said.filter(s => s.includes(`@child('MissingRequired')`))).toHaveLength(1);
        expect(said.filter(s => s.includes(`@find('NoSuchManager')`))).toHaveLength(1);
        expect(said.some(s => s.includes('MissingOptional'))).toBe(false);
    });

    it('combines a base class\'s decorators with the derived class\'s', () => {
        const node = scripted(`
            import { Node, child, find } from 'cleo'
            class Base extends Node {
              @find('GameManager') gm?: Node
              @child('Model') model?: Node
            }
            export default class Derived extends Base {
              @child('Rig/Model') model?: Node
              @child('Sprite') sprite?: Node
            }`, tree('Hero', tree('Model'), tree('Rig', tree('Model')), tree('Sprite')), new Scene(), [new Node('GameManager')]);
        expect(node.gm?.name).toBe('GameManager');
        expect(node.sprite?.name).toBe('Sprite');
        expect(node.model).toBe(node.children[1].children[0]);   // the derived class's path wins
    });
});

describe('@onAction through the script runtime', () => {
    function actor(): any {
        return scripted(`
            import { Node, onAction } from 'cleo'
            export default class A extends Node {
              log: string[] = []
              @onAction('Jump') jump(state) { this.log.push('jump:' + state.phase + ':' + this.name) }
              @onAction('Jump', 'released') land() { this.log.push('land') }
              @onAction('Gameplay/Fire', 'changed') fire(state) { this.log.push('fire:' + (state.started ? 'down' : 'up')) }
              @onAction('Roll', 'performed') roll() { this.log.push('roll') }
              onAction(action) { this.log.push('any:' + action) }
            }`);
    }

    it('calls a method on the action it names, by default on the press', () => {
        const node = actor();
        stageChanges([{ map: 'Gameplay', action: 'Jump', state: PRESS }]);
        node.scene.update(1 / 60, 0, false);
        expect(node.log).toEqual(['jump:performed:subject', 'any:Jump']);
    });

    it('filters by when, and matches a map-qualified name', () => {
        const node = actor();
        stageChanges([
            { map: 'Gameplay', action: 'Jump', state: RELEASE },
            { map: 'Gameplay', action: 'Fire', state: PRESS },
            { map: 'Gameplay', action: 'Fire', state: RELEASE },
            { map: 'Menu', action: 'Fire', state: PRESS },
            { map: 'Gameplay', action: 'Roll', state: edge({ pressed: true, started: true, phase: 'started' }) },
        ]);
        node.scene.update(1 / 60, 0, false);
        expect(node.log.filter((s: string) => !s.startsWith('any:'))).toEqual(['land', 'fire:down', 'fire:up']);
    });

    it('delivers nothing while the scene is paused', () => {
        const node = actor();
        stageChanges([{ map: 'Gameplay', action: 'Jump', state: PRESS }]);
        node.scene.update(1 / 60, 0, true);
        expect(node.log).toEqual([]);
    });

    it('catches a throwing method and keeps dispatching', () => {
        const errors: string[] = [];
        vi.spyOn(Logger, 'error').mockImplementation(((m: unknown) => { errors.push(String(m)); }) as any);
        const node = scripted(`
            import { Node, onAction } from 'cleo'
            export default class A extends Node {
              ok = 0
              @onAction('Jump') boom() { throw new Error('boom') }
              @onAction('Jump') fine() { this.ok++ }
            }`);
        stageChanges([{ map: 'Gameplay', action: 'Jump', state: PRESS }]);
        node.scene.update(1 / 60, 0, false);
        expect(node.ok).toBe(1);
        expect(errors.join('\n')).toContain('boom');
    });
});

describe('decorators with standard semantics', () => {
    it('records @save, @options and @pick for the engine to read', () => {
        const node = new Node('n');
        attachScriptFactory(node, compileScript(`
            import { Node, save, options, pick } from 'cleo'
            export default class A extends Node {
              list: string[] = ['a']
              @save @options('list') choice = 'a'
              @pick('sound') cue = ''
            }`));
        const kinds = membersOfNode(node).map(m => `${m.kind}:${'field' in m ? m.field : ''}`);
        expect(kinds.sort()).toEqual(['options:choice', 'pick:cue', 'save:choice']);
    });

    it('lets a method decorator replace the method', () => {
        const node = scripted(`
            import { Node } from 'cleo'
            const twice = (fn) => function () { fn.call(this); fn.call(this) }
            export default class A extends Node {
              n = 0
              @twice bump() { this.n++ }
            }`);
        node.bump();
        expect(node.n).toBe(2);
    });

    it('rejects what a class that is never constructed cannot run', () => {
        expect(() => attachScriptFactory(new Node('n'), compileScript(`
            import { Node } from 'cleo'
            const init = () => () => 5
            export default class A extends Node { @init x = 1 }`))).toThrow(/initializer/);
        expect(() => attachScriptFactory(new Node('n'), compileScript(`
            import { Node } from 'cleo'
            const late = (_v, ctx) => { ctx.addInitializer(() => {}) }
            export default class A extends Node { @late m() {} }`))).toThrow(/addInitializer/);
    });

    it('works the same on a class compiled by a standard compiler and used as a Node subclass', () => {
        // esbuild compiles this file, decorators included: the path the Souls tests take.
        class Native extends Node {
            @child('Muzzle') muzzle?: Node;
            @find('GameManager') gm?: Node;
            @save kills = 0;
            public jumps = 0;
            @onAction('Jump') jump() { this.jumps++; }
        }
        class Derived extends Native {
            @child('Sight') sight?: Node;
        }
        expect(scriptMembersOf(Derived).map(m => m.kind).sort()).toEqual(['action', 'child', 'child', 'find', 'save']);
        expect(scriptMembersOf(Native).map(m => m.kind).sort()).toEqual(['action', 'child', 'find', 'save']);

        const scene = new Scene();
        const node = new Derived('Gun');
        node.addChild(new Node('Muzzle'));
        node.addChild(new Node('Sight'));
        scene.addNode(node);
        scene.addNode(new Node('GameManager'));
        scene.start();
        expect(node.muzzle?.name).toBe('Muzzle');
        expect(node.sight?.name).toBe('Sight');
        expect(node.gm?.name).toBe('GameManager');

        stageChanges([{ map: 'Gameplay', action: 'Jump', state: PRESS }]);
        scene.update(1 / 60, 0, false);
        expect(node.jumps).toBe(1);
    });

    it('reports a decorator on the wrong kind of member', () => {
        expect(() => {
            class Wrong extends Node {
                // @ts-expect-error -- @onAction goes on a method
                @onAction('Jump') field = 1;
            }
            return Wrong;
        }).toThrow(/goes on a method/);
        expect(typeof pick).toBe('function');
        expect(typeof options).toBe('function');
    });
});

describe('@onEvent, @every, @onEnter / @onExit', () => {
    it('@onEvent listens while the node is awake, with the payload', () => {
        const node = scripted(`
            import { Node, onEvent } from 'cleo'
            export default class A extends Node {
              got = []
              @onEvent('Hurt') hurt(p) { this.got.push(p) }
            }`);
        GameEvents.emit('Hurt', 3);
        expect(node.got).toEqual([3]);
        node.despawn();
        GameEvents.emit('Hurt', 4);
        expect(node.got).toEqual([3]);          // asleep: not called
        node.spawn();
        GameEvents.emit('Hurt', 5);
        expect(node.got).toEqual([3, 5]);       // awake again: listening again
        node.scene.remove?.(node);
        node.parent?.removeChild?.(node);
        GameEvents.emit('Hurt', 6);
        expect(node.got.includes(6)).toBe(false);
    });

    it('@every runs on the period, in unpaused game time, and stops on despawn', () => {
        const node = scripted(`
            import { Node, every } from 'cleo'
            export default class A extends Node {
              ticks = 0
              @every(0.5) tick() { this.ticks++ }
            }`);
        for (let i = 0; i < 65; i++) node.scene.update(1 / 60, i / 60, false);
        expect(node.ticks).toBe(2);
        for (let i = 0; i < 60; i++) node.scene.update(1 / 60, i / 60, true);
        expect(node.ticks).toBe(2);             // paused: no time passes
        node.despawn();
        for (let i = 0; i < 60; i++) node.scene.update(1 / 60, i / 60, false);
        expect(node.ticks).toBe(2);
    });

    it('@onEnter / @onExit filter by name or variable, on the node or an ancestor', () => {
        const node = scripted(`
            import { Node, onEnter, onExit } from 'cleo'
            export default class A extends Node {
              log = []
              @onEnter() any(o) { this.log.push('any:' + o.name) }
              @onEnter('Player') player(o) { this.log.push('player:' + o.name) }
              @onEnter('isEnemy') enemy(o) { this.log.push('enemy:' + o.name) }
              @onExit('Player') left(o) { this.log.push('left:' + o.name) }
            }`);
        const player = tree('Player Collider', tree('Player'));
        const hollow = new Node('Hollow'); hollow.setVariable('isEnemy', true, 'boolean', 'public');
        const rock = new Node('Rock');
        const hand = player.children[0];
        routeTrigger(node, 'enter', hand);       // a child of ... whose ancestor is not named Player: the child is
        routeTrigger(node, 'enter', hollow);
        routeTrigger(node, 'enter', rock);
        routeTrigger(node, 'exit', hand);
        expect(node.log).toEqual(['any:Player', 'player:Player', 'any:Hollow', 'enemy:Hollow', 'any:Rock', 'left:Player']);
    });
});

describe('@onHold and @onTap', () => {
    const input = () => InputSystem.instance as any;
    function actor(): any {
        return scripted(`
            import { Node, onHold, onTap } from 'cleo'
            export default class A extends Node {
              log: string[] = []
              @onHold('Roll', 0.5) sprint() { this.log.push('hold') }
              @onTap('Roll', 0.25) roll() { this.log.push('tap') }
            }`);
    }

    it('a quick press and release is a tap, and never a hold', () => {
        const node = actor();
        const scene = node.scene;
        const stateOf = vi.spyOn(input(), 'state').mockReturnValue({ ...idleState('button'), pressed: true, heldSeconds: 0.05 } as any);
        stageChanges([{ map: 'G', action: 'Roll', state: edge({ pressed: true, started: true, phase: 'performed' }) }]);
        scene.update(0.05, 0, false);
        stageChanges([{ map: 'G', action: 'Roll', state: edge({ released: true, phase: 'canceled' }) }]);
        stateOf.mockReturnValue({ ...idleState('button') } as any);
        scene.update(0.05, 0.05, false);
        expect(node.log).toEqual(['tap']);
    });

    it('a long press fires the hold once, and its release is not a tap', () => {
        const node = actor();
        const scene = node.scene;
        let held = 0;
        vi.spyOn(input(), 'state').mockImplementation(() => ({ ...idleState('button'), pressed: held > 0, heldSeconds: held } as any));
        held = 0.01;
        stageChanges([{ map: 'G', action: 'Roll', state: edge({ pressed: true, started: true, phase: 'performed' }) }]);
        scene.update(0.01, 0, false);
        stageChanges([]);
        for (let t = 0; t < 1; t += 0.1) { held = 0.01 + t; scene.update(0.1, t, false); }
        stageChanges([{ map: 'G', action: 'Roll', state: edge({ released: true, phase: 'canceled' }) }]);
        held = 0;
        scene.update(0.1, 1, false);
        stageChanges([]);
        scene.update(0.1, 1.1, false);
        expect(node.log).toEqual(['hold']);
    });

    it('delivers nothing while paused', () => {
        const node = actor();
        vi.spyOn(input(), 'state').mockReturnValue({ ...idleState('button'), pressed: true, heldSeconds: 2 } as any);
        node.scene.update(0.1, 0, true);
        expect(node.log).toEqual([]);
    });
});

describe('@attribute', () => {
    it('records its group and options, bare or called, through the script compile', () => {
        const node = new Node('n');
        attachScriptFactory(node, compileScript(`
            import { Node, attribute } from 'cleo'
            export default class A extends Node {
              @attribute speed = 1
              @attribute('Combat') damage = 2
              @attribute('Combat', { min: 0, max: 1 }) crit = 0.1
              @attribute({ readonly: true }) private _hp = 3
            }`));
        const attrs = membersOfNode(node).filter(m => m.kind === 'attribute') as any[];
        const byField = Object.fromEntries(attrs.map(a => [a.field, a]));
        expect(byField.speed).toMatchObject({ group: undefined, options: {} });
        expect(byField.damage).toMatchObject({ group: 'Combat' });
        expect(byField.crit).toMatchObject({ group: 'Combat', options: { min: 0, max: 1 } });
        expect(byField._hp).toMatchObject({ options: { readonly: true } });
    });

    it('works bare under a standard compiler too', () => {
        class Native extends Node { @attribute speed = 1; @attribute('Combat') damage = 2; }
        expect(scriptMembersOf(Native).filter(m => m.kind === 'attribute').map((m: any) => `${m.field}:${m.group ?? ''}`).sort())
            .toEqual(['damage:Combat', 'speed:']);
    });
});

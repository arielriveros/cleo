import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';
import { attachScriptFactory } from '../src/core/scene/nodes/nodeScripting';
import {
    compileScript, buildFactoryBody, normalizeScriptSpecifier, listScriptImports, setScriptModuleSources,
    setScriptModuleProvider, resetScriptModules, resolveScriptModule, compileScriptModule,
} from '../src/core/scripting/scriptRuntime';
import '../src/cleo';   // registers 'cleo'

// One script importing another: helper modules (functions, constants, enums) and shared base classes,
// addressed by project path — '@/Shared/Math' from the root, './Util' relative to the importer. A node's
// own script still runs per node; an imported module runs once and is shared.

beforeEach(() => resetScriptModules());
afterEach(() => { resetScriptModules(); setScriptModuleProvider(null); });

/** Attach `source` (the script at `path`) to a fresh node, the way scene parsing does. */
function attach(source: string, path?: string, node: Node = new Node('n')): Node {
    attachScriptFactory(node, compileScript(source, { path }));
    return node;
}

describe('specifiers', () => {
    it('maps project-root and relative paths to one canonical id', () => {
        expect(normalizeScriptSpecifier('@/Shared/Math')).toBe('/Shared/Math');
        expect(normalizeScriptSpecifier('./Util', '/Enemies/Hollow')).toBe('/Enemies/Util');
        expect(normalizeScriptSpecifier('../Shared/Math.ts', '/Enemies/Hollow')).toBe('/Shared/Math');
        expect(normalizeScriptSpecifier('./a/../b/./C.script', '/X/Y')).toBe('/X/b/C');
        expect(normalizeScriptSpecifier('cleo')).toBe('cleo');
    });

    it('rejects what the tools could not resolve identically', () => {
        expect(() => normalizeScriptSpecifier('./Util')).toThrow(/saved script asset/);
        expect(() => normalizeScriptSpecifier('../../X', '/A/B')).toThrow(/above the project root/);
        expect(() => normalizeScriptSpecifier('/Shared/Math')).toThrow(/'@\/Shared\/Math'/);
    });

    it('lists a script\'s imports canonicalised, without type-only ones', () => {
        const src = `import { Node } from 'cleo'
import type { T } from '@/Types'
import { a } from '../Shared/Math'
import * as U from './Util'
export { b } from '@/Shared/More'
export default class X extends Node { f(t: T) { return a + U.x } }`;
        // Unused imports are dropped by Sucrase before the scan — the runtime never loads them either.
        expect(listScriptImports(src, '/Enemies/Hollow')).toEqual(['/Shared/Math', '/Enemies/Util', '/Shared/More']);
    });
});

describe('helper modules', () => {
    it('exports functions, constants, lets, enums, aliases and a default', () => {
        setScriptModuleSources({
            '/Shared/Math': `
export function clamp01(v: number): number { return Math.max(0, Math.min(1, v)) }
export const TAU = Math.PI * 2, HALF = 0.5
export let counter = 0
export function bump() { counter++ }
export enum Dir { Up, Down }
const secret = 42
export { secret as answer }
export default function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
export type Vec = [number, number]
`,
        });
        const node = attach(`
import lerp, { clamp01, TAU, HALF, Dir, answer, bump } from '@/Shared/Math'
import * as M from '@/Shared/Math'
import { Node } from 'cleo'
export default class Probe extends Node {
    readOut(): any {
        bump()
        return [clamp01(2), TAU, HALF, Dir.Down, Dir[0], answer, lerp(0, 10, 0.5), M.counter]
    }
}`, '/Probe');
        expect((node as any).readOut()).toEqual([1, Math.PI * 2, 0.5, 1, 'Up', 42, 5, 1]);
    });

    it('re-exports from another module, by name and wholesale', () => {
        setScriptModuleSources({
            '/A': `export const a = 1; export const shared = 'A'; export default 'ignored-by-star'`,
            '/B': `export * from './A'\nexport { a as renamed } from '@/A'\nexport * as all from './A'\nexport const shared = 'B'`,
        });
        const b = resolveScriptModule('/B');
        expect(b.a).toBe(1);
        expect(b.renamed).toBe(1);
        expect(b.shared).toBe('B');      // own export wins over the star
        expect(b.default).toBeUndefined(); // `export *` never forwards a default
        expect(b.all.shared).toBe('A');
    });

    it('resolves a folder to its index script', () => {
        setScriptModuleSources({ '/Shared/index': `export const x = 7` });
        expect(resolveScriptModule('/Shared').x).toBe(7);
    });

    it('evaluates a module once and shares its state across nodes', () => {
        setScriptModuleSources({ '/Counter': `export const state = { loads: 0, hits: 0 }; state.loads++` });
        const src = `import { state } from '@/Counter'\nimport { Node } from 'cleo'\nexport default class C extends Node { hit() { state.hits++; return state } }`;
        const nodes = [attach(src, '/C'), attach(src, '/C'), attach(src, '/C')];
        nodes.forEach(n => (n as any).hit());
        expect((nodes[0] as any).hit()).toEqual({ loads: 1, hits: 4 });
    });

    it('names the missing module and lists the known ones', () => {
        setScriptModuleSources({ '/Shared/Math': 'export const x = 1' });
        expect(() => resolveScriptModule('/Shared/Nope')).toThrow(/Cannot import '\/Shared\/Nope'.*'\/Shared\/Math'/);
    });

    it('reports a failing module once, then rethrows the cached error', () => {
        let runs = 0;
        (globalThis as any).__countRun = () => runs++;
        setScriptModuleSources({ '/Bad': `(globalThis as any).__countRun(); throw new Error('boom')` });
        expect(() => resolveScriptModule('/Bad')).toThrow(/Error in script module '\/Bad': boom/);
        expect(() => resolveScriptModule('/Bad')).toThrow(/boom/);
        expect(runs).toBe(1);
        delete (globalThis as any).__countRun;
    });

    it('resolves a case mismatch with a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setScriptModuleSources({ '/Shared/Math': 'export const x = 3' });
        expect(resolveScriptModule('/shared/math').x).toBe(3);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('rejects destructured exports with a clear message', () => {
        expect(() => buildFactoryBody(`export const { a, b } = obj`, { mode: 'module' })).toThrow(/destructured/);
        expect(() => buildFactoryBody(`export async x`, { mode: 'module' })).toThrow();
    });
});

describe('circular imports', () => {
    it('works when the cycle only shares functions', () => {
        setScriptModuleSources({
            '/A': `import { b } from './B'\nexport function a(n: number): number { return n <= 0 ? 0 : 1 + b(n - 1) }`,
            '/B': `import { a } from './A'\nexport function b(n: number): number { return n <= 0 ? 0 : 1 + a(n - 1) }`,
        });
        expect(resolveScriptModule('/A').a(5)).toBe(5);
    });

    it('names the cycle when a value is used before its module finished loading', () => {
        setScriptModuleSources({
            '/A': `import { B } from './B'\nexport const A = 'a' + B`,
            '/B': `import { A } from './A'\nexport const B = A + 'b'`,
        });
        expect(() => resolveScriptModule('/A')).toThrow(/circular import \/A → \/B → \/A/);
    });
});

describe('shared base classes', () => {
    const BASE = `
import { Node } from 'cleo'
export default class EnemyBase extends Node {
    public maxHp: number = 100
    public speed: number = 2
    public log: string[] = []
    get alive(): boolean { return (this as any).hp > 0 }
    onUpdate(delta: number) { this.log.push('base') }
    describe(): string { return 'enemy' }
    damage(n: number) { (this as any).hp -= n }
}`;

    it('brings inherited methods, accessors and field defaults to the node', () => {
        setScriptModuleSources({ '/Shared/EnemyBase': BASE });
        const node = attach(`
import EnemyBase from '../Shared/EnemyBase'
export default class Hollow extends EnemyBase {
    public speed: number = 5
    public hp: number = 30
    describe(): string { return 'hollow ' + super.describe() }
    onUpdate(delta: number) { super.onUpdate(delta); this.log.push('hollow') }
}`, '/Enemies/Hollow') as any;

        expect(node.maxHp).toBe(100);          // inherited default
        expect(node.speed).toBe(5);            // derived default overrides the base's
        expect(node.describe()).toBe('hollow enemy');
        node.damage(10);
        expect(node.hp).toBe(20);
        expect(node.alive).toBe(true);
        node.onUpdate(0.016);
        expect(node.log).toEqual(['base', 'hollow']);
        // The engine's own methods stay on the prototype — never frozen onto the node.
        expect(Object.prototype.hasOwnProperty.call(node, 'addChild')).toBe(false);
    });

    it('lets per-node values win over both levels of defaults', () => {
        setScriptModuleSources({ '/Shared/EnemyBase': BASE });
        const node = new Node('n') as any;
        node.maxHp = 7;
        attach(`import EnemyBase from '@/Shared/EnemyBase'\nexport default class H extends EnemyBase {}`, '/H', node);
        expect(node.maxHp).toBe(7);
    });

    it('guards an inherited handler that throws', () => {
        setScriptModuleSources({ '/Base': `import { Node } from 'cleo'\nexport default class B extends Node { onUpdate() { throw new Error('inherited boom') } }` });
        const node = attach(`import B from '@/Base'\nexport default class D extends B {}`, '/D') as any;
        expect(() => node.onUpdate(0)).not.toThrow();
    });

    it('stops at the first engine class even when the node is a different type', () => {
        const node = attach(`import { CharacterNode } from 'cleo'\nexport default class C extends CharacterNode { hello() { return 1 } }`, '/C');
        expect((node as any).hello()).toBe(1);
        expect(Object.prototype.hasOwnProperty.call(node, 'drive')).toBe(false);
        expect(node instanceof CharacterNode).toBe(false);
    });
});

describe('node scripts', () => {
    it('still accept a legacy handler script and a named class export', () => {
        const legacy = attach(`this.onUpdate = (self) => { self.name = 'legacy' }`);
        (legacy as any).onUpdate(0);
        expect(legacy.name).toBe('legacy');
        const named = attach(`import { Node } from 'cleo'\nexport class Named extends Node { ping() { return 'pong' } }`);
        expect((named as any).ping()).toBe('pong');
    });

    it('keeps runtime error line numbers aligned with the source, in both modes', () => {
        const src = [
            `import { Node } from 'cleo'`,        // 1
            `export const a = 1, b = 2`,          // 2
            `export function f() { return a }`,   // 3
            `export default class X extends Node {`, // 4
            `    boom() {`,                       // 5
            `        throw new Error('line6')`,   // 6
            `    }`,
            `}`,
        ].join('\n');
        const body = buildFactoryBody(src);
        const lines = body.split('\n');
        // Source line N is body line N (index N): the header, every export getter included, takes the
        // place of the `"use strict"` line the body always started with.
        expect(lines[6]).toContain(`throw new Error('line6')`);
        expect(buildFactoryBody(src, { mode: 'module' }).split('\n')[6]).toContain(`throw new Error('line6')`);
    });

    it('gives a shared module a cleo whose getData sees public variables only', () => {
        setScriptModuleSources({ '/Peek': `import { getData } from 'cleo'\nexport function peek(n: any, r?: any) { return getData(n, r) }` });
        const target = new Node('t');
        target.setVariable('open', 1, 'number', 'public');
        target.setVariable('hidden', 2, 'number', 'private');
        const peek = resolveScriptModule('/Peek').peek;
        expect(peek(target)).toEqual({ open: 1 });
        expect(peek(target, target)).toEqual({ open: 1, hidden: 2 });
    });
});

describe('published builds', () => {
    it('loads modules from precompiled factories with no source in sight', () => {
        const factories: Record<string, any> = {
            '/Shared/Math': new Function('__cleoImport', '__cleoExports', buildFactoryBody(`export const two = 2`, { path: '/Shared/Math', mode: 'module' })),
        };
        setScriptModuleProvider(id => factories[id]);
        const node = new Node('n');
        const factory = new Function('__cleoImport', '__cleoExports',
            buildFactoryBody(`import { two } from '../Shared/Math'\nimport { Node } from 'cleo'\nexport default class P extends Node { get v() { return two } }`, { path: '/Game/P' }));
        attachScriptFactory(node, factory as any);
        expect((node as any).v).toBe(2);
    });

    it('compiles a module standalone with a devtools source name', () => {
        expect(compileScriptModule('export const x = 1', '/Shared/My Math').toString()).toContain('cleo-script:///Shared/My%20Math.ts');
    });
});

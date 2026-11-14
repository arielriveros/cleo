import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { attachScriptFactory } from '../src/core/scene/nodes/nodeScripting';
import { compileScript, setScriptModuleSources, resetScriptModules, resolveScriptModule, clearScriptCompileCache } from '../src/core/scripting/scriptRuntime';
import {
    scriptSourceUrl, inlineScriptUrl, moduleIdOfScriptUrl, isScriptUrl, scriptLocationOf, scriptLocationLabel,
} from '../src/core/scripting/scriptUrls';
import { logScriptError } from '../src/core/scripting/scriptErrors';
import { Logger, LogEntry } from '../src/core/logger';
import { engineEventBus } from '../src/core/eventBus';
import '../src/cleo';   // registers 'cleo'

// What a debugger and the Console need from a compiled script: a name (`//# sourceURL`) and the author's
// own line numbers. A stack frame, a CDP location and a breakpoint all use them unmapped, so line N of a
// script must be line N of what V8 runs — in a node script, a shared module and a legacy script alike.

beforeEach(() => { resetScriptModules(); clearScriptCompileCache(); });
afterEach(() => resetScriptModules());

function caught(fn: () => void): any {
    try { fn(); } catch (e) { return e; }
    throw new Error('expected a throw');
}

function frameOf(e: any): { url: string; line: number } | null {
    const loc = scriptLocationOf(e);
    return loc && { url: loc.url, line: loc.line };
}

describe('script source names and lines', () => {
    it('names a node script by its module id and keeps its line numbers', () => {
        const src = [
            `import { Node } from 'cleo'`,          // 1
            `export const SPEED = 3`,               // 2
            `export default class Hero extends Node {`, // 3
            `    speed: number = SPEED`,            // 4
            `    boom(n: number): void {`,          // 5
            `        const x: any = null`,          // 6
            `        x.explode(n)`,                 // 7
            `    }`,
            `}`,
        ].join('\n');
        const node = new Node('hero');
        attachScriptFactory(node, compileScript(src, { path: '/Player/Hero' }));
        const e = caught(() => (node as any).boom(1));
        expect(frameOf(e)).toEqual({ url: 'cleo-script:///Player/Hero.ts', line: 7 });
        // The header's export getters still work although they now share line 1 with the author's import.
        expect((node as any).speed).toBe(3);
    });

    it('keeps line 1 on line 1', () => {
        const node = new Node('one');
        attachScriptFactory(node, compileScript(`export default class A { go() { throw new Error('one') } }`, { path: '/A' }));
        expect(frameOf(caught(() => (node as any).go()))).toEqual({ url: 'cleo-script:///A.ts', line: 1 });
    });

    it('names a shared module the same way', () => {
        setScriptModuleSources({ '/Shared/My Math': `export function f() {\n  return 1\n}\nexport function g() {\n  throw new Error('g')\n}` });
        const e = caught(() => resolveScriptModule('/Shared/My Math').g());
        expect(frameOf(e)).toEqual({ url: 'cleo-script:///Shared/My%20Math.ts', line: 5 });
        expect(moduleIdOfScriptUrl('cleo-script:///Shared/My%20Math.ts')).toBe('/Shared/My Math');
    });

    it('names a legacy script with no asset by its source', () => {
        const src = `this.onStart = function () {\n  throw new Error('legacy')\n}`;
        const url = inlineScriptUrl(src);
        expect(url).toMatch(/^cleo-inline:\/\/\/[0-9a-f]{8}\.ts$/);
        expect(isScriptUrl(url)).toBe(true);
        expect(moduleIdOfScriptUrl(url)).toBeNull();
        // A legacy script assigns its handlers to `this` (the node proxy); call the raw one directly.
        const self: any = {};
        compileScript(src).call(self, () => ({}), undefined);
        expect(frameOf(caught(() => self.onStart()))).toEqual({ url, line: 2 });
    });

    it('points a compile error at the author\'s line', () => {
        const e = caught(() => compileScript(`const a = 1\nconst b = (\nexport default class X {}`, { path: '/Broken' }));
        expect(scriptLocationOf(e)?.url).toBe('cleo-script:///Broken.ts');
        expect(scriptLocationOf(e)?.line).toBe(3);
    });

    it('points a module that fails to load at the module, not the script that imported it', () => {
        setScriptModuleSources({ '/Bad': `export const ok = 1\nthrow new Error('bad module')` });
        const node = new Node('importer');
        // The wrapper error's own stack runs through the importer's line 1; its cause is in Bad.ts.
        const e = caught(() => attachScriptFactory(node,
            compileScript(`import { ok } from './Bad'\nexport default class I {\n  get v() { return ok }\n}`, { path: '/Importer' })));
        expect(String(e.message)).toMatch(/Error in script module '\/Bad'/);
        expect(String(e.stack)).toContain('cleo-script:///Importer.ts:1');
        expect(frameOf(e)).toEqual({ url: 'cleo-script:///Bad.ts', line: 2 });
    });
});

describe('scriptUrls', () => {
    it('round-trips module ids, escaping what a stack parser would trip on', () => {
        for (const id of ['/Player/Hero', '/A b/C (2)', '/100%/x']) {
            const url = scriptSourceUrl(id);
            expect(url).not.toMatch(/[\s()]/);
            expect(moduleIdOfScriptUrl(url)).toBe(id);
        }
        expect(moduleIdOfScriptUrl('http://localhost/x.ts')).toBeNull();
        expect(isScriptUrl('engine.js')).toBe(false);
    });

    it('reads Chrome and Firefox stack frames', () => {
        expect(scriptLocationOf({ stack: 'Error: x\n    at Hero.onUpdate (cleo-script:///Player/Hero.ts:42:9)\n    at engine.js:1:1' }))
            .toEqual({ url: 'cleo-script:///Player/Hero.ts', line: 42, column: 9 });
        expect(scriptLocationOf({ stack: 'onUpdate@cleo-script:///Player/Hero.ts:12:3\n' }))
            .toEqual({ url: 'cleo-script:///Player/Hero.ts', line: 12, column: 3 });
        expect(scriptLocationOf({ stack: 'Error: x\n    at engine.js:1:1' })).toBeNull();
        expect(scriptLocationOf('a string')).toBeNull();
        expect(scriptLocationOf(null)).toBeNull();
    });

    it('labels a location by file name and line', () => {
        expect(scriptLocationLabel({ url: 'cleo-script:///Player/Hero.ts', line: 42 })).toBe('Hero.ts:42');
        expect(scriptLocationLabel({ url: inlineScriptUrl('x'), line: 3 })).toBe('inline.ts:3');
    });
});

describe('logScriptError', () => {
    it('logs the same text as before, with the script location as the entry\'s source', () => {
        const seen: LogEntry[] = [];
        const listener = (entry: LogEntry) => seen.push(entry);
        engineEventBus.on('LOG', listener);
        const quiet = console.error;
        console.error = () => {};
        try {
            const node = new Node('hero');
            attachScriptFactory(node, compileScript(`export default class H {\n  onUpdate() {\n    throw new Error('frame')\n  }\n}`, { path: '/H' }));
            (node as any).onUpdate(0.016);
            logScriptError('Error in a timer for node x', 'plain string');
        } finally {
            console.error = quiet;
            engineEventBus.off('LOG', listener);
        }
        const [handler, plain] = seen.slice(-2);
        expect(handler.method).toBe('error');
        expect(handler.scope).toBe('Script');
        expect(handler.data[0]).toBe('Error in onUpdate for node hero: Error: frame');
        expect(handler.source).toEqual({ url: 'cleo-script:///H.ts', line: 3, column: expect.any(Number) });
        expect(plain.data[0]).toBe('Error in a timer for node x: plain string');
        expect(plain.source).toBeUndefined();
        expect(Logger.logs.at(-2)?.source?.line).toBe(3);
    });
});

import { describe, it, expect } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { attachScriptFactory } from '../src/core/scene/nodes/nodeScripting';
import { compileScript, scriptCompileCount, clearScriptCompileCache } from '../src/core/scripting/scriptRuntime';
import '../src/cleo';

// Every spawn used to re-run the TypeScript transform + `new Function` for its script — four compiles
// per hit in Hollow Keep. One compile now serves every node running the same source; each node still
// calls the factory itself, so per-node state stays per node.

const SOURCE = `export default class Counter { count = 0; bump() { return ++this.count; } }`;

describe('compiled script cache', () => {
    it('compiles a source once, however many nodes run it', () => {
        clearScriptCompileCache();
        const before = scriptCompileCount();
        const a = compileScript(SOURCE, { path: 'Counter' });
        const b = compileScript(SOURCE, { path: 'Counter' });
        expect(b).toBe(a);
        expect(scriptCompileCount() - before).toBe(1);
    });

    it('keys on path and source: an edit or another file compiles fresh', () => {
        clearScriptCompileCache();
        const a = compileScript(SOURCE, { path: 'Counter' });
        expect(compileScript(SOURCE, { path: 'Other' })).not.toBe(a);
        expect(compileScript(SOURCE + '\n', { path: 'Counter' })).not.toBe(a);
    });

    it('still gives every node its own state', () => {
        clearScriptCompileCache();
        const src = `import { Node } from 'cleo'
            export default class C extends Node { public count: number = 0; bump(): number { return ++this.count } }`;
        const scene = new Scene();
        const one: any = new Node('one'), two: any = new Node('two');
        scene.addNode(one); scene.addNode(two);
        attachScriptFactory(one, compileScript(src, { path: 'C' }));
        attachScriptFactory(two, compileScript(src, { path: 'C' }));
        scene.start();
        one.bump(); one.bump();
        expect(two.bump()).toBe(1);
        expect(one.count).toBe(2);
    });
});

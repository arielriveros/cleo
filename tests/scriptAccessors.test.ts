import { describe, it, expect } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { attachScriptFactory } from '../src/core/scene/nodes/nodeScripting';
import { compileScript } from '../src/core/scripting/scriptRuntime';
import '../src/cleo';   // registers the 'cleo' module a script's `import ... from 'cleo'` resolves to

// A class script's methods are copied onto the live node, because the class is never constructed. Its
// ACCESSORS used to be dropped on the way: the copy loop tested `typeof desc.value === 'function'`, and
// a getter's descriptor has no `value` at all.
//
// Nothing reported it. `this.progress` simply read `undefined`, arithmetic on it produced NaN, and the
// NaN travelled — into a render setting, a light intensity, a transform — until something far away
// looked broken. That is the whole reason this file exists: the failure had no symptom at its cause.

/** Attach a class script's source to a fresh node in a started scene, the way the editor does. */
function scripted(source: string): any {
    const scene = new Scene();
    const node = new Node('subject');
    scene.addNode(node);
    attachScriptFactory(node, compileScript(source));
    scene.start();
    return node;
}

describe('a class script with accessors', () => {
    it('gives the node a working getter', () => {
        const node = scripted(`
            import { Node } from 'cleo'
            export default class T extends Node {
              public base: number = 10
              get doubled(): number { return this.base * 2 }
            }
        `);
        expect(node.doubled).toBe(20);
    });

    it('binds the getter to the node, not to a detached instance', () => {
        // The class is never constructed, so a getter that closed over anything but the live node
        // would read a different object's fields.
        const node = scripted(`
            import { Node } from 'cleo'
            export default class T extends Node {
              public base: number = 3
              get named(): string { return this.name + ':' + this.base }
            }
        `);
        node.base = 7;
        expect(node.named).toBe('subject:7');
    });

    it('makes it an OWN property, which is what an animation binding requires', () => {
        // `Animator._refreshVariableParams` resolves a bound node property through `hasOwnProperty`,
        // which a PROTOTYPE getter fails. A computed value could not back an animation parameter until
        // the accessor landed on the node itself.
        const node = scripted(`
            import { Node } from 'cleo'
            export default class T extends Node {
              get speedish(): number { return 1.5 }
            }
        `);
        expect(Object.prototype.hasOwnProperty.call(node, 'speedish')).toBe(true);
        expect(node.speedish).toBe(1.5);
    });

    it('does not turn arithmetic on a computed value into NaN', () => {
        // The exact shape of the bug: a getter feeding a number the rest of the script depends on.
        const node = scripted(`
            import { Node } from 'cleo'
            export default class T extends Node {
              public elapsed: number = 5
              public total: number = 20
              public out: number = -1
              get progress(): number { return this.elapsed / this.total }
              onUpdate() { this.out = this.progress * 100 }
            }
        `);
        node.onUpdate(0.016, 0);
        expect(Number.isNaN(node.out)).toBe(false);
        expect(node.out).toBe(25);
    });

    it('carries a setter across too', () => {
        const node = scripted(`
            import { Node } from 'cleo'
            export default class T extends Node {
              public raw: number = 0
              get scaled(): number { return this.raw * 10 }
              set scaled(v: number) { this.raw = v / 10 }
            }
        `);
        node.scaled = 50;
        expect(node.raw).toBe(5);
        expect(node.scaled).toBe(50);
    });

    it('still copies ordinary methods and still guards the handlers', () => {
        // The accessor branch returns early, so this is here to prove it did not swallow the rest.
        const node = scripted(`
            import { Node } from 'cleo'
            export default class T extends Node {
              public ran: boolean = false
              get ok(): boolean { return true }
              helper(): number { return 42 }
              onUpdate() { this.ran = true; throw new Error('boom') }
            }
        `);
        expect(node.helper()).toBe(42);
        expect(node.ok).toBe(true);
        // A throwing handler is caught and logged rather than taking the frame with it.
        expect(() => node.onUpdate(0.016, 0)).not.toThrow();
        expect(node.ran).toBe(true);
    });
});

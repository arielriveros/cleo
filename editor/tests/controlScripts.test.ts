import { describe, it, expect } from 'vitest';
import * as cleo from 'cleo';
import { buildFactoryBody } from 'cleo';
import { BASE_CLASS, BASE_TYPE_LABEL, defaultScriptClass, parseScriptVariables } from '../src/utils/scripts';
import type { ScriptBaseType } from '../src/utils/scripts';

// A script's base class is resolved BY CLASS NAME, through the `import { X } from 'cleo'` line the
// generated source carries. So the editor's table and the engine's barrel have to agree exactly, and
// nothing checks that at compile time — a typo produces a script that fails to compile at ATTACH time,
// in the running game, with a message about an undefined identifier.
//
// The starters themselves go through Sucrase and the import rewriter before they ever run, so "does the
// thing we generate actually compile" is worth asserting once rather than discovering per new base type.

const BASE_TYPES = Object.keys(BASE_CLASS) as ScriptBaseType[];

describe('the script base-class table', () => {
    it('names a class the engine actually exports, for every base type', () => {
        for (const type of BASE_TYPES) {
            const name = BASE_CLASS[type];
            expect(typeof (cleo as Record<string, unknown>)[name], `${type} -> ${name}`).toBe('function');
        }
    });

    it('labels every base type', () => {
        for (const type of BASE_TYPES) expect(BASE_TYPE_LABEL[type], type).toBeTruthy();
    });

    it('covers the control pair', () => {
        expect(BASE_CLASS.character).toBe('CharacterNode');
        expect(BASE_CLASS.controller).toBe('ControllerNode');
    });
});

describe('generated starters', () => {
    it('compiles for every base type', () => {
        // buildFactoryBody runs Sucrase's typescript transform and then the import rewriter. A starter
        // that tripped either would only fail when a user created a script of that type.
        for (const type of BASE_TYPES) {
            const source = defaultScriptClass('My Script', type);
            expect(() => buildFactoryBody(source), type).not.toThrow();
        }
    });

    it('extends the class its base type names', () => {
        for (const type of BASE_TYPES) {
            const source = defaultScriptClass('My Script', type);
            expect(source, type).toContain(`extends ${BASE_CLASS[type]}`);
            expect(source, type).toContain(`import { `);
        }
    });

    it('gives a Character starter that does NOT write velocity', () => {
        // The whole hazard of a script on a Character: locomotion owns the velocity, and a script writing
        // it too produces a character that stutters. The starter must not teach that.
        const source = defaultScriptClass('Hero', 'character');
        expect(source).not.toContain('this.velocity =');
        expect(source).toContain('drive()');
    });

    it('gives a Controller starter built around onThink and drive()', () => {
        const source = defaultScriptClass('Brain', 'controller');
        expect(source).toContain('onThink(delta: number)');
        expect(source).toContain('this.possessed');
        expect(source).toContain('drive()');
    });

    it('exposes each starter\'s public fields to the inspector', () => {
        // `parseScriptVariables` only understands literal-initialized number/string/boolean/vec3 fields.
        // A starter whose example field it cannot read would show an empty Variables list.
        for (const type of ['character', 'controller'] as ScriptBaseType[]) {
            const variables = parseScriptVariables(defaultScriptClass('X', type));
            expect(variables.length, type).toBeGreaterThan(0);
            for (const v of variables) expect(v.type, `${type}.${v.name}`).toBeTruthy();
        }
    });
});

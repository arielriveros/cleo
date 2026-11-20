import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import path from 'path';
import { fileURLToPath } from 'url';
import * as Decorators from '../src/decorators';

// The script decorators' doc comments are what the script editors show: the hover on `@attribute`, the
// signature help inside `@onAction(`, the documentation beside each entry of the `@` completion list. So the
// compiler reads them here the way those editors do, and this holds the rules decorators.ts states:
//
//   - every decorator has a summary, and every overload of one has its own;
//   - every parameter has an `@param`;
//   - no other tag. TypeScript starts a tag at an `@` that begins a doc line or follows a space, inside
//     backticks too, so an example written `@save @pick(…)` turns into a tag called `pick` in the hover.

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'scripting', 'decorators.ts');

// The file alone (noResolve): its imports are types the docs do not need, and the whole engine is a slow read.
const program = ts.createProgram([SOURCE], { target: ts.ScriptTarget.ES2020, noResolve: true, noLib: true, skipLibCheck: true });
const checker = program.getTypeChecker();
const file = program.getSourceFile(SOURCE)!;
const exports = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(file)!).map(s => [s.name, s]));

const NAMES = Object.keys(Decorators).sort();
/** The decorator's own parameters: not the `(value, context)` a decorator is called with by the language. */
const isDecoratorCallParam = (name: string) => /^_?(value|context|method)$/.test(name);

function text(parts: ts.SymbolDisplayPart[]): string {
    return ts.displayPartsToString(parts).replace(/\r/g, '').trim();
}

describe('the script decorators', () => {
    it('are the 19 that cleo/decorators exports', () => {
        expect(NAMES).toEqual(['attribute', 'child', 'eventDispatch', 'eventListener', 'every', 'find', 'netcall', 'observable', 'onAction', 'onClipEvent', 'onEnter', 'onEvent', 'onExit', 'onHold', 'onTap', 'options', 'pick', 'save', 'synced']);
        for (const name of NAMES) expect(exports.has(name), name).toBe(true);
    });

    it.each(NAMES)('%s has a summary sentence and no stray tags', (name) => {
        const symbol = exports.get(name)!;
        const doc = text(symbol.getDocumentationComment(checker));
        expect(doc, `${name} has no doc comment`).not.toBe('');
        // A first paragraph that is a sentence: the hover's first line, and the completion list's.
        expect(doc.split(/\n\s*\n/)[0], name).toMatch(/[.:]$/);
        const tags = symbol.getJsDocTags(checker).map(t => t.name);
        expect(tags.filter(t => t !== 'param' && t !== 'see'), `${name}: an @ in an example became a tag`).toEqual([]);
    });

    it.each(NAMES)('%s documents every parameter, in every overload', (name) => {
        const symbol = exports.get(name)!;
        const signatures = checker.getTypeOfSymbolAtLocation(symbol, file).getCallSignatures();
        expect(signatures.length, name).toBeGreaterThan(0);
        for (const signature of signatures) {
            // Overloads are told apart in signature help by their own docs; a lone signature shares the symbol's.
            if (signatures.length > 1)
                expect(text(signature.getDocumentationComment(checker)), `${name}: an overload has no doc`).not.toBe('');
            const tags = signature.getJsDocTags().map(t => t.name);
            expect(tags.filter(t => t !== 'param' && t !== 'see'), `${name}: an @ in an example became a tag`).toEqual([]);
            for (const param of signature.getParameters()) {
                if (isDecoratorCallParam(param.name)) continue;
                expect(text(param.getDocumentationComment(checker)), `${name}(${param.name}) has no @param`).not.toBe('');
            }
        }
    });
});

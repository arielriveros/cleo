import { describe, it, expect } from 'vitest';
import { decoratorSiteAt } from '../src/core/scripting/scriptDecoratorLowering';

// decoratorSiteAt is what the script editor's `@` completion asks: is the cursor in a member decorator being
// typed, and what does it decorate? `|` marks the cursor in each source below.

function at(marked: string) {
    const offset = marked.indexOf('|');
    return decoratorSiteAt(marked.slice(0, offset) + marked.slice(offset + 1), offset);
}

describe('decoratorSiteAt', () => {
    it('finds an @ just typed in a class body, with nothing after it yet', () => {
        expect(at(`class A extends Node {\n  @|\n}`)).toEqual({ at: 25, typed: '', member: null });
    });

    it('reads the part of the name typed so far', () => {
        expect(at(`class A {\n  @onA|\n}`)).toMatchObject({ typed: 'onA' });
    });

    it('tells a field from a method by what follows the cursor', () => {
        expect(at(`class A {\n  @| speed = 4\n}`)?.member).toBe('field');
        expect(at(`class A {\n  @|\n  speed?: number\n}`)?.member).toBe('field');
        expect(at(`class A {\n  @|\n  private _hp!: number\n}`)?.member).toBe('field');
        expect(at(`class A {\n  @| jump() {}\n}`)?.member).toBe('method');
        expect(at(`class A {\n  @|\n  async think<T>(x: T) {}\n}`)?.member).toBe('method');
        expect(at(`class A {\n  @|\n  *walk() {}\n}`)?.member).toBe('method');
    });

    it('looks past the rest of the name, its arguments and other decorators to the member', () => {
        expect(at(`class A {\n  @onA|ction('Jump') jump() {}\n}`)?.member).toBe('method');
        expect(at(`class A {\n  @|\n  @save\n  @attribute cue: SoundName = 'Hit'\n}`)?.member).toBe('field');
        expect(at(`class A {\n  @| @onAction('Fire', 'released') fire() {}\n}`)?.member).toBe('method');
    });

    it('works after other members, decorated or not', () => {
        const src = `class A extends Node {\n  @child('Muzzle') muzzle?: Node\n  hp = { max: 3 }\n  go() { if (x) { y() } }\n  @|\n}`;
        expect(at(src)).toMatchObject({ member: null });
    });

    it('finds the body of a class whose heritage has braces, and of a nested class', () => {
        expect(at(`class A extends Base<{ x: number }> {\n  @|\n}`)).not.toBeNull();
        expect(at(`class Outer {\n  make() { return class Inner {\n    @|\n  } }\n}`)).not.toBeNull();
    });

    it.each([
        ['top level', `@|\nexport default class A {}`],
        ['a class decorator', `const a = 1\n@|\nclass A {}`],
        ['a method body', `class A {\n  go() {\n    @|\n  }\n}`],
        ['an initializer in brackets', `class A {\n  x = f(@|)\n}`],
        ['an object literal', `class A {\n  x = { a: @| }\n}`],
        ['a string', `class A {\n  x = 'a@|b'\n}`],
        ['a template', `class A {\n  x = \`@|\`\n}`],
        ['a line comment', `class A {\n  // @|\n}`],
        ['a doc comment', `class A {\n  /** @pa| */\n  x = 1\n}`],
        ['the heritage clause', `class A extends B<@|> {}`],
        ['no @ at all', `class A {\n  sp|eed = 4\n}`],
        ['an @ that is not a name', `class A {\n  @1|\n}`],
    ])('is null in %s', (_label, src) => {
        expect(at(src)).toBeNull();
    });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { isTextEntryEvent, isTextEntryTarget } from '../src/input/textEntry';
import { DeviceSampler } from '../src/input/deviceSampler';

// A key typed into a text field is the user writing: it must reach the field, the game must not see it,
// and no window listener may cancel it. Duck-typed elements, since this suite runs without a DOM.

const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, closest: () => null, ...extra });
const input = (type?: string) => el('INPUT', type === undefined ? {} : { type });
const insideMonaco = (tagName: string) => el(tagName, { closest: (s: string) => (s === '.monaco-editor' ? {} : null) });

describe('isTextEntryTarget', () => {
    it('counts every field a letter is typed into', () => {
        for (const type of [undefined, 'text', 'number', 'search', 'password', 'email', 'date', 'TEXT'])
            expect(isTextEntryTarget(input(type)), `input type=${type}`).toBe(true);
        expect(isTextEntryTarget(el('TEXTAREA'))).toBe(true);
        // A select's type-ahead picks options by letter.
        expect(isTextEntryTarget(el('SELECT'))).toBe(true);
        expect(isTextEntryTarget(el('DIV', { isContentEditable: true }))).toBe(true);
        expect(isTextEntryTarget(el('textarea'))).toBe(true);
    });

    it('counts anything inside the code editor, whatever element it focuses', () => {
        expect(isTextEntryTarget(insideMonaco('DIV'))).toBe(true);
        expect(isTextEntryTarget(insideMonaco('TEXTAREA'))).toBe(true);
    });

    it('does not count a control that types nothing, so a shortcut still works after clicking one', () => {
        for (const type of ['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image', 'hidden'])
            expect(isTextEntryTarget(input(type)), `input type=${type}`).toBe(false);
        expect(isTextEntryTarget(el('BUTTON'))).toBe(false);
        expect(isTextEntryTarget(el('DIV'))).toBe(false);
        expect(isTextEntryTarget(el('DIV', { isContentEditable: false }))).toBe(false);
    });

    it('does not count non-elements', () => {
        for (const t of [null, undefined, 0, 'INPUT', {}, { tagName: 7 }]) expect(isTextEntryTarget(t)).toBe(false);
    });

    it('reads an event by its composed path first, so a field in a shadow root is seen as itself', () => {
        const host = el('DIV');
        expect(isTextEntryEvent({ target: host, composedPath: () => [input('text'), host] } as unknown as Event)).toBe(true);
        expect(isTextEntryEvent({ target: input('text') } as unknown as Event)).toBe(true);
        expect(isTextEntryEvent({ target: host, composedPath: () => [] } as unknown as Event)).toBe(false);
    });
});

describe('DeviceSampler and text fields', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    const key = (code: string, target: unknown) =>
        ({ code, repeat: false, ctrlKey: false, metaKey: false, target, preventDefault: vi.fn() });
    const sampler = () => {
        const s = new DeviceSampler();
        s.preventDefault = true;
        s.isBoundCode = () => true;
        return s as unknown as DeviceSampler & {
            _onKeyDown(e: unknown): void; _onKeyUp(e: unknown): void; _onMouseDown(e: unknown): void;
        };
    };

    it('a key typed into a field is neither game input nor cancelled', () => {
        const s = sampler();
        const down = key('KeyW', input('text'));
        s._onKeyDown(down);
        expect(s.keys.has('KeyW')).toBe(false);
        expect(down.preventDefault).not.toHaveBeenCalled();
        const up = key('KeyW', input('text'));
        s._onKeyUp(up);
        expect(up.preventDefault).not.toHaveBeenCalled();
    });

    it('the same key with no field focused is held, and its default swallowed', () => {
        const s = sampler();
        const down = key('KeyW', el('BODY'));
        s._onKeyDown(down);
        expect(s.keys.has('KeyW')).toBe(true);
        expect(down.preventDefault).toHaveBeenCalled();
    });

    it('a key held outside a field and released inside one still lets go', () => {
        const s = sampler();
        s._onKeyDown(key('KeyW', el('BODY')));
        s._onKeyUp(key('KeyW', el('TEXTAREA')));
        expect(s.keys.has('KeyW')).toBe(false);
    });

    it('a click on the game takes the keyboard from a focused field, since the cancelled press cannot', () => {
        const field = { ...input('text'), blur: vi.fn() };
        vi.stubGlobal('document', { activeElement: field });
        const s = sampler();
        s._onMouseDown({ button: 0, clientX: 0, clientY: 0, preventDefault: vi.fn() });
        expect(field.blur).toHaveBeenCalled();

        const button = { ...el('BUTTON'), blur: vi.fn() };
        vi.stubGlobal('document', { activeElement: button });
        s._onMouseDown({ button: 0, clientX: 0, clientY: 0, preventDefault: vi.fn() });
        expect(button.blur).not.toHaveBeenCalled();
    });
});

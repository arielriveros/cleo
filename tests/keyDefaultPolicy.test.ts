import { describe, it, expect } from 'vitest';
import { shouldCancelKeyDefault } from '../src/input/deviceSampler';

// While a game owns the keyboard, the browser's shortcuts must not fire over it (Ctrl+D bookmarks the page,
// Ctrl+S saves it), but DevTools and reload stay reachable.

const key = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('shouldCancelKeyDefault', () => {
    it('cancels a bound key, with or without Ctrl', () => {
        expect(shouldCancelKeyDefault(key('KeyW'), true)).toBe(true);
        expect(shouldCancelKeyDefault(key('KeyW', { ctrlKey: true }), true)).toBe(true);
    });

    it('cancels the browser shortcuts a game never asked for', () => {
        for (const code of ['KeyD', 'KeyS', 'KeyF', 'KeyP', 'KeyG', 'KeyU'])
            expect(shouldCancelKeyDefault(key(code, { ctrlKey: true }), false), `Ctrl+${code}`).toBe(true);
        expect(shouldCancelKeyDefault(key('KeyD', { metaKey: true }), false)).toBe(true);
        expect(shouldCancelKeyDefault(key('ArrowLeft', { altKey: true }), false)).toBe(true);
        expect(shouldCancelKeyDefault(key('F1'), false)).toBe(true);
        expect(shouldCancelKeyDefault(key('F3'), false)).toBe(true);
    });

    it('leaves plain unbound keys alone', () => {
        expect(shouldCancelKeyDefault(key('KeyZ'), false)).toBe(false);
        expect(shouldCancelKeyDefault(key('Tab'), false)).toBe(false);
    });

    it('keeps DevTools and reload reachable, bound or not', () => {
        expect(shouldCancelKeyDefault(key('F12'), false)).toBe(false);
        expect(shouldCancelKeyDefault(key('F12'), true)).toBe(false);
        expect(shouldCancelKeyDefault(key('F5'), false)).toBe(false);
        expect(shouldCancelKeyDefault(key('KeyR', { ctrlKey: true }), false)).toBe(false);
        for (const code of ['KeyI', 'KeyJ', 'KeyC'])
            expect(shouldCancelKeyDefault(key(code, { ctrlKey: true, shiftKey: true }), true), `Ctrl+Shift+${code}`).toBe(false);
    });
});

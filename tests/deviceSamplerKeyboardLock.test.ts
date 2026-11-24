import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DeviceSampler, shouldLockKeyboard } from '../src/input/deviceSampler';

// Ctrl+W closes the tab over a game that binds Ctrl and W (walk, forward): a page cannot cancel it with
// preventDefault. Only the Keyboard Lock API takes it, and only in fullscreen, so the sampler holds the whole
// keyboard while the game owns it, the pointer is locked and the page is fullscreen, and gives it back the moment
// any of the three ends. Under the lock Esc no longer frees the mouse: the release key does.

type Listener = (event: any) => void;

/** A window, document and navigator just big enough for the sampler's listeners and locks. */
function fakeBrowser() {
    const listeners = new Map<string, Listener[]>();
    const on = (target: string) => (type: string, fn: Listener) => {
        const key = `${target}:${type}`;
        listeners.set(key, [...(listeners.get(key) ?? []), fn]);
    };
    const fire = (target: string, type: string, event: any = {}) => { for (const fn of listeners.get(`${target}:${type}`) ?? []) fn(event); };
    // `style`: the sampler sets the canvas's cursor (Input.mouse) and clears it on dispose.
    const canvas: any = { addEventListener: on('canvas'), requestPointerLock: vi.fn(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), style: {} };
    const document: any = {
        addEventListener: on('document'), pointerLockElement: null, fullscreenElement: null, activeElement: null,
        exitPointerLock: vi.fn(() => { document.pointerLockElement = null; fire('document', 'pointerlockchange'); }),
    };
    const keyboard = { lock: vi.fn(() => Promise.resolve()), unlock: vi.fn() };
    vi.stubGlobal('window', { addEventListener: on('window') });
    vi.stubGlobal('document', document);
    vi.stubGlobal('navigator', { keyboard });
    return {
        canvas, document, keyboard, fire,
        lockPointer() { document.pointerLockElement = canvas; fire('document', 'pointerlockchange'); },
        fullscreen(on: boolean) { document.fullscreenElement = on ? canvas : null; fire('document', 'fullscreenchange'); },
        key(code: string, extra: any = {}) {
            const event = { code, key: code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, preventDefault: vi.fn(), ...extra };
            fire('window', 'keydown', event);
            return event;
        },
    };
}

describe('the Keyboard Lock in fullscreen Play', () => {
    let browser: ReturnType<typeof fakeBrowser>;
    let sampler: DeviceSampler;
    beforeEach(() => { browser = fakeBrowser(); sampler = new DeviceSampler(); sampler.initialize(browser.canvas); });
    afterEach(() => { sampler.dispose(); vi.unstubAllGlobals(); });

    it('says when: owning the keyboard, pointer locked and fullscreen, all three', () => {
        expect(shouldLockKeyboard({ preventDefault: true, pointerLocked: true, fullscreen: true })).toBe(true);
        for (const off of ['preventDefault', 'pointerLocked', 'fullscreen'] as const)
            expect(shouldLockKeyboard({ preventDefault: true, pointerLocked: true, fullscreen: true, [off]: false }), off).toBe(false);
    });

    it('takes the keyboard only once all three hold, and gives it back when any ends', () => {
        sampler.preventDefault = true;
        browser.lockPointer();
        expect(browser.keyboard.lock).not.toHaveBeenCalled();   // not fullscreen: the browser would ignore it
        browser.fullscreen(true);
        expect(browser.keyboard.lock).toHaveBeenCalledTimes(1);
        expect(sampler.isKeyboardLocked).toBe(true);
        browser.fullscreen(false);
        expect(browser.keyboard.unlock).toHaveBeenCalledTimes(1);
        expect(sampler.isKeyboardLocked).toBe(false);
        browser.fullscreen(true);
        expect(sampler.isKeyboardLocked).toBe(true);
        sampler.preventDefault = false;                           // Play stopped
        expect(sampler.isKeyboardLocked).toBe(false);
    });

    it('lets the mouse go on the release key, and with it the keyboard', () => {
        sampler.preventDefault = true;
        browser.lockPointer();
        browser.fullscreen(true);
        expect(sampler.isKeyboardLocked).toBe(true);
        const escape = browser.key('Escape');
        expect(browser.document.exitPointerLock).toHaveBeenCalled();
        expect(escape.preventDefault).toHaveBeenCalled();
        expect(sampler.isPointerLocked).toBe(false);
        expect(sampler.isKeyboardLocked).toBe(false);
        // The key that let go does not reach the game as a press.
        expect(sampler.keys.has('Escape')).toBe(false);
    });

    it('takes any key the editor sets as the release key, and nothing else lets go', () => {
        sampler.preventDefault = true;
        sampler.releaseKey = 'Backquote';
        browser.lockPointer();
        browser.key('Escape');
        expect(browser.document.exitPointerLock).not.toHaveBeenCalled();
        browser.key('Backquote');
        expect(browser.document.exitPointerLock).toHaveBeenCalledTimes(1);
        // Unlocked, the release key is an ordinary key.
        browser.key('Backquote');
        expect(sampler.keys.has('Backquote')).toBe(true);
    });

    it('does nothing where the browser has no Keyboard Lock', () => {
        vi.stubGlobal('navigator', {});
        sampler.preventDefault = true;
        browser.lockPointer();
        browser.fullscreen(true);
        expect(sampler.isKeyboardLocked).toBe(false);
    });
});

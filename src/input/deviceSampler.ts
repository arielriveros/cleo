/**
 * The browser half of the input system: DOM listeners in, a {@link DeviceSnapshot} out.
 *
 * Everything DOM-shaped lives here so that nothing else in `src/input/` has to. It owns the listener
 * set, the per-frame accumulators, the `preventDefault` policy and pointer lock.
 *
 * Three deliberate departures from the system this replaces:
 *
 *   * LISTENERS ARE REMOVABLE. The old manager bound with `canvas.onmousemove = ...`, which clobbers
 *     whatever else was there and can never be undone — `clear()` did not detach. Here every listener
 *     is registered against one `AbortController`'s signal, so `dispose()` is total. That makes
 *     `initialize()` genuinely idempotent instead of accidentally so: with `addEventListener` a second
 *     `initialize` would otherwise DOUBLE every mouse delta, and the editor re-initializes routinely.
 *   * KEYS ARE NOT FILTERED. Any `KeyboardEvent.code` goes into the down-set. The whitelist that used
 *     to sit here is now only the editor's picker list.
 *   * `preventDefault` IS NARROW. The old flag was session-wide over every handled event, and with a
 *     key set that now includes Tab, F5 and F12 that would swallow browser shortcuts a user expects.
 *     It applies only to codes the caller says are actually bound, and never while Ctrl or Meta is
 *     held — a modified key is a browser command, not a game one.
 *
 * And one rule over all of it: a key typed into a text field is not game input. It never enters the
 * down-set and is never cancelled, so a name box in the game's own UI — or, in the editor, every field
 * and the code editor — keeps its letters even though the listeners sit on the window.
 */

import { MOUSE_BUTTONS } from "./inputSources";
import type { MouseButton } from "./inputSources";
import { createGestureState, stepTouchGestures } from "./gestures";
import type { GestureState, PointerSample } from "./gestures";
import { createVirtualState, layoutVirtualControls, stepVirtualControls } from "./virtualControls";
import type { VirtualLayout, VirtualState } from "./virtualControls";
import { createDeviceSnapshot } from "./resolveActions";
import type { DeviceSnapshot } from "./resolveActions";
import type { TouchGestureConfig, VirtualControl } from "./actionMap";
import { DEFAULT_TOUCH_CONFIG } from "./actionMap";
import { isTextEntryEvent, isTextEntryTarget } from "./textEntry";
import { createPointerSpikeFilter, pointerSpike } from "./pointerFilter";

/** What the sampler asks its owner before deciding whether to swallow a browser default. */
export type BoundCodeTest = (code: string) => boolean;

/**
 * Whether a key event's browser default is cancelled while the game owns the keyboard (`preventDefault` on, and
 * the event is not text entry). A bound key is always cancelled. So is any Ctrl/Meta/Alt combination and any
 * function key: Ctrl+D (bookmark), Ctrl+S (save page), Ctrl+F, Ctrl+P, F1, F3... are the browser talking over a
 * game that is not listening for them. What stays reachable is what a developer or player needs: DevTools (F12,
 * Ctrl+Shift+I/J/C), reload (F5, Ctrl+R), and the window's own shortcuts the page cannot cancel anyway.
 * (Ctrl+W, Ctrl+T, Ctrl+N and Ctrl+Tab are not cancellable by a page in a normal tab, whatever this says. In
 * fullscreen, with the pointer locked, the sampler takes the whole keyboard with the Keyboard Lock API instead: see
 * {@link shouldLockKeyboard}.)
 */
export function shouldCancelKeyDefault(
    e: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
    bound: boolean,
): boolean {
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'F12' || e.code === 'F5') return false;
    if (mod && e.code === 'KeyR') return false;
    if (mod && e.shiftKey && (e.code === 'KeyI' || e.code === 'KeyJ' || e.code === 'KeyC' || e.code === 'Delete')) return false;
    if (bound) return true;
    return mod || e.altKey || /^F\d{1,2}$/.test(e.code);
}

/**
 * Whether the game should hold the whole keyboard with the Keyboard Lock API (`navigator.keyboard.lock()`), so the
 * browser's own shortcuts (Ctrl+W, Ctrl+T, Ctrl+N, Esc) reach the game instead: while it owns the keyboard
 * (`preventDefault`), the pointer is locked to it and the page is fullscreen, the only state in which a browser
 * honours the lock. Leaving fullscreen then takes holding Esc, and the pointer is let go by the release key.
 */
export function shouldLockKeyboard(state: { preventDefault: boolean; pointerLocked: boolean; fullscreen: boolean }): boolean {
    return state.preventDefault && state.pointerLocked && state.fullscreen;
}

type KeyboardLockApi = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void };

export class DeviceSampler {
    private _canvas: HTMLElement | null = null;
    private _abort: AbortController | null = null;

    private readonly _keys = new Set<string>();
    private readonly _mouseButtons = new Set<MouseButton>();
    private _pointerLocked = false;
    /** Chromium's pointer-lock glitches: see pointerFilter.ts. */
    private readonly _spikes = createPointerSpikeFilter();
    private _pointerOverCanvas = false;
    private _deltaX = 0;
    private _deltaY = 0;
    private _wheelX = 0;
    private _wheelY = 0;
    private _normX = 0;
    private _normY = 0;
    private _pxX = 0;
    private _pxY = 0;
    /** Buttons that went down / came up this frame (cleared in endFrame), and seconds each has been held. */
    private readonly _pressed = new Set<MouseButton>();
    private readonly _released = new Set<MouseButton>();
    private readonly _held = new Map<MouseButton, number>();
    private _cursor = '';

    /** Touch samples accumulated since the last frame, in arrival order. */
    private _samples: PointerSample[] = [];
    private _gestureState: GestureState = createGestureState();
    private _virtualState: VirtualState = createVirtualState();
    private _virtualLayouts: VirtualLayout[] = [];
    private _touchConfig: TouchGestureConfig = { ...DEFAULT_TOUCH_CONFIG };

    private _snapshot: DeviceSnapshot = createDeviceSnapshot();
    private _preventDefault = false;
    /** Whether the Keyboard Lock is held (see {@link shouldLockKeyboard}). */
    private _keyboardLocked = false;
    /** Swallow the browser's default action for keys the action map actually binds. Off by default. */
    public get preventDefault(): boolean { return this._preventDefault; }
    public set preventDefault(value: boolean) {
        this._preventDefault = value;
        this._syncKeyboardLock();
    }
    /**
     * A key (`KeyboardEvent.code`) that lets the pointer go while it is locked. The browser lets it go on Esc
     * regardless, except under the Keyboard Lock, where this is the only way out. Null: none of the game's own.
     */
    public releaseKey: string | null = 'Escape';
    /** Whether a click on the canvas should request pointer lock. Off by default. */
    public pointerLockOnClick = false;
    /** Asked whether a code is bound, so `preventDefault` stays narrow. Defaults to "nothing is". */
    public isBoundCode: BoundCodeTest = () => false;

    /**
     * Bind to `canvas`. Safe to call again — the previous listener set is aborted first, which is the
     * whole reason for the AbortController and not merely tidiness (see the module comment).
     */
    public initialize(canvas: HTMLElement): void {
        this.dispose();
        this._canvas = canvas;
        const controller = new AbortController();
        this._abort = controller;
        const options = { signal: controller.signal } as AddEventListenerOptions;
        const passive = { signal: controller.signal, passive: false } as AddEventListenerOptions;

        // Keys on the window: a game must keep responding while focus sits on the page rather than the
        // canvas, which cannot take focus of its own without a tabindex.
        window.addEventListener('keydown', this._onKeyDown, options);
        window.addEventListener('keyup', this._onKeyUp, options);
        // A held key whose keyup the page never sees (alt-tab, a native dialog) would otherwise stay
        // down forever. Blur is the only signal a browser gives for that.
        window.addEventListener('blur', this._onBlur, options);

        canvas.addEventListener('mousedown', this._onMouseDown, options);
        canvas.addEventListener('mousemove', this._onMouseMove, options);
        // On the window, so a drag that leaves the canvas still ends when the button comes up. Binding
        // it to the canvas is what leaves a camera spinning after the cursor exits the viewport.
        window.addEventListener('mouseup', this._onMouseUp, options);
        canvas.addEventListener('mouseenter', this._onMouseEnter, options);
        canvas.addEventListener('mouseleave', this._onMouseLeave, options);
        canvas.addEventListener('wheel', this._onWheel, passive);
        canvas.addEventListener('contextmenu', this._onContextMenu, options);

        // Touch through the Pointer Events API, which reports every finger with a stable id. `touch*`
        // events would work too, but pointer events give the same code path for a stylus.
        canvas.addEventListener('pointerdown', this._onPointerDown, options);
        canvas.addEventListener('pointermove', this._onPointerMove, options);
        window.addEventListener('pointerup', this._onPointerUp, options);
        window.addEventListener('pointercancel', this._onPointerCancel, options);

        document.addEventListener('pointerlockchange', this._onPointerLockChange, options);
        document.addEventListener('pointerlockerror', this._onPointerLockError, options);
        document.addEventListener('fullscreenchange', this._onFullscreenChange, options);
    }

    /** Detach every listener and forget all held state. Total, unlike the old `clear()`. */
    public dispose(): void {
        this.setCursor('');
        this._abort?.abort();
        this._abort = null;
        this._canvas = null;
        this._setKeyboardLock(false);
        this.resetState();
    }

    /** Drop every held key/button and every in-flight gesture, keeping the listeners bound. */
    public resetState(): void {
        this._keys.clear();
        this._mouseButtons.clear();
        this._pressed.clear();
        this._released.clear();
        this._held.clear();
        this._deltaX = this._deltaY = this._wheelX = this._wheelY = 0;
        this._samples = [];
        this._gestureState = createGestureState();
        this._virtualState = createVirtualState();
    }

    public get canvas(): HTMLElement | null { return this._canvas; }

    /** Seconds a mouse button has been held as of the last sample, or 0. */
    public heldSeconds(button: MouseButton): number { return this._held.get(button) ?? 0; }

    /** Set the CSS cursor over the canvas ('' restores the default). */
    public setCursor(css: string): void {
        this._cursor = css;
        const canvas = this._canvas;
        if (canvas) canvas.style.cursor = css;
    }
    public get cursor(): string { return this._cursor; }
    /** The most recent snapshot. Rebuilt by {@link sample}; read by the editor's device monitor. */
    public get snapshot(): DeviceSnapshot { return this._snapshot; }
    public get isPointerLocked(): boolean { return this._pointerLocked; }
    /** The live down-set of `KeyboardEvent.code`s. Read-only to callers; the sampler owns it. */
    public get keys(): ReadonlySet<string> { return this._keys; }

    /** The on-screen controls to hit-test against, and the viewport they are laid out in. */
    public setVirtualControls(controls: readonly VirtualControl[], width: number, height: number): void {
        this._virtualLayouts = layoutVirtualControls(controls, width, height);
    }

    public get virtualLayouts(): readonly VirtualLayout[] { return this._virtualLayouts; }

    public setTouchConfig(config: TouchGestureConfig): void {
        this._touchConfig = config;
    }

    /**
     * Fold this frame's events into a snapshot: step the gestures, step the on-screen controls, and
     * publish the accumulated deltas. Called once, at the top of the frame.
     */
    public sample(dt: number): DeviceSnapshot {
        const gestures = stepTouchGestures(this._gestureState, this._samples, dt, this._touchConfig);
        this._gestureState = gestures.state;

        const virtual = stepVirtualControls(this._virtualState, this._virtualLayouts, this._samples);
        this._virtualState = virtual.state;

        this._samples = [];

        for (const button of this._mouseButtons) this._held.set(button, (this._held.get(button) ?? 0) + dt);
        for (const button of [...this._held.keys()]) if (!this._mouseButtons.has(button)) this._held.delete(button);

        this._snapshot = {
            keys: this._keys,
            mouseButtons: this._mouseButtons,
            mousePressed: this._pressed,
            mouseReleased: this._released,
            pointer: {
                deltaX: this._deltaX, deltaY: this._deltaY,
                wheelX: this._wheelX, wheelY: this._wheelY,
                x: this._normX, y: this._normY,
                px: this._pxX, py: this._pxY,
            },
            pointerLocked: this._pointerLocked,
            pointerOverCanvas: this._pointerOverCanvas,
            gamepads: [],                       // filled in by InputSystem, which owns the pad sampler
            gestures: gestures.output,
            virtual: virtual.readings,
        };
        return this._snapshot;
    }

    /**
     * Clear the per-frame accumulators. Must run at the END of the frame, not the start: DOM events
     * land between rAF callbacks, so clearing here is what makes "everything that arrived during this
     * frame is visible during this frame" true.
     */
    public endFrame(): void {
        this._pressed.clear();
        this._released.clear();
        this._deltaX = 0;
        this._deltaY = 0;
        this._wheelX = 0;
        this._wheelY = 0;
    }

    // ----- Pointer lock -------------------------------------------------------------------------

    /**
     * Request pointer lock on the canvas. The single owner of this call in the whole engine — the
     * editor's viewport-capture helper delegates here rather than locking on its own, because two
     * callers racing produce a rejected re-lock and a camera that stops responding.
     *
     * Browsers only grant this inside a user gesture, and reject a re-lock issued too soon after an
     * exit, so a caller must not assume it succeeded.
     */
    public requestPointerLock(): void {
        type Lockable = HTMLElement & { requestPointerLock?: (options?: { unadjustedMovement?: boolean }) => Promise<void> | void };
        const canvas = this._canvas as Lockable | null;
        if (!canvas || document.pointerLockElement === canvas) return;
        const plain = () => {
            try {
                const result = canvas.requestPointerLock?.() as Promise<void> | undefined;
                result?.catch(() => { /* denied — usually a too-soon re-lock; carry on uncaptured */ });
            } catch { /* older browsers throw rather than rejecting */ }
        };
        try {
            // Raw input where the platform has it: no OS acceleration, and no cursor warp behind the lock, which
            // is where most of Chromium's huge one-off movementX readings come from. A platform without it
            // rejects (NotSupportedError) and gets the ordinary lock; one that ignores the option returns no
            // promise and simply locks.
            const result = canvas.requestPointerLock?.({ unadjustedMovement: true }) as Promise<void> | undefined;
            result?.catch((error: unknown) => {
                if ((error as { name?: string })?.name === 'NotSupportedError') plain();
            });
        } catch { plain(); }
    }

    public releasePointerLock(): void {
        try { if (document.pointerLockElement) document.exitPointerLock(); } catch { /* ignore */ }
        this._pointerLocked = false;
        this._syncKeyboardLock();
    }

    /** Whether the whole keyboard is held from the browser right now (Keyboard Lock). */
    public get isKeyboardLocked(): boolean { return this._keyboardLocked; }

    /** Take or give back the keyboard as {@link shouldLockKeyboard} says, where the browser has the API. */
    private _syncKeyboardLock(): void {
        const doc = typeof document !== 'undefined' ? document as Document & { fullscreenElement?: Element | null } : null;
        const fullscreen = !!doc?.fullscreenElement;
        this._setKeyboardLock(shouldLockKeyboard({ preventDefault: this._preventDefault, pointerLocked: this._pointerLocked, fullscreen }));
    }

    private _setKeyboardLock(on: boolean): void {
        if (on === this._keyboardLocked) return;
        const api = typeof navigator !== 'undefined' ? (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard : undefined;
        if (on) {
            if (!api?.lock) return;
            this._keyboardLocked = true;
            // Every key: Ctrl+W and the rest, and Esc, which the release key stands in for.
            try { api.lock().catch(() => { this._keyboardLocked = false; }); }
            catch { this._keyboardLocked = false; }
        } else {
            this._keyboardLocked = false;
            try { api?.unlock?.(); } catch { /* ignore */ }
        }
    }

    // ----- Handlers -----------------------------------------------------------------------------
    //
    // Arrow properties, not methods: they are passed straight to addEventListener, and a prototype
    // method would lose `this` and could not be removed by identity either.

    private _onKeyDown = (event: KeyboardEvent): void => {
        // The way out of the pointer lock: the browser's own Esc, and (the only one, under the Keyboard Lock) this.
        if (this._pointerLocked && this.releaseKey && event.code === this.releaseKey && !event.repeat) {
            this.releasePointerLock();
            event.preventDefault();
            return;
        }
        // Typing, not playing: the letter belongs to the field (see the module comment).
        if (isTextEntryEvent(event)) return;
        // A repeat is the OS auto-repeating a held key. The down-set already has it, and letting it
        // through would do nothing — but skipping it keeps the set honest for anything reading size.
        if (!event.repeat) this._keys.add(event.code);
        this._maybePreventKeyDefault(event);
    };

    private _onKeyUp = (event: KeyboardEvent): void => {
        // Released wherever focus is: a key held down outside a field and let go inside one still lets go.
        this._keys.delete(event.code);
        if (!isTextEntryEvent(event)) this._maybePreventKeyDefault(event);
    };

    private _maybePreventKeyDefault(event: KeyboardEvent): void {
        if (!this.preventDefault) return;
        if (shouldCancelKeyDefault(event, this.isBoundCode(event.code))) event.preventDefault();
    }

    private _onBlur = (): void => {
        // Everything held is now un-releasable, so let it all go. The resolver turns each of these into
        // a one-frame `canceled`, which is exactly what a script wants on alt-tab.
        this._keys.clear();
        this._mouseButtons.clear();
    };

    private _onMouseDown = (event: MouseEvent): void => {
        const button = MOUSE_BUTTONS[event.button];
        if (button) { if (!this._mouseButtons.has(button)) this._pressed.add(button); this._mouseButtons.add(button); }
        this._updatePosition(event);
        if (this.pointerLockOnClick && event.button === 0) this.requestPointerLock();
        if (this.preventDefault) {
            event.preventDefault();
            // Cancelling the press also cancels the focus change it would make, so a field focused before
            // the click would keep the keyboard — and its keys are not game input. A click on the game
            // takes the keyboard, as it would without the cancel.
            const active = typeof document !== 'undefined' ? document.activeElement : null;
            if (isTextEntryTarget(active)) (active as HTMLElement).blur();
        }
    };

    private _onMouseUp = (event: MouseEvent): void => {
        const button = MOUSE_BUTTONS[event.button];
        if (button) { if (this._mouseButtons.delete(button)) this._released.add(button); }
    };

    private _onMouseMove = (event: MouseEvent): void => {
        // `movementX/Y` in both modes, not just under lock: it is relative motion either way, and it is
        // the only reading that exists while the cursor is hidden. Accumulated, so several events
        // arriving inside one frame all count rather than the last one winning.
        const dx = event.movementX || 0, dy = event.movementY || 0;
        // Under lock, one glitched reading is a camera swung half round in a frame: dropped (pointerFilter.ts).
        // So is the first reading after the lock is taken or released, either way.
        const filtered = this._pointerLocked || this._spikes.dropNext;
        if (!(filtered && pointerSpike(this._spikes, dx, dy))) {
            this._deltaX += dx;
            this._deltaY += dy;
        }
        // Under lock there is no cursor and `clientX/Y` is meaningless, so the position is left alone.
        if (!this._pointerLocked) this._updatePosition(event);
    };

    private _onMouseEnter = (): void => { this._pointerOverCanvas = true; };
    private _onMouseLeave = (): void => { this._pointerOverCanvas = false; };

    private _onWheel = (event: WheelEvent): void => {
        this._wheelX += event.deltaX || 0;
        this._wheelY += event.deltaY || 0;
        // Always swallowed while preventDefault is on: a wheel over the canvas is a zoom, and letting
        // it scroll the page as well is never what anyone means.
        if (this.preventDefault) event.preventDefault();
    };

    private _onContextMenu = (event: MouseEvent): void => {
        // Right-drag is a camera pan in every 3D tool; a context menu on top of it is unusable.
        if (this.preventDefault) event.preventDefault();
    };

    private _onPointerDown = (event: PointerEvent): void => {
        if (event.pointerType === 'mouse') return;          // the mouse path above already has it
        this._samples.push({ id: event.pointerId, x: event.clientX, y: event.clientY, phase: 'down' });
        this._updateNormalized(event.clientX, event.clientY);
    };

    private _onPointerMove = (event: PointerEvent): void => {
        if (event.pointerType === 'mouse') return;
        this._samples.push({ id: event.pointerId, x: event.clientX, y: event.clientY, phase: 'move' });
        this._updateNormalized(event.clientX, event.clientY);
    };

    private _onPointerUp = (event: PointerEvent): void => {
        if (event.pointerType === 'mouse') return;
        this._samples.push({ id: event.pointerId, x: event.clientX, y: event.clientY, phase: 'up' });
    };

    private _onPointerCancel = (event: PointerEvent): void => {
        if (event.pointerType === 'mouse') return;
        this._samples.push({ id: event.pointerId, x: event.clientX, y: event.clientY, phase: 'cancel' });
    };

    private _onPointerLockChange = (): void => {
        this._pointerLocked = document.pointerLockElement === this._canvas;
        // The first reading after a lock change is measured across the cursor's jump into (or out of) the lock.
        this._spikes.dropNext = true;
        this._spikes.recent.length = 0;
        this._syncKeyboardLock();
    };

    private _onPointerLockError = (): void => {
        this._pointerLocked = false;
        this._syncKeyboardLock();
    };

    private _onFullscreenChange = (): void => { this._syncKeyboardLock(); };

    private _updatePosition(event: MouseEvent): void {
        this._updateNormalized(event.clientX, event.clientY);
    }

    /** Canvas-relative position in 0..1, so a binding never depends on the viewport's pixel size. */
    private _updateNormalized(clientX: number, clientY: number): void {
        const canvas = this._canvas;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        this._normX = (clientX - rect.left) / rect.width;
        this._normY = (clientY - rect.top) / rect.height;
        this._pxX = clientX - rect.left;
        this._pxY = clientY - rect.top;
    }
}

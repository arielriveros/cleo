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

/** What the sampler asks its owner before deciding whether to swallow a browser default. */
export type BoundCodeTest = (code: string) => boolean;

export class DeviceSampler {
    private _canvas: HTMLElement | null = null;
    private _abort: AbortController | null = null;

    private readonly _keys = new Set<string>();
    private readonly _mouseButtons = new Set<MouseButton>();
    private _pointerLocked = false;
    private _pointerOverCanvas = false;
    private _deltaX = 0;
    private _deltaY = 0;
    private _wheelX = 0;
    private _wheelY = 0;
    private _normX = 0;
    private _normY = 0;

    /** Touch samples accumulated since the last frame, in arrival order. */
    private _samples: PointerSample[] = [];
    private _gestureState: GestureState = createGestureState();
    private _virtualState: VirtualState = createVirtualState();
    private _virtualLayouts: VirtualLayout[] = [];
    private _touchConfig: TouchGestureConfig = { ...DEFAULT_TOUCH_CONFIG };

    private _snapshot: DeviceSnapshot = createDeviceSnapshot();
    /** Swallow the browser's default action for keys the action map actually binds. Off by default. */
    public preventDefault = false;
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
    }

    /** Detach every listener and forget all held state. Total, unlike the old `clear()`. */
    public dispose(): void {
        this._abort?.abort();
        this._abort = null;
        this._canvas = null;
        this.resetState();
    }

    /** Drop every held key/button and every in-flight gesture, keeping the listeners bound. */
    public resetState(): void {
        this._keys.clear();
        this._mouseButtons.clear();
        this._deltaX = this._deltaY = this._wheelX = this._wheelY = 0;
        this._samples = [];
        this._gestureState = createGestureState();
        this._virtualState = createVirtualState();
    }

    public get canvas(): HTMLElement | null { return this._canvas; }
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

        this._snapshot = {
            keys: this._keys,
            mouseButtons: this._mouseButtons,
            pointer: {
                deltaX: this._deltaX, deltaY: this._deltaY,
                wheelX: this._wheelX, wheelY: this._wheelY,
                x: this._normX, y: this._normY,
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
        const canvas = this._canvas as HTMLElement & { requestPointerLock?: () => Promise<void> | void };
        if (!canvas || document.pointerLockElement === canvas) return;
        try {
            const result = canvas.requestPointerLock?.() as Promise<void> | undefined;
            result?.catch(() => { /* denied — usually a too-soon re-lock; carry on uncaptured */ });
        } catch { /* older browsers throw rather than rejecting */ }
    }

    public releasePointerLock(): void {
        try { if (document.pointerLockElement) document.exitPointerLock(); } catch { /* ignore */ }
        this._pointerLocked = false;
    }

    // ----- Handlers -----------------------------------------------------------------------------
    //
    // Arrow properties, not methods: they are passed straight to addEventListener, and a prototype
    // method would lose `this` and could not be removed by identity either.

    private _onKeyDown = (event: KeyboardEvent): void => {
        // A repeat is the OS auto-repeating a held key. The down-set already has it, and letting it
        // through would do nothing — but skipping it keeps the set honest for anything reading size.
        if (!event.repeat) this._keys.add(event.code);
        this._maybePreventKeyDefault(event);
    };

    private _onKeyUp = (event: KeyboardEvent): void => {
        this._keys.delete(event.code);
        this._maybePreventKeyDefault(event);
    };

    private _maybePreventKeyDefault(event: KeyboardEvent): void {
        if (!this.preventDefault) return;
        // Ctrl/Meta means the user is talking to the browser (Ctrl+T, Cmd+W), not to the game.
        if (event.ctrlKey || event.metaKey) return;
        if (this.isBoundCode(event.code)) event.preventDefault();
    }

    private _onBlur = (): void => {
        // Everything held is now un-releasable, so let it all go. The resolver turns each of these into
        // a one-frame `canceled`, which is exactly what a script wants on alt-tab.
        this._keys.clear();
        this._mouseButtons.clear();
    };

    private _onMouseDown = (event: MouseEvent): void => {
        const button = MOUSE_BUTTONS[event.button];
        if (button) this._mouseButtons.add(button);
        this._updatePosition(event);
        if (this.pointerLockOnClick && event.button === 0) this.requestPointerLock();
        if (this.preventDefault) event.preventDefault();
    };

    private _onMouseUp = (event: MouseEvent): void => {
        const button = MOUSE_BUTTONS[event.button];
        if (button) this._mouseButtons.delete(button);
    };

    private _onMouseMove = (event: MouseEvent): void => {
        // `movementX/Y` in both modes, not just under lock: it is relative motion either way, and it is
        // the only reading that exists while the cursor is hidden. Accumulated, so several events
        // arriving inside one frame all count rather than the last one winning.
        this._deltaX += event.movementX || 0;
        this._deltaY += event.movementY || 0;
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
    };

    private _onPointerLockError = (): void => {
        this._pointerLocked = false;
    };

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
    }
}

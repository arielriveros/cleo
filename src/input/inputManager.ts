import { vec2 } from "gl-matrix";
import { KEYS } from "./keys";
import { Logger } from "../core/logger";

interface MouseInfo {
    buttons: {
        Left: boolean,
        Right: boolean,
        Middle: boolean
    }
    position: vec2;
    velocity: vec2;
    // Wheel deltas accumulated each frame
    wheel: { deltaX: number; deltaY: number };
    // Whether the mouse is captured via Pointer Lock
    captured: boolean;
}

interface KeyInfo {
    pressed: boolean,
    released: boolean,
    onPress: () => void
}

interface KeysInfo {
    [key: string]: KeyInfo
}

export class InputManager {
    private static _instance: InputManager;
    private static _canvas: HTMLCanvasElement;
    private static _mouseInfo: MouseInfo = { 
        buttons: { 
            Left: false,
            Right: false,
            Middle: false },
        position: vec2.create(), 
        velocity: vec2.create(),
        wheel: { deltaX: 0, deltaY: 0 },
        captured: false
    };
    private static _prevetDefault: boolean = false;
    private static _keysInfo: KeysInfo = {};
    // Gate for requesting pointer lock on user clicks.
    private static _mouseCaptureEnabled: boolean = false;
    private constructor() {}

    public static initialize(canvas: HTMLCanvasElement) {
        InputManager._canvas = canvas;
        InputManager.instance._initKeys();

        InputManager._canvas.onmousemove = InputManager.instance._onMouseMove;
        InputManager._canvas.onmousedown = InputManager.instance._onMouseDown;
        InputManager._canvas.onmouseup = InputManager.instance._onMouseUp;
        InputManager._canvas.onwheel = InputManager.instance._onWheel as any;
        window.onkeydown = InputManager.instance._onKeyDown;
        window.onkeyup = InputManager.instance._onKeyUp;

        const onPointerLockChange = () => {
            const locked = (document as any).pointerLockElement === InputManager._canvas;
            InputManager._mouseInfo.captured = locked;
        };
        document.addEventListener('pointerlockchange', onPointerLockChange);
        document.addEventListener('pointerlockerror', () => {
            InputManager._mouseInfo.captured = false;
        });
    }

    private _onMouseMove(event: MouseEvent) {
        if (InputManager._prevetDefault) event.preventDefault();
        const mouseInfo = InputManager._mouseInfo;

        if (mouseInfo.captured) {
            const dx = (event as any).movementX || 0;
            const dy = (event as any).movementY || 0;
            // Accumulated, so several events in one frame all count.
            mouseInfo.velocity[0] += dx;
            mouseInfo.velocity[1] += dy;
            // Under pointer lock there is no real cursor, so `position` is a virtual one.
            mouseInfo.position[0] += dx;
            mouseInfo.position[1] += dy;
            return;
        }

        const lastPosition = vec2.clone(mouseInfo.position);
    
        mouseInfo.position[0] = event.clientX;
        mouseInfo.position[1] = event.clientY;
    
        if (vec2.distance(mouseInfo.position, lastPosition) > Number.EPSILON ) {
            mouseInfo.velocity[0] = (mouseInfo.position[0] - lastPosition[0]);
            mouseInfo.velocity[1] = (mouseInfo.position[1] - lastPosition[1]);
        }
    }

    private _onMouseDown(event: MouseEvent) {
        if (InputManager._prevetDefault) event.preventDefault();
        const mouseInfo = InputManager._mouseInfo;
        switch (event.button) {
            case 0:
                mouseInfo.buttons.Left = true;
                if (InputManager._mouseCaptureEnabled && InputManager._canvas) {
                    try { (InputManager._canvas as any).requestPointerLock?.(); } catch {}
                }
                break;
            case 1:
                mouseInfo.buttons.Middle = true;
                break;
            case 2:
                mouseInfo.buttons.Right = true;
                break;
            default:
                mouseInfo.buttons.Left = false;
                mouseInfo.buttons.Middle = false;
                mouseInfo.buttons.Right = false;
                break;
        }
    }

    private _onMouseUp(event: MouseEvent) {
        if (InputManager._prevetDefault) event.preventDefault();
        const mouseInfo = InputManager._mouseInfo;
        switch (event.button) {
            case 0:
                mouseInfo.buttons.Left = false;
                break;
            case 1:
                mouseInfo.buttons.Middle = false;
                break;
            case 2:
                mouseInfo.buttons.Right = false;
                break;
            default:
                mouseInfo.buttons.Left = false;
                mouseInfo.buttons.Middle = false;
                mouseInfo.buttons.Right = false;
                break;
        }
    }

    private _onWheel(event: WheelEvent) {
        if (InputManager._prevetDefault) event.preventDefault();
        const mouseInfo = InputManager._mouseInfo;
        // Accumulated, so several wheel events in one frame all count.
        mouseInfo.wheel.deltaX += event.deltaX || 0;
        mouseInfo.wheel.deltaY += event.deltaY || 0;
    }

    private _onKeyDown(event: KeyboardEvent) {
        if (InputManager._prevetDefault) event.preventDefault();
        const keysInfo = InputManager._keysInfo;
        if (!keysInfo[event.code]) return;
        keysInfo[event.code].pressed = true;
        // A script's onPress runs off the browser's keydown dispatch, outside every guard the engine
        // wraps its own lifecycle handlers in, so a throw here would escape to the page.
        if (keysInfo[event.code].released) {
            try { keysInfo[event.code].onPress(); }
            catch (e) { Logger.error(`Error in registerKeyPress('${event.code}') callback: ${e}`, 'Script'); }
        }
        keysInfo[event.code].released = false;

    }

    private _onKeyUp(event: KeyboardEvent) {
        if (InputManager._prevetDefault) event.preventDefault();
        const keysInfo = InputManager._keysInfo;
        if (!keysInfo[event.code]) return;
        keysInfo[event.code].pressed = false;
        keysInfo[event.code].released = true;
    }

    private _initKeys() {
        InputManager._keysInfo = {};
        for (const key of KEYS) {
            InputManager._keysInfo[key] = {
                pressed: false,
                released: true,
                onPress: () => {}
            }
        }
    }

    public resetMouseVelocity() {
        InputManager._mouseInfo.velocity[0] = 0;
        InputManager._mouseInfo.velocity[1] = 0;
        InputManager._mouseInfo.wheel.deltaX = 0;
        InputManager._mouseInfo.wheel.deltaY = 0;
    }
    
    public static get instance(): InputManager {
        if (!InputManager._instance) {
            InputManager._instance = new InputManager();
        }
        return InputManager._instance;
    }

    /** Buttons/position/velocity/wheel this frame. `velocity`/`wheel` reset to 0 every frame — read them
     *  in onUpdate, not once in onStart. Under pointer lock, `position` is a free-running virtual point
     *  (there is no real cursor), and `velocity` is relative movement, not a delta of `position`. */
    public get mouse(): MouseInfo { return InputManager._mouseInfo; }
    /** Every known key's live pressed/released state, keyed by `KeyboardEvent.code` (see keys.ts). Most
     *  scripts want `isKeyPressed`/`registerKeyPress` instead of reading this directly. */
    public get keys(): KeysInfo { return InputManager._keysInfo; }

    public isMouseOverCanvas(): boolean {
        if (!InputManager._canvas) return false;
        // Under pointer lock the cursor has no screen position, but every event goes to the canvas.
        if (InputManager._mouseInfo.captured) return true;

        const rect = InputManager._canvas.getBoundingClientRect();
        const mouseX = InputManager._mouseInfo.position[0];
        const mouseY = InputManager._mouseInfo.position[1];
        
        return mouseX >= rect.left && 
               mouseX <= rect.right && 
               mouseY >= rect.top && 
               mouseY <= rect.bottom;
    }

    /** True every frame the key is held — poll this in onUpdate for continuous movement (`isKeyPressed`
     *  is `KeyboardEvent.code`, e.g. `'KeyW'`, `'Space'`, not the printed character). */
    public isKeyPressed(key: string): boolean {
        if (!InputManager._keysInfo[key]) return false;
        return InputManager._keysInfo[key].pressed;
    }

    /** Stops the browser's default action for every handled key/mouse event (e.g. Space scrolling the
     *  page) for the remainder of this session. */
    public preventDefault() {
        InputManager._prevetDefault = true;
    }

    /** Calls `onPress` once on each press of `key` (edge-triggered — held-down does not repeat it; pair
     *  with `isKeyPressed` for continuous movement instead). A throwing `onPress` is caught and logged,
     *  not thrown to the page. */
    public registerKeyPress(key: string, onPress: () => void) {
        if (!InputManager._keysInfo[key]) return;
        InputManager._keysInfo[key].onPress = onPress;
    }

    /** Cancels a callback registered with `registerKeyPress` for `key`. */
    public unregisterKeyPress(key: string) {
        if (!InputManager._keysInfo[key]) return;
        InputManager._keysInfo[key].onPress = () => {};
    }

    /** Allows `captureMouse`/a left click on the canvas to request pointer lock. Off by default. */
    public enableMouseCapture() {
        InputManager._mouseCaptureEnabled = true;
    }
    /** Disallows pointer lock and releases it now, if currently captured. */
    public disableMouseCapture() {
        InputManager._mouseCaptureEnabled = false;
        try { (document as any).exitPointerLock?.(); } catch {}
        InputManager._mouseInfo.captured = false;
    }
    /** Requests pointer lock on the canvas (mouse hidden, `mouse.velocity` becomes relative movement).
     *  Browsers require a user gesture (click/keypress) in the same event to grant this. */
    public captureMouse() {
        try { (InputManager._canvas as any)?.requestPointerLock?.(); } catch {}
    }
    /** Releases pointer lock, if currently captured. */
    public releaseMouse() {
        try { (document as any).exitPointerLock?.(); } catch {}
        InputManager._mouseInfo.captured = false;
    }
    public get isPointerLocked(): boolean { return InputManager._mouseInfo.captured; }

    public clear() {
        InputManager.instance._initKeys();
        InputManager._prevetDefault = false;
        this.disableMouseCapture();
    }
}
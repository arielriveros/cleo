import { vec2 } from "gl-matrix";
import { KEYS } from "./keys";

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
    // Gate to allow requesting pointer lock on user clicks
    private static _mouseCaptureEnabled: boolean = false;
    private constructor() {}

    public static initialize(canvas: HTMLCanvasElement) {
        InputManager._canvas = canvas;
        InputManager.instance._initKeys();

        InputManager._canvas.onmousemove = InputManager.instance._onMouseMove;
        InputManager._canvas.onmousedown = InputManager.instance._onMouseDown;
        InputManager._canvas.onmouseup = InputManager.instance._onMouseUp;
        // Only capture wheel events when mouse is over the canvas
        InputManager._canvas.onwheel = InputManager.instance._onWheel as any;
        window.onkeydown = InputManager.instance._onKeyDown;
        window.onkeyup = InputManager.instance._onKeyUp;

        // Pointer lock state listeners
        const onPointerLockChange = () => {
            const locked = (document as any).pointerLockElement === InputManager._canvas;
            InputManager._mouseInfo.captured = locked;
        };
        document.addEventListener('pointerlockchange', onPointerLockChange);
        document.addEventListener('pointerlockerror', () => {
            // Simply mark as not captured on error
            InputManager._mouseInfo.captured = false;
        });
    }

    private _onMouseMove(event: MouseEvent) {
        if (InputManager._prevetDefault) event.preventDefault();
        const mouseInfo = InputManager._mouseInfo;

        // When pointer is locked, use relative movement deltas
        if (mouseInfo.captured) {
            const dx = (event as any).movementX || 0;
            const dy = (event as any).movementY || 0;
            // Accumulate movement to capture multiple events in a frame
            mouseInfo.velocity[0] += dx;
            mouseInfo.velocity[1] += dy;
            // Maintain a virtual position while locked
            mouseInfo.position[0] += dx;
            mouseInfo.position[1] += dy;
            return;
        }

        const lastPosition = vec2.clone(mouseInfo.position);
    
        mouseInfo.position[0] = event.clientX;
        mouseInfo.position[1] = event.clientY;
    
        // Check if the mouse has moved
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
                // If enabled (e.g., in play mode), capture the pointer on left click
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
        // Accumulate deltas so multiple wheel events in a frame are captured
        mouseInfo.wheel.deltaX += event.deltaX || 0;
        mouseInfo.wheel.deltaY += event.deltaY || 0;
    }

    private _onKeyDown(event: KeyboardEvent) {
        if (InputManager._prevetDefault) event.preventDefault();
        const keysInfo = InputManager._keysInfo;
        if (!keysInfo[event.code]) return;
        keysInfo[event.code].pressed = true;
        // dont call onPress if the key is not released
        if (keysInfo[event.code].released) keysInfo[event.code].onPress();
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
        // Also reset wheel deltas each frame
        InputManager._mouseInfo.wheel.deltaX = 0;
        InputManager._mouseInfo.wheel.deltaY = 0;
    }
    
    public static get instance(): InputManager {
        if (!InputManager._instance) {
            InputManager._instance = new InputManager();
        }
        return InputManager._instance;
    }

    public get mouse(): MouseInfo { return InputManager._mouseInfo; }
    public get keys(): KeysInfo { return InputManager._keysInfo; }

    public isMouseOverCanvas(): boolean {
        if (!InputManager._canvas) return false;
        
        const rect = InputManager._canvas.getBoundingClientRect();
        const mouseX = InputManager._mouseInfo.position[0];
        const mouseY = InputManager._mouseInfo.position[1];
        
        return mouseX >= rect.left && 
               mouseX <= rect.right && 
               mouseY >= rect.top && 
               mouseY <= rect.bottom;
    }

    public isKeyPressed(key: string): boolean {
        if (!InputManager._keysInfo[key]) return false;
        return InputManager._keysInfo[key].pressed;
    }

    public preventDefault() {
        InputManager._prevetDefault = true;
    }

    public registerKeyPress(key: string, onPress: () => void) {
        if (!InputManager._keysInfo[key]) return;
        InputManager._keysInfo[key].onPress = onPress;
    }

    public unregisterKeyPress(key: string) {
        if (!InputManager._keysInfo[key]) return;
        InputManager._keysInfo[key].onPress = () => {};
    }

    // Public API to control pointer lock
    public enableMouseCapture() {
        InputManager._mouseCaptureEnabled = true;
    }
    public disableMouseCapture() {
        InputManager._mouseCaptureEnabled = false;
        try { (document as any).exitPointerLock?.(); } catch {}
        InputManager._mouseInfo.captured = false;
    }
    public captureMouse() {
        try { (InputManager._canvas as any)?.requestPointerLock?.(); } catch {}
    }
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
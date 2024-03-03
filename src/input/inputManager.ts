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
        velocity: vec2.create()
    };
    private static _prevetDefault: boolean = false;
    private static _keysInfo: KeysInfo = {};
    private constructor() {}

    public static initialize(canvas: HTMLCanvasElement) {
        InputManager._canvas = canvas;
        InputManager.instance._initKeys();

        InputManager._canvas.onmousemove = InputManager.instance._onMouseMove;
        InputManager._canvas.onmousedown = InputManager.instance._onMouseDown;
        InputManager._canvas.onmouseup = InputManager.instance._onMouseUp;
        window.onkeydown = InputManager.instance._onKeyDown;
        window.onkeyup = InputManager.instance._onKeyUp;
    }

    private _onMouseMove(event: MouseEvent) {
        if (InputManager._prevetDefault) event.preventDefault();
        const mouseInfo = InputManager._mouseInfo;
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
    }
    
    public static get instance(): InputManager {
        if (!InputManager._instance) {
            InputManager._instance = new InputManager();
        }
        return InputManager._instance;
    }

    public get mouse(): MouseInfo { return InputManager._mouseInfo; }
    public get keys(): KeysInfo { return InputManager._keysInfo; }

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

    public clear() {
        InputManager.instance._initKeys();
        InputManager._prevetDefault = false;
    }
}
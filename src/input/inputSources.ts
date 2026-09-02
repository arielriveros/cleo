/**
 * The device vocabulary: every physical thing an action can be bound to, and how one is named.
 *
 * Must stay a leaf — no DOM, no Gamepad API, no engine imports. The editor's binding picker, the action
 * resolver and the tolerant JSON reader all describe sources with these types, and only `deviceSampler`
 * and `gamepadSampler` ever touch a real device. That separation is what lets the resolver be tested
 * under `environment: 'node'` at all.
 *
 * The one design decision worth stating up front is {@link KeyCode}'s `(string & {})` arm. The system
 * this replaces kept a 51-entry whitelist and silently dropped every `KeyboardEvent.code` outside it —
 * which is why `registerKeyPress('Escape', ...)` was dead code for as long as it existed. Here the list
 * is only what the picker OFFERS; an unlisted code from an unusual layout still binds and still fires.
 */

/**
 * The `KeyboardEvent.code` values the editor offers in its picker, grouped as a keyboard is laid out.
 * NOT a filter — see {@link KeyCode}. Order is the order the picker shows them in.
 */
export const KEY_CODES = [
    // Letters
    'KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'KeyM',
    'KeyN', 'KeyO', 'KeyP', 'KeyQ', 'KeyR', 'KeyS', 'KeyT', 'KeyU', 'KeyV', 'KeyW', 'KeyX', 'KeyY', 'KeyZ',
    // Digit row
    'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
    // Editing and whitespace
    'Escape', 'Tab', 'CapsLock', 'Enter', 'Backspace', 'Space',
    // Modifiers. Left and right are distinct codes, and a binding that means "either" needs two bindings.
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'MetaLeft', 'MetaRight', 'ContextMenu',
    // Arrows and navigation
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
    // Function row
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
    // Numpad
    'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8',
    'Numpad9', 'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal',
    'NumpadEnter', 'NumLock',
    // Punctuation, by physical position (these are US-layout names for the KEY, not the printed glyph)
    'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Backquote',
    'Comma', 'Period', 'Slash', 'IntlBackslash',
] as const;

/**
 * A key binding's code — a `KeyboardEvent.code`, so it names a PHYSICAL key and does not move when the
 * user switches layout (`KeyW` is the same key whether it prints `w` or `z`).
 *
 * The `(string & {})` arm is deliberate and load-bearing: the union half gives the editor autocomplete
 * and a canonical list to render, while the string half means a code this build has never heard of still
 * binds and still fires. Nothing is silently dropped for not being on a list.
 */
export type KeyCode = typeof KEY_CODES[number] | (string & {});

/** Mouse buttons, in `MouseEvent.button` index order — index IS the position in this array. */
export const MOUSE_BUTTONS = ['left', 'middle', 'right', 'back', 'forward'] as const;
export type MouseButton = typeof MOUSE_BUTTONS[number];

/**
 * Pointer axes. `delta*` is movement during the frame (relative movement under pointer lock, where there
 * is no cursor); `wheel*` is scroll accumulated during the frame; `x`/`y` are the absolute position
 * inside the canvas, normalized to 0..1 so a binding does not depend on the viewport's pixel size.
 */
export const POINTER_AXES = ['deltaX', 'deltaY', 'wheelX', 'wheelY', 'x', 'y'] as const;
export type PointerAxis = typeof POINTER_AXES[number];

/**
 * The W3C "standard" gamepad mapping, in button index order — the index of a name here IS its
 * `gamepad.buttons` index. A pad reporting `mapping !== 'standard'` has no guarantee these names mean
 * anything, which is why `gamepadSampler` also exposes the raw index array.
 */
export const GAMEPAD_BUTTONS = [
    'a', 'b', 'x', 'y',
    'leftBumper', 'rightBumper', 'leftTrigger', 'rightTrigger',
    'select', 'start', 'leftStick', 'rightStick',
    'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight',
    'home',
] as const;
export type GamepadButton = typeof GAMEPAD_BUTTONS[number];

/**
 * Standard-mapping stick axes, in `gamepad.axes` index order. Y is reported by the browser with DOWN
 * positive; the sampler flips it so `leftStickY` is positive UP, matching every other 2D source here.
 */
export const GAMEPAD_AXES = ['leftStickX', 'leftStickY', 'rightStickX', 'rightStickY'] as const;
export type GamepadAxis = typeof GAMEPAD_AXES[number];

/** How many local players a binding can name. Slots are stable across disconnects — see gamepadSampler. */
export const MAX_GAMEPAD_PLAYERS = 4;

/**
 * Recognized touch gestures. `tap`, `doubleTap` and `longPress` are one-shot buttons; `drag` and `pinch`
 * are continuous — `drag` produces a per-frame movement pair, `pinch` a per-frame scale delta.
 */
export const TOUCH_GESTURES = ['tap', 'doubleTap', 'longPress', 'drag', 'pinch'] as const;
export type TouchGesture = typeof TOUCH_GESTURES[number];

/**
 * What a binding reads from. This union IS the serialized shape — a source is written to JSON verbatim,
 * so adding an arm is a format change and `normalizeSource` is what keeps an unknown one from crashing
 * a project authored against a newer build.
 *
 * `player` omitted means "any pad": the contribution is whichever connected pad is pushing hardest. That
 * is the right default for a single-player game, where asking the author to think about slots is noise.
 * Set it to 0..3 for local co-op.
 */
export type BindingSource =
    | { device: 'key'; code: KeyCode }
    | { device: 'mouse'; button: MouseButton }
    | { device: 'pointer'; axis: PointerAxis }
    | { device: 'gamepad'; button: GamepadButton; player?: number }
    | { device: 'gamepadAxis'; axis: GamepadAxis; player?: number }
    /** `axis` picks one component out of a 2D gesture; omitted means its scalar magnitude. */
    | { device: 'touch'; gesture: TouchGesture; axis?: 'x' | 'y' }
    | { device: 'virtual'; control: string; axis?: 'x' | 'y' };

export type DeviceKind = BindingSource['device'];

export const DEVICE_KINDS: readonly DeviceKind[] =
    ['key', 'mouse', 'pointer', 'gamepad', 'gamepadAxis', 'touch', 'virtual'];

/**
 * A held-state gate on a binding. Only sources with an unambiguous on/off reading may gate — an axis
 * cannot, because "is the stick held?" has no answer a user would agree with.
 *
 * `state` is a pseudo-device for conditions the engine owns rather than a device: `pointerLock` is what
 * lets a Look binding read mouse movement only while the mouse is captured, which used to be an
 * `if (!input.isPointerLocked && !mouse.buttons.Left) return` at the top of every camera script.
 */
export type ModifierSource =
    | { device: 'key'; code: KeyCode }
    | { device: 'mouse'; button: MouseButton }
    | { device: 'gamepad'; button: GamepadButton; player?: number }
    | { device: 'state'; flag: StateFlag };

export const STATE_FLAGS = ['pointerLock', 'pointerOverCanvas'] as const;
export type StateFlag = typeof STATE_FLAGS[number];

/**
 * A stable string identity for a source. Three things key on it and all three break without it: dedupe
 * of two bindings that read the same thing, modifier suppression (see resolveActions), and the editor's
 * "this key is already bound to X" conflict warning.
 *
 * `player` is part of the identity — pad 0's A and pad 1's A are different buttons — but "any pad" and
 * "pad 0" are also different, so an omitted player renders as `*` rather than defaulting to 0.
 */
export function sourceKey(source: BindingSource | ModifierSource): string {
    switch (source.device) {
        case 'key': return `key:${source.code}`;
        case 'mouse': return `mouse:${source.button}`;
        case 'pointer': return `pointer:${source.axis}`;
        case 'gamepad': return `gamepad:${source.button}:${playerTag(source.player)}`;
        case 'gamepadAxis': return `gamepadAxis:${source.axis}:${playerTag(source.player)}`;
        case 'touch': return `touch:${source.gesture}${source.axis ? `:${source.axis}` : ''}`;
        case 'virtual': return `virtual:${source.control}${source.axis ? `:${source.axis}` : ''}`;
        case 'state': return `state:${source.flag}`;
    }
}

function playerTag(player: number | undefined): string {
    return typeof player === 'number' && Number.isFinite(player) ? String(player) : '*';
}

const KEY_LABELS: Record<string, string> = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
    AltLeft: 'Left Alt', AltRight: 'Right Alt',
    MetaLeft: 'Left Meta', MetaRight: 'Right Meta',
    BracketLeft: '[', BracketRight: ']', Backquote: '`', Backslash: '\\',
    Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    IntlBackslash: '\\', ContextMenu: 'Menu',
};

const GAMEPAD_LABELS: Record<GamepadButton, string> = {
    a: 'A', b: 'B', x: 'X', y: 'Y',
    leftBumper: 'LB', rightBumper: 'RB', leftTrigger: 'LT', rightTrigger: 'RT',
    select: 'Select', start: 'Start', leftStick: 'L3', rightStick: 'R3',
    dpadUp: 'D-Pad Up', dpadDown: 'D-Pad Down', dpadLeft: 'D-Pad Left', dpadRight: 'D-Pad Right',
    home: 'Home',
};

/** How a source reads in the editor's binding row and in a "press any key" prompt. Display only. */
export function sourceLabel(source: BindingSource | ModifierSource): string {
    switch (source.device) {
        case 'key':
            return KEY_LABELS[source.code] ?? source.code.replace(/^(Key|Digit|Numpad)/, m => m === 'Numpad' ? 'Num ' : '');
        case 'mouse':
            return `${source.button[0].toUpperCase()}${source.button.slice(1)} Mouse`;
        case 'pointer':
            return `Pointer ${source.axis}`;
        case 'gamepad':
            return `${GAMEPAD_LABELS[source.button] ?? source.button}${playerSuffix(source.player)}`;
        case 'gamepadAxis':
            return `${source.axis}${playerSuffix(source.player)}`;
        case 'touch':
            return `Touch ${source.gesture}${source.axis ? ` ${source.axis}` : ''}`;
        case 'virtual':
            return `On-screen ${source.control}${source.axis ? ` ${source.axis}` : ''}`;
        case 'state':
            return source.flag === 'pointerLock' ? 'Mouse captured' : 'Pointer over view';
    }
}

function playerSuffix(player: number | undefined): string {
    return typeof player === 'number' && Number.isFinite(player) ? ` (P${player + 1})` : '';
}

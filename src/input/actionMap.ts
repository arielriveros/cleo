/**
 * What an input map IS: named actions, the bindings that feed them, and the readers that turn untrusted
 * JSON back into one.
 *
 * Must stay a leaf — no DOM, no Gamepad API, no engine imports beyond the source vocabulary. The editor
 * panel types its state from here, the node suite imports it under `environment: 'node'`, and the
 * resolver consumes it. A single `window` reference would take all three away.
 *
 * The tolerant readers — `normalizeSource`, `normalizeBinding`, `normalizeAction`, `parseInputMap` — ARE
 * the migration story, mirroring `parseSoundSettings` and `resolvePostChain`: a field that has gained a
 * meaning, lost one, or arrived as garbage from an older project resolves to a default or is dropped,
 * never throws. Nothing downstream validates, because everything comes through here.
 *
 * The rule that shapes the whole file: an unreadable BINDING is dropped while its siblings keep their
 * order, and an unreadable ACTION is dropped whole. Replacing either with a default would silently bind
 * a key nobody asked for — worse than the action simply not firing, because it looks like it works.
 */

import {
    DEVICE_KINDS, GAMEPAD_AXES, GAMEPAD_BUTTONS, MAX_GAMEPAD_PLAYERS, MOUSE_BUTTONS, POINTER_AXES,
    STATE_FLAGS, TOUCH_GESTURES,
} from "./inputSources";
import type {
    BindingSource, DeviceKind, GamepadAxis, GamepadButton, ModifierSource, MouseButton, PointerAxis,
    StateFlag, TouchGesture,
} from "./inputSources";

// ---------------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------------

/**
 * What an action produces. The kind is authored, not inferred from the bindings: an author who binds a
 * single key to a `vector` action means "this contributes one component", and guessing otherwise would
 * make adding the second key change the meaning of the first.
 */
export const ACTION_KINDS = ['button', 'axis', 'vector'] as const;
export type ActionKind = typeof ACTION_KINDS[number];

/**
 * Which slot of a composite a binding drives. Absent means it drives the whole value — a stick bound to
 * a `vector` action with no part contributes both components at once.
 *
 * `positive`/`negative` are the `axis` pair; `up`/`down`/`left`/`right` are the `vector` four; `x`/`y`
 * write one component of a vector directly from a scalar source (a trigger driving throttle, say).
 */
export const COMPOSITE_PARTS = ['positive', 'negative', 'up', 'down', 'left', 'right', 'x', 'y'] as const;
export type CompositePart = typeof COMPOSITE_PARTS[number];

/**
 * One shaping step. A discriminated union rather than a bag of optional fields, so a deadzone's `min`
 * and a curve's `exponent` can never be confused for each other by the editor's parameter rows.
 */
export type Processor =
    | { kind: 'deadzone'; min: number; max: number }
    | { kind: 'radialDeadzone'; min: number; max: number }
    | { kind: 'scale'; factor: number }
    | { kind: 'invert'; x: boolean; y: boolean }
    | { kind: 'curve'; exponent: number }
    | { kind: 'smooth'; seconds: number }
    | { kind: 'normalize' };

export type ProcessorKind = Processor['kind'];

export const PROCESSOR_KINDS: readonly ProcessorKind[] =
    ['deadzone', 'radialDeadzone', 'scale', 'invert', 'curve', 'smooth', 'normalize'];

// ---------------------------------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------------------------------

export interface InputBinding {
    /**
     * Stable identity within its action. The editor's row key, the rebind target, and what distinguishes
     * two bindings that happen to read the same source. Minted deterministically when absent, so loading
     * an older project twice does not produce two different sets of ids.
     */
    id: string;
    source: BindingSource;
    part?: CompositePart;
    /** ALL must be held for this binding to contribute at all. */
    modifiers?: ModifierSource[];
    /** Applied to this binding's own reading, before it competes with the action's other bindings. */
    processors?: Processor[];
}

export interface InputAction {
    name: string;
    kind: ActionKind;
    bindings: InputBinding[];
    /** Applied AFTER the winning binding, to the composed value. Where `normalize` usually belongs. */
    processors?: Processor[];
    /** `button` only: |value| at or above which it counts as pressed. Default 0.5, so triggers work. */
    pressPoint?: number;
    /** `button` only: seconds held before `phase` becomes `performed`. 0 means the same frame as `started`. */
    holdSeconds?: number;
}

export interface InputActionMap {
    name: string;
    /**
     * The AUTHORED default. Runtime enable/disable lives on InputSystem, not in the data — a map the
     * player disabled by opening a menu must not be written back into the project.
     */
    enabled: boolean;
    actions: InputAction[];
}

/** An on-screen control drawn over the canvas, bound to actions like any other device. */
export interface VirtualControl {
    /** Referenced by a `{ device: 'virtual', control }` binding. */
    id: string;
    kind: 'stick' | 'button';
    /**
     * Placement in NORMALIZED viewport coordinates, origin top-left, 0..1. `radius` is in units of
     * viewport HEIGHT for both axes — a circle stays a circle on an ultrawide monitor, which it would
     * not if the axes were normalized independently.
     */
    x: number;
    y: number;
    radius: number;
    /** `stick` only: fraction of `radius` inside which the stick reads zero. */
    deadzone?: number;
    /** `button` only: what to print on it. */
    label?: string;
}

/** Thresholds the gesture recognizer judges by. Pixels are CSS pixels, seconds are seconds. */
export interface TouchGestureConfig {
    tapMaxSeconds: number;
    tapMaxPixels: number;
    doubleTapMaxSeconds: number;
    longPressSeconds: number;
    dragMinPixels: number;
    pinchMinPixels: number;
}

export interface InputMap {
    /** Bumped only by a change `parseInputMap` cannot absorb. Nothing reads it yet, by design. */
    version: 1;
    maps: InputActionMap[];
    virtualControls: VirtualControl[];
    touch: TouchGestureConfig;
}

// ---------------------------------------------------------------------------------------------------
// Action state
// ---------------------------------------------------------------------------------------------------

/**
 * Where a button action is in its press. `started` and `canceled` each last exactly one frame;
 * `performed` is the steady held state, delayed by `holdSeconds` when one is authored.
 */
export const ACTION_PHASES = ['idle', 'started', 'performed', 'canceled'] as const;
export type ActionPhase = typeof ACTION_PHASES[number];

/** Everything a script can read about one action this frame. Rebuilt every frame; never mutated in place. */
export interface ActionState {
    kind: ActionKind;
    /** `button`: 0..1 (analog on a trigger). `axis`: -1..1. `vector`: the magnitude of {@link vector}. */
    value: number;
    vector: [number, number];
    pressed: boolean;
    /** True on EXACTLY the frame the value crossed `pressPoint` upward. */
    started: boolean;
    /** True on EXACTLY the frame it fell back below — including the frame its map was disabled. */
    released: boolean;
    phase: ActionPhase;
    heldSeconds: number;
    /** Which device won this frame, so a HUD can swap key prompts for pad glyphs. Null when idle. */
    device: DeviceKind | null;
}

/** What an unknown action name reads as. Frozen and shared — a typo must not allocate, or crash. */
export const IDLE_STATE: Readonly<ActionState> = Object.freeze({
    kind: 'button' as ActionKind,
    value: 0,
    vector: Object.freeze([0, 0]) as unknown as [number, number],
    pressed: false,
    started: false,
    released: false,
    phase: 'idle' as ActionPhase,
    heldSeconds: 0,
    device: null,
});

/** A fresh zeroed state for an action of `kind`. */
export function idleState(kind: ActionKind): ActionState {
    return {
        kind, value: 0, vector: [0, 0], pressed: false, started: false, released: false,
        phase: 'idle', heldSeconds: 0, device: null,
    };
}

// ---------------------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------------------

export const DEFAULT_PRESS_POINT = 0.5;

export const DEFAULT_TOUCH_CONFIG: TouchGestureConfig = {
    tapMaxSeconds: 0.25,
    tapMaxPixels: 12,
    doubleTapMaxSeconds: 0.3,
    longPressSeconds: 0.5,
    dragMinPixels: 8,
    pinchMinPixels: 12,
};

/** A fresh processor of `kind`, tuned to be the mildest thing a user would still call an effect. */
export function defaultProcessor(kind: ProcessorKind): Processor {
    switch (kind) {
        // 0.15 is the smallest deadzone that reliably silences a worn analog stick at rest; 0.95 gives
        // back the last few percent of travel, which most pads never physically reach.
        case 'deadzone': return { kind: 'deadzone', min: 0.15, max: 0.95 };
        case 'radialDeadzone': return { kind: 'radialDeadzone', min: 0.15, max: 0.95 };
        case 'scale': return { kind: 'scale', factor: 1 };
        case 'invert': return { kind: 'invert', x: false, y: false };
        case 'curve': return { kind: 'curve', exponent: 1 };
        case 'smooth': return { kind: 'smooth', seconds: 0.05 };
        case 'normalize': return { kind: 'normalize' };
    }
}

function binding(id: string, source: BindingSource, extra: Partial<InputBinding> = {}): InputBinding {
    return { id, source, ...extra };
}

const STICK_DEADZONE: Processor = { kind: 'radialDeadzone', min: 0.15, max: 0.95 };

/**
 * The map a project starts with, and what a build with no authored bindings runs on. Chosen so that the
 * example scripts, the editor's Play button and a freshly generated script all do something sensible on
 * a keyboard, a pad and a phone without anyone opening the Input panel first.
 *
 * `Look` is the one worth reading closely: its pointer bindings are gated on `pointerLock` OR the left
 * button, which is the binding-level expression of the guard every camera script used to open with.
 */
export const DEFAULT_INPUT_MAP: InputMap = {
    version: 1,
    maps: [
        {
            name: 'Gameplay',
            enabled: true,
            actions: [
                {
                    name: 'Move',
                    kind: 'vector',
                    bindings: [
                        binding('move:w', { device: 'key', code: 'KeyW' }, { part: 'up' }),
                        binding('move:s', { device: 'key', code: 'KeyS' }, { part: 'down' }),
                        binding('move:a', { device: 'key', code: 'KeyA' }, { part: 'left' }),
                        binding('move:d', { device: 'key', code: 'KeyD' }, { part: 'right' }),
                        binding('move:up', { device: 'key', code: 'ArrowUp' }, { part: 'up' }),
                        binding('move:down', { device: 'key', code: 'ArrowDown' }, { part: 'down' }),
                        binding('move:left', { device: 'key', code: 'ArrowLeft' }, { part: 'left' }),
                        binding('move:right', { device: 'key', code: 'ArrowRight' }, { part: 'right' }),
                        binding('move:padX', { device: 'gamepadAxis', axis: 'leftStickX' },
                            { part: 'x', processors: [{ kind: 'deadzone', min: 0.15, max: 0.95 }] }),
                        binding('move:padY', { device: 'gamepadAxis', axis: 'leftStickY' },
                            { part: 'y', processors: [{ kind: 'deadzone', min: 0.15, max: 0.95 }] }),
                        binding('move:stick', { device: 'virtual', control: 'moveStick' }),
                    ],
                    // Clamps the WASD diagonal to unit length without amplifying a half-pushed stick.
                    processors: [{ kind: 'normalize' }],
                },
                {
                    name: 'Look',
                    kind: 'vector',
                    bindings: [
                        binding('look:mouseX', { device: 'pointer', axis: 'deltaX' }, {
                            part: 'x',
                            modifiers: [{ device: 'state', flag: 'pointerLock' }],
                        }),
                        binding('look:mouseY', { device: 'pointer', axis: 'deltaY' }, {
                            part: 'y',
                            modifiers: [{ device: 'state', flag: 'pointerLock' }],
                        }),
                        binding('look:dragX', { device: 'pointer', axis: 'deltaX' }, {
                            part: 'x',
                            modifiers: [{ device: 'mouse', button: 'left' }],
                        }),
                        binding('look:dragY', { device: 'pointer', axis: 'deltaY' }, {
                            part: 'y',
                            modifiers: [{ device: 'mouse', button: 'left' }],
                        }),
                        binding('look:padX', { device: 'gamepadAxis', axis: 'rightStickX' },
                            { part: 'x', processors: [STICK_DEADZONE, { kind: 'scale', factor: 4 }] }),
                        binding('look:padY', { device: 'gamepadAxis', axis: 'rightStickY' },
                            { part: 'y', processors: [STICK_DEADZONE, { kind: 'scale', factor: -4 }] }),
                        binding('look:touch', { device: 'touch', gesture: 'drag' }),
                    ],
                },
                {
                    name: 'Jump',
                    kind: 'button',
                    bindings: [
                        binding('jump:space', { device: 'key', code: 'Space' }),
                        binding('jump:pad', { device: 'gamepad', button: 'a' }),
                        binding('jump:virtual', { device: 'virtual', control: 'jump' }),
                    ],
                },
                {
                    name: 'Sprint',
                    kind: 'button',
                    bindings: [
                        binding('sprint:shift', { device: 'key', code: 'ShiftLeft' }),
                        binding('sprint:pad', { device: 'gamepad', button: 'leftStick' }),
                    ],
                },
                {
                    name: 'Fire',
                    kind: 'button',
                    bindings: [
                        binding('fire:mouse', { device: 'mouse', button: 'left' }),
                        // An analog trigger reads 0..1, so pressPoint is what makes it a button at all.
                        binding('fire:pad', { device: 'gamepad', button: 'rightTrigger' }),
                        binding('fire:tap', { device: 'touch', gesture: 'tap' }),
                    ],
                },
                {
                    name: 'Zoom',
                    kind: 'axis',
                    bindings: [
                        binding('zoom:wheel', { device: 'pointer', axis: 'wheelY' }),
                        binding('zoom:pinch', { device: 'touch', gesture: 'pinch' }),
                    ],
                },
            ],
        },
        {
            name: 'UI',
            enabled: true,
            actions: [
                {
                    name: 'Navigate',
                    kind: 'vector',
                    bindings: [
                        binding('nav:up', { device: 'key', code: 'ArrowUp' }, { part: 'up' }),
                        binding('nav:down', { device: 'key', code: 'ArrowDown' }, { part: 'down' }),
                        binding('nav:left', { device: 'key', code: 'ArrowLeft' }, { part: 'left' }),
                        binding('nav:right', { device: 'key', code: 'ArrowRight' }, { part: 'right' }),
                        binding('nav:padX', { device: 'gamepadAxis', axis: 'leftStickX' },
                            { part: 'x', processors: [{ kind: 'deadzone', min: 0.5, max: 0.95 }] }),
                        binding('nav:padY', { device: 'gamepadAxis', axis: 'leftStickY' },
                            { part: 'y', processors: [{ kind: 'deadzone', min: 0.5, max: 0.95 }] }),
                    ],
                },
                {
                    name: 'Submit',
                    kind: 'button',
                    bindings: [
                        binding('submit:enter', { device: 'key', code: 'Enter' }),
                        binding('submit:pad', { device: 'gamepad', button: 'a' }),
                    ],
                },
                {
                    name: 'Cancel',
                    kind: 'button',
                    bindings: [
                        binding('cancel:escape', { device: 'key', code: 'Escape' }),
                        binding('cancel:pad', { device: 'gamepad', button: 'b' }),
                    ],
                },
                {
                    name: 'Pause',
                    kind: 'button',
                    bindings: [
                        binding('pause:escape', { device: 'key', code: 'Escape' }),
                        binding('pause:pad', { device: 'gamepad', button: 'start' }),
                    ],
                },
            ],
        },
    ],
    virtualControls: [
        // Off by default: `enabled` on a control would be a fourth place to say "is touch on", so instead
        // the runtime layer only draws these when the device reports a touch screen. See VirtualControlsLayer.
        { id: 'moveStick', kind: 'stick', x: 0.15, y: 0.76, radius: 0.11, deadzone: 0.12 },
        { id: 'jump', kind: 'button', x: 0.87, y: 0.78, radius: 0.07, label: 'Jump' },
    ],
    touch: { ...DEFAULT_TOUCH_CONFIG },
};

// ---------------------------------------------------------------------------------------------------
// Tolerant readers
// ---------------------------------------------------------------------------------------------------

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
    return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : fallback;
}

function optionalOneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
    return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : undefined;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

/** Player slot, or undefined for "any pad". Out-of-range slots read as "any" rather than being clamped
 *  into a slot the author never named. */
function playerSlot(v: unknown): number | undefined {
    if (typeof v !== 'number' || !Number.isInteger(v)) return undefined;
    return v >= 0 && v < MAX_GAMEPAD_PLAYERS ? v : undefined;
}

/**
 * Read one source out of untrusted JSON. Returns null for a device this build does not know, which is
 * how a project authored against a newer version degrades: the binding is dropped and the ones around
 * it keep working, rather than the whole map failing to load.
 */
export function normalizeSource(raw: unknown): BindingSource | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    const device = s.device;
    if (typeof device !== 'string' || !(DEVICE_KINDS as readonly string[]).includes(device)) return null;

    switch (device as DeviceKind) {
        case 'key': {
            // Any non-empty string is a legal code — the whitelist is the picker's, not the format's.
            const code = str(s.code);
            return code ? { device: 'key', code } : null;
        }
        case 'mouse': {
            const button = optionalOneOf<MouseButton>(s.button, MOUSE_BUTTONS);
            return button ? { device: 'mouse', button } : null;
        }
        case 'pointer': {
            const axis = optionalOneOf<PointerAxis>(s.axis, POINTER_AXES);
            return axis ? { device: 'pointer', axis } : null;
        }
        case 'gamepad': {
            const button = optionalOneOf<GamepadButton>(s.button, GAMEPAD_BUTTONS);
            if (!button) return null;
            const player = playerSlot(s.player);
            return player === undefined ? { device: 'gamepad', button } : { device: 'gamepad', button, player };
        }
        case 'gamepadAxis': {
            const axis = optionalOneOf<GamepadAxis>(s.axis, GAMEPAD_AXES);
            if (!axis) return null;
            const player = playerSlot(s.player);
            return player === undefined ? { device: 'gamepadAxis', axis } : { device: 'gamepadAxis', axis, player };
        }
        case 'touch': {
            const gesture = optionalOneOf<TouchGesture>(s.gesture, TOUCH_GESTURES);
            if (!gesture) return null;
            const axis = optionalOneOf<'x' | 'y'>(s.axis, ['x', 'y']);
            return axis ? { device: 'touch', gesture, axis } : { device: 'touch', gesture };
        }
        case 'virtual': {
            const control = str(s.control);
            if (!control) return null;
            const axis = optionalOneOf<'x' | 'y'>(s.axis, ['x', 'y']);
            return axis ? { device: 'virtual', control, axis } : { device: 'virtual', control };
        }
    }
    return null;
}

/** Read one modifier. Narrower than a source: only devices with an unambiguous held state may gate. */
export function normalizeModifier(raw: unknown): ModifierSource | null {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>;
    if (m.device === 'state') {
        const flag = optionalOneOf<StateFlag>(m.flag, STATE_FLAGS);
        return flag ? { device: 'state', flag } : null;
    }
    const source = normalizeSource(raw);
    if (!source) return null;
    if (source.device === 'key' || source.device === 'mouse' || source.device === 'gamepad') return source;
    return null;
}

/** Read one processor. Parameters are defaulted then clamped to the range each one is meaningful over. */
export function normalizeProcessor(raw: unknown): Processor | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Record<string, unknown>;
    const kind = p.kind;
    if (typeof kind !== 'string' || !(PROCESSOR_KINDS as readonly string[]).includes(kind)) return null;

    switch (kind as ProcessorKind) {
        case 'deadzone':
        case 'radialDeadzone': {
            const base = defaultProcessor(kind as 'deadzone') as Extract<Processor, { kind: 'deadzone' }>;
            const min = clamp(num(p.min, base.min), 0, 0.99);
            return {
                kind: kind as 'deadzone' | 'radialDeadzone',
                min,
                // Never at or below min: the rescale divides by (max - min) and would blow up or invert.
                max: clamp(num(p.max, base.max), min + 0.01, 1),
            };
        }
        case 'scale':
            // 1000x is already absurd for a sensitivity; beyond it a typo silently makes a game unplayable.
            return { kind: 'scale', factor: clamp(num(p.factor, 1), -1000, 1000) };
        case 'invert':
            return { kind: 'invert', x: p.x === true, y: p.y === true };
        case 'curve':
            // Below 0.1 the response is effectively binary; above 5 the first half of the travel is dead.
            return { kind: 'curve', exponent: clamp(num(p.exponent, 1), 0.1, 5) };
        case 'smooth':
            // A second of smoothing on input is already unusably mushy.
            return { kind: 'smooth', seconds: clamp(num(p.seconds, 0.05), 0, 1) };
        case 'normalize':
            return { kind: 'normalize' };
    }
    return null;
}

function normalizeProcessors(raw: unknown): Processor[] {
    if (!Array.isArray(raw)) return [];
    const out: Processor[] = [];
    for (const entry of raw) {
        const processor = normalizeProcessor(entry);
        if (processor) out.push(processor);
    }
    return out;
}

function normalizeModifiers(raw: unknown): ModifierSource[] {
    if (!Array.isArray(raw)) return [];
    const out: ModifierSource[] = [];
    for (const entry of raw) {
        const modifier = normalizeModifier(entry);
        if (modifier) out.push(modifier);
    }
    return out;
}

/**
 * Read one binding. `fallbackId` is minted from the action name and the binding's INDEX, so a project
 * saved by an older build that never wrote ids gets the same ids on every load — an id that churned
 * would make the editor's selection jump and every diff of a saved project noisy.
 */
export function normalizeBinding(raw: unknown, fallbackId: string): InputBinding | null {
    if (!raw || typeof raw !== 'object') return null;
    const b = raw as Record<string, unknown>;
    const source = normalizeSource(b.source);
    if (!source) return null;

    const out: InputBinding = { id: str(b.id) || fallbackId, source };
    const part = optionalOneOf<CompositePart>(b.part, COMPOSITE_PARTS);
    if (part) out.part = part;
    const modifiers = normalizeModifiers(b.modifiers);
    if (modifiers.length) out.modifiers = modifiers;
    const processors = normalizeProcessors(b.processors);
    if (processors.length) out.processors = processors;
    return out;
}

/**
 * Read one action. Dropped entirely — not defaulted — when it has no name or an unknown kind: an action
 * whose kind we cannot read would compose its bindings by a rule the author did not choose.
 *
 * Binding ids are made unique within the action: two rows sharing an id would make the editor edit both
 * at once, and it is the kind of thing a hand-edited project file does.
 */
export function normalizeAction(raw: unknown): InputAction | null {
    if (!raw || typeof raw !== 'object') return null;
    const a = raw as Record<string, unknown>;
    const name = str(a.name);
    if (!name) return null;
    if (typeof a.kind !== 'string' || !(ACTION_KINDS as readonly string[]).includes(a.kind)) return null;
    const kind = a.kind as ActionKind;

    const bindings: InputBinding[] = [];
    const seen = new Set<string>();
    const rawBindings = Array.isArray(a.bindings) ? a.bindings : [];
    for (let i = 0; i < rawBindings.length; i++) {
        const parsed = normalizeBinding(rawBindings[i], `${name}:${i}`);
        if (!parsed) continue;
        let id = parsed.id;
        for (let suffix = 2; seen.has(id); suffix++) id = `${parsed.id}#${suffix}`;
        seen.add(id);
        bindings.push(id === parsed.id ? parsed : { ...parsed, id });
    }

    const out: InputAction = { name, kind, bindings };
    const processors = normalizeProcessors(a.processors);
    if (processors.length) out.processors = processors;
    if (kind === 'button') {
        // Only meaningful on a button, and carrying it elsewhere would put a control in the panel that
        // does nothing. Never 0: a press point of 0 makes an untouched analog trigger permanently held.
        // Written only when it differs from the default, so an untouched action serializes no field and
        // a round-trip through JSON comes back byte-identical (see isDefaultInputMap).
        const pressPoint = clamp(num(a.pressPoint, DEFAULT_PRESS_POINT), 0.01, 1);
        if (pressPoint !== DEFAULT_PRESS_POINT) out.pressPoint = pressPoint;
        const hold = clamp(num(a.holdSeconds, 0), 0, 10);
        if (hold > 0) out.holdSeconds = hold;
    }
    return out;
}

/** Read one action map. Duplicate action names keep the FIRST — the later one is unreachable anyway. */
export function normalizeActionMap(raw: unknown): InputActionMap | null {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>;
    const name = str(m.name);
    if (!name) return null;

    const actions: InputAction[] = [];
    const seen = new Set<string>();
    for (const entry of (Array.isArray(m.actions) ? m.actions : [])) {
        const action = normalizeAction(entry);
        if (!action || seen.has(action.name)) continue;
        seen.add(action.name);
        actions.push(action);
    }
    return { name, enabled: m.enabled !== false, actions };
}

/** Read one on-screen control. Placement is clamped into the viewport so a bad value cannot hide it. */
export function normalizeVirtualControl(raw: unknown): VirtualControl | null {
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    const id = str(c.id);
    if (!id) return null;
    const kind = oneOf<'stick' | 'button'>(c.kind, ['stick', 'button'], 'button');
    const out: VirtualControl = {
        id,
        kind,
        x: clamp(num(c.x, 0.5), 0, 1),
        y: clamp(num(c.y, 0.5), 0, 1),
        // Below ~2% of viewport height nothing is hittable by a thumb; above 40% it covers the game.
        radius: clamp(num(c.radius, 0.1), 0.02, 0.4),
    };
    if (kind === 'stick') out.deadzone = clamp(num(c.deadzone, 0.12), 0, 0.9);
    const label = str(c.label);
    if (kind === 'button' && label) out.label = label;
    return out;
}

export function normalizeTouchConfig(raw: unknown): TouchGestureConfig {
    const t = (raw && typeof raw === 'object' ? raw : {}) as Partial<TouchGestureConfig>;
    const tapMaxSeconds = clamp(num(t.tapMaxSeconds, DEFAULT_TOUCH_CONFIG.tapMaxSeconds), 0.05, 2);
    return {
        tapMaxSeconds,
        tapMaxPixels: clamp(num(t.tapMaxPixels, DEFAULT_TOUCH_CONFIG.tapMaxPixels), 1, 200),
        doubleTapMaxSeconds: clamp(num(t.doubleTapMaxSeconds, DEFAULT_TOUCH_CONFIG.doubleTapMaxSeconds), 0.05, 2),
        // Must exceed tapMaxSeconds, or every tap would also be a long press and the two would fight.
        longPressSeconds: Math.max(tapMaxSeconds + 0.01,
            clamp(num(t.longPressSeconds, DEFAULT_TOUCH_CONFIG.longPressSeconds), 0.05, 5)),
        dragMinPixels: clamp(num(t.dragMinPixels, DEFAULT_TOUCH_CONFIG.dragMinPixels), 0, 200),
        pinchMinPixels: clamp(num(t.pinchMinPixels, DEFAULT_TOUCH_CONFIG.pinchMinPixels), 0, 200),
    };
}

/**
 * Build a full {@link InputMap} from anything — a partial, a stale record, `undefined`, or junk.
 *
 * A blob with no readable maps at all falls back to {@link DEFAULT_INPUT_MAP} rather than to an empty
 * map: an empty map is a game where nothing responds, which reads to the player as a broken build, while
 * the defaults at least move the character.
 */
export function parseInputMap(raw: unknown): InputMap {
    if (!raw || typeof raw !== 'object') return cloneInputMap(DEFAULT_INPUT_MAP);
    const r = raw as Record<string, unknown>;

    const maps: InputActionMap[] = [];
    const seen = new Set<string>();
    for (const entry of (Array.isArray(r.maps) ? r.maps : [])) {
        const map = normalizeActionMap(entry);
        if (!map || seen.has(map.name)) continue;
        seen.add(map.name);
        maps.push(map);
    }
    if (maps.length === 0) return cloneInputMap(DEFAULT_INPUT_MAP);

    const virtualControls: VirtualControl[] = [];
    const controlIds = new Set<string>();
    for (const entry of (Array.isArray(r.virtualControls) ? r.virtualControls : [])) {
        const control = normalizeVirtualControl(entry);
        if (!control || controlIds.has(control.id)) continue;
        controlIds.add(control.id);
        virtualControls.push(control);
    }

    return { version: 1, maps, virtualControls, touch: normalizeTouchConfig(r.touch) };
}

/** A deep copy. The map is handed to the editor as mutable state, so nothing may alias the defaults. */
export function cloneInputMap(map: InputMap): InputMap {
    return JSON.parse(JSON.stringify(map)) as InputMap;
}

/**
 * Whether `map` is the shipped default. What it is FOR: a project nobody has touched must serialize no
 * input block at all, so an unrelated save does not add bytes to the file — the same reason
 * `isDefaultChain` exists for the post chain.
 *
 * Compared through `parseInputMap` so field ORDER and absent-versus-default optionals cannot make an
 * equivalent map look different.
 */
export function isDefaultInputMap(map: unknown): boolean {
    return JSON.stringify(parseInputMap(map)) === JSON.stringify(parseInputMap(DEFAULT_INPUT_MAP));
}

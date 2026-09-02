/**
 * One frame of the input system: raw device readings in, a table of action states out.
 *
 * This is a PURE function of (maps, enabled set, device snapshot, last frame's state, dt). It holds no
 * module-level state — the two things that genuinely need to persist between frames, smoothing filters
 * and hold timers, are carried in a {@link ResolveState} the caller passes in and gets back. That is
 * what makes the whole system testable: a test writes a sequence of snapshots and asserts on the states
 * that come out, with no DOM, no clock and no engine.
 *
 * The four rules that are easy to get wrong, and are each pinned by a test:
 *
 *   * EDGES ARE EXACTLY ONE FRAME. `started` is true on the frame a value crosses the press point and
 *     never again while it stays there; `released` likewise on the way down. Everything that used to be
 *     `registerKeyPress` depends on this.
 *   * MODIFIERS SUPPRESS. If `Shift+S` is bound anywhere in a map and Shift is down, a plain `S` binding
 *     in that same map does not fire. Computed per frame across the whole map, before any action is
 *     evaluated — the alternative is that saving also crouches.
 *   * DISABLING A MAP CANCELS ITS HELDS. An action that was pressed when its map went away gets one
 *     frame of `released`/`canceled`, then idles. Without it, opening a menu while holding W walks
 *     forever.
 *   * THE LOUDEST CONTRIBUTOR WINS, AND TIES GO TO THE EARLIER BINDING. Deterministic winner selection
 *     is what makes `state.device` trustworthy enough for a HUD to swap key prompts for pad glyphs.
 */

import { DEFAULT_PRESS_POINT, idleState } from "./actionMap";
import type {
    ActionKind, ActionPhase, ActionState, InputAction, InputActionMap, InputBinding,
} from "./actionMap";
import { GAMEPAD_AXES, GAMEPAD_BUTTONS, sourceKey } from "./inputSources";
import type { BindingSource, DeviceKind, ModifierSource, MouseButton } from "./inputSources";
import { runProcessors1D, runProcessors2D, unsignZero } from "./processors";
import type { SmoothingState, Vec2 } from "./processors";
import type { GestureOutput } from "./gestures";
import type { VirtualReading } from "./virtualControls";

// ---------------------------------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------------------------------

/** One pad as the resolver sees it. `buttons`/`axes` are indexed the way the Gamepad API indexes them. */
export interface GamepadReading {
    connected: boolean;
    /** 0..1 per button — analog on triggers, so a press point rather than a boolean is what reads them. */
    buttons: readonly number[];
    /** Raw axis indices, with the Y axes already flipped to Y-UP by the sampler. */
    axes: readonly number[];
}

export interface PointerReading {
    deltaX: number;
    deltaY: number;
    wheelX: number;
    wheelY: number;
    /** Position inside the canvas, normalized 0..1. Meaningless while pointer-locked. */
    x: number;
    y: number;
}

/**
 * Everything the devices report this frame. The ONLY thing the DOM layer hands the resolver, and
 * deliberately made of plain sets, numbers and maps so a test can build one by hand.
 */
export interface DeviceSnapshot {
    /** `KeyboardEvent.code` values currently down. A raw code set — no whitelist filters it. */
    keys: ReadonlySet<string>;
    mouseButtons: ReadonlySet<MouseButton>;
    pointer: PointerReading;
    pointerLocked: boolean;
    pointerOverCanvas: boolean;
    /** Indexed by PLAYER SLOT, not by `gamepad.index`. A null slot is an empty one. */
    gamepads: readonly (GamepadReading | null)[];
    gestures: GestureOutput;
    virtual: ReadonlyMap<string, VirtualReading>;
}

/** A zeroed snapshot. The sampler starts from this, and so does every test that only cares about keys. */
export function createDeviceSnapshot(): DeviceSnapshot {
    return {
        keys: new Set<string>(),
        mouseButtons: new Set<MouseButton>(),
        pointer: { deltaX: 0, deltaY: 0, wheelX: 0, wheelY: 0, x: 0, y: 0 },
        pointerLocked: false,
        pointerOverCanvas: false,
        gamepads: [],
        gestures: {
            tap: false, doubleTap: false, longPress: false,
            drag: [0, 0], dragActive: false, pinch: 0, pinchScale: 1, pinchActive: false,
        },
        virtual: new Map<string, VirtualReading>(),
    };
}

// ---------------------------------------------------------------------------------------------------
// Carried state
// ---------------------------------------------------------------------------------------------------

export interface ResolveState {
    /** Last frame's state, keyed `Map/Action`. Qualified, so two maps may share an action name. */
    states: Record<string, ActionState>;
    /** Smoothing filters, keyed `Map/Action/bindingId`. One per binding — they are per-source filters. */
    smoothing: Record<string, SmoothingState>;
}

export function createResolveState(): ResolveState {
    return { states: {}, smoothing: {} };
}

/** One action whose phase changed this frame — what `onAction` and the editor's monitor are driven by. */
export interface ActionChange {
    map: string;
    action: string;
    state: ActionState;
}

export interface ResolveResult {
    /** Keyed by BOTH `Map/Action` and the bare `Action`; the bare key goes to the first ENABLED map. */
    states: Map<string, ActionState>;
    changed: ActionChange[];
    next: ResolveState;
}

// ---------------------------------------------------------------------------------------------------
// Reading a source
// ---------------------------------------------------------------------------------------------------

const NO_VECTOR: Vec2 | null = null;

/** A source's reading: a scalar, plus a 2D pair when the source produces one on its own. */
interface Reading {
    value: number;
    vector: Vec2 | null;
}

function gamepadButtonValue(snapshot: DeviceSnapshot, button: string, player: number | undefined): number {
    const index = (GAMEPAD_BUTTONS as readonly string[]).indexOf(button);
    if (index < 0) return 0;
    if (typeof player === 'number') {
        const pad = snapshot.gamepads[player];
        return pad?.connected ? (pad.buttons[index] ?? 0) : 0;
    }
    let best = 0;
    for (const pad of snapshot.gamepads) {
        if (!pad?.connected) continue;
        const value = pad.buttons[index] ?? 0;
        if (value > best) best = value;
    }
    return best;
}

function gamepadAxisValue(snapshot: DeviceSnapshot, axis: string, player: number | undefined): number {
    const index = (GAMEPAD_AXES as readonly string[]).indexOf(axis);
    if (index < 0) return 0;
    if (typeof player === 'number') {
        const pad = snapshot.gamepads[player];
        return pad?.connected ? (pad.axes[index] ?? 0) : 0;
    }
    // "Any pad" takes the one pushing hardest rather than summing: two players on one action should not
    // be able to produce a value of 2 by both pushing forward.
    let best = 0;
    for (const pad of snapshot.gamepads) {
        if (!pad?.connected) continue;
        const value = pad.axes[index] ?? 0;
        if (Math.abs(value) > Math.abs(best)) best = value;
    }
    return best;
}

function readSource(source: BindingSource, snapshot: DeviceSnapshot): Reading {
    switch (source.device) {
        case 'key':
            return { value: snapshot.keys.has(source.code) ? 1 : 0, vector: NO_VECTOR };
        case 'mouse':
            return { value: snapshot.mouseButtons.has(source.button) ? 1 : 0, vector: NO_VECTOR };
        case 'pointer':
            return { value: snapshot.pointer[source.axis], vector: NO_VECTOR };
        case 'gamepad':
            return { value: gamepadButtonValue(snapshot, source.button, source.player), vector: NO_VECTOR };
        case 'gamepadAxis':
            return { value: gamepadAxisValue(snapshot, source.axis, source.player), vector: NO_VECTOR };
        case 'touch': {
            const g = snapshot.gestures;
            switch (source.gesture) {
                case 'tap': return { value: g.tap ? 1 : 0, vector: NO_VECTOR };
                case 'doubleTap': return { value: g.doubleTap ? 1 : 0, vector: NO_VECTOR };
                case 'longPress': return { value: g.longPress ? 1 : 0, vector: NO_VECTOR };
                case 'pinch': return { value: g.pinch, vector: NO_VECTOR };
                case 'drag': {
                    if (source.axis === 'x') return { value: g.drag[0], vector: NO_VECTOR };
                    if (source.axis === 'y') return { value: g.drag[1], vector: NO_VECTOR };
                    const vector: Vec2 = [g.drag[0], g.drag[1]];
                    return { value: Math.hypot(vector[0], vector[1]), vector };
                }
            }
            return { value: 0, vector: NO_VECTOR };
        }
        case 'virtual': {
            const reading = snapshot.virtual.get(source.control);
            if (!reading) return { value: 0, vector: NO_VECTOR };
            // A button has no direction, so it stays a scalar even unparted — otherwise a pressed
            // button would contribute a zero-length vector and read as not pressed at all.
            if (reading.kind === 'button') return { value: reading.pressed ? 1 : 0, vector: NO_VECTOR };
            if (source.axis === 'x') return { value: reading.vector[0], vector: NO_VECTOR };
            if (source.axis === 'y') return { value: reading.vector[1], vector: NO_VECTOR };
            const vector: Vec2 = [reading.vector[0], reading.vector[1]];
            return { value: Math.hypot(vector[0], vector[1]), vector };
        }
    }
}

function modifierSatisfied(modifier: ModifierSource, snapshot: DeviceSnapshot): boolean {
    switch (modifier.device) {
        case 'key': return snapshot.keys.has(modifier.code);
        case 'mouse': return snapshot.mouseButtons.has(modifier.button);
        case 'gamepad':
            return gamepadButtonValue(snapshot, modifier.button, modifier.player) >= DEFAULT_PRESS_POINT;
        case 'state':
            return modifier.flag === 'pointerLock' ? snapshot.pointerLocked : snapshot.pointerOverCanvas;
    }
}

function modifiersSatisfied(binding: InputBinding, snapshot: DeviceSnapshot): boolean {
    if (!binding.modifiers || binding.modifiers.length === 0) return true;
    for (const modifier of binding.modifiers) if (!modifierSatisfied(modifier, snapshot)) return false;
    return true;
}

// ---------------------------------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------------------------------

/**
 * Which plain (unmodified) sources are being claimed by a modified binding right now.
 *
 * Computed once per MAP rather than per action, because the two bindings that collide are usually in
 * different actions — that is the whole shape of the problem: `Shift+S` is Save and `S` is Crouch.
 */
function suppressedSources(map: InputActionMap, snapshot: DeviceSnapshot): Set<string> {
    const suppressed = new Set<string>();
    for (const action of map.actions)
        for (const binding of action.bindings) {
            if (!binding.modifiers || binding.modifiers.length === 0) continue;
            if (modifiersSatisfied(binding, snapshot)) suppressed.add(sourceKey(binding.source));
        }
    return suppressed;
}

/** A per-binding smoothing slot, created on demand and carried into the next frame. */
function smoothingSlot(
    next: ResolveState, prev: ResolveState, key: string, binding: InputBinding,
): SmoothingState | null {
    const needsSmoothing = binding.processors?.some(p => p.kind === 'smooth');
    if (!needsSmoothing) return null;
    let slot = next.smoothing[key];
    if (!slot) {
        const carried = prev.smoothing[key];
        // Copied, never aliased: `prev` belongs to the caller and a filter that wrote through it would
        // make the resolver's output depend on whether anyone else had already read the old state.
        slot = carried ? { x: carried.x, y: carried.y } : { x: 0, y: 0 };
        next.smoothing[key] = slot;
    }
    return slot;
}

interface Contribution {
    value: number;
    device: DeviceKind;
    /** Index within the action's bindings — the tiebreaker, so an equal-magnitude tie is deterministic. */
    order: number;
}

const NONE: Contribution = { value: 0, device: 'key', order: Number.MAX_SAFE_INTEGER };

/** Whichever contribution is louder; an exact tie keeps the one authored first. */
function louder(a: Contribution, b: Contribution): Contribution {
    const magA = Math.abs(a.value);
    const magB = Math.abs(b.value);
    if (magB > magA) return b;
    if (magB === magA && b.order < a.order) return b;
    return a;
}

function resolveAction(
    action: InputAction, mapName: string, snapshot: DeviceSnapshot, suppressed: ReadonlySet<string>,
    prev: ResolveState, next: ResolveState, dt: number,
): ActionState {
    const scratch: Vec2 = [0, 0];

    // Composite accumulators (up/down/left/right and positive/negative), and the best whole-value and
    // per-component contributions they compete with.
    let compositeX = 0;
    let compositeY = 0;
    let compositeDevice: DeviceKind | null = null;
    let bestWhole = NONE;
    let bestX = NONE;
    let bestY = NONE;
    let bestScalar = NONE;
    let wholeVector: Vec2 | null = null;

    for (let i = 0; i < action.bindings.length; i++) {
        const binding = action.bindings[i];
        if (!modifiersSatisfied(binding, snapshot)) continue;
        // A plain binding stands down while a modified one claims the same physical source this frame.
        if ((!binding.modifiers || binding.modifiers.length === 0) && suppressed.has(sourceKey(binding.source)))
            continue;

        const reading = readSource(binding.source, snapshot);
        const slot = smoothingSlot(next, prev, `${mapName}/${action.name}/${binding.id}`, binding);

        if (reading.vector && !binding.part) {
            runProcessors2D(scratch, binding.processors, reading.vector[0], reading.vector[1], slot, dt);
            const candidate: Contribution = {
                value: Math.hypot(scratch[0], scratch[1]), device: binding.source.device, order: i,
            };
            const winner = louder(bestWhole, candidate);
            if (winner === candidate) { bestWhole = candidate; wholeVector = [scratch[0], scratch[1]]; }
            continue;
        }

        const value = runProcessors1D(binding.processors, reading.value, slot, dt);
        const candidate: Contribution = { value, device: binding.source.device, order: i };

        switch (binding.part) {
            case 'up': compositeY += value; if (value !== 0) compositeDevice ??= binding.source.device; break;
            case 'down': compositeY -= value; if (value !== 0) compositeDevice ??= binding.source.device; break;
            case 'right': compositeX += value; if (value !== 0) compositeDevice ??= binding.source.device; break;
            case 'left': compositeX -= value; if (value !== 0) compositeDevice ??= binding.source.device; break;
            case 'positive': bestScalar = louder(bestScalar, candidate); break;
            case 'negative': bestScalar = louder(bestScalar, { ...candidate, value: -value }); break;
            case 'x': bestX = louder(bestX, candidate); break;
            case 'y': bestY = louder(bestY, candidate); break;
            default:
                // Unparted scalar. On a vector action it is the magnitude of a whole-value contribution
                // (a trigger driving "how hard"), which has no direction of its own — so it only counts
                // for button and axis actions.
                bestScalar = louder(bestScalar, action.kind === 'button'
                    ? { ...candidate, value: Math.abs(value) }
                    : candidate);
                break;
        }
    }

    let value = 0;
    let vector: Vec2 = [0, 0];
    let device: DeviceKind | null = null;

    if (action.kind === 'vector') {
        // Per component, the composite (keys) and the direct x/y contribution (a stick) compete on
        // magnitude — so a resting stick never cancels held keys, and a pushed one overrides them.
        const componentX = louder({ value: compositeX, device: compositeDevice ?? 'key', order: -1 }, bestX);
        const componentY = louder({ value: compositeY, device: compositeDevice ?? 'key', order: -1 }, bestY);
        const composed: Vec2 = [componentX.value, componentY.value];
        const composedMagnitude = Math.hypot(composed[0], composed[1]);

        if (wholeVector && Math.abs(bestWhole.value) > composedMagnitude) {
            vector = wholeVector;
            device = bestWhole.device;
        } else if (composedMagnitude > 0) {
            vector = composed;
            device = Math.abs(componentX.value) >= Math.abs(componentY.value)
                ? componentX.device : componentY.device;
        }
        runProcessors2D(scratch, action.processors, vector[0], vector[1], null, dt);
        vector = [unsignZero(scratch[0]), unsignZero(scratch[1])];
        value = Math.hypot(vector[0], vector[1]);
    } else {
        const winner = louder(bestScalar, bestWhole);
        value = unsignZero(runProcessors1D(action.processors, winner.value, null, dt));
        if (value !== 0) device = winner.device;
        if (action.kind === 'button') value = Math.abs(value);
        vector = [value, 0];
    }

    const pressPoint = action.pressPoint ?? DEFAULT_PRESS_POINT;
    const previous = prev.states[`${mapName}/${action.name}`];
    const wasPressed = previous?.pressed === true;
    const pressed = Math.abs(value) >= pressPoint;
    const heldSeconds = pressed ? (previous?.heldSeconds ?? 0) + Math.max(0, dt) : 0;

    return {
        kind: action.kind,
        value,
        vector,
        pressed,
        started: pressed && !wasPressed,
        released: !pressed && wasPressed,
        phase: phaseOf(action, pressed, wasPressed, heldSeconds),
        heldSeconds,
        device,
    };
}

function phaseOf(
    action: InputAction, pressed: boolean, wasPressed: boolean, heldSeconds: number,
): ActionPhase {
    // A release is `canceled`, whether it came from the player letting go or from the map being turned
    // off underneath them. Both mean the same thing to a handler: stop doing the thing.
    if (!pressed) return wasPressed ? 'canceled' : 'idle';
    const hold = action.holdSeconds ?? 0;
    return heldSeconds >= hold ? 'performed' : 'started';
}

/**
 * The state an action of a DISABLED map reads as: idle, except for the single frame after it was held,
 * which reports the release so a handler can undo whatever the hold started.
 */
function disabledState(kind: ActionKind, previous: ActionState | undefined): ActionState {
    const state = idleState(kind);
    if (previous?.pressed) { state.released = true; state.phase = 'canceled'; }
    return state;
}

/** Whether an action needs to be reported to `onAction` and the editor's monitor this frame. */
function phaseChanged(previous: ActionState | undefined, current: ActionState): boolean {
    if (current.started || current.released) return true;
    return (previous?.phase ?? 'idle') !== current.phase;
}

/**
 * Resolve one frame.
 *
 * `maps` is the full list in priority order — the project's own maps followed by any host overlays.
 * `enabled` names the ones that are live right now; a map that is absent from it still gets evaluated,
 * because an action that was held when its map went away has one last thing to say.
 */
export function resolveFrame(
    maps: readonly InputActionMap[],
    enabled: ReadonlySet<string>,
    snapshot: DeviceSnapshot,
    prev: ResolveState,
    dt: number,
): ResolveResult {
    const next: ResolveState = { states: {}, smoothing: {} };
    const states = new Map<string, ActionState>();
    const changed: ActionChange[] = [];

    for (const map of maps) {
        const live = enabled.has(map.name);
        const suppressed = live ? suppressedSources(map, snapshot) : EMPTY_SET;

        for (const action of map.actions) {
            const qualified = `${map.name}/${action.name}`;
            const previous = prev.states[qualified];
            const state = live
                ? resolveAction(action, map.name, snapshot, suppressed, prev, next, dt)
                : disabledState(action.kind, previous);

            next.states[qualified] = state;
            states.set(qualified, state);
            if (phaseChanged(previous, state)) changed.push({ map: map.name, action: action.name, state });
        }
    }

    // Bare names go to the first ENABLED map that defines them, so a UI map listed ahead of Gameplay can
    // shadow an action by name. Disabled maps fill only the gaps, which is what lets the one-frame
    // release of a map that just went away still be visible to a script polling the bare name.
    for (const map of maps) {
        if (!enabled.has(map.name)) continue;
        for (const action of map.actions)
            if (!states.has(action.name)) states.set(action.name, states.get(`${map.name}/${action.name}`)!);
    }
    for (const map of maps)
        for (const action of map.actions)
            if (!states.has(action.name)) states.set(action.name, states.get(`${map.name}/${action.name}`)!);

    return { states, changed, next };
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

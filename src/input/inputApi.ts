/**
 * The input facade a user script reaches for: `import { Input } from 'cleo'`.
 *
 * Same shape and same reason as `Game` in core/game.ts — a script author should write `Input.pressed(...)`,
 * not `InputSystem.instance.pressed(...)`, and should never have to think about a singleton.
 *
 * Everything here is addressed by ACTION NAME rather than by key code, which is the point of the whole
 * subsystem: `Input.vector('Move')` is the same line of script whether the player is on WASD, a
 * thumbstick or an on-screen joystick, and it keeps working after they rebind it. Actions are authored
 * in the editor's Input panel; the names below come from the shipped default map.
 *
 * A name may be bare (`'Jump'` — the first enabled map that defines it wins) or qualified
 * (`'Gameplay/Jump'`). An unknown name reads as idle rather than throwing.
 */

import { InputSystem } from "./inputSystem";
import type { ActionListener, Unsubscribe } from "./inputSystem";
import type { ActionState } from "./actionMap";
import type { DeviceKind } from "./inputSources";

export const Input = {
    /**
     * A 2D action's value, `[x, y]` with Y positive UP. Composite key bindings and analog sticks both
     * arrive here already normalized and deadzoned, so a script never does that arithmetic itself.
     */
    vector(action: string): [number, number] {
        return InputSystem.instance.vector(action);
    },

    /** A 1D action's value: -1..1 for an axis, 0..1 for a button (analog on a trigger). */
    value(action: string): number {
        return InputSystem.instance.value(action);
    },

    /** True every frame the action is held — poll this in `onUpdate` for continuous movement. */
    pressed(action: string): boolean {
        return InputSystem.instance.pressed(action);
    },

    /**
     * True on EXACTLY the frame the press began, and never again while it is held. This is what
     * `registerKeyPress` used to do, minus the single global callback slot and the unregister.
     */
    started(action: string): boolean {
        return InputSystem.instance.started(action);
    },

    /** True on exactly the frame the press ended — including when its map was disabled mid-hold. */
    released(action: string): boolean {
        return InputSystem.instance.released(action);
    },

    /** Seconds the action has been held, or 0. Reset on release. */
    heldSeconds(action: string): number {
        return InputSystem.instance.heldSeconds(action);
    },

    /** `idle` | `started` | `performed` | `canceled`. The same value a node's `onAction` receives. */
    phase(action: string): ActionState['phase'] {
        return InputSystem.instance.state(action).phase;
    },

    /** Everything about the action this frame. Read-only — mutating it does not change anything. */
    state(action: string): Readonly<ActionState> {
        return InputSystem.instance.state(action);
    },

    /**
     * Which device produced the value this frame, or null while idle. For swapping on-screen prompts
     * between key names and pad glyphs without asking the player what they are holding.
     */
    device(action: string): DeviceKind | null {
        return InputSystem.instance.device(action);
    },

    /**
     * Run `listener` whenever the action changes phase. `action` may be a bare name, `Map/Action`, or
     * `'*'` for every action. Returns a function that cancels the subscription.
     *
     * A node script usually wants the `onAction` handler instead — it is unsubscribed automatically when
     * the node despawns. This is for code that outlives a node.
     */
    onAction(action: string, listener: ActionListener): Unsubscribe {
        return InputSystem.instance.onAction(action, listener);
    },

    /** Turn an action map on. Maps are the contexts a game switches between (Gameplay, UI, ...). */
    enableMap(name: string): void {
        InputSystem.instance.enableMap(name);
    },

    /**
     * Turn an action map off. Anything held in it gets one frame of `released`/`canceled` first, so
     * opening a menu while the player is holding W does not leave the character walking.
     */
    disableMap(name: string): void {
        InputSystem.instance.disableMap(name);
    },

    isMapEnabled(name: string): boolean {
        return InputSystem.instance.isMapEnabled(name);
    },

    /** Every map that is live right now, in priority order. */
    get enabledMaps(): string[] {
        return InputSystem.instance.enabledMaps;
    },

    /**
     * Hide the cursor and switch mouse bindings to relative motion. Browsers only grant this inside a
     * user gesture (a click or a keypress in the same event), so call it from an action handler.
     */
    captureMouse(): void {
        InputSystem.instance.requestPointerLock();
    },

    /** Give the cursor back. */
    releaseMouse(): void {
        InputSystem.instance.releasePointerLock();
    },

    get isMouseCaptured(): boolean {
        return InputSystem.instance.isPointerLocked;
    },

    /** The authored input map — action names, bindings, on-screen controls. Read-only at runtime. */
    get map() {
        return InputSystem.instance.map;
    },
} as const;

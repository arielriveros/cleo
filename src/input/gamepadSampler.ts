/**
 * The Gamepad API half of the input system: connected pads read into the resolver's snapshot.
 *
 * Gamepads are POLL-ONLY. `navigator.getGamepads()` hands back a fresh set of immutable snapshots each
 * time it is called, and the objects from a previous call never update — so this must run once per
 * frame, from `beginFrame`, and there is no event to subscribe to instead. (`gamepadconnected` exists,
 * but only tells you a pad appeared; it carries no state.)
 *
 * Two things this file exists to get right:
 *
 *   * STABLE PLAYER SLOTS. `gamepad.index` is the browser's slot and it moves: unplug pad 0 in a
 *     two-player game and the other pad can be re-indexed. A binding that named "player 2" would
 *     silently start driving player 1. So slots are assigned here, on first sight of a pad's `id`, and
 *     kept until that pad disconnects.
 *   * A DISCONNECT ZEROES, NEVER LATCHES. A pad unplugged mid-hold must not leave an axis stuck at full
 *     deflection, which is what reusing the last reading would do.
 */

import { GAMEPAD_AXES, MAX_GAMEPAD_PLAYERS } from "./inputSources";
import type { GamepadReading } from "./resolveActions";

/** Indices into `gamepad.axes` that the browser reports DOWN-positive and everything else reads Y-up. */
const FLIPPED_AXES = [1, 3];

export class GamepadSampler {
    /** Player slot -> the `gamepad.index` occupying it. -1 is an empty slot. */
    private _slots: number[] = new Array(MAX_GAMEPAD_PLAYERS).fill(-1);
    private _readings: (GamepadReading | null)[] = new Array(MAX_GAMEPAD_PLAYERS).fill(null);
    /** Whether any pad has ever been seen — the panel shows a "press a button" hint until one has. */
    private _seenAny = false;

    /**
     * Re-read every connected pad. Returns the per-slot readings, which the caller puts straight into
     * the {@link DeviceSnapshot}.
     */
    public poll(): readonly (GamepadReading | null)[] {
        const pads = GamepadSampler._pads();

        // Free slots whose pad has gone. Done before assignment so a reconnect can reuse its old slot.
        for (let slot = 0; slot < this._slots.length; slot++) {
            const index = this._slots[slot];
            if (index < 0) continue;
            if (!pads[index]) { this._slots[slot] = -1; this._readings[slot] = null; }
        }

        for (const pad of pads) {
            if (!pad) continue;
            this._seenAny = true;
            let slot = this._slots.indexOf(pad.index);
            if (slot < 0) {
                slot = this._slots.indexOf(-1);
                // More pads than slots: the extra ones are simply not readable. Silently ignoring them
                // beats renumbering everyone, which would move a live player's bindings mid-game.
                if (slot < 0) continue;
                this._slots[slot] = pad.index;
            }
            this._readings[slot] = GamepadSampler._read(pad);
        }

        return this._readings;
    }

    /** Forget every pad. Used on shutdown and when the engine hands the input system a new canvas. */
    public reset(): void {
        this._slots.fill(-1);
        this._readings.fill(null);
    }

    /** Whether a pad has been seen at all this session. Pads stay invisible until a user gesture. */
    public get hasSeenGamepad(): boolean { return this._seenAny; }

    /** Which player slot a `gamepad.index` currently occupies, or -1. For the editor's pad readout. */
    public slotOf(index: number): number { return this._slots.indexOf(index); }

    private static _pads(): readonly (Gamepad | null)[] {
        // `getGamepads` is missing in a non-browser host and throws in a few sandboxed ones.
        try {
            const nav = typeof navigator !== 'undefined' ? navigator : undefined;
            return nav?.getGamepads ? nav.getGamepads() : [];
        } catch {
            return [];
        }
    }

    private static _read(pad: Gamepad): GamepadReading {
        const buttons: number[] = [];
        for (const button of pad.buttons) {
            // `value` is the analog reading and `pressed` the digital one; a d-pad on some pads reports
            // only the latter, so neither alone covers every device.
            buttons.push(button.pressed && button.value === 0 ? 1 : button.value);
        }

        const axes: number[] = [];
        for (let i = 0; i < pad.axes.length; i++) {
            const value = pad.axes[i] ?? 0;
            // Flipped here, once, so `leftStickY` means the same thing as every other Y in the system.
            axes.push(FLIPPED_AXES.indexOf(i) >= 0 ? -value : value);
        }
        // Pad out to the standard axis count so a binding never reads `undefined` off a short array.
        while (axes.length < GAMEPAD_AXES.length) axes.push(0);

        return { connected: pad.connected !== false, buttons, axes };
    }
}

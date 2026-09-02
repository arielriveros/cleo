/**
 * The input system's front door: owns the action map, the two samplers and the per-frame resolve, and
 * answers everything a script, the editor or the engine loop asks about input.
 *
 * A singleton like `InputManager` was, and for the same reason — a game has one keyboard — but with the
 * five jobs that used to be fused inside it now delegated: DOM binding to `DeviceSampler`, pad polling
 * to `GamepadSampler`, and all the actual semantics to the pure `resolveFrame`. What is left here is
 * only wiring and the two things that genuinely need to be process-wide: which maps are live, and who
 * is listening.
 *
 * Maps come from two places and the split matters:
 *   * `setMap` installs the PROJECT's map. It is serialized and shipped with the game.
 *   * `setOverlayMaps` installs HOST maps — the editor's viewport camera controls. They are never
 *     serialized, which is structural rather than a convention: they live in a different field, so
 *     there is no path by which an editor binding could end up in a published build.
 */

import {
    DEFAULT_INPUT_MAP, IDLE_STATE, cloneInputMap, idleState, parseInputMap,
} from "./actionMap";
import type { ActionState, InputActionMap, InputMap } from "./actionMap";
import { GAMEPAD_AXES, GAMEPAD_BUTTONS } from "./inputSources";
import type { BindingSource, DeviceKind } from "./inputSources";
import { DeviceSampler } from "./deviceSampler";
import { GamepadSampler } from "./gamepadSampler";
import { createResolveState, resolveFrame } from "./resolveActions";
// eventBus is a dependency-free leaf, so importing it here closes no cycle.
import { authoring, engineEventBus } from "../core/eventBus";
import type { ActionChange, DeviceSnapshot, ResolveState } from "./resolveActions";
import type { VirtualReading } from "./virtualControls";

/** Called when an action changes phase. Returns nothing; throwing is the caller's problem to guard. */
export type ActionListener = (state: ActionState, action: string, map: string) => void;

/** Cancels a subscription. Returned by `onAction` so a caller never has to keep the function around. */
export type Unsubscribe = () => void;

/** What a rebind capture accepts. Return false to keep listening — how a device filter is expressed. */
export type RebindFilter = (source: BindingSource) => boolean;

export class InputSystem {
    private static _instance: InputSystem | null = null;

    private readonly _device = new DeviceSampler();
    private readonly _gamepads = new GamepadSampler();

    private _map: InputMap = cloneInputMap(DEFAULT_INPUT_MAP);
    private _overlays: InputActionMap[] = [];
    private _enabled = new Set<string>();
    private _resolveState: ResolveState = createResolveState();
    private _states = new Map<string, ActionState>();
    private _changed: ActionChange[] = [];

    /** Subscribers keyed by bare or qualified action name, plus `*` for "every action". */
    private readonly _listeners = new Map<string, Set<ActionListener>>();
    /** Codes any enabled map binds, rebuilt whenever the maps change. Feeds the preventDefault policy. */
    private _boundCodes = new Set<string>();

    private _rebindFilter: RebindFilter | null = null;
    private _rebindResolve: ((source: BindingSource | null) => void) | null = null;

    private constructor() {
        this._device.isBoundCode = (code: string) => this._boundCodes.has(code);
        this._seedEnabled();
    }

    public static get instance(): InputSystem {
        if (!InputSystem._instance) InputSystem._instance = new InputSystem();
        return InputSystem._instance;
    }

    /** Bind to the render canvas. Idempotent — a second call rebinds rather than doubling listeners. */
    public static initialize(canvas: HTMLElement): void {
        InputSystem.instance._device.initialize(canvas);
    }

    // ----- The map ------------------------------------------------------------------------------

    /**
     * Install the project's input map, from anything: a parsed map, a raw config blob, or undefined for
     * the shipped defaults. Runs through `parseInputMap`, so a hand-edited or stale record repairs
     * rather than throwing.
     *
     * Held state is dropped, because the bindings that produced it may no longer exist.
     */
    public setMap(raw: unknown): void {
        this._map = parseInputMap(raw);
        // A project load starts from the authored enable state, not from whatever the last project's
        // play session left behind.
        this._known.clear();
        this._seedEnabled();
        this.resetState();
        engineEventBus.emit('INPUT_MAP_CHANGED');
    }

    public get map(): InputMap { return this._map; }

    /**
     * Install host-owned maps that sit alongside the project's — the editor's camera controls. Replaces
     * the whole overlay list; pass `[]` to remove them.
     */
    public setOverlayMaps(maps: readonly InputActionMap[]): void {
        this._overlays = maps.slice();
        this._seedEnabled();
    }

    /** Project maps first, then host overlays. This order is the name-shadowing priority. */
    private get _allMaps(): InputActionMap[] {
        return [...this._map.maps, ...this._overlays];
    }

    /**
     * Rebuild the live set. A map already known keeps whatever `enableMap`/`disableMap` last said; a
     * newly appearing one starts from its authored `enabled`.
     *
     * That split is what lets the editor install its camera overlay without resurrecting a Gameplay map
     * the play loop had just disabled — and, conversely, lets a project load (which clears `_known`)
     * start from a clean authored state rather than inheriting the previous project's toggles.
     */
    private _seedEnabled(): void {
        const next = new Set<string>();
        for (const map of this._allMaps) {
            const live = this._known.has(map.name) ? this._enabled.has(map.name) : map.enabled;
            if (live) next.add(map.name);
            this._known.add(map.name);
        }
        this._enabled = next;
        this._rebuildBoundCodes();
    }

    /** Map names whose live state is a runtime decision rather than the authored default. */
    private readonly _known = new Set<string>();

    public enableMap(name: string): void {
        this._enabled.add(name);
        this._rebuildBoundCodes();
    }

    public disableMap(name: string): void {
        this._enabled.delete(name);
        this._rebuildBoundCodes();
    }

    public isMapEnabled(name: string): boolean { return this._enabled.has(name); }

    /** Every map name currently live, in priority order. */
    public get enabledMaps(): string[] {
        return this._allMaps.filter(m => this._enabled.has(m.name)).map(m => m.name);
    }

    private _rebuildBoundCodes(): void {
        this._boundCodes.clear();
        for (const map of this._allMaps) {
            if (!this._enabled.has(map.name)) continue;
            for (const action of map.actions)
                for (const binding of action.bindings) {
                    if (binding.source.device === 'key') this._boundCodes.add(binding.source.code);
                    for (const modifier of binding.modifiers ?? [])
                        if (modifier.device === 'key') this._boundCodes.add(modifier.code);
                }
        }
    }

    // ----- The frame ----------------------------------------------------------------------------

    /**
     * Poll the devices and resolve every action. Runs FIRST in the frame — nothing downstream may read
     * a half-built action table, and physics is downstream.
     *
     * Runs even while the engine is paused: a paused game still has to see the action that unpauses it,
     * and the editor's camera map is live in edit mode. What pausing gates is DELIVERY to scripts,
     * which `Scene.update` already handles.
     */
    public beginFrame(dt: number): void {
        const snapshot: DeviceSnapshot = { ...this._device.sample(dt), gamepads: this._gamepads.poll() };

        if (this._rebindResolve) { this._captureRebind(snapshot); return; }

        const result = resolveFrame(this._allMaps, this._enabled, snapshot, this._resolveState, dt);
        this._states = result.states;
        this._changed = result.changed;
        this._resolveState = result.next;

        for (const change of this._changed) this._dispatch(change);
        // Gated exactly as the property-level SCENE_CHANGED kinds are: a published game must not pay an
        // emit per action per frame for a monitor only the editor ever opens.
        if (authoring.enabled)
            for (const change of this._changed)
                engineEventBus.emit('INPUT_ACTION', { map: change.map, action: change.action, state: change.state });
    }

    /** Clear the per-frame accumulators. Runs LAST in the frame — see `DeviceSampler.endFrame`. */
    public endFrame(): void {
        this._device.endFrame();
    }

    /** Every action that changed phase this frame. What `Scene.update` drains into node `onAction`s. */
    public get changedThisFrame(): readonly ActionChange[] { return this._changed; }

    private _dispatch(change: ActionChange): void {
        this._notify(change.action, change);
        this._notify(`${change.map}/${change.action}`, change);
        this._notify('*', change);
    }

    private _notify(key: string, change: ActionChange): void {
        const set = this._listeners.get(key);
        if (!set || set.size === 0) return;
        // Iterate a copy so a listener that unsubscribes during dispatch cannot disturb it.
        for (const listener of [...set]) listener(change.state, change.action, change.map);
    }

    // ----- Reading ------------------------------------------------------------------------------

    /**
     * The full state of an action, by bare name (first enabled map wins) or `Map/Action`. An unknown
     * name reads as a shared frozen idle state rather than throwing — a typo must not crash a game.
     */
    public state(action: string): Readonly<ActionState> {
        return this._states.get(action) ?? IDLE_STATE;
    }

    public value(action: string): number { return this.state(action).value; }
    /** A copy, so a caller writing into it cannot corrupt next frame's comparison. */
    public vector(action: string): [number, number] {
        const v = this.state(action).vector;
        return [v[0], v[1]];
    }
    public pressed(action: string): boolean { return this.state(action).pressed; }
    /** True on exactly the frame the press began — the replacement for `registerKeyPress`. */
    public started(action: string): boolean { return this.state(action).started; }
    /** True on exactly the frame the press ended, including when its map was disabled underneath it. */
    public released(action: string): boolean { return this.state(action).released; }
    public heldSeconds(action: string): number { return this.state(action).heldSeconds; }
    /** Which device produced the value, so a HUD can swap key prompts for pad glyphs. */
    public device(action: string): DeviceKind | null { return this.state(action).device; }

    /**
     * Whether a physical key is down RIGHT NOW, bypassing the action map entirely.
     *
     * The low-level escape hatch, and deliberately not what a script should reach for — a key code in
     * game logic is exactly what actions exist to replace, and it cannot be rebound, cannot come from a
     * pad and cannot come from a touch screen. It is here for authoring surfaces that store a raw code
     * of their own (the Animator's legacy key triggers) and for the editor's rebind UI.
     *
     * Unlike the system this replaces, ANY code works — there is no whitelist to fall outside of.
     */
    public isKeyDown(code: string): boolean {
        return this._device.keys.has(code);
    }

    /** Every action state this frame, keyed by both bare and qualified name. For the editor's monitor. */
    public get states(): ReadonlyMap<string, ActionState> { return this._states; }

    /**
     * Subscribe to an action's phase changes. `action` may be a bare name, a `Map/Action`, or `'*'` for
     * every action. Returns an unsubscribe.
     *
     * Unlike the single `onPress` slot per key this replaces, any number of listeners may share an
     * action, and nothing has to be unregistered by name.
     */
    public onAction(action: string, listener: ActionListener): Unsubscribe {
        let set = this._listeners.get(action);
        if (!set) { set = new Set(); this._listeners.set(action, set); }
        set.add(listener);
        return () => { set!.delete(listener); };
    }

    // ----- Rebinding ----------------------------------------------------------------------------

    /**
     * Listen for the next input and report it as a raw {@link BindingSource}, for the editor's "press a
     * key" rebind row. Resolves with null if `cancel` is called first.
     *
     * Deliberately bypasses the action map: you cannot capture a binding through a system that requires
     * the binding to already exist. While a capture is in flight no action resolves at all, so a key
     * pressed to rebind Jump does not also make the character jump.
     */
    public beginRebind(filter?: RebindFilter): Promise<BindingSource | null> {
        this.cancelRebind();
        this._rebindFilter = filter ?? null;
        return new Promise<BindingSource | null>(resolve => { this._rebindResolve = resolve; });
    }

    public cancelRebind(): void {
        const resolve = this._rebindResolve;
        this._rebindResolve = null;
        this._rebindFilter = null;
        resolve?.(null);
    }

    public get isRebinding(): boolean { return this._rebindResolve !== null; }

    private _captureRebind(snapshot: DeviceSnapshot): void {
        const resolve = this._rebindResolve!;
        for (const source of InputSystem._candidateSources(snapshot)) {
            if (this._rebindFilter && !this._rebindFilter(source)) continue;
            this._rebindResolve = null;
            this._rebindFilter = null;
            resolve(source);
            return;
        }
    }

    /** Everything the snapshot says is active right now, as bindable sources. Order is priority. */
    private static _candidateSources(snapshot: DeviceSnapshot): BindingSource[] {
        const out: BindingSource[] = [];
        for (const code of snapshot.keys) out.push({ device: 'key', code });
        for (const button of snapshot.mouseButtons) out.push({ device: 'mouse', button });

        for (let player = 0; player < snapshot.gamepads.length; player++) {
            const pad = snapshot.gamepads[player];
            if (!pad?.connected) continue;
            for (let i = 0; i < pad.buttons.length; i++) {
                if ((pad.buttons[i] ?? 0) < 0.5) continue;
                const button = GAMEPAD_BUTTONS[i];
                if (button) out.push({ device: 'gamepad', button, player });
            }
            for (let i = 0; i < pad.axes.length; i++) {
                // A high threshold on purpose: a worn stick rests off-centre, and capturing that as the
                // binding is the most annoying way for a rebind prompt to fail.
                if (Math.abs(pad.axes[i] ?? 0) < 0.7) continue;
                const axis = GAMEPAD_AXES[i];
                if (axis) out.push({ device: 'gamepadAxis', axis, player });
            }
        }

        // Wheel and pointer motion last: they fire constantly, and would otherwise win every capture.
        if (Math.abs(snapshot.pointer.wheelY) > 0) out.push({ device: 'pointer', axis: 'wheelY' });
        return out;
    }

    // ----- Pointer lock and policy --------------------------------------------------------------

    /** Whether a left click on the canvas requests pointer lock. Off in the editor, on in play mode. */
    public get pointerLockOnClick(): boolean { return this._device.pointerLockOnClick; }
    public set pointerLockOnClick(value: boolean) { this._device.pointerLockOnClick = value; }

    /**
     * Whether to swallow the browser's default action for input the game actually binds. Narrower than
     * the flag it replaces: only bound key codes, and never while Ctrl or Meta is held.
     */
    public get preventDefault(): boolean { return this._device.preventDefault; }
    public set preventDefault(value: boolean) { this._device.preventDefault = value; }

    public requestPointerLock(): void { this._device.requestPointerLock(); }
    public releasePointerLock(): void { this._device.releasePointerLock(); }
    public get isPointerLocked(): boolean { return this._device.isPointerLocked; }

    /** Lay the on-screen controls out for a viewport of this size. Called on resize and on map change. */
    public layoutVirtualControls(width: number, height: number): void {
        this._device.setVirtualControls(this._map.virtualControls, width, height);
        this._device.setTouchConfig(this._map.touch);
    }

    /** Where the on-screen controls sit right now, for the overlay that draws them. */
    public get virtualLayouts() { return this._device.virtualLayouts; }

    /**
     * What one on-screen control reads this frame, or null for an id nothing knows about.
     *
     * The overlay that DRAWS the controls reads this rather than tracking its own pointer events: the
     * engine is what actually received the touch, and a second tracker would disagree with it the
     * moment a thumb slid outside the circle it had captured.
     */
    public virtualReading(id: string): VirtualReading | null {
        return this._device.snapshot.virtual.get(id) ?? null;
    }

    /** Whether a pad has been seen this session. The editor's panel shows a hint until one has. */
    public get hasSeenGamepad(): boolean { return this._gamepads.hasSeenGamepad; }

    // ----- Lifecycle ----------------------------------------------------------------------------

    /**
     * Drop every held key, in-flight gesture and action state, keeping the map and the listeners.
     *
     * The distinction from the old `clear()` matters: that also wiped the callbacks and the capture
     * policy. A `Game.loadScene` calls this between scenes, and un-binding the game there would leave
     * the next scene dead.
     */
    public resetState(): void {
        this._device.resetState();
        this._gamepads.reset();
        this._resolveState = createResolveState();
        this._states = new Map();
        this._changed = [];
    }

    /** Detach every listener. The engine calls this on shutdown. */
    public dispose(): void {
        this.cancelRebind();
        this._device.dispose();
        this._listeners.clear();
        this.resetState();
    }

    /** A zeroed state of the given kind, for a caller that needs one to compare against. */
    public static idle(kind: ActionState['kind'] = 'button'): ActionState { return idleState(kind); }
}

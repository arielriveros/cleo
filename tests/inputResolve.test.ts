import { describe, it, expect } from 'vitest';
import { createDeviceSnapshot, createResolveState, resolveFrame } from '../src/input/resolveActions';
import type { DeviceSnapshot, ResolveState } from '../src/input/resolveActions';
import { DEFAULT_INPUT_MAP, parseInputMap } from '../src/input/actionMap';
import type { ActionState, InputActionMap, MouseButton } from '../src/cleo';

// resolveFrame is where a wrong answer is silent: a jump that fires twice, a key that stays held after
// a menu opens, a stick that cancels the keyboard. None of those throw, and none are visible in a
// screenshot. They are visible in a sequence of frames, which is exactly what this file writes.
//
// Every test drives the resolver the way the engine does — one frame at a time, feeding last frame's
// state back in — because the invariants that matter (edges last one frame; a disabled map cancels its
// helds) only exist ACROSS frames.

const FRAME = 1 / 60;

/** Build a snapshot with only the fields a case cares about. */
function snapshot(overrides: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
    return { ...createDeviceSnapshot(), ...overrides };
}

function keys(...codes: string[]): DeviceSnapshot {
    return snapshot({ keys: new Set(codes) });
}

function pad(axes: number[] = [], buttons: number[] = []): DeviceSnapshot {
    return snapshot({ gamepads: [{ connected: true, buttons, axes }] });
}

/** Drives one frame and hands back both the states and the state to feed the next frame. */
function step(
    maps: readonly InputActionMap[], enabled: string[], snap: DeviceSnapshot, prev: ResolveState, dt = FRAME,
) {
    return resolveFrame(maps, new Set(enabled), snap, prev, dt);
}

const MOVE_MAP: InputActionMap = {
    name: 'Gameplay',
    enabled: true,
    actions: [
        {
            name: 'Move',
            kind: 'vector',
            bindings: [
                { id: 'w', source: { device: 'key', code: 'KeyW' }, part: 'up' },
                { id: 's', source: { device: 'key', code: 'KeyS' }, part: 'down' },
                { id: 'a', source: { device: 'key', code: 'KeyA' }, part: 'left' },
                { id: 'd', source: { device: 'key', code: 'KeyD' }, part: 'right' },
                { id: 'padX', source: { device: 'gamepadAxis', axis: 'leftStickX' }, part: 'x' },
                { id: 'padY', source: { device: 'gamepadAxis', axis: 'leftStickY' }, part: 'y' },
            ],
            processors: [{ kind: 'normalize' }],
        },
        {
            name: 'Jump',
            kind: 'button',
            bindings: [
                { id: 'space', source: { device: 'key', code: 'Space' } },
                { id: 'padA', source: { device: 'gamepad', button: 'a' } },
            ],
        },
    ],
};

describe('composites', () => {
    it('reads the four cardinal keys as a unit vector', () => {
        const s = createResolveState();
        expect(step([MOVE_MAP], ['Gameplay'], keys('KeyW'), s).states.get('Move')!.vector).toEqual([0, 1]);
        expect(step([MOVE_MAP], ['Gameplay'], keys('KeyS'), s).states.get('Move')!.vector).toEqual([0, -1]);
        expect(step([MOVE_MAP], ['Gameplay'], keys('KeyA'), s).states.get('Move')!.vector).toEqual([-1, 0]);
        expect(step([MOVE_MAP], ['Gameplay'], keys('KeyD'), s).states.get('Move')!.vector).toEqual([1, 0]);
    });

    it('normalizes a diagonal so it is not faster than a cardinal', () => {
        const move = step([MOVE_MAP], ['Gameplay'], keys('KeyW', 'KeyA'), createResolveState())
            .states.get('Move')!;
        expect(move.vector[0]).toBeCloseTo(-Math.SQRT1_2, 10);
        expect(move.vector[1]).toBeCloseTo(Math.SQRT1_2, 10);
        expect(move.value).toBeCloseTo(1, 10);
    });

    it('cancels opposing keys to exactly zero, with no NaN', () => {
        const move = step([MOVE_MAP], ['Gameplay'], keys('KeyW', 'KeyS'), createResolveState())
            .states.get('Move')!;
        expect(move.vector).toEqual([0, 0]);
        expect(move.value).toBe(0);
    });

    it('lets a resting stick leave held keys alone', () => {
        // Writing the x/y components directly instead of competing on magnitude is the obvious
        // implementation and the wrong one: a stick at rest would zero the keyboard every frame.
        const resting = step([MOVE_MAP], ['Gameplay'], snapshot({
            keys: new Set(['KeyW']), gamepads: [{ connected: true, buttons: [], axes: [0, 0] }],
        }), createResolveState()).states.get('Move')!;
        expect(resting.vector).toEqual([0, 1]);
    });

    it('lets a stick pushed harder than the keys override them, per component', () => {
        const move = step([MOVE_MAP], ['Gameplay'], snapshot({
            keys: new Set(['KeyD']),                         // x = +1, y = 0
            gamepads: [{ connected: true, buttons: [], axes: [0.5, -0.8] }],
        }), createResolveState()).states.get('Move')!;
        // X: the key is louder than a half-pushed stick, so the key holds it.
        expect(move.vector[0]).toBeGreaterThan(0);
        // Y: no key contributes at all, so the stick owns the component outright.
        expect(move.vector[1]).toBeLessThan(0);
    });

    it('gives an exact tie between keys and stick to the keys', () => {
        // A full stick against a held key is a genuine tie on magnitude, and the resolver has to answer
        // it the same way every frame or the character stutters. Ties go to the composite.
        const move = step([MOVE_MAP], ['Gameplay'], snapshot({
            keys: new Set(['KeyW']), gamepads: [{ connected: true, buttons: [], axes: [0, -1] }],
        }), createResolveState()).states.get('Move')!;
        expect(move.vector).toEqual([0, 1]);
    });

    it('preserves an analog stick partial deflection instead of stretching it to full tilt', () => {
        // `normalize` clamps; it must not amplify. This is the regression that turns a gentle push into
        // a sprint when a keyboard controller is ported to a pad.
        const move = step([MOVE_MAP], ['Gameplay'], pad([0.3, 0]), createResolveState()).states.get('Move')!;
        expect(move.vector[0]).toBeCloseTo(0.3, 10);
    });
});

describe('press edges', () => {
    const HOLD_MAP: InputActionMap = {
        name: 'M', enabled: true,
        actions: [{
            name: 'Fire', kind: 'button', holdSeconds: 0.2,
            bindings: [{ id: 'f', source: { device: 'key', code: 'KeyF' } }],
        }],
    };

    it('fires started on exactly one frame, however long the key is held', () => {
        // This is the whole contract registerKeyPress used to provide, and the reason a script no
        // longer needs an unregister in onDespawn.
        let state = createResolveState();
        let startedCount = 0;
        for (let i = 0; i < 100; i++) {
            const result = step([MOVE_MAP], ['Gameplay'], keys('Space'), state);
            if (result.states.get('Jump')!.started) startedCount++;
            state = result.next;
        }
        expect(startedCount).toBe(1);
    });

    it('fires released on exactly one frame, then idles', () => {
        let state = createResolveState();
        state = step([MOVE_MAP], ['Gameplay'], keys('Space'), state).next;
        const first = step([MOVE_MAP], ['Gameplay'], snapshot(), state);
        expect(first.states.get('Jump')!.released).toBe(true);
        expect(first.states.get('Jump')!.phase).toBe('canceled');
        const second = step([MOVE_MAP], ['Gameplay'], snapshot(), first.next);
        expect(second.states.get('Jump')!.released).toBe(false);
        expect(second.states.get('Jump')!.phase).toBe('idle');
    });

    it('reaches performed immediately when no hold is authored', () => {
        const jump = step([MOVE_MAP], ['Gameplay'], keys('Space'), createResolveState()).states.get('Jump')!;
        expect(jump.started).toBe(true);
        expect(jump.phase).toBe('performed');
    });

    it('delays performed until the authored hold has elapsed', () => {
        let state = createResolveState();
        const phases: string[] = [];
        for (let i = 0; i < 20; i++) {
            const result = step([HOLD_MAP], ['M'], keys('KeyF'), state);
            phases.push(result.states.get('Fire')!.phase);
            state = result.next;
        }
        expect(phases[0]).toBe('started');
        expect(phases.indexOf('performed')).toBeGreaterThan(0);
        // 0.2s at 60fps is 12 frames; the crossing must be at 12, not 11 or 13.
        expect(phases.indexOf('performed')).toBe(12);
    });

    it('accumulates heldSeconds while pressed and zeroes it on release', () => {
        let state = createResolveState();
        for (let i = 0; i < 6; i++) state = step([MOVE_MAP], ['Gameplay'], keys('Space'), state).next;
        const held = step([MOVE_MAP], ['Gameplay'], keys('Space'), state);
        expect(held.states.get('Jump')!.heldSeconds).toBeCloseTo(7 * FRAME, 10);
        expect(step([MOVE_MAP], ['Gameplay'], snapshot(), held.next).states.get('Jump')!.heldSeconds).toBe(0);
    });

    it('reads an analog trigger through the press point', () => {
        const TRIGGER: InputActionMap = {
            name: 'M', enabled: true,
            actions: [{
                name: 'Fire', kind: 'button', pressPoint: 0.6,
                bindings: [{ id: 't', source: { device: 'gamepad', button: 'rightTrigger' } }],
            }],
        };
        const buttons = (v: number) => { const b = new Array(17).fill(0); b[7] = v; return b; };
        expect(step([TRIGGER], ['M'], pad([], buttons(0.4)), createResolveState()).states.get('Fire')!.pressed)
            .toBe(false);
        const hard = step([TRIGGER], ['M'], pad([], buttons(0.8)), createResolveState()).states.get('Fire')!;
        expect(hard.pressed).toBe(true);
        expect(hard.value).toBeCloseTo(0.8, 10);
    });
});

describe('modifier suppression', () => {
    const EDIT_MAP: InputActionMap = {
        name: 'Edit', enabled: true,
        actions: [
            {
                name: 'Save', kind: 'button',
                bindings: [{
                    id: 'save', source: { device: 'key', code: 'KeyS' },
                    modifiers: [{ device: 'key', code: 'ControlLeft' }],
                }],
            },
            { name: 'Crouch', kind: 'button', bindings: [{ id: 'crouch', source: { device: 'key', code: 'KeyS' } }] },
        ],
    };

    it('fires only the modified action while the modifier is held', () => {
        const result = step([EDIT_MAP], ['Edit'], keys('ControlLeft', 'KeyS'), createResolveState());
        expect(result.states.get('Save')!.pressed).toBe(true);
        expect(result.states.get('Crouch')!.pressed).toBe(false);
    });

    it('fires only the plain action when the modifier is not held', () => {
        const result = step([EDIT_MAP], ['Edit'], keys('KeyS'), createResolveState());
        expect(result.states.get('Save')!.pressed).toBe(false);
        expect(result.states.get('Crouch')!.pressed).toBe(true);
    });

    it('hands the key back the moment the modifier is released', () => {
        // Suppression is recomputed per frame, not latched — otherwise letting go of Ctrl while still
        // holding S would leave the key dead until it was released and pressed again.
        let state = step([EDIT_MAP], ['Edit'], keys('ControlLeft', 'KeyS'), createResolveState()).next;
        const after = step([EDIT_MAP], ['Edit'], keys('KeyS'), state);
        expect(after.states.get('Save')!.released).toBe(true);
        expect(after.states.get('Crouch')!.started).toBe(true);
    });

    it('gates a pointer axis on pointer lock', () => {
        const LOOK: InputActionMap = {
            name: 'G', enabled: true,
            actions: [{
                name: 'Look', kind: 'vector',
                bindings: [{
                    id: 'x', source: { device: 'pointer', axis: 'deltaX' }, part: 'x',
                    modifiers: [{ device: 'state', flag: 'pointerLock' }],
                }],
            }],
        };
        const moving = { ...createDeviceSnapshot().pointer, deltaX: 10 };
        expect(step([LOOK], ['G'], snapshot({ pointer: moving }), createResolveState()).states.get('Look')!.vector)
            .toEqual([0, 0]);
        expect(step([LOOK], ['G'], snapshot({ pointer: moving, pointerLocked: true }), createResolveState())
            .states.get('Look')!.vector[0]).toBe(10);
    });

    it('does not suppress across maps', () => {
        // Two maps are two contexts. A modifier claimed in the editor map must not silence a game one.
        const other: InputActionMap = {
            name: 'Game', enabled: true,
            actions: [{ name: 'Crouch', kind: 'button', bindings: [{ id: 'c', source: { device: 'key', code: 'KeyS' } }] }],
        };
        const result = step([EDIT_MAP, other], ['Edit', 'Game'], keys('ControlLeft', 'KeyS'), createResolveState());
        expect(result.states.get('Game/Crouch')!.pressed).toBe(true);
    });
});

describe('enabling and disabling maps', () => {
    it('cancels a held action for exactly one frame when its map goes away', () => {
        // Without this, opening a menu while holding W walks the character forever.
        let state = step([MOVE_MAP], ['Gameplay'], keys('Space'), createResolveState()).next;
        const disabled = step([MOVE_MAP], [], keys('Space'), state);
        const jump = disabled.states.get('Gameplay/Jump')!;
        expect(jump.pressed).toBe(false);
        expect(jump.released).toBe(true);
        expect(jump.phase).toBe('canceled');

        const next = step([MOVE_MAP], [], keys('Space'), disabled.next);
        expect(next.states.get('Gameplay/Jump')!.released).toBe(false);
        expect(next.states.get('Gameplay/Jump')!.phase).toBe('idle');
    });

    it('reports the cancellation through the bare name too', () => {
        let state = step([MOVE_MAP], ['Gameplay'], keys('Space'), createResolveState()).next;
        expect(step([MOVE_MAP], [], keys('Space'), state).states.get('Jump')!.released).toBe(true);
    });

    it('does not fire a fresh press while its map is disabled', () => {
        const result = step([MOVE_MAP], [], keys('Space'), createResolveState());
        expect(result.states.get('Gameplay/Jump')!.pressed).toBe(false);
        expect(result.states.get('Gameplay/Jump')!.started).toBe(false);
    });

    it('picks the press up again once the map comes back', () => {
        let state = step([MOVE_MAP], [], keys('Space'), createResolveState()).next;
        expect(step([MOVE_MAP], ['Gameplay'], keys('Space'), state).states.get('Jump')!.started).toBe(true);
    });
});

describe('name resolution', () => {
    const ui: InputActionMap = {
        name: 'UI', enabled: true,
        actions: [{ name: 'Cancel', kind: 'button', bindings: [{ id: 'esc', source: { device: 'key', code: 'Escape' } }] }],
    };
    const game: InputActionMap = {
        name: 'Gameplay', enabled: true,
        actions: [{ name: 'Cancel', kind: 'button', bindings: [{ id: 'q', source: { device: 'key', code: 'KeyQ' } }] }],
    };

    it('gives a bare name to the first enabled map that defines it', () => {
        const result = step([ui, game], ['UI', 'Gameplay'], keys('Escape'), createResolveState());
        expect(result.states.get('Cancel')!.pressed).toBe(true);
        expect(result.states.get('Gameplay/Cancel')!.pressed).toBe(false);
    });

    it('skips a disabled map when handing out the bare name', () => {
        const result = step([ui, game], ['Gameplay'], keys('KeyQ'), createResolveState());
        expect(result.states.get('Cancel')!.pressed).toBe(true);
    });

    it('always keeps the qualified name addressable', () => {
        const result = step([ui, game], ['UI', 'Gameplay'], keys('KeyQ'), createResolveState());
        expect(result.states.get('Cancel')!.pressed).toBe(false);
        expect(result.states.get('Gameplay/Cancel')!.pressed).toBe(true);
    });
});

describe('device attribution', () => {
    it('names the device that produced the winning value', () => {
        // A HUD swapping key prompts for pad glyphs reads this, so it has to be right — and stable.
        const byKey = step([MOVE_MAP], ['Gameplay'], keys('KeyW'), createResolveState()).states.get('Move')!;
        expect(byKey.device).toBe('key');
        const byPad = step([MOVE_MAP], ['Gameplay'], pad([0, 1]), createResolveState()).states.get('Move')!;
        expect(byPad.device).toBe('gamepadAxis');
    });

    it('is null while the action is idle', () => {
        expect(step([MOVE_MAP], ['Gameplay'], snapshot(), createResolveState()).states.get('Move')!.device)
            .toBeNull();
    });

    it('breaks an exact tie in favour of the binding authored first', () => {
        const TIED: InputActionMap = {
            name: 'M', enabled: true,
            actions: [{
                name: 'Fire', kind: 'button',
                bindings: [
                    { id: 'first', source: { device: 'key', code: 'KeyF' } },
                    { id: 'second', source: { device: 'mouse', button: 'left' } },
                ],
            }],
        };
        const both = snapshot({ keys: new Set(['KeyF']), mouseButtons: new Set<MouseButton>(['left']) });
        expect(step([TIED], ['M'], both, createResolveState()).states.get('Fire')!.device).toBe('key');
    });
});

describe('change reporting', () => {
    it('reports an action only on the frames its phase moves', () => {
        // onAction and the editor monitor are driven by this; reporting every frame would make a
        // published game pay an emit per action per frame forever.
        let state = createResolveState();
        const counts: number[] = [];
        for (let i = 0; i < 5; i++) {
            const result = step([MOVE_MAP], ['Gameplay'], keys('Space'), state);
            counts.push(result.changed.filter(c => c.action === 'Jump').length);
            state = result.next;
        }
        expect(counts[0]).toBe(1);
        expect(counts.slice(1)).toEqual([0, 0, 0, 0]);
    });

    it('reports the release, and the qualified map it came from', () => {
        const state = step([MOVE_MAP], ['Gameplay'], keys('Space'), createResolveState()).next;
        const released = step([MOVE_MAP], ['Gameplay'], snapshot(), state)
            .changed.find(c => c.action === 'Jump')!;
        expect(released.map).toBe('Gameplay');
        expect(released.state.released).toBe(true);
    });
});

describe('smoothing', () => {
    const SMOOTHED: InputActionMap = {
        name: 'M', enabled: true,
        actions: [{
            name: 'Aim', kind: 'axis',
            bindings: [{
                id: 'x', source: { device: 'gamepadAxis', axis: 'rightStickX' },
                processors: [{ kind: 'smooth', seconds: 0.1 }],
            }],
        }],
    };

    it('ramps toward a step input rather than jumping to it', () => {
        let state = createResolveState();
        const first = step([SMOOTHED], ['M'], pad([0, 0, 1, 0]), state);
        expect(first.states.get('Aim')!.value).toBeGreaterThan(0);
        expect(first.states.get('Aim')!.value).toBeLessThan(1);
        state = first.next;
        for (let i = 0; i < 60; i++) state = step([SMOOTHED], ['M'], pad([0, 0, 1, 0]), state).next;
        expect(step([SMOOTHED], ['M'], pad([0, 0, 1, 0]), state).states.get('Aim')!.value).toBeCloseTo(1, 3);
    });

    it('carries the filter across frames without writing through the previous state', () => {
        const first = step([SMOOTHED], ['M'], pad([0, 0, 1, 0]), createResolveState());
        const carriedValue = first.next.smoothing['M/Aim/x'].x;
        step([SMOOTHED], ['M'], pad([0, 0, 1, 0]), first.next);
        expect(first.next.smoothing['M/Aim/x'].x).toBe(carriedValue);
    });
});

describe('purity', () => {
    it('does not mutate the state it was given', () => {
        const prev = step([MOVE_MAP], ['Gameplay'], keys('Space'), createResolveState()).next;
        const before = JSON.stringify(prev);
        step([MOVE_MAP], ['Gameplay'], keys('Space'), prev);
        expect(JSON.stringify(prev)).toBe(before);
    });

    it('gives the same output twice for the same inputs', () => {
        const prev = createResolveState();
        const a = step([MOVE_MAP], ['Gameplay'], keys('KeyW', 'KeyD'), prev);
        const b = step([MOVE_MAP], ['Gameplay'], keys('KeyW', 'KeyD'), prev);
        expect([...b.states.entries()]).toEqual([...a.states.entries()]);
    });

    it('never reads a source as NaN, however odd the snapshot', () => {
        const odd = snapshot({ gamepads: [null, { connected: false, buttons: [], axes: [] }] });
        for (const [, state] of step([MOVE_MAP], ['Gameplay'], odd, createResolveState()).states) {
            expect(Number.isNaN(state.value)).toBe(false);
            expect(state.vector.some(Number.isNaN)).toBe(false);
        }
    });
});

describe('the shipped default map', () => {
    const maps = DEFAULT_INPUT_MAP.maps;
    const enabled = new Set(maps.filter(m => m.enabled).map(m => m.name));

    it('moves on WASD and on the arrow keys alike', () => {
        for (const code of ['KeyW', 'ArrowUp']) {
            const result = resolveFrame(maps, enabled, keys(code), createResolveState(), FRAME);
            expect(result.states.get('Gameplay/Move')!.vector).toEqual([0, 1]);
        }
    });

    it('jumps on Space, on the pad A button and on the on-screen button', () => {
        const buttons = new Array(17).fill(0); buttons[0] = 1;
        const cases: DeviceSnapshot[] = [
            keys('Space'),
            pad([], buttons),
            snapshot({ virtual: new Map([['jump', { kind: 'button' as const, pressed: true, vector: [0, 0] as [number, number] }]]) }),
        ];
        for (const snap of cases)
            expect(resolveFrame(maps, enabled, snap, createResolveState(), FRAME).states.get('Jump')!.pressed)
                .toBe(true);
    });

    it('looks with the mouse only while the mouse is captured or a button is down', () => {
        // The binding-level replacement for the guard every camera script used to open with.
        const moving = { ...createDeviceSnapshot().pointer, deltaX: 12 };
        const free = resolveFrame(maps, enabled, snapshot({ pointer: moving }), createResolveState(), FRAME);
        expect(free.states.get('Look')!.vector).toEqual([0, 0]);

        const locked = resolveFrame(
            maps, enabled, snapshot({ pointer: moving, pointerLocked: true }), createResolveState(), FRAME);
        expect(locked.states.get('Look')!.vector[0]).toBe(12);

        const dragging = resolveFrame(
            maps, enabled, snapshot({ pointer: moving, mouseButtons: new Set<MouseButton>(['left']) }),
            createResolveState(), FRAME);
        expect(dragging.states.get('Look')!.vector[0]).toBe(12);
    });

    it('binds Escape — the key the old whitelist made unbindable', () => {
        const result = resolveFrame(maps, enabled, keys('Escape'), createResolveState(), FRAME);
        expect(result.states.get('UI/Cancel')!.pressed).toBe(true);
        expect(result.states.get('UI/Pause')!.pressed).toBe(true);
    });

    it('survives a round trip through the tolerant reader unchanged in behaviour', () => {
        const reparsed = parseInputMap(JSON.parse(JSON.stringify(DEFAULT_INPUT_MAP)));
        const a = resolveFrame(maps, enabled, keys('KeyW'), createResolveState(), FRAME);
        const b = resolveFrame(reparsed.maps, enabled, keys('KeyW'), createResolveState(), FRAME);
        expect(b.states.get('Move')).toEqual<ActionState>(a.states.get('Move')!);
    });
});

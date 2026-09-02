import { describe, it, expect } from 'vitest';
import {
    ACTION_KINDS, DEFAULT_INPUT_MAP, DEFAULT_PRESS_POINT, DEFAULT_TOUCH_CONFIG, PROCESSOR_KINDS,
    cloneInputMap, defaultProcessor, isDefaultInputMap, normalizeAction, normalizeActionMap,
    normalizeBinding, normalizeModifier, normalizeProcessor, normalizeSource, normalizeTouchConfig,
    normalizeVirtualControl, parseInputMap,
} from '../src/input/actionMap';
import { sourceKey, sourceLabel } from '../src/input/inputSources';
import type { Processor } from '../src/input/actionMap';

// actionMap.ts is the input system's tolerant reader: an input map arrives from a project file, an
// exported bundle or a published game's config blob, and nothing downstream validates it again. So the
// cases worth writing are the hostile ones — a device from a newer build, a NaN deadzone, a hand-edited
// file with two bindings sharing an id — because in the app those are exactly where it comes from.
//
// The rule the whole module is built around, and the one most of these tests exist to pin: an unreadable
// BINDING is dropped while its siblings keep their order, and an unreadable ACTION is dropped whole.
// Substituting a default instead would silently bind a key nobody asked for.

describe('normalizeSource', () => {
    it('rejects non-objects and devices this build does not know', () => {
        expect(normalizeSource(null)).toBeNull();
        expect(normalizeSource('KeyW')).toBeNull();
        expect(normalizeSource({})).toBeNull();
        expect(normalizeSource({ device: 'brainwave', code: 'KeyW' })).toBeNull();
    });

    it('accepts a key code the picker has never heard of', () => {
        // The whole point of KeyCode's `(string & {})` arm: the old system kept a 51-entry whitelist and
        // silently dropped everything else, which is why registerKeyPress('Escape') was dead code.
        expect(normalizeSource({ device: 'key', code: 'Lang1' })).toEqual({ device: 'key', code: 'Lang1' });
        expect(normalizeSource({ device: 'key', code: 'Escape' })).toEqual({ device: 'key', code: 'Escape' });
        expect(normalizeSource({ device: 'key', code: '' })).toBeNull();
        expect(normalizeSource({ device: 'key', code: 42 })).toBeNull();
    });

    it('rejects an enumerated value outside its set rather than defaulting it', () => {
        expect(normalizeSource({ device: 'mouse', button: 'thumb' })).toBeNull();
        expect(normalizeSource({ device: 'pointer', axis: 'deltaZ' })).toBeNull();
        expect(normalizeSource({ device: 'gamepad', button: 'turbo' })).toBeNull();
        expect(normalizeSource({ device: 'touch', gesture: 'rotate' })).toBeNull();
    });

    it('reads an out-of-range or fractional player slot as "any pad"', () => {
        expect(normalizeSource({ device: 'gamepad', button: 'a', player: 9 }))
            .toEqual({ device: 'gamepad', button: 'a' });
        expect(normalizeSource({ device: 'gamepad', button: 'a', player: 1.5 }))
            .toEqual({ device: 'gamepad', button: 'a' });
        expect(normalizeSource({ device: 'gamepad', button: 'a', player: 1 }))
            .toEqual({ device: 'gamepad', button: 'a', player: 1 });
    });

    it('drops an axis qualifier that is not x or y', () => {
        expect(normalizeSource({ device: 'touch', gesture: 'drag', axis: 'z' }))
            .toEqual({ device: 'touch', gesture: 'drag' });
    });
});

describe('normalizeModifier', () => {
    it('accepts only sources with an unambiguous held state', () => {
        expect(normalizeModifier({ device: 'key', code: 'ShiftLeft' })).not.toBeNull();
        expect(normalizeModifier({ device: 'mouse', button: 'left' })).not.toBeNull();
        expect(normalizeModifier({ device: 'gamepad', button: 'leftBumper' })).not.toBeNull();
        // An axis cannot gate: "is the stick held?" has no answer a user would agree with.
        expect(normalizeModifier({ device: 'gamepadAxis', axis: 'leftStickX' })).toBeNull();
        expect(normalizeModifier({ device: 'pointer', axis: 'deltaX' })).toBeNull();
    });

    it('reads the engine-owned state flags', () => {
        expect(normalizeModifier({ device: 'state', flag: 'pointerLock' }))
            .toEqual({ device: 'state', flag: 'pointerLock' });
        expect(normalizeModifier({ device: 'state', flag: 'gravity' })).toBeNull();
    });
});

describe('normalizeProcessor', () => {
    it('rejects unknown kinds and fills missing parameters from the default for that kind', () => {
        expect(normalizeProcessor({ kind: 'quantize' })).toBeNull();
        for (const kind of PROCESSOR_KINDS)
            expect(normalizeProcessor({ kind })).toEqual(defaultProcessor(kind));
    });

    it('replaces a non-finite parameter with its default rather than propagating it', () => {
        // A NaN here would silently zero every reading that passed through the chain.
        expect(normalizeProcessor({ kind: 'scale', factor: NaN })).toEqual({ kind: 'scale', factor: 1 });
        expect(normalizeProcessor({ kind: 'curve', exponent: Infinity })).toEqual({ kind: 'curve', exponent: 1 });
        const dz = normalizeProcessor({ kind: 'deadzone', min: NaN, max: NaN }) as Extract<Processor, { kind: 'deadzone' }>;
        expect(Number.isFinite(dz.min)).toBe(true);
        expect(Number.isFinite(dz.max)).toBe(true);
    });

    it('keeps a deadzone max strictly above its min, whatever was authored', () => {
        // The rescale divides by (max - min); equal or inverted bounds blow up or invert the response.
        const inverted = normalizeProcessor({ kind: 'deadzone', min: 0.8, max: 0.2 }) as Extract<Processor, { kind: 'deadzone' }>;
        expect(inverted.max).toBeGreaterThan(inverted.min);
        const equal = normalizeProcessor({ kind: 'radialDeadzone', min: 0.5, max: 0.5 }) as Extract<Processor, { kind: 'radialDeadzone' }>;
        expect(equal.max).toBeGreaterThan(equal.min);
    });

    it('reads invert flags as booleans, never as truthiness', () => {
        expect(normalizeProcessor({ kind: 'invert', x: 1, y: 'yes' })).toEqual({ kind: 'invert', x: false, y: false });
        expect(normalizeProcessor({ kind: 'invert', x: true })).toEqual({ kind: 'invert', x: true, y: false });
    });
});

describe('normalizeBinding', () => {
    it('drops a binding whose source is unreadable, and mints an id when none was written', () => {
        expect(normalizeBinding({ source: { device: 'nope' } }, 'Fire:0')).toBeNull();
        expect(normalizeBinding({ source: { device: 'key', code: 'KeyF' } }, 'Fire:0')!.id).toBe('Fire:0');
    });

    it('omits empty modifier and processor lists rather than writing them out', () => {
        // Keeps a round-trip byte-identical: an absent optional and an empty array must not differ.
        const b = normalizeBinding({ source: { device: 'key', code: 'KeyF' }, modifiers: [], processors: [] }, 'x')!;
        expect('modifiers' in b).toBe(false);
        expect('processors' in b).toBe(false);
    });

    it('drops individual unreadable modifiers and processors but keeps the binding', () => {
        const b = normalizeBinding({
            source: { device: 'key', code: 'KeyF' },
            modifiers: [{ device: 'key', code: 'ShiftLeft' }, { device: 'gamepadAxis', axis: 'leftStickX' }],
            processors: [{ kind: 'scale', factor: 2 }, { kind: 'quantize' }],
        }, 'x')!;
        expect(b.modifiers).toHaveLength(1);
        expect(b.processors).toEqual([{ kind: 'scale', factor: 2 }]);
    });
});

describe('normalizeAction', () => {
    it('drops an action with no name or an unreadable kind', () => {
        expect(normalizeAction({ kind: 'button', bindings: [] })).toBeNull();
        expect(normalizeAction({ name: '   ', kind: 'button' })).toBeNull();
        expect(normalizeAction({ name: 'Spin', kind: 'quaternion' })).toBeNull();
        for (const kind of ACTION_KINDS) expect(normalizeAction({ name: 'X', kind })!.kind).toBe(kind);
    });

    it('drops an unreadable binding while its siblings keep their order', () => {
        const action = normalizeAction({
            name: 'Move', kind: 'vector',
            bindings: [
                { id: 'a', source: { device: 'key', code: 'KeyW' }, part: 'up' },
                { id: 'b', source: { device: 'brainwave' } },
                { id: 'c', source: { device: 'key', code: 'KeyS' }, part: 'down' },
            ],
        })!;
        expect(action.bindings.map(b => b.id)).toEqual(['a', 'c']);
    });

    it('makes duplicate binding ids unique, so an editor row cannot edit two at once', () => {
        const action = normalizeAction({
            name: 'Fire', kind: 'button',
            bindings: [
                { id: 'same', source: { device: 'key', code: 'KeyF' } },
                { id: 'same', source: { device: 'mouse', button: 'left' } },
            ],
        })!;
        expect(new Set(action.bindings.map(b => b.id)).size).toBe(2);
    });

    it('mints the same ids on every load of an id-less record', () => {
        const raw = { name: 'Fire', kind: 'button', bindings: [{ source: { device: 'key', code: 'KeyF' } }] };
        // Ids that churned would make the editor selection jump and every saved diff noisy.
        expect(normalizeAction(raw)!.bindings[0].id).toBe(normalizeAction(raw)!.bindings[0].id);
        expect(normalizeAction(raw)!.bindings[0].id).toBe('Fire:0');
    });

    it('carries pressPoint and holdSeconds on buttons only', () => {
        // Written only when it differs from the default, so an untouched action adds no field.
        expect(normalizeAction({ name: 'Fire', kind: 'button', bindings: [] })!.pressPoint).toBeUndefined();
        const button = normalizeAction({ name: 'Fire', kind: 'button', bindings: [], pressPoint: 0.9 })!;
        expect(button.pressPoint).toBe(0.9);
        expect(DEFAULT_PRESS_POINT).toBe(0.5);
        const axis = normalizeAction({ name: 'Zoom', kind: 'axis', bindings: [], pressPoint: 0.9, holdSeconds: 2 })!;
        expect(axis.pressPoint).toBeUndefined();
        expect(axis.holdSeconds).toBeUndefined();
    });

    it('never lets a press point reach zero', () => {
        // At 0 an untouched analog trigger reads as permanently held.
        expect(normalizeAction({ name: 'F', kind: 'button', bindings: [], pressPoint: 0 })!.pressPoint)
            .toBeGreaterThan(0);
        expect(normalizeAction({ name: 'F', kind: 'button', bindings: [], pressPoint: -3 })!.pressPoint)
            .toBeGreaterThan(0);
    });
});

describe('normalizeActionMap', () => {
    it('keeps the first of two actions sharing a name', () => {
        const map = normalizeActionMap({
            name: 'Gameplay',
            actions: [
                { name: 'Fire', kind: 'button', bindings: [{ source: { device: 'key', code: 'KeyF' } }] },
                { name: 'Fire', kind: 'axis', bindings: [] },
            ],
        })!;
        expect(map.actions).toHaveLength(1);
        expect(map.actions[0].kind).toBe('button');
    });

    it('treats a missing enabled as on, and only an explicit false as off', () => {
        expect(normalizeActionMap({ name: 'A' })!.enabled).toBe(true);
        expect(normalizeActionMap({ name: 'A', enabled: 0 })!.enabled).toBe(true);
        expect(normalizeActionMap({ name: 'A', enabled: false })!.enabled).toBe(false);
    });
});

describe('normalizeVirtualControl', () => {
    it('clamps placement into the viewport so a bad value cannot hide the control', () => {
        const c = normalizeVirtualControl({ id: 'stick', kind: 'stick', x: -5, y: 9, radius: 100 })!;
        expect(c.x).toBe(0);
        expect(c.y).toBe(1);
        expect(c.radius).toBeLessThanOrEqual(0.4);
        expect(c.radius).toBeGreaterThanOrEqual(0.02);
    });

    it('carries deadzone only on sticks and a label only on buttons', () => {
        const stick = normalizeVirtualControl({ id: 's', kind: 'stick', label: 'Nope' })!;
        expect(stick.deadzone).toBeDefined();
        expect(stick.label).toBeUndefined();
        const button = normalizeVirtualControl({ id: 'b', kind: 'button', deadzone: 0.5, label: 'Jump' })!;
        expect(button.deadzone).toBeUndefined();
        expect(button.label).toBe('Jump');
    });

    it('needs an id', () => {
        expect(normalizeVirtualControl({ kind: 'stick' })).toBeNull();
    });
});

describe('normalizeTouchConfig', () => {
    it('fills a missing or junk record from the defaults', () => {
        expect(normalizeTouchConfig(undefined)).toEqual(DEFAULT_TOUCH_CONFIG);
        expect(normalizeTouchConfig('nope')).toEqual(DEFAULT_TOUCH_CONFIG);
    });

    it('keeps long press strictly longer than a tap', () => {
        // Otherwise every tap is also a long press and the two gestures fight over the same touch.
        const c = normalizeTouchConfig({ tapMaxSeconds: 0.8, longPressSeconds: 0.1 });
        expect(c.longPressSeconds).toBeGreaterThan(c.tapMaxSeconds);
    });
});

describe('parseInputMap', () => {
    it('round-trips the default map through JSON unchanged', () => {
        const roundTripped = parseInputMap(JSON.parse(JSON.stringify(DEFAULT_INPUT_MAP)));
        expect(roundTripped).toEqual(DEFAULT_INPUT_MAP);
    });

    it('falls back to the defaults for junk, rather than to a map where nothing responds', () => {
        // An empty map reads to a player as a broken build; the defaults at least move the character.
        for (const junk of [null, undefined, [], 'maps', 42, { maps: 'no' }, { maps: [] }, { maps: [{}] }])
            expect(parseInputMap(junk)).toEqual(DEFAULT_INPUT_MAP);
    });

    it('keeps the first of two maps sharing a name, and drops duplicate virtual control ids', () => {
        const parsed = parseInputMap({
            maps: [
                { name: 'A', actions: [{ name: 'X', kind: 'button', bindings: [] }] },
                { name: 'A', actions: [] },
            ],
            virtualControls: [{ id: 'stick', kind: 'stick' }, { id: 'stick', kind: 'button' }],
        });
        expect(parsed.maps).toHaveLength(1);
        expect(parsed.virtualControls).toHaveLength(1);
        expect(parsed.virtualControls[0].kind).toBe('stick');
    });

    it('is idempotent — parsing its own output changes nothing', () => {
        const once = parseInputMap({ maps: [{ name: 'M', actions: [{ name: 'A', kind: 'axis', bindings: [] }] }] });
        expect(parseInputMap(once)).toEqual(once);
    });

    it('does not alias the defaults, so an editor mutation cannot corrupt them', () => {
        const parsed = parseInputMap(null);
        parsed.maps[0].actions[0].name = 'Clobbered';
        expect(DEFAULT_INPUT_MAP.maps[0].actions[0].name).toBe('Move');
    });
});

describe('isDefaultInputMap', () => {
    it('is true for the default and for anything that parses back to it', () => {
        expect(isDefaultInputMap(DEFAULT_INPUT_MAP)).toBe(true);
        expect(isDefaultInputMap(JSON.parse(JSON.stringify(DEFAULT_INPUT_MAP)))).toBe(true);
        expect(isDefaultInputMap(undefined)).toBe(true);
    });

    it('flips after a single binding edit', () => {
        // This is what keeps an untouched project from gaining an input block in its saved file.
        const edited = cloneInputMap(DEFAULT_INPUT_MAP);
        edited.maps[0].actions[0].bindings[0].source = { device: 'key', code: 'KeyI' };
        expect(isDefaultInputMap(edited)).toBe(false);
    });
});

describe('sourceKey / sourceLabel', () => {
    it('distinguishes "any pad" from pad 0', () => {
        // They are different bindings, and a conflict warning that conflated them would be wrong.
        expect(sourceKey({ device: 'gamepad', button: 'a' }))
            .not.toBe(sourceKey({ device: 'gamepad', button: 'a', player: 0 }));
    });

    it('gives equal sources equal keys and different sources different ones', () => {
        expect(sourceKey({ device: 'key', code: 'KeyW' })).toBe(sourceKey({ device: 'key', code: 'KeyW' }));
        expect(sourceKey({ device: 'key', code: 'KeyW' })).not.toBe(sourceKey({ device: 'key', code: 'KeyS' }));
        expect(sourceKey({ device: 'pointer', axis: 'deltaX' }))
            .not.toBe(sourceKey({ device: 'pointer', axis: 'deltaY' }));
    });

    it('labels every source with something non-empty', () => {
        const sources = [
            { device: 'key', code: 'KeyW' }, { device: 'key', code: 'ArrowUp' }, { device: 'key', code: 'Lang1' },
            { device: 'mouse', button: 'left' }, { device: 'pointer', axis: 'deltaX' },
            { device: 'gamepad', button: 'a', player: 1 }, { device: 'gamepadAxis', axis: 'leftStickX' },
            { device: 'touch', gesture: 'drag', axis: 'x' }, { device: 'virtual', control: 'jump' },
            { device: 'state', flag: 'pointerLock' }, { device: 'state', flag: 'pointerOverCanvas' },
        ] as const;
        for (const source of sources) expect(sourceLabel(source).length).toBeGreaterThan(0);
        expect(sourceLabel({ device: 'gamepad', button: 'a', player: 1 })).toContain('P2');
    });
});

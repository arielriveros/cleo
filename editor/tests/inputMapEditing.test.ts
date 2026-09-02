import { describe, it, expect } from 'vitest';
import { DEFAULT_INPUT_MAP, cloneInputMap, parseInputMap, sourceKey } from 'cleo';
import type { InputMap } from 'cleo';
import * as edits from '../src/features/input/inputMapEdits';

// An input map is a four-level tree — map → action → binding → processor — and almost every edit the
// panel makes is an immutable splice several levels down. That is exactly the code where a mistake is
// quiet: a rename that also renumbers ids, a kind change that leaves a part behind doing nothing, a
// control delete that orphans the bindings naming it. None of those throw; they just produce a binding
// that does not work, with nothing on screen to say why.
//
// These functions are pure precisely so they can be driven here rather than through a component.

/** A small map, so an assertion names what it is checking instead of indexing into the defaults. */
function fixture(): InputMap {
    return parseInputMap({
        maps: [
            {
                name: 'Gameplay',
                enabled: true,
                actions: [
                    {
                        name: 'Move', kind: 'vector',
                        bindings: [
                            { id: 'w', source: { device: 'key', code: 'KeyW' }, part: 'up' },
                            { id: 's', source: { device: 'key', code: 'KeyS' }, part: 'down' },
                        ],
                    },
                    {
                        name: 'Jump', kind: 'button',
                        bindings: [{ id: 'space', source: { device: 'key', code: 'Space' } }],
                    },
                ],
            },
            { name: 'UI', enabled: false, actions: [] },
        ],
        virtualControls: [
            { id: 'moveStick', kind: 'stick', x: 0.2, y: 0.8, radius: 0.1, deadzone: 0.1 },
            { id: 'jump', kind: 'button', x: 0.8, y: 0.8, radius: 0.07, label: 'Jump' },
        ],
    });
}

const mapNamed = (m: InputMap, name: string) => m.maps.find(x => x.name === name)!;
const actionNamed = (m: InputMap, map: string, action: string) =>
    mapNamed(m, map).actions.find(a => a.name === action)!;

describe('purity', () => {
    it('never mutates the map it was given', () => {
        const before = fixture();
        const snapshot = JSON.stringify(before);
        edits.addMap(before);
        edits.addAction(before, 'Gameplay');
        edits.addBinding(before, 'Gameplay', 'Jump');
        edits.removeVirtualControl(before, 'jump');
        expect(JSON.stringify(before)).toBe(snapshot);
    });

    it('produces something the tolerant reader accepts unchanged', () => {
        // Every edit ends up in IndexedDB and in a published build, both of which come back through
        // parseInputMap. An edit that produced a shape the reader had to repair would silently undo
        // itself on the next load.
        let map = fixture();
        map = edits.addAction(map, 'Gameplay', 'axis', 'Throttle');
        map = edits.addBinding(map, 'Gameplay', 'Throttle');
        map = edits.addProcessor(map, 'Gameplay', 'Throttle', null, 'normalize');
        map = edits.setBindingModifiers(map, 'Gameplay', 'Jump', 'space',
            [{ device: 'key', code: 'ShiftLeft' }]);
        expect(parseInputMap(map)).toEqual(map);
    });
});

describe('maps', () => {
    it('adds with a unique name rather than colliding', () => {
        let map = edits.addMap(fixture(), 'Gameplay');
        expect(map.maps.map(m => m.name)).toEqual(['Gameplay', 'UI', 'Gameplay 2']);
        map = edits.addMap(map, 'Gameplay');
        expect(map.maps.map(m => m.name)).toEqual(['Gameplay', 'UI', 'Gameplay 2', 'Gameplay 3']);
    });

    it('keeps map ORDER through a rename — order is the name-shadowing priority', () => {
        const map = edits.renameMap(fixture(), 'Gameplay', 'Player');
        expect(map.maps.map(m => m.name)).toEqual(['Player', 'UI']);
    });

    it('ignores an empty or unchanged rename', () => {
        const before = fixture();
        expect(edits.renameMap(before, 'Gameplay', '   ')).toBe(before);
        expect(edits.renameMap(before, 'Gameplay', 'Gameplay')).toBe(before);
    });

    it('renames away from a collision', () => {
        const map = edits.renameMap(fixture(), 'Gameplay', 'UI');
        expect(map.maps.map(m => m.name)).toEqual(['UI 2', 'UI']);
    });

    it('removes a map without touching the others', () => {
        const map = edits.removeMap(fixture(), 'UI');
        expect(map.maps.map(m => m.name)).toEqual(['Gameplay']);
        expect(actionNamed(map, 'Gameplay', 'Move').bindings).toHaveLength(2);
    });

    it('toggles the authored enable flag', () => {
        expect(mapNamed(edits.setMapEnabled(fixture(), 'UI', true), 'UI').enabled).toBe(true);
        expect(mapNamed(edits.setMapEnabled(fixture(), 'Gameplay', false), 'Gameplay').enabled).toBe(false);
    });
});

describe('actions', () => {
    it('renames one action and nothing else', () => {
        const map = edits.renameAction(fixture(), 'Gameplay', 'Jump', 'Hop');
        expect(mapNamed(map, 'Gameplay').actions.map(a => a.name)).toEqual(['Move', 'Hop']);
        // Binding ids are opaque row identities. Reminting them on a rename would move the panel's
        // selection and make every saved diff noisier than the edit actually was.
        expect(actionNamed(map, 'Gameplay', 'Hop').bindings[0].id).toBe('space');
        expect(actionNamed(map, 'Gameplay', 'Move')).toEqual(actionNamed(fixture(), 'Gameplay', 'Move'));
    });

    it('renames away from a collision inside its own map only', () => {
        const map = edits.renameAction(fixture(), 'Gameplay', 'Jump', 'Move');
        expect(mapNamed(map, 'Gameplay').actions.map(a => a.name)).toEqual(['Move', 'Move 2']);
    });

    it('adds with a unique name and no bindings', () => {
        const map = edits.addAction(edits.addAction(fixture(), 'Gameplay'), 'Gameplay');
        const names = mapNamed(map, 'Gameplay').actions.map(a => a.name);
        expect(names).toEqual(['Move', 'Jump', 'New Action', 'New Action 2']);
        expect(actionNamed(map, 'Gameplay', 'New Action').bindings).toEqual([]);
    });

    it('drops composite parts a new kind cannot use', () => {
        // A `part: 'up'` on an axis action contributes nothing at all, which reads to the author as a
        // binding that is simply broken.
        const map = edits.setActionKind(fixture(), 'Gameplay', 'Move', 'axis');
        for (const binding of actionNamed(map, 'Gameplay', 'Move').bindings)
            expect(binding.part).toBeUndefined();
    });

    it('keeps parts the new kind still understands', () => {
        let map = edits.setActionKind(fixture(), 'Gameplay', 'Move', 'vector');
        expect(actionNamed(map, 'Gameplay', 'Move').bindings[0].part).toBe('up');
        map = edits.setActionKind(map, 'Gameplay', 'Move', 'button');
        expect(actionNamed(map, 'Gameplay', 'Move').bindings[0].part).toBeUndefined();
    });

    it('carries press point and hold time on a button, and drops hold at zero', () => {
        let map = edits.setPressPoint(fixture(), 'Gameplay', 'Jump', 0.8);
        expect(actionNamed(map, 'Gameplay', 'Jump').pressPoint).toBe(0.8);
        map = edits.setHoldSeconds(map, 'Gameplay', 'Jump', 0.5);
        expect(actionNamed(map, 'Gameplay', 'Jump').holdSeconds).toBe(0.5);
        map = edits.setHoldSeconds(map, 'Gameplay', 'Jump', 0);
        expect(actionNamed(map, 'Gameplay', 'Jump').holdSeconds).toBeUndefined();
    });

    it('removes an action without disturbing its siblings', () => {
        const map = edits.removeAction(fixture(), 'Gameplay', 'Move');
        expect(mapNamed(map, 'Gameplay').actions.map(a => a.name)).toEqual(['Jump']);
    });
});

describe('bindings', () => {
    it('mints a unique id for every new binding', () => {
        let map = fixture();
        for (let i = 0; i < 5; i++) map = edits.addBinding(map, 'Gameplay', 'Jump');
        const ids = actionNamed(map, 'Gameplay', 'Jump').bindings.map(b => b.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('leaves a valid action behind when the last binding goes', () => {
        const map = edits.removeBinding(fixture(), 'Gameplay', 'Jump', 'space');
        expect(actionNamed(map, 'Gameplay', 'Jump').bindings).toEqual([]);
        expect(parseInputMap(map)).toEqual(map);
    });

    it('replaces a source in place, keeping the row id and its part', () => {
        const map = edits.setBindingSource(fixture(), 'Gameplay', 'Move', 'w',
            { device: 'gamepadAxis', axis: 'leftStickY' });
        const binding = actionNamed(map, 'Gameplay', 'Move').bindings[0];
        expect(binding.id).toBe('w');
        expect(binding.part).toBe('up');
        expect(binding.source).toEqual({ device: 'gamepadAxis', axis: 'leftStickY' });
    });

    it('writes an empty modifier list as ABSENT, not as []', () => {
        // The tolerant reader omits empty lists, so writing `[]` here would make a save/load round trip
        // change the object — and `isDefaultInputMap` compares through that reader.
        let map = edits.setBindingModifiers(fixture(), 'Gameplay', 'Jump', 'space',
            [{ device: 'key', code: 'ShiftLeft' }]);
        expect(actionNamed(map, 'Gameplay', 'Jump').bindings[0].modifiers).toHaveLength(1);
        map = edits.setBindingModifiers(map, 'Gameplay', 'Jump', 'space', []);
        expect('modifiers' in actionNamed(map, 'Gameplay', 'Jump').bindings[0]).toBe(false);
    });

    it('clears a part with null', () => {
        const map = edits.setBindingPart(fixture(), 'Gameplay', 'Move', 'w', null);
        expect('part' in actionNamed(map, 'Gameplay', 'Move').bindings[0]).toBe(false);
    });
});

describe('processors', () => {
    it('adds to the binding chain and to the action chain independently', () => {
        let map = edits.addProcessor(fixture(), 'Gameplay', 'Move', 'w', 'scale');
        map = edits.addProcessor(map, 'Gameplay', 'Move', null, 'normalize');
        expect(actionNamed(map, 'Gameplay', 'Move').bindings[0].processors).toHaveLength(1);
        expect(actionNamed(map, 'Gameplay', 'Move').processors).toEqual([{ kind: 'normalize' }]);
    });

    it('preserves order, which is the author\'s meaning', () => {
        let map = edits.addProcessor(fixture(), 'Gameplay', 'Move', null, 'deadzone');
        map = edits.addProcessor(map, 'Gameplay', 'Move', null, 'scale');
        map = edits.addProcessor(map, 'Gameplay', 'Move', null, 'normalize');
        expect(actionNamed(map, 'Gameplay', 'Move').processors!.map(p => p.kind))
            .toEqual(['deadzone', 'scale', 'normalize']);
        map = edits.moveProcessor(map, 'Gameplay', 'Move', null, 2, -1);
        expect(actionNamed(map, 'Gameplay', 'Move').processors!.map(p => p.kind))
            .toEqual(['deadzone', 'normalize', 'scale']);
    });

    it('ignores a move that would leave the chain', () => {
        let map = edits.addProcessor(fixture(), 'Gameplay', 'Move', null, 'scale');
        const before = JSON.stringify(map);
        map = edits.moveProcessor(map, 'Gameplay', 'Move', null, 0, -1);
        expect(JSON.stringify(map)).toBe(before);
        map = edits.moveProcessor(map, 'Gameplay', 'Move', null, 0, 5);
        expect(JSON.stringify(map)).toBe(before);
    });

    it('writes an emptied chain as ABSENT, like modifiers', () => {
        let map = edits.addProcessor(fixture(), 'Gameplay', 'Move', null, 'scale');
        map = edits.removeProcessor(map, 'Gameplay', 'Move', null, 0);
        expect('processors' in actionNamed(map, 'Gameplay', 'Move')).toBe(false);
    });

    it('updates one entry in place', () => {
        let map = edits.addProcessor(fixture(), 'Gameplay', 'Move', null, 'scale');
        map = edits.updateProcessor(map, 'Gameplay', 'Move', null, 0, { kind: 'scale', factor: 4 });
        expect(actionNamed(map, 'Gameplay', 'Move').processors).toEqual([{ kind: 'scale', factor: 4 }]);
    });
});

describe('on-screen controls', () => {
    it('adds a new control and updates an existing one in place', () => {
        let map = edits.upsertVirtualControl(fixture(),
            { id: 'fire', kind: 'button', x: 0.7, y: 0.6, radius: 0.06 });
        expect(map.virtualControls.map(c => c.id)).toEqual(['moveStick', 'jump', 'fire']);
        map = edits.upsertVirtualControl(map, { ...map.virtualControls[0], radius: 0.2 });
        expect(map.virtualControls[0].radius).toBe(0.2);
        expect(map.virtualControls).toHaveLength(3);
    });

    it('removing a control also removes every binding that named it', () => {
        // A `{device:'virtual'}` source pointing at nothing is valid JSON, survives the reader and simply
        // never fires — so the panel would keep showing a row that does nothing.
        let map = edits.addBinding(fixture(), 'Gameplay', 'Jump', { device: 'virtual', control: 'jump' });
        expect(actionNamed(map, 'Gameplay', 'Jump').bindings).toHaveLength(2);
        map = edits.removeVirtualControl(map, 'jump');
        expect(map.virtualControls.map(c => c.id)).toEqual(['moveStick']);
        expect(actionNamed(map, 'Gameplay', 'Jump').bindings.map(b => b.id)).toEqual(['space']);
    });

    it('leaves bindings on OTHER controls alone', () => {
        let map = edits.addBinding(fixture(), 'Gameplay', 'Move', { device: 'virtual', control: 'moveStick' });
        map = edits.removeVirtualControl(map, 'jump');
        expect(actionNamed(map, 'Gameplay', 'Move').bindings).toHaveLength(3);
    });
});

describe('conflict reporting', () => {
    it('lists every place a source is bound', () => {
        // Reported, never blocked. Escape being both UI/Cancel and UI/Pause is deliberate in the shipped
        // defaults, and a shared key under different modifiers is the whole point of modifiers.
        const escape = sourceKey({ device: 'key', code: 'Escape' });
        const where = edits.bindingsUsing(cloneInputMap(DEFAULT_INPUT_MAP), escape, sourceKey);
        expect(where).toEqual(['UI/Cancel', 'UI/Pause']);
    });

    it('reports nothing for a source nobody uses', () => {
        expect(edits.bindingsUsing(fixture(), sourceKey({ device: 'key', code: 'F7' }), sourceKey)).toEqual([]);
    });
});

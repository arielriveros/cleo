import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_INPUT_MAP, Scene, cloneInputMap, isDefaultInputMap, parseInputMap } from 'cleo';
import type { InputMap } from 'cleo';
import { buildGameData } from '../src/features/publish/buildGameData';

// Bindings have to survive the whole round trip — editor → IndexedDB → published bin → player — and the
// way that fails is silent: a game that boots and simply does not respond to anything, with nothing on
// screen to say the map never arrived.
//
// The other half is the reverse. An input block must NOT appear in a build that never touched its
// bindings, or every unrelated save of an untouched project grows a diff nobody asked for. That is the
// same contract `isDefaultChain` gives the post-processing chain.

function emptySources() {
    return {
        scene: new Scene(),
        scripts: new Map<string, string>(),
        bodies: new Map<string, any>(),
        triggers: new Map<string, any>(),
        useCache: true,
    };
}

/** The defaults with one binding moved — the smallest thing that counts as "the user authored bindings". */
function edited(): InputMap {
    const map = cloneInputMap(DEFAULT_INPUT_MAP);
    map.maps[0].actions[0].bindings[0].source = { device: 'key', code: 'KeyI' };
    return map;
}

describe('buildGameData writes config.input', () => {
    it('carries an authored map into the build', async () => {
        const json = await buildGameData({ ...emptySources(), input: edited() });
        expect(json.config?.input).toBeDefined();
        expect(json.config.input.maps[0].actions[0].bindings[0].source)
            .toEqual({ device: 'key', code: 'KeyI' });
    });

    it('writes NOTHING for an untouched project', async () => {
        const untouched = await buildGameData({ ...emptySources(), input: cloneInputMap(DEFAULT_INPUT_MAP) });
        expect(untouched.config).toBeUndefined();

        const absent = await buildGameData(emptySources());
        expect(absent.config).toBeUndefined();
    });

    it('survives the JSON round trip a published bin puts it through', async () => {
        const json = await buildGameData({ ...emptySources(), input: edited() });
        const reloaded = parseInputMap(JSON.parse(JSON.stringify(json.config.input)));
        expect(reloaded).toEqual(edited());
        expect(isDefaultInputMap(reloaded)).toBe(false);
    });

    it('reads a missing block as the shipped defaults, not as "no bindings"', async () => {
        // How an older build's bin degrades: the player calls setMap(data?.config?.input) either way, and
        // a game with no bindings at all would look broken rather than merely un-customized.
        const absent = await buildGameData(emptySources());
        expect(parseInputMap(absent.config?.input)).toEqual(DEFAULT_INPUT_MAP);
    });

    it('keeps the render settings and the input map in the same config block', async () => {
        const json = await buildGameData({
            ...emptySources(),
            input: edited(),
            settings: { clearColor: [0, 0, 0, 1] } as any,
        });
        expect(json.config.render).toBeDefined();
        expect(json.config.input).toBeDefined();
        expect(json.config.graphics.clearColor).toEqual([0, 0, 0, 1]);
    });
});

describe('the shipped example project', () => {
    // Its scripts are EMBEDDED as strings in three generated JSON files with no generator to regenerate
    // them, so they drift silently: nothing typechecks them, nothing imports them, and the only symptom
    // of a stale copy is that the sample project stops responding to input once the API it used is gone.
    const FIXTURES = [
        'public/examples/3d-example/libraries/scripts.json',
        'public/examples/3d-example/libraries/templates.json',
        'public/examples/3d-example/scenes/afe4727c54de62f1bafbf6ac25c32b74.json',
    ];

    it('calls no input API the engine no longer has', () => {
        // CALL forms, not bare names: the migrated scripts mention the old API in a comment explaining
        // what replaced it, and that comment is worth keeping for anyone reading the sample.
        const gone = ['InputManager.', '.isKeyPressed(', '.registerKeyPress(', '.unregisterKeyPress('];
        for (const rel of FIXTURES) {
            const text = readFileSync(join(__dirname, '..', rel), 'utf-8');
            for (const call of gone)
                expect(text.includes(call), `${rel} still calls ${call}`).toBe(false);
        }
    });

    it('drives its character through actions', () => {
        const text = readFileSync(join(__dirname, '..', FIXTURES[0]), 'utf-8');
        expect(text).toContain('onAction(');
    });

    it('carries no field from the pre-controller character script', () => {
        // `_jumpCooldown` and `_smoothDir` were PRIVATE fields of the locomotion that now lives in the
        // engine. Only a stale copy of the old script has them, so their presence is the cheapest
        // possible signal that one of these three files was missed by the migration.
        //
        // Underscore-prefixed names on purpose: the migrated scripts mention the old design in prose —
        // `pivotName` appears in a comment explaining what replaced it — and a guard that tripped on
        // prose would have to be weakened or deleted the first time someone wrote a good comment.
        for (const rel of FIXTURES) {
            const text = readFileSync(join(__dirname, '..', rel), 'utf-8');
            for (const gone of ['_jumpCooldown', '_smoothDir', '_turning'])
                expect(text.includes(gone), `${rel} still carries ${gone}`).toBe(false);
        }
    });

    it('uses the control node pair', () => {
        // The scene has to demonstrate the thing: a Character that a Controller possesses. A Character
        // with nothing driving it is inert by design, so a missed controller means a sample project that
        // opens fine and simply does not respond.
        const scene = readFileSync(join(__dirname, '..', FIXTURES[2]), 'utf-8');
        expect(scene).toContain('"type":"character"');
        expect(scene).toContain('"type":"controller"');
        expect(scene).toContain('"possessedId"');
        // ...and the template, or instantiating it gives a plain Node the Character script cannot bind to.
        const templates = readFileSync(join(__dirname, '..', FIXTURES[1]), 'utf-8');
        expect(templates).toContain('"type":"character"');
    });
});

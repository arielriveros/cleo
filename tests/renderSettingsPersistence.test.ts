import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every renderer setting has to survive a refresh, a publish and an export — and the way it fails is
 * silent.
 *
 * The chain is: `Renderer.getRenderSettings()` produces a `RenderSettings`; `saveCurrentScene` folds it
 * into the scene blob as `config.render`; `applyGameData` and the standalone player hand it back to
 * `applyRenderSettings()`. Nothing in the middle whitelists keys — `buildGameData` writes
 * `render: sources.settings` wholesale — so the only place a setting can fall out is at the two ends.
 *
 * A setting declared on the interface but missing from `getRenderSettings` is never written. One missing
 * from `applyRenderSettings` is written and never read back. Neither throws, neither shows up in a
 * screenshot, and both present identically to the user: "I set it, and it was gone after a refresh."
 * That is exactly how terrain AO shipped inert one phase earlier, and the lesson there was to assert the
 * structure rather than trust the diff.
 *
 * Source-text scanning, for the same reason `gpuProfilerLabels` does it: constructing a Renderer needs a
 * GPU.
 */

const RENDERER = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8');

/** The block between a marker and the first line that closes it at the given indent. */
function blockAfter(marker: string, closer: string): string {
    const start = RENDERER.indexOf(marker);
    expect(start, `${marker} not found`).toBeGreaterThan(-1);
    const end = RENDERER.indexOf(closer, start);
    expect(end, `${marker} never closed`).toBeGreaterThan(start);
    return RENDERER.slice(start, end);
}

/** Keys declared on `interface RenderSettings`. */
function interfaceKeys(): string[] {
    const body = blockAfter('export interface RenderSettings', '\n}');
    return [...body.matchAll(/^ {4}([a-zA-Z0-9_]+)\??:/gm)].map(m => m[1]);
}

/** Keys `getRenderSettings()` actually writes. */
function serializedKeys(): string[] {
    const body = blockAfter('public getRenderSettings(): RenderSettings {', '\n    }');
    return [...body.matchAll(/^ {12}([a-zA-Z0-9_]+):/gm)].map(m => m[1]);
}

/** Keys `applyRenderSettings()` reads off the incoming object. */
function appliedKeys(): Set<string> {
    const body = blockAfter('public applyRenderSettings(', '\n    }\n');
    return new Set([...body.matchAll(/\bs\.([a-zA-Z0-9_]+)/g)].map(m => m[1]));
}

/**
 * `bloomEnabled` is a DERIVED report, `this._bloomIntensity > 0`, not a stored setting — the intensity
 * is what carries the value, and applying the boolean would be meaningless. The only key allowed to be
 * written without being read back, and it is listed here so a second one cannot join it quietly.
 */
const DERIVED_ONLY = new Set(['bloomEnabled']);

describe('RenderSettings survives save, publish and export', () => {
    it('writes every declared setting', () => {
        const missing = interfaceKeys().filter(k => !serializedKeys().includes(k));
        expect(missing, `declared on RenderSettings but never written by getRenderSettings: ${missing}`)
            .toEqual([]);
    });

    it('reads back every setting it writes', () => {
        const missing = serializedKeys().filter(k => !appliedKeys().has(k) && !DERIVED_ONLY.has(k));
        expect(missing, `written by getRenderSettings but never restored by applyRenderSettings: ${missing}`)
            .toEqual([]);
    });

    it('writes nothing that is not declared', () => {
        const extra = serializedKeys().filter(k => !interfaceKeys().includes(k));
        expect(extra, `written but not on the interface: ${extra}`).toEqual([]);
    });

    it('carries the settings this roadmap added', () => {
        // A floor under the two structural checks above, which would both pass if the interface and the
        // serializer shrank together.
        const declared = interfaceKeys();
        for (const key of [
            'specularOcclusionEnabled', 'specularAaEnabled', 'horizonOcclusionEnabled',
            'autoExposureEnabled', 'exposureCompensation', 'exposureMinEV', 'exposureMaxEV',
            'exposureSpeedUp', 'exposureSpeedDown',
            'bloomThreshold', 'bloomKnee', 'bloomIntensity', 'bloomMaskEnabled',
        ]) expect(declared, `${key} is not a persisted render setting`).toContain(key);
    });

    it('does not persist the debug channel', () => {
        // `debugView` blits an internal buffer instead of the frame. It is a way of LOOKING at a scene,
        // not part of it, and a published game that opened on the normal channel would be a bug.
        expect(serializedKeys()).not.toContain('debugView');
        expect(interfaceKeys()).not.toContain('debugView');
    });
});

describe('the editor notifies when a render setting changes', () => {
    const PANEL = readFileSync(join(__dirname, '..', 'editor', 'src', 'features', 'renderer',
                                    'RendererSettingsPanel.tsx'), 'utf-8');

    it('marks the scene dirty from every handler that writes to the renderer', () => {
        // Writing `renderer.x = v` mutates the engine directly and emits nothing, so without this the
        // setting is correct on screen and gone after a refresh — saved only if some unrelated edit
        // happened to mark the scene dirty first.
        const handlers = PANEL.match(/onChange=\{\([a-zA-Z]*\) => \{[^{}]*\}\}/g) ?? [];
        const writing = handlers.filter(h => h.includes('renderer.'));
        expect(writing.length).toBeGreaterThan(40);
        const silent = writing.filter(h => !h.includes('touch()'));
        expect(silent, `handlers that change a setting without marking the scene dirty: ${silent}`)
            .toEqual([]);
    });

    it('marks dirty through the same event the rest of the editor uses', () => {
        // `SCENE_CHANGED` is what EngineContext subscribes to in order to call `markTabDirty`;
        // `SceneSettings` marks the clear colour the same way.
        expect(PANEL).toContain("eventEmitter?.emit('SCENE_CHANGED')");
    });
});

describe('nothing between the ends drops a key', () => {
    const BUILD = readFileSync(join(__dirname, '..', 'editor', 'src', 'features', 'publish',
                                    'buildGameData.ts'), 'utf-8');

    it('publishes the settings object wholesale rather than key by key', () => {
        // The moment this becomes a hand-listed set of fields, every future setting ships missing from
        // published games and nothing says so.
        expect(BUILD).toContain('render: sources.settings');
    });
});

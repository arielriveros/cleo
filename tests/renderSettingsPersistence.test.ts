import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every renderer setting has to survive a refresh, a publish and an export — and the way it fails is
 * silent.
 *
 * The chain is: `Renderer.getRenderSettings()` produces a `RenderSettings`; `saveCurrentScene` folds it
 * into the scene blob as `config.render`; `applyGameData` and the standalone player hand it back to
 * `applyRenderSettings()`. Nothing in the middle whitelists keys — `buildGameData` assigns
 * `config.render = sources.settings` wholesale — so the only place a setting can fall out is at the two
 * ends.
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

// Line endings normalized on the way in. `blockAfter` closes a block on a literal LF-indent-brace-LF,
// and a checkout with `core.autocrlf=true` — any default Windows clone — hands back CRLF, which never
// matches. `appliedKeys` then came back empty and this file went red on the developer's machine while
// staying green in CI, which is the wrong way round for a guard whose whole job is to catch a setting
// someone forgot to wire up locally.
const RENDERER = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8')
    .replace(/\r\n/g, '\n');

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
            'toneMapper', 'colorGradingLut', 'colorGradingIntensity',
            'taaEnabled',
        ]) expect(declared, `${key} is not a persisted render setting`).toContain(key);
    });

    it('does not persist which host is allowed to meter', () => {
        // `exposureMeteringAllowed` is view state, like `debugView`: the editor suppresses metering on
        // preview tabs, and that must not be written into the project or a scene saved from a material
        // tab would come back with auto-exposure disabled.
        expect(serializedKeys()).not.toContain('exposureMeteringAllowed');
        expect(interfaceKeys()).not.toContain('exposureMeteringAllowed');
    });

    it('does not persist whether a host runs post-processing', () => {
        // Same class as the two above. The editor suppresses the post chain on preview tabs so a
        // material sphere is judged on the material rather than on the scene's bloom and grain; saving
        // from one must not bank that, or the project would come back with its whole look switched off
        // and nothing in the settings panel to explain it.
        expect(serializedKeys()).not.toContain('postProcessingAllowed');
        expect(interfaceKeys()).not.toContain('postProcessingAllowed');
    });

    it('does not persist the debug channel', () => {
        // `debugView` blits an internal buffer instead of the frame. It is a way of LOOKING at a scene,
        // not part of it, and a published game that opened on the normal channel would be a bug.
        expect(serializedKeys()).not.toContain('debugView');
        expect(interfaceKeys()).not.toContain('debugView');
    });

    it('does not persist the value-validity overlay', () => {
        // `debugValidity` paints NaN/Inf/illegal-negative texels over the selected channel. Same class
        // as `debugView`, and it shares that channel's exemption from the dirty-marking rule below:
        // its handler deliberately does not call `touch()`, because there is nothing to save.
        expect(serializedKeys()).not.toContain('debugValidity');
        expect(interfaceKeys()).not.toContain('debugValidity');
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
        expect(BUILD).toContain('config.render = sources.settings');
    });

    it('writes an input map into the same config block', () => {
        // Bindings ship beside the render look, and only when they differ from the shipped defaults —
        // an untouched project must not gain an input block in its build.
        expect(BUILD).toContain('config.input = sources.input');
        expect(BUILD).toContain('isDefaultInputMap');
    });
});

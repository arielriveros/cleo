import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_POST_CHAIN } from '../src/graphics/renderGraph/chain';

/**
 * Four effects were added to the default post chain — depth of field, lens flare, vignette and film
 * grain — and the promise made when they were is that no existing project's image changed.
 *
 * That promise rests entirely on them shipping OFF. `DEFAULT_POST_CHAIN` is what every camera that has
 * never been reordered runs, so a newcomer whose default intensity was non-zero would silently restyle
 * every scene in every project at once, with nothing in any saved file having changed to explain it.
 * Nobody would connect the two.
 *
 * The second half is the build-time gate. `_buildPostGraph` adds a pass only if the effect will
 * actually do something, and for the ping-pong effects that is not an optimisation: skipping a pass
 * that was going to write the next chain buffer leaves the stage after it reading one nothing filled,
 * and a framebuffer keeps its contents, so the frame comes back holding the previous one rather than
 * failing. An effect gated by an early return INSIDE its body instead would produce exactly that.
 *
 * Source-text scanning, for the reason `renderSettingsPersistence` gives: constructing a Renderer
 * needs a GPU.
 */

const RENDERER = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8')
    .replace(/\r\n/g, '\n');

/** The initializer of a `private _name... = value;` field declaration. */
function fieldDefault(name: string): string {
    const match = RENDERER.match(new RegExp(`private _${name}\\s*:\\s*[A-Za-z<>|\\[\\] ]+ = ([^;]+);`));
    expect(match, `no default found for _${name}`).toBeTruthy();
    return match![1].trim();
}

describe('effects added after the render graph ship switched off', () => {
    it.each([
        ['dofEnabled', 'false'],
        ['lensFlareIntensity', '0.0'],
        ['lensDirtIntensity', '0.0'],
        ['vignetteStrength', '0.0'],
        ['filmGrainIntensity', '0.0'],
    ])('%s defaults to %s', (field, expected) => {
        expect(fieldDefault(field)).toBe(expected);
    });

    it('leaves the three original effects at the values they already had', () => {
        // Guards the other direction. These are the defaults the engine shipped with BEFORE the four
        // newcomers were added — bloom has always been on, chromatic aberration has always been off —
        // and changing either would restyle every existing project just as surely as a new effect
        // defaulting on would. They are pinned here because they are now easy to edit by accident:
        // they sit in the same block as the five fields above.
        expect(fieldDefault('bloomIntensity')).toBe('0.35');
        expect(fieldDefault('chromaticAberrationStrength')).toBe('0.0');
    });

    it('ships a lens dirt mask but not the effect', () => {
        // The polarity that makes this work: null means the BUILT-IN mask rather than "no texture", so
        // turning the intensity up needs no import — but the intensity is what is off.
        expect(fieldDefault('lensDirtTexture')).toBe('null');
        expect(fieldDefault('lensDirtIntensity')).toBe('0.0');
    });
});

describe('every chain effect is gated where the ping-pong is decided', () => {
    /** The body of `_buildPostGraph`, which is where an effect earns a pass or is skipped. */
    const GRAPH = (() => {
        const start = RENDERER.indexOf('private _buildPostGraph(');
        expect(start, '_buildPostGraph not found').toBeGreaterThan(-1);
        const end = RENDERER.indexOf('\n    }\n', start);
        return RENDERER.slice(start, end);
    })();

    it.each([
        ['depthOfField', '_dofEnabled'],
        ['lensFlare', '_lensFlareIntensity'],
        ['vignette', '_vignetteStrength'],
        ['filmGrain', '_filmGrainIntensity'],
        ['bloom', '_bloomIntensity'],
        ['chromatic', '_chromaticAberrationStrength'],
    ])('%s is gated on %s at build time', (effect, field) => {
        const at = GRAPH.indexOf(`entry.effect === '${effect}'`);
        expect(at, `${effect} has no branch in _buildPostGraph`).toBeGreaterThan(-1);
        // The gate has to be in the branch, before the pass is added — not inside the pass body.
        const branch = GRAPH.slice(at, GRAPH.indexOf('graph.addPass', at));
        expect(branch, `${effect} is not gated on ${field} before adding its pass`).toContain(field);
        expect(branch).toContain('continue;');
    });

    it('gives every built-in effect a branch', () => {
        // A chain entry with no branch is not an error anywhere — `resolvePostChain` happily returns
        // it and the loop silently falls through, so the effect simply never runs and the panel row
        // does nothing when dragged.
        for (const effect of DEFAULT_POST_CHAIN)
            expect(GRAPH, `no branch for '${effect}'`).toContain(`entry.effect === '${effect}'`);
    });

    it('skips the whole chain on a preview surface, but keeps the anchors', () => {
        // A material sphere or a model tab shows the ASSET, not the project's look — bloom, depth of
        // field, a vignette and grain are all reasons a material would not look like itself.
        //
        // The anchors have to survive it. `compose` is what puts the scene INTO the chain, and
        // `present` is the display resolve; skipping either leaves a black viewport rather than an
        // un-post-processed one, which is the failure this shape is arranged to avoid.
        expect(GRAPH).toContain('_postProcessingAllowed');
        const gate = GRAPH.slice(GRAPH.indexOf('const chain ='), GRAPH.indexOf('for (const entry of chain)'));
        expect(gate).toContain('_postProcessingAllowed');
        // Motion blur IS the compose step when it runs, so it is gated on the same flag rather than
        // left to the loop that no longer executes.
        const head = GRAPH.slice(GRAPH.indexOf('const blur ='), GRAPH.indexOf("id: 'compose'"));
        expect(head).toContain('_postProcessingAllowed');
        // ...and the two anchors are added outside the loop, so nothing about them depends on it.
        for (const anchor of ["id: 'compose'", "id: 'present'"])
            expect(GRAPH.indexOf(anchor)).toBeGreaterThan(-1);
        expect(GRAPH.indexOf("id: 'compose'")).toBeLessThan(GRAPH.indexOf('for (const entry of chain)'));
        expect(GRAPH.indexOf("id: 'present'")).toBeGreaterThan(GRAPH.indexOf('for (const entry of chain)'));
    });

    it('leaves antialiasing out of the post chain entirely', () => {
        // The one effect a preview KEEPS. TAA resolves at the temporal boundary inside the scene
        // render, not in the chain, which is what lets the chain be switched off wholesale without
        // taking antialiasing with it. If a `taa` branch ever appears here, that stops being true.
        expect(GRAPH).not.toContain("entry.effect === 'taa'");
        expect(RENDERER).toContain('private _taaResolvePass()');
    });

    it('advances the ping-pong only for effects that consume a chain stage', () => {
        // God rays and lens flare composite additively INTO the stage they read, so they must not
        // advance `src`. If they did, the next effect would read a buffer nothing had written.
        for (const inPlace of ['godRays', 'lensFlare']) {
            const at = GRAPH.indexOf(`entry.effect === '${inPlace}'`);
            const branch = GRAPH.slice(at, GRAPH.indexOf('continue;', GRAPH.indexOf('graph.addPass', at)));
            expect(branch, `${inPlace} declares itself in-place`).toContain('readWrites');
            expect(branch, `${inPlace} must not advance the ping-pong`).not.toContain('src = to');
        }
    });
});

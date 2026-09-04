import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which passes rasterize with the TAA jitter, and which do not.
 *
 * This is the most load-bearing test in the TAA work, and it exists because the GPU harness that would
 * otherwise have caught this class of mistake was deleted. The rule is simple to state and impossible
 * to see in a screenshot until it is wrong in a specific way:
 *
 *   - A pass that draws into the image TAA resolves MUST jitter, or its samples all land on the pixel
 *     centre and there is nothing to accumulate — TAA then softens the image and antialiases nothing.
 *   - A pass drawn AFTER the resolve must NOT jitter, because nothing downstream will average its
 *     sub-pixel offsets back out. It simply shimmers, every frame, forever.
 *
 * In practice every camera-projection site calls `_rasterProjection` and the `_taaJitterActive` flag —
 * cleared the moment the resolve runs — decides. That is deliberate: `_renderModel` alone serves the
 * forward-opaque queue, the transparent queue and the probe capture, and the right answer differs for
 * all three, so no list of call sites can express it. What this test pins is the SET of sites, so a
 * new one cannot be added without someone deciding which side of the boundary it is on.
 */

const RENDERER = readFileSync(join(__dirname, '../src/graphics/renderer.ts'), 'utf8')
    .replace(/\r\n/g, '\n');

/** The method a source offset sits inside, by the nearest preceding member declaration. */
function enclosingMethod(source: string, index: number): string {
    const head = source.slice(0, index);
    const declarations = [...head.matchAll(
        /^    (?:private|public|protected)(?: static)? (?:get |set )?(_?[A-Za-z0-9_]+)\s*[(<]/gm)];
    return declarations.length ? declarations[declarations.length - 1][1] : '<none>';
}

/** Every method containing at least one `this.<call>(`, with how many. */
function callers(call: string): Map<string, number> {
    const needle = `this.${call}(`;
    const found = new Map<string, number>();
    let at = RENDERER.indexOf(needle);
    while (at !== -1) {
        const method = enclosingMethod(RENDERER, at);
        found.set(method, (found.get(method) ?? 0) + 1);
        at = RENDERER.indexOf(needle, at + needle.length);
    }
    return found;
}

describe('the camera projection reaches every pass through one wrapper', () => {
    it('leaves no camera-projection site on the unjittered path', () => {
        // The whole design rests on this being zero. A site left on `_clipProjection` is one that can
        // never jitter, whichever side of the resolve it is on — and if it is on the near side, TAA
        // silently degrades to a blur over that geometry.
        expect(RENDERER.split('this._clipProjection(this._activeCamera.projectionMatrix)').length - 1)
            .toBe(0);
    });

    it('routes exactly these methods through _rasterProjection', () => {
        // Adding a method here is a decision, not a formality: check where the new pass sits relative
        // to `_taaResolvePass` before you add it. Everything below the resolve is drawn on top of the
        // resolved image and must come out unjittered.
        expect([...callers('_rasterProjection').keys()].sort()).toEqual([
            // --- Before the resolve: these ARE the TAA input, and must jitter. ---
            '_drawGeometryNode',      // all deferred opaques, terrain included
            '_drawInstancedGroup',    // twice: the RHI branch and the legacy one
            '_drawSky',               // the horizon aliases harder than anything else in a scene
            '_foliagePass',
            // Its draws depth-test `less-equal` against the JITTERED depth buffer; unjittered here and
            // every mover's velocity is rejected or smeared by half a pixel at its own silhouette.
            '_objectVelocityPass',
            '_renderModel',           // forward opaque (jitters) AND transparents (does not)

            // --- After the resolve: the flag is already false, and these must stay put. ---
            '_drawSkeletonOverlay',
            '_drawTileBand',
            // The overlay layer's per-mesh draw, shared by the gizmo and helper sub-passes. It is
            // composited after the post chain, so it is further from the jitter than anything else here.
            '_drawOverlayNode',
            '_overdrawPass',
            '_renderSelectionMask',
            '_renderSprite',
        ].sort());
    });

    it('keeps the light-space and capture projections off the jittered path entirely', () => {
        // These never see `camera.projectionMatrix`. Shadow cascades are fitted from the camera's fov
        // and position rather than its matrix, and `_captureProj` is a fixed 90-degree square face —
        // so both are immune by construction rather than by being excluded, and jittering either would
        // move shadows and probe captures against the image instead of with it.
        expect([...callers('_clipProjection').keys()].sort()).toEqual([
            '_bakeSkyAtmosphere',     // _captureProj
            '_convolveCubeFaces',     // _captureProj
            '_foliageShadowPass',     // lightSpace
            '_rasterProjection',      // the wrapper's own two returns
            '_renderShadowCasters',   // lightSpace
        ].sort());
    });

    it('clears the jitter at the temporal boundary, in both pipelines', () => {
        // Deferred goes through `_renderForwardOverlay`, forward through `_renderScene`, and they are
        // separate functions with separate insertion points. One wired and the other not would leave
        // half the pipelines shimmering.
        expect(RENDERER.split('this._endJitterPhase();').length - 1).toBe(2);
        expect(RENDERER.split('this._taaResolvePass();').length - 1).toBe(2);
        expect(RENDERER.split('this._produceVelocity();').length - 1).toBe(2);
    });

    it('gates the jitter and the resolve on the same flag', () => {
        // A jittered image that nothing resolves is strictly worse than no TAA: it is the same
        // aliasing, now crawling. One field decides both.
        expect(RENDERER).toContain('if (!this._taaJitterActive || this._cubeFaceCapture');
        expect(RENDERER).toContain('if (!this._taaJitterActive || !this._velocityProducedThisFrame) return;');
    });
});

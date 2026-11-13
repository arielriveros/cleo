import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rendererSource, expectAbsent } from './helpers/rendererSource';

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
 * cleared the moment the resolve runs — decides. That is deliberate: `ModelDraw.beginModel` alone serves the
 * forward-opaque queue, the transparent queue and the probe capture, and the right answer differs for
 * all three, so no list of call sites can express it. What this test pins is the SET of sites, so a
 * new one cannot be added without someone deciding which side of the boundary it is on.
 */

const RENDERER = rendererSource()
    .replace(/\r\n/g, '\n');

/** The method a source offset sits inside, by the nearest preceding member declaration. */
function enclosingMethod(source: string, index: number): string {
    const head = source.slice(0, index);
    const declarations = [...head.matchAll(
        /^    (?:private|public|protected)(?: static)? (?:get |set )?(_?[A-Za-z0-9_]+)\s*[(<]/gm)];
    return declarations.length ? declarations[declarations.length - 1][1] : '<none>';
}

/**
 * Every method calling the projection helper `call`, with how many: `this._projection.<call>(` from the
 * renderer, `this.<call>(` from inside ViewProjection itself.
 */
function callers(call: string): Map<string, number> {
    const found = new Map<string, number>();
    for (const m of RENDERER.matchAll(new RegExp(`this\\.(?:_projection\\.)?${call}\\(`, 'g'))) {
        const method = enclosingMethod(RENDERER, m.index!);
        found.set(method, (found.get(method) ?? 0) + 1);
    }
    return found;
}

describe('the camera projection reaches every pass through one wrapper', () => {
    it('leaves no camera-projection site on the unjittered path', () => {
        // The whole design rests on this being zero. A site left on `_clipProjection` is one that can
        // never jitter, whichever side of the resolve it is on — and if it is on the near side, TAA
        // silently degrades to a blur over that geometry.
        // Anchored on the jittered call, so a rename of the camera field cannot make this pass vacuously.
        expectAbsent(RENDERER, 'this._projection.clipProjection(this._view.camera.projectionMatrix)',
                     'this._projection.rasterProjection(this._view.camera.projectionMatrix)');
    });

    it('routes exactly these methods through _rasterProjection', () => {
        // Adding a method here is a decision, not a formality: check where the new pass sits relative
        // to the TAA resolve (`TemporalPasses.taaResolvePass`) before you add it. Everything below the resolve is drawn on top of the
        // resolved image and must come out unjittered.
        expect([...callers('rasterProjection').keys()].sort()).toEqual([
            // --- Before the resolve: these ARE the TAA input, and must jitter. ---
            '_drawInstancedGroup',
            // Every deferred opaque (terrain included) AND every forward model: ModelDraw.beginModel sets the
            // projection for both, so forward opaques jitter and transparents, drawn after the resolve, do not.
            'beginModel',
            '_drawSky',               // the horizon aliases harder than anything else in a scene
            'foliagePass',
            '_drawOctahedralImpostors',   // the foliage pass's impostor bucket, inside it
            // A GI Volume capture face's plants (FoliagePasses.drawCapture): drawn while `_view.capturing`,
            // which the wrapper answers with the unjittered projection, as every capture draw.
            'drawCapture',
            // Occlusion query boxes, tested against the jittered G-buffer depth they must agree with.
            'gpuOcclusionPass',
            // Its draws depth-test `less-equal` against the JITTERED depth buffer; unjittered here and
            // every mover's velocity is rejected or smeared by half a pixel at its own silhouette.
            '_objectVelocityPass',
            // The landscape-only depth decals with `receivers: 'terrain'` compare against. It must jitter
            // exactly like the G-buffer and scene depth it is compared with, or the two disagree by a
            // TAA offset at every slope and the brush frays.
            'decalReceiverPass',
            // Every decal box: the DBuffer and emissive passes (before the resolve, jittered) AND the
            // editor overlay (after it, not) — the `beginModel` situation, decided by the flag.
            '_setDecalUniforms',

            // --- After the resolve: the flag is already false, and these must stay put. ---
            '_drawSkeletonOverlay',
            // The editor's GI probe spheres, in the overlay layer like the skeleton.
            'drawProbeOverlay',
            '_drawTileBand',
            // A helper with a coplanar depth nudge reaches `_rasterProjection` through this thin wrapper
            // (ModelDraw.beginModel calls it only when the nudge is non-zero); every other overlay draw goes
            // through beginModel's own raster call. Either way the jitter semantics are unchanged: the
            // overlay is composited after the post chain, so it is further from the jitter than anything
            // else here.
            'nudgedProjection',
            'overdrawPass',
            // A viewmodel's projection (Node.viewmodel): the raster projection, then the camera's viewmodel
            // matrix. Reached from ModelDraw.beginModel and the velocity pass for a flagged node only, so it
            // jitters on the same side of the resolve as the model it serves.
            'viewmodelProjection',
            // GPU particles: drawn after the transparents, in both pipelines and in the 2D pass.
            'particleDrawFrame',
            // Smoke-and-fire volumes, ray-marched over the resolved image (`FluidVolumePasses.renderFluidVolumes`).
            'renderFluidVolumes',
            'renderSelectionMask',
            // The batched sprite pass's raster projection, taken once per draw list (scene sprites and the
            // editor's icons, both after the resolve): every batch draws through it, and the batch planner
            // compares screen rectangles projected through it, so they match what the GPU rasterizes.
            '_beginList',
        ].sort());
    });

    it('keeps the light-space and capture projections off the jittered path entirely', () => {
        // These never see `camera.projectionMatrix`. Shadow cascades are fitted from the camera's fov
        // and position rather than its matrix, and `_captureProj` is a fixed 90-degree square face —
        // so both are immune by construction rather than by being excluded, and jittering either would
        // move shadows and probe captures against the image instead of with it.
        expect([...callers('clipProjection').keys()].sort()).toEqual([
            'convolveCubeFaces',      // _captureProj
            '_drawImpostorShadows',   // lightSpace
            'foliageShadowPass',      // lightSpace
            'rasterProjection',       // the wrapper's own two returns
            '_renderAtmosphereFaces', // _captureProj (the sky bake and the cloud-sky bake)
            '_renderShadowCasters',   // lightSpace
        ].sort());
    });

    it('clears the jitter at the temporal boundary, in both pipelines', () => {
        // Deferred goes through `renderForwardOverlay`, forward through `renderScene`, and they are
        // separate functions with separate insertion points. One wired and the other not would leave
        // half the pipelines shimmering.
        expect(RENDERER.split('this._projection.endJitterPhase();').length - 1).toBe(2);
        expect(RENDERER.split('this._temporal.taaResolvePass();').length - 1).toBe(2);
        expect(RENDERER.split('this._temporal.produceVelocity();').length - 1).toBe(2);
    });

    it('gates the jitter and the resolve on the same flag', () => {
        // A jittered image that nothing resolves is strictly worse than no TAA: it is the same
        // aliasing, now crawling. One field decides both.
        expect(RENDERER).toContain('if ((!this._view.taaJitterActive && !this._view.movieJitter) || this._view.cubeFace');
        expect(RENDERER).toContain('if (!this._view.taaJitterActive || !this.velocityProducedThisFrame) return;');
        // The one other jitter is a movie sample's (render/movieCapture.ts), which nothing resolves BY
        // DESIGN: the movie averages its samples instead. It never turns the resolve on.
        expect(RENDERER).not.toMatch(/movieJitter.*velocityProducedThisFrame/);
    });
});

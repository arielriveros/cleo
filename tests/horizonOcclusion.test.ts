import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Horizon occlusion and the geometric normal it is measured against, ported to JS.
 *
 * Two things here are easy to get wrong and invisible once wrong.
 *
 * The first is that horizon occlusion is a comparison between TWO normals. Fed the shading normal
 * twice it is identically 1 — `reflect` cannot send a ray below the normal it reflected about — so a
 * wiring mistake that passes `N` where `Ng` belongs does not crash, does not look odd, and silently
 * disables the feature. `identityWhenNormalsAgree` is the test that would catch that.
 *
 * The second is the neighbour choice in the depth reconstruction. A plain forward difference straddles
 * silhouettes: one of the two neighbours belongs to whatever is BEHIND the object, and the plane
 * through that pair is nearly edge-on to the camera, which drives `dot(R, Ng)` hard negative and paints
 * a black outline around everything. The min-abs rule is what avoids it, and it is four lines that look
 * arbitrary until the failure is described.
 */

const HORIZON_FADE = 1.3;

/** `horizonOcclusion` from chunks/pbrLighting.wgsl. */
function horizonOcclusion(R: [number, number, number], Ng: [number, number, number]): number {
    const h = Math.min(1, Math.max(0, 1 + HORIZON_FADE * dot(R, Ng)));
    return h * h;
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: number[]): [number, number, number] => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
};
/** `reflect(-V, N)` — the same expression both shaders pass in. */
const reflectRay = (V: [number, number, number], N: [number, number, number]): [number, number, number] => {
    const I: [number, number, number] = [-V[0], -V[1], -V[2]];
    const d = 2 * dot(I, N);
    return norm([I[0] - d * N[0], I[1] - d * N[1], I[2] - d * N[2]]);
};

describe('horizon occlusion', () => {
    it('is identically 1 when the two normals agree', () => {
        // The property that makes a mis-wiring silent, asserted so it cannot be mistaken for coverage.
        // Any view direction, any normal: if Ng is the normal the ray was reflected about, the ray is
        // in the upper hemisphere by construction and there is nothing to occlude.
        for (const N of [norm([0, 1, 0]), norm([1, 2, 3]), norm([-4, 1, 0.2])])
            for (const V of [norm([0, 1, 0.2]), norm([1, 0.15, 0]), norm([-2, 0.3, 1])]) {
                if (dot(V, N) <= 0) continue;                       // not a visible surface
                expect(horizonOcclusion(reflectRay(V, N), N)).toBeCloseTo(1, 12);
            }
    });

    it('is zero once the ray is far enough under the surface', () => {
        // The knee is at the horizon but the ZERO is at dot = -1/HORIZON_FADE = -0.769, so a ray only
        // 45 degrees under (dot -0.707) is still faintly reflective. That gap is the fade.
        const Ng = norm([0, 1, 0]);
        expect(horizonOcclusion(norm([0, -1, 0]), Ng)).toBe(0);
        expect(horizonOcclusion(norm([1, -3, 0]), Ng)).toBe(0);
        expect(horizonOcclusion(norm([1, -1, 0]), Ng)).toBeGreaterThan(0);
    });

    it('is still 1 at the horizon itself, and falls only below it', () => {
        // `1.0 +` places the knee AT the horizon: a ray exactly along the surface is not occluded, and
        // dropping the `1.0` (or flipping the sign of the dot) would darken every grazing reflection in
        // the scene instead of only the ones that have gone under.
        const Ng = norm([0, 1, 0]);
        expect(horizonOcclusion(norm([1, 0, 0]), Ng)).toBeCloseTo(1, 12);
        expect(horizonOcclusion(norm([1, 0.3, 0]), Ng)).toBeCloseTo(1, 12);
        expect(horizonOcclusion(norm([1, -0.3, 0]), Ng)).toBeLessThan(1);
    });

    it('joins full occlusion smoothly, and the horizon steeply', () => {
        // WHICH END the square smooths is the thing to be exact about, because the intuition points the
        // wrong way. `h * h` has zero slope at h = 0, so the fade meets the fully-occluded region
        // without a crease; at h = 1 it is twice as steep as a linear ramp. A previous version of this
        // file — and of the comment in the shader — claimed the opposite.
        const at = (d: number) => { const h = Math.min(1, Math.max(0, 1 + HORIZON_FADE * d)); return h * h; };
        const nearZero = at(-0.70) - at(-0.75);
        const middle = at(-0.35) - at(-0.40);
        const atHorizon = at(0) - at(-0.05);
        expect(nearZero).toBeLessThan(middle / 5);
        expect(atHorizon).toBeGreaterThan(middle);
    });

    it('is monotonic in how far under the ray has gone', () => {
        const Ng = norm([0, 1, 0]);
        let prev = 2;
        for (const y of [0.2, 0.05, 0, -0.05, -0.2, -0.5, -1]) {
            const v = horizonOcclusion(norm([1, y, 0]), Ng);
            expect(v).toBeLessThanOrEqual(prev + 1e-12);
            prev = v;
        }
    });

    it('fires on a normal map, which is the case it exists for', () => {
        // The tilt has to be SIDEWAYS, and finding that out is half the value of writing this down.
        // Tilting the shading normal toward the viewer sends the reflection up, not down; tilting it
        // away sends the surface back-facing, which is a degenerate case rather than the one this term
        // is for. A tilt across the view leaves the surface front-facing (dot(V, N) > 0) while
        // collapsing the reflection's elevation, which is exactly what a bumpy map does at a slope.
        const Ng = norm([0, 1, 0]);
        const N = norm([0.95, 0.312, 0]);              // ~72 degrees off the surface normal
        const V = norm([0, 0.5, 0.866]);               // 60 degrees off vertical
        const R = reflectRay(V, N);
        expect(dot(V, N)).toBeGreaterThan(0);          // still a front-facing surface
        expect(dot(R, Ng)).toBeLessThan(0);            // and the ray really is under it
        expect(horizonOcclusion(R, Ng)).toBeLessThan(0.6);
        expect(horizonOcclusion(R, N)).toBeCloseTo(1, 12);   // invisible without the second normal
    });
});

describe('the depth-reconstructed geometric normal', () => {
    /** The min-abs neighbour choice from `geometricNormal` in deferredLighting.wgsl. */
    const choose = (centre: number, back: number, forward: number) =>
        Math.abs(back - centre) < Math.abs(forward - centre) ? 'back' : 'forward';

    it('picks the neighbour on this surface at a silhouette', () => {
        // Centre sits on an object at depth 0.30. Its left neighbour is still on the object; its right
        // neighbour has fallen off onto a distant wall. Taking the right one would build a plane
        // spanning 0.30 to 0.95 — nearly edge-on, and a black outline around the object.
        expect(choose(0.30, 0.301, 0.95)).toBe('back');
        expect(choose(0.30, 0.95, 0.301)).toBe('forward');
    });

    it('is a free choice in the interior, where both neighbours are equally good', () => {
        // On a smooth surface the two are symmetric to floating-point noise; either is correct, which
        // is why the rule can be a strict `<` without a tolerance.
        expect(['back', 'forward']).toContain(choose(0.5, 0.499, 0.501));
    });

    it('does not depend on which side is nearer the camera', () => {
        // The test is on |delta|, not on sign. A centre at the far edge of a foreground object has its
        // off-surface neighbour NEARER, not further, and the rule has to reject it just the same.
        expect(choose(0.60, 0.601, 0.10)).toBe('back');
        expect(choose(0.60, 0.10, 0.601)).toBe('forward');
    });
});

describe('the shaders it was ported from', () => {
    const CHUNK = readFileSync(
        join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks', 'pbrLighting.wgsl'), 'utf-8');
    const DEFERRED = readFileSync(
        join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'deferredLighting.wgsl'), 'utf-8');
    const FORWARD = readFileSync(
        join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks', 'pbrForward.wgsl'), 'utf-8');

    it('keeps the knee at the horizon and squares the fade', () => {
        expect(CHUNK).toContain('saturate(1.0 + HORIZON_FADE * dot(R, Ng))');
        expect(CHUNK).toContain('return horizon * horizon;');
        expect(CHUNK).toContain(`HORIZON_FADE: f32 = ${HORIZON_FADE}`);
    });

    it('passes a SECOND normal on both paths', () => {
        // `horizonOcclusion(reflect(-V, N), N)` would compile, run, and do nothing at all.
        expect(DEFERRED).toContain('horizonOcclusion(reflect(-V, N), Ng)');
        expect(FORWARD).toContain('horizonOcclusion(reflect(-V, N), Ng)');
        expect(DEFERRED).toContain('let Ng = geometricNormal(uv, depth, worldPos);');
        expect(FORWARD).toContain('var Ng = normalize(tbnOf(in)[2]);');
    });

    it('flips the forward geometric normal for a back face', () => {
        // Without it, every double-sided leaf seen from behind reflects along a ray the shader thinks
        // is underground, and loses its specular entirely.
        const block = FORWARD.slice(FORWARD.indexOf('var Ng = normalize(tbnOf(in)[2]);'));
        expect(block.slice(0, 200)).toContain('if (!front) { Ng = -Ng; }');
    });

    it('orients the reconstructed normal by the viewer, not by a winding rule', () => {
        expect(DEFERRED).toContain('dot(n, toEye) >= 0.0');
    });

    it('guards the reconstruction against a degenerate pair', () => {
        expect(DEFERRED).toContain('if (dot(n, n) < 1e-20)');
    });

    it('applies to the specular factor only', () => {
        // Never to `diffuseAO`: a reflection ray is not a statement about the diffuse lobe, which has
        // no single direction to compare against.
        for (const src of [DEFERRED, FORWARD])
            expect(src).toContain('specularAO *= horizonOcclusion(');
    });
});

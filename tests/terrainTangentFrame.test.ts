import { describe, expect, it, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { Terrain } from '../src/terrain/terrain';

/**
 * Terrain's tangent frame has to agree with terrain's UV CHART, and those are two different claims.
 *
 * The chart is left-handed: `_buildChunkGeometry` writes `u -> +X`, `v -> +Z` with `N = +Y`, so
 * `dP/du x dP/dv = X x Z = -Y = -N`. Meanwhile `chunks/modelVarying.wgsl` negates the bitangent
 * unconditionally, for the convention mesh importers produce:
 *
 *     (*out).bitangent = normalize((model * vec4<f32>(-bitangent, 0.0)).xyz);
 *
 * So whatever terrain pushes is flipped before the shader sees it, and terrain used to push `+Z`. That
 * landed `tbn[1]` on `-dP/dv`, and `addLayer` decodes its normal map with a plain `* 2 - 1` into that
 * basis — so the GREEN CHANNEL drove the shading normal against the direction v increases. That is the
 * OpenGL/DirectX green flip: every bump renders as a dent, in place, wherever the normal map carries the
 * relief rather than the vertices. On a landscape that is everywhere past a few metres.
 *
 * THE TEST THAT MATTERS IS THE SECOND ONE. The broken frame was still right-handed with respect to the
 * normal — `T x B = +N` held throughout — so a handedness check alone passes and always did. What it was
 * not is aligned with the chart. Both are asserted below, and the first is kept precisely to show it is
 * not sufficient.
 */

beforeAll(() => {
    let n = 0;
    const constants: Record<string, number> = {
        UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
    };
    const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
    const gl = new Proxy({}, {
        get: (_t, key: string) => (key in constants ? constants[key]
            : objects.has(key) ? () => ({ id: ++n }) : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];

/** The frame the SHADER sees: `modelVarying` negates the bitangent attribute on the way through. */
const shaderFrame = (t: Terrain, vertex = 0) => {
    const g = (t as any)._chunks[0].model.geometry;
    const at = (arr: ArrayLike<number>, i: number) => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
    return {
        tangent: at(g.tangents, vertex),
        bitangent: at(g.bitangents, vertex).map((v: number) => -v),   // the negation, applied
        normal: at(g.normals, vertex),
    };
};

/** `dP/dv` measured from the geometry itself: two vertices one row apart, over their uv delta. */
const chartDpDv = (t: Terrain) => {
    const g = (t as any)._chunks[0].model.geometry;
    const stride = (t as any)._chunkSpan((t as any)._chunks[0]).stride;
    const p = (i: number) => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
    const uv = (i: number) => [g.uvs[i * 2], g.uvs[i * 2 + 1]];
    const a = 0, b = stride;                       // same column, next row
    const dv = uv(b)[1] - uv(a)[1];
    expect(dv, 'the two sampled vertices must differ in v').not.toBe(0);
    const d = [p(b)[0] - p(a)[0], p(b)[1] - p(a)[1], p(b)[2] - p(a)[2]].map(x => x / dv);
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    return d.map(x => x / len);
};

const flat = () => new Terrain({ size: 32, resolution: 17, chunkQuads: 8 });

describe('the terrain tangent frame', () => {
    it('is LEFT-handed with respect to the normal, and that is correct here', () => {
        // Worth pinning because it looks like a bug and is not, and because the opposite was true before
        // the fix. A tangent frame is not obliged to be right-handed — it is obliged to match the chart
        // its normal maps were authored in, and this chart is left-handed. `T x B = -N` is the direct
        // consequence, and a frame that satisfied `T x B = +N` here would be the mirrored one.
        //
        // This is exactly how the fault survived: the old `+Z` bitangent gave `T x B = +N`, so every
        // reflex check for "is the TBN sane" passed while the frame was mirrored against the surface.
        const f = shaderFrame(flat());
        const c = cross(f.tangent, f.bitangent);
        for (let i = 0; i < 3; i++) expect(c[i]).toBeCloseTo(-f.normal[i], 6);
    });

    it('and its bitangent points along the chart\u2019s dP/dv, which is the real guarantee', () => {
        // The one that fails on the old `+Z`. `dP/dv` is measured from the vertices and uvs the geometry
        // actually carries, so this compares the frame against the surface rather than against itself.
        const t = flat();
        const f = shaderFrame(t);
        const dpdv = chartDpDv(t);
        for (let i = 0; i < 3; i++)
            expect(f.bitangent[i], `bitangent must be +dP/dv, not -dP/dv`).toBeCloseTo(dpdv[i], 6);
    });

    it('the chart really is left-handed, which is why the sign needed deciding at all', () => {
        // Stated as a fact about the geometry rather than a comment: `dP/du x dP/dv = -N` here, so the
        // engine-wide negation (written for right-handed importer output) cannot serve terrain unchanged.
        const t = flat();
        const f = shaderFrame(t);
        const dpdv = chartDpDv(t);
        const c = cross(f.tangent, dpdv);
        for (let i = 0; i < 3; i++) expect(c[i]).toBeCloseTo(-f.normal[i], 6);
    });

    it('holds at density > 1, where the vertices are rebuilt', () => {
        // `_rebuildChunksIfDensityChanged` re-runs `_buildChunkGeometry`; the frame is constant per
        // vertex and must survive that.
        const t = flat();
        (t as any)._cfg.targetVertsPerTile = 32;
        const f = shaderFrame(t, 5);
        const dpdv = chartDpDv(t);
        for (let i = 0; i < 3; i++) expect(f.bitangent[i]).toBeCloseTo(dpdv[i], 6);
    });
});

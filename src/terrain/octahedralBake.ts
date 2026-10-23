/**
 * Bake an octahedral impostor on the CPU: N x N orthographic views of a model over the upper hemisphere
 * (octahedralImpostor.ts holds the conventions), written into two atlases.
 *
 * - **Albedo**: sRGB base colour, straight alpha = coverage. UNLIT — the impostor shader writes it into
 *   the G-buffer with the normal below, so a distant tree is lit by the same sun, sky and shadows as the
 *   mesh it replaces rather than by whatever light the bake happened to use.
 * - **Normal**: model-space normal as `n * 0.5 + 0.5`, alpha = an ambient-occlusion estimate (below).
 *
 * ## Why on the CPU
 *
 * The single-card bake renders through the GPU (`bakeModelImpostor`), and both its silent failure modes —
 * an empty capture and an opaque one — came from the capture path, not the framing. This bake needs two
 * unlit channels per view, 64 views, a framing that must match the shader exactly and a result the
 * generator (no GPU) can reproduce. A small rasterizer is the one implementation that serves the editor,
 * the Valley generator and the unit tests alike.
 *
 * Supersampled and box-filtered down, so needle edges get fractional coverage, and each frame is dilated
 * into its empty texels so bilinear filtering at a silhouette never mixes in the background colour.
 */

import {
    frameBasis, frameDirection, OCTA_DEFAULT_FRAMES, type OctahedralImpostorInfo, type V3,
} from './octahedralImpostor';

/** One drawable part of the model: its triangles and how to colour them. */
export interface OctahedralBakePart {
    /** Model-space xyz per vertex. */
    positions: ArrayLike<number>;
    /** xyz per vertex; null derives flat face normals. */
    normals?: ArrayLike<number> | null;
    /** uv per vertex, v = 0 at the TOP row of the image (how the engine samples). */
    uvs?: ArrayLike<number> | null;
    /** Triangle indices; null = consecutive vertex triples. */
    indices?: ArrayLike<number> | null;
    /** Straight-alpha sRGB colour at (u, v) into `out` (r, g, b, a in 0..1). Null = plain `color`. */
    sample?: ((u: number, v: number, out: Float32Array) => void) | null;
    /** Multiplies the sample, sRGB space. Default white. */
    color?: readonly [number, number, number, number];
    /** Alpha below this is a hole (a leaf card's cutout). 0 = opaque. */
    cutoff?: number;
}

export interface OctahedralBakeOptions {
    /** Views per side. */
    frames?: number;
    /** Texels per frame side in the albedo atlas. */
    frameSize?: number;
    /** Texels per frame side in the normal atlas (normals are smooth; half the albedo's is plenty). */
    normalFrameSize?: number;
    /** Samples per texel per axis. */
    supersample?: number;
    /** Dilation passes into each frame's empty texels. */
    dilate?: number;
    /**
     * How far each baked normal leans toward the outward direction from the capture centre, 0..1. 0.6
     * by default, for foliage (see the bake loop); 0 keeps the surface's own normals, for a solid prop.
     */
    roundNormals?: number;
}

export interface OctahedralBakeResult {
    info: OctahedralImpostorInfo;
    /** Albedo atlas, `albedoSize` square, RGBA8. */
    albedo: Uint8ClampedArray;
    albedoSize: number;
    /** Normal atlas, `normalSize` square, RGBA8. */
    normal: Uint8ClampedArray;
    normalSize: number;
    /** Fraction of all frames' texels at or above half coverage — the share the runtime cutout keeps. */
    coverage: number;
}

/** The sphere every frame captures: the box centre, and the farthest vertex from it. */
export function impostorSphere(parts: readonly OctahedralBakePart[]): { center: V3; radius: number } {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of parts) {
        const pos = p.positions;
        for (let i = 0; i + 2 < pos.length; i += 3)
            for (let a = 0; a < 3; a++) { const v = pos[i + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
    }
    if (!(hi[0] >= lo[0])) return { center: [0, 0, 0], radius: 1 };
    const center: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    let r2 = 0;
    for (const p of parts) {
        const pos = p.positions;
        for (let i = 0; i + 2 < pos.length; i += 3) {
            const dx = pos[i] - center[0], dy = pos[i + 1] - center[1], dz = pos[i + 2] - center[2];
            const d = dx * dx + dy * dy + dz * dz;
            if (d > r2) r2 = d;
        }
    }
    // A hair of margin, so a silhouette touching the sphere is not cut by the frame's edge.
    return { center, radius: Math.max(1e-3, Math.sqrt(r2) * 1.02) };
}

/** A bilinear, wrapping sampler over RGBA8 pixels (row 0 = top), for {@link OctahedralBakePart.sample}. */
export function rgbaSampler(data: ArrayLike<number>, width: number, height: number):
        (u: number, v: number, out: Float32Array) => void {
    return (u, v, out) => {
        const x = (u - Math.floor(u)) * width - 0.5, y = (v - Math.floor(v)) * height - 0.5;
        const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
        const xa = ((x0 % width) + width) % width, xb = (xa + 1) % width;
        const ya = ((y0 % height) + height) % height, yb = (ya + 1) % height;
        const i00 = (ya * width + xa) * 4, i10 = (ya * width + xb) * 4, i01 = (yb * width + xa) * 4, i11 = (yb * width + xb) * 4;
        for (let c = 0; c < 4; c++) {
            const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx;
            const bottom = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
            out[c] = (top + (bottom - top) * fy) / 255;
        }
    };
}

/**
 * Bake every frame. Synchronous and allocation-bounded; a few seconds for a 30k-triangle tree at the
 * defaults, so the editor runs it behind a busy indicator.
 */
export function bakeOctahedralImpostor(parts: readonly OctahedralBakePart[],
                                       options: OctahedralBakeOptions = {}): OctahedralBakeResult {
    const N = Math.max(2, Math.min(32, Math.round(options.frames ?? OCTA_DEFAULT_FRAMES)));
    const F = Math.max(8, Math.round(options.frameSize ?? 256));
    const NF = Math.max(4, Math.round(options.normalFrameSize ?? F / 2));
    const ss = Math.max(1, Math.round(options.supersample ?? 2));
    const dilate = Math.max(0, Math.round(options.dilate ?? 4));
    const ROUNDING = Math.max(0, Math.min(1, options.roundNormals ?? 0.6));
    const { center, radius } = impostorSphere(parts);
    const S = F * ss;

    const albedoSize = N * F, normalSize = N * NF;
    const albedo = new Uint8ClampedArray(albedoSize * albedoSize * 4);
    const normal = new Uint8ClampedArray(normalSize * normalSize * 4);

    // Per-sample scratch, reused by every frame.
    const zbuf = new Float32Array(S * S);
    const col = new Float32Array(S * S * 3);
    const nrm = new Float32Array(S * S * 3);
    const ao = new Float32Array(S * S);
    // Per-texel results of one frame, before they are written into the atlases.
    const fCol = new Float32Array(F * F * 4);
    const fNrm = new Float32Array(NF * NF * 4);
    const colFilled = new Uint8Array(F * F), nrmFilled = new Uint8Array(NF * NF);

    // Prepared parts: triangle index lists and per-vertex normals, built once.
    const prepared = parts.map(p => prepare(p));
    const maxVerts = prepared.reduce((m, p) => Math.max(m, p.vertexCount), 0);
    const sx = new Float64Array(maxVerts), sy = new Float64Array(maxVerts), sz = new Float64Array(maxVerts);
    const texel = new Float32Array(4);

    let kept = 0;
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const d = frameDirection(i, j, N);
            const { t, b } = frameBasis(d);
            zbuf.fill(-Infinity);
            const scale = S / (2 * radius);

            for (const p of prepared) {
                const pos = p.positions;
                for (let v = 0; v < p.vertexCount; v++) {
                    const lx = pos[v * 3] - center[0], ly = pos[v * 3 + 1] - center[1], lz = pos[v * 3 + 2] - center[2];
                    // Image right = t, image up = b (so y DOWN the image is -b), depth toward the viewer = d.
                    sx[v] = (lx * t[0] + ly * t[1] + lz * t[2]) * scale + S / 2;
                    sy[v] = S / 2 - (lx * b[0] + ly * b[1] + lz * b[2]) * scale;
                    sz[v] = lx * d[0] + ly * d[1] + lz * d[2];
                }
                const idx = p.indices, uv = p.uvs, nv = p.normals, cutoff = p.cutoff, sample = p.sample, tint = p.color;
                for (let k = 0; k + 2 < idx.length; k += 3) {
                    const a = idx[k], bb = idx[k + 1], c = idx[k + 2];
                    const x0 = sx[a], y0 = sy[a], x1 = sx[bb], y1 = sy[bb], x2 = sx[c], y2 = sy[c];
                    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
                    if (!(Math.abs(area) > 1e-12)) continue;
                    const minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
                    const maxX = Math.min(S - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
                    const minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
                    const maxY = Math.min(S - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
                    if (minX > maxX || minY > maxY) continue;
                    const inv = 1 / area;
                    const z0 = sz[a], z1 = sz[bb], z2 = sz[c];
                    for (let y = minY; y <= maxY; y++) {
                        const py = y + 0.5;
                        for (let x = minX; x <= maxX; x++) {
                            const px = x + 0.5;
                            // Barycentrics of vertices a (w0), b (w1), c (w2).
                            const w1 = ((px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)) * inv;
                            const w2 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) * inv;
                            const w0 = 1 - w1 - w2;
                            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                            const z = w0 * z0 + w1 * z1 + w2 * z2;
                            const s = y * S + x;
                            if (z <= zbuf[s]) continue;
                            let r = tint[0], g = tint[1], bl = tint[2], al = tint[3];
                            if (sample && uv) {
                                const u = w0 * uv[a * 2] + w1 * uv[bb * 2] + w2 * uv[c * 2];
                                const vv = w0 * uv[a * 2 + 1] + w1 * uv[bb * 2 + 1] + w2 * uv[c * 2 + 1];
                                sample(u, vv, texel);
                                r *= texel[0]; g *= texel[1]; bl *= texel[2]; al *= texel[3];
                            }
                            if (cutoff > 0 && al < cutoff) continue;   // a hole: what is behind shows
                            zbuf[s] = z;
                            col[s * 3] = r; col[s * 3 + 1] = g; col[s * 3 + 2] = bl;
                            let nx = w0 * nv[a * 3] + w1 * nv[bb * 3] + w2 * nv[c * 3];
                            let ny = w0 * nv[a * 3 + 1] + w1 * nv[bb * 3 + 1] + w2 * nv[c * 3 + 1];
                            let nz = w0 * nv[a * 3 + 2] + w1 * nv[bb * 3 + 2] + w2 * nv[c * 3 + 2];
                            // The side facing the viewer: a two-sided leaf seen from behind lights as its back,
                            // which is what the G-buffer shader does with a back face (pbrGBuffer.wgsl).
                            if (nx * d[0] + ny * d[1] + nz * d[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
                            const nl = Math.hypot(nx, ny, nz) || 1;
                            // ROUNDED toward the outward direction from the centre. A canopy's leaf normals
                            // point every way and the mesh is lit per leaf, so its tips catch a sun behind
                            // it; averaged into one normal per texel they turn to face the viewer, and a
                            // backlit impostor went black where the mesh it replaced was rimmed with light.
                            // The sphere normal puts the tops and the silhouette back toward the light.
                            const qu = (px - S / 2) / scale, qv = (S / 2 - py) / scale;
                            let ox = t[0] * qu + b[0] * qv + d[0] * z, oy = t[1] * qu + b[1] * qv + d[1] * z;
                            let oz = t[2] * qu + b[2] * qv + d[2] * z;
                            const ol = Math.hypot(ox, oy, oz) || 1;
                            ox /= ol; oy /= ol; oz /= ol;
                            nrm[s * 3] = (1 - ROUNDING) * nx / nl + ROUNDING * ox;
                            nrm[s * 3 + 1] = (1 - ROUNDING) * ny / nl + ROUNDING * oy;
                            nrm[s * 3 + 2] = (1 - ROUNDING) * nz / nl + ROUNDING * oz;
                            // Canopy self-occlusion, from depth alone: what is seen deep inside the sphere
                            // (through gaps, on the far side) is a little darker than the outer shell. Mild:
                            // the screen-space AO still runs over the impostor on top of it.
                            const depth = z / radius;   // -1 far side .. +1 near side
                            ao[s] = 0.85 + 0.15 * smoothstep(-0.9, 0.35, depth);
                        }
                    }
                }
            }

            kept += resolveFrame(zbuf, col, nrm, ao, S, ss, F, NF, fCol, fNrm, colFilled, nrmFilled);
            dilateFrame(fCol, F, colFilled, dilate);
            dilateFrame(fNrm, NF, nrmFilled, dilate);
            writeFrame(albedo, albedoSize, i * F, j * F, F, fCol, v => v);
            writeFrame(normal, normalSize, i * NF, j * NF, NF, fNrm, v => v * 0.5 + 0.5);
        }
    }

    return {
        info: { frames: N, radius, center },
        albedo, albedoSize, normal, normalSize,
        coverage: kept / (N * N * F * F),
    };
}

interface PreparedPart {
    positions: ArrayLike<number>;
    vertexCount: number;
    indices: ArrayLike<number>;
    normals: Float32Array;
    uvs: ArrayLike<number> | null;
    sample: ((u: number, v: number, out: Float32Array) => void) | null;
    color: readonly [number, number, number, number];
    cutoff: number;
}

function prepare(p: OctahedralBakePart): PreparedPart {
    const vertexCount = Math.floor(p.positions.length / 3);
    let indices: ArrayLike<number> = p.indices ?? [];
    if (!p.indices) {
        const seq = new Uint32Array(vertexCount - (vertexCount % 3));
        for (let k = 0; k < seq.length; k++) seq[k] = k;
        indices = seq;
    }
    let normals: Float32Array;
    if (p.normals && p.normals.length >= vertexCount * 3) normals = Float32Array.from(p.normals as ArrayLike<number>);
    else {
        // Area-weighted face normals, summed per vertex.
        normals = new Float32Array(vertexCount * 3);
        const q = p.positions;
        for (let k = 0; k + 2 < indices.length; k += 3) {
            const a = indices[k], b = indices[k + 1], c = indices[k + 2];
            const ux = q[b * 3] - q[a * 3], uy = q[b * 3 + 1] - q[a * 3 + 1], uz = q[b * 3 + 2] - q[a * 3 + 2];
            const vx = q[c * 3] - q[a * 3], vy = q[c * 3 + 1] - q[a * 3 + 1], vz = q[c * 3 + 2] - q[a * 3 + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            for (const v of [a, b, c]) { normals[v * 3] += nx; normals[v * 3 + 1] += ny; normals[v * 3 + 2] += nz; }
        }
    }
    return {
        positions: p.positions, vertexCount, indices, normals,
        uvs: p.uvs && p.uvs.length >= vertexCount * 2 ? p.uvs : null,
        sample: p.sample ?? null,
        color: p.color ?? [1, 1, 1, 1],
        cutoff: Math.max(0, p.cutoff ?? 0),
    };
}

/**
 * Box-filter one frame's samples down: coverage = the covered share of each texel, colour and AO the mean
 * of only the covered samples (no background bleeds into an edge), normal their normalized sum. Marks the
 * filled texels of each atlas in `colFilled`/`nrmFilled`, and returns those at or above half coverage.
 */
function resolveFrame(zbuf: Float32Array, col: Float32Array, nrm: Float32Array, ao: Float32Array, S: number,
                      ss: number, F: number, NF: number, fCol: Float32Array, fNrm: Float32Array,
                      colFilled: Uint8Array, nrmFilled: Uint8Array): number {
    let kept = 0;
    for (let y = 0; y < F; y++) {
        for (let x = 0; x < F; x++) {
            let n = 0, r = 0, g = 0, b = 0;
            for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
                const s = (y * ss + sy) * S + x * ss + sx;
                if (zbuf[s] === -Infinity) continue;
                n++; r += col[s * 3]; g += col[s * 3 + 1]; b += col[s * 3 + 2];
            }
            const t = y * F + x, o = t * 4;
            colFilled[t] = n > 0 ? 1 : 0;
            if (n === 0) { fCol[o] = fCol[o + 1] = fCol[o + 2] = fCol[o + 3] = 0; continue; }
            fCol[o] = r / n; fCol[o + 1] = g / n; fCol[o + 2] = b / n; fCol[o + 3] = n / (ss * ss);
            if (n * 2 >= ss * ss) kept++;
        }
    }
    // The normal atlas has its own resolution: each of its texels gathers an (S / NF)-sample square.
    const k = S / NF;
    for (let y = 0; y < NF; y++) {
        for (let x = 0; x < NF; x++) {
            let n = 0, nx = 0, ny = 0, nz = 0, a = 0;
            const y0 = Math.floor(y * k), y1 = Math.floor((y + 1) * k), x0 = Math.floor(x * k), x1 = Math.floor((x + 1) * k);
            for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
                const s = sy * S + sx;
                if (zbuf[s] === -Infinity) continue;
                n++; nx += nrm[s * 3]; ny += nrm[s * 3 + 1]; nz += nrm[s * 3 + 2]; a += ao[s];
            }
            const t = y * NF + x, o = t * 4;
            nrmFilled[t] = n > 0 ? 1 : 0;
            // Empty: straight up and unoccluded, until the dilation gives it a neighbour's normal.
            if (n === 0) { fNrm[o] = 0; fNrm[o + 1] = 1; fNrm[o + 2] = 0; fNrm[o + 3] = 1; continue; }
            const l = Math.hypot(nx, ny, nz) || 1;
            fNrm[o] = nx / l; fNrm[o + 1] = ny / l; fNrm[o + 2] = nz / l; fNrm[o + 3] = a / n;
        }
    }
    return kept;
}

/**
 * Grow a frame's filled texels into its empty ones, a ring per pass: each empty texel takes the mean RGB
 * of its filled neighbours. The fourth channel is left alone — coverage stays 0, so the silhouette does not
 * move, and bilinear filtering at it blends toward the right colour instead of the background's.
 */
function dilateFrame(f: Float32Array, size: number, filled: Uint8Array, passes: number): void {
    const next: number[] = [];
    for (let pass = 0; pass < passes; pass++) {
        next.length = 0;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const t = y * size + x;
                if (filled[t]) continue;
                let n = 0, r = 0, g = 0, b = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= size) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= size) continue;
                        const q = yy * size + xx;
                        if (!filled[q]) continue;
                        n++; r += f[q * 4]; g += f[q * 4 + 1]; b += f[q * 4 + 2];
                    }
                }
                if (n) next.push(t, r / n, g / n, b / n);
            }
        }
        if (next.length === 0) break;
        for (let k = 0; k < next.length; k += 4) {
            const t = next[k];
            f[t * 4] = next[k + 1]; f[t * 4 + 1] = next[k + 2]; f[t * 4 + 2] = next[k + 3];
            filled[t] = 1;
        }
    }
}

/** Copy one frame into its tile of an atlas, quantized: `rgb` maps a channel value to 0..1 first. */
function writeFrame(atlas: Uint8ClampedArray, atlasSize: number, ox: number, oy: number, size: number,
                    f: Float32Array, rgb: (v: number) => number): void {
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const s = (y * size + x) * 4, o = ((oy + y) * atlasSize + ox + x) * 4;
            atlas[o] = toByte(rgb(f[s]));
            atlas[o + 1] = toByte(rgb(f[s + 1]));
            atlas[o + 2] = toByte(rgb(f[s + 2]));
            atlas[o + 3] = toByte(f[s + 3]);
        }
    }
}

function toByte(v: number): number {
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
}

function smoothstep(e0: number, e1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

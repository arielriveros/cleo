import { describe, it, expect } from 'vitest';
import {
    bodyWavePush, createWaveSimGrid, stepWaveSim, waveDamping, waveKernelIndex, waveKernelSymbol, waveSimKernel,
    BODY_SPEED_CAP, WAVE_DAMPING_RUNNING, WAVE_DAMPING_STILL,
    WAVE_SIM_CELL, WAVE_SIM_DEPTHS, WAVE_SIM_DT, WAVE_SIM_GRAVITY, WAVE_SIM_REACH, WAVE_SIM_TAPS, type WaveSimBody,
} from '../src/water/waveSim';
import { catmullRomWeights } from '../src/core/math';
import { waterFoamPixels, WATER_FOAM_SIZE } from '../src/water/waterTextures';

// The live waves on running water (water/waveSim.ts; run on the GPU by graphics/render/waterWaves.ts). The
// shaders cannot run here, so what is held to account is the arithmetic they are handed and share: the wave
// operator's kernel, and the scheme (carry, then propagate) through its CPU reference.

describe('the wave kernel', () => {
    const P = WAVE_SIM_REACH;

    it('packs one weight for each unordered, unsigned offset', () => {
        expect(WAVE_SIM_TAPS).toBe(28);
        const seen = new Set<number>();
        for (let j = -P; j <= P; j++) for (let i = -P; i <= P; i++) {
            const k = waveKernelIndex(i, j);
            expect(k).toBe(waveKernelIndex(j, i));
            expect(k).toBe(waveKernelIndex(-i, j));
            seen.add(k);
        }
        expect(seen.size).toBe(WAVE_SIM_TAPS);
        expect(Math.max(...seen)).toBe(WAVE_SIM_TAPS - 1);
    });

    for (const depth of WAVE_SIM_DEPTHS) {
        it(`leaves level water level and no wave growing, ${depth} m deep`, () => {
            const kernel = waveSimKernel(depth);
            let sum = 0;
            for (let j = -P; j <= P; j++) for (let i = -P; i <= P; i++) sum += kernel[waveKernelIndex(i, j)];
            expect(Math.abs(sum)).toBeLessThan(1e-6);
            // Its symbol is the square of each wave's frequency (over g / texel). Below zero a wave would grow
            // without bound; too high and the step itself is unstable (frequency times step under 2).
            let low = Infinity, high = -Infinity;
            for (let b = 0; b <= 48; b++) for (let a = 0; a <= 48; a++) {
                const s = waveKernelSymbol(kernel, a * Math.PI / 48, b * Math.PI / 48);
                low = Math.min(low, s); high = Math.max(high, s);
            }
            expect(low).toBeGreaterThan(-1e-6);
            expect(Math.sqrt(WAVE_SIM_GRAVITY / WAVE_SIM_CELL * high) * WAVE_SIM_DT).toBeLessThan(0.5);
        });
    }

    it('runs each wavelength at water\'s own speed over that depth', () => {
        // The speed is the square root of the symbol over k tanh(k h). Shallow water (a river) is held to two
        // parts in a hundred from five texels a wave to thirty-two; over deep water the thirteen taps cannot
        // hold the longest waves, and it is eight in a hundred up to twenty texels (three metres).
        const off = (depth: number, texels: number, diagonal: boolean) => {
            const kernel = waveSimKernel(depth), q = 2 * Math.PI / texels, H = depth / WAVE_SIM_CELL;
            const s = diagonal ? waveKernelSymbol(kernel, q * Math.SQRT1_2, q * Math.SQRT1_2) : waveKernelSymbol(kernel, q, 0);
            return Math.abs(Math.sqrt(s / (q * Math.tanh(q * H))) - 1);
        };
        for (const texels of [5, 6, 8, 10, 12, 16, 20, 24, 32]) for (const diagonal of [false, true]) {
            expect(off(WAVE_SIM_DEPTHS[0], texels, diagonal)).toBeLessThan(0.02);
            if (texels <= 20) expect(off(WAVE_SIM_DEPTHS[1], texels, diagonal)).toBeLessThan(0.08);
        }
        // Dispersion itself: over the deep kernel a wave twice as long runs faster, not at the same speed.
        const kernel = waveSimKernel(WAVE_SIM_DEPTHS[1]);
        const speed = (texels: number) => Math.sqrt(waveKernelSymbol(kernel, 2 * Math.PI / texels, 0)) / (2 * Math.PI / texels);
        expect(speed(16) / speed(8)).toBeGreaterThan(1.3);
    });
});

describe('the wave scheme', () => {
    it('carries a wave with the current at the current\'s speed, and keeps its shape', () => {
        const nx = 96, nz = 32, grid = createWaveSimGrid(nx, nz);
        for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) grid.eta[z * nx + x] = Math.exp(-((x - 20) ** 2 + (z - 16) ** 2) / 18);
        // No wave operator: the transport alone, for a second at a metre and a half a second.
        const still = new Float32Array(WAVE_SIM_TAPS);
        for (let s = 0; s < 60; s++) stepWaveSim(grid, { kernel: still, flowX: 1.5 });
        let mass = 0, moment = 0, peak = 0;
        for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { const e = grid.eta[z * nx + x]; mass += e; moment += e * x; peak = Math.max(peak, e); }
        expect(moment / mass).toBeCloseTo(20 + 1.5 / WAVE_SIM_CELL, 1);
        // (A linear lookup leaves less than half of it.)
        expect(peak).toBeGreaterThan(0.95);
        const w = catmullRomWeights(0.3);
        expect(w[0] + w[1] + w[2] + w[3]).toBeCloseTo(1, 12);
        // On a sample, that sample.
        const on = catmullRomWeights(0);
        expect(on[1]).toBe(1);
        expect(Math.abs(on[0]) + Math.abs(on[2]) + Math.abs(on[3])).toBe(0);
    });

    it('swings a standing wave at the frequency water has for its length and depth', () => {
        // A patch of waves at rest, let go: its middle falls through level and comes back, half a period
        // between the two crossings.
        const N = 96;
        for (const [depth, texels, within] of [[0.25, 8, 0.03], [0.25, 12, 0.03], [1.2, 8, 0.05]] as const) {
            const grid = createWaveSimGrid(N, N), kernel = waveSimKernel(depth), q = 2 * Math.PI / texels;
            for (let z = 0; z < N; z++) for (let x = 0; x < N; x++)
                grid.eta[z * N + x] = Math.cos(q * (x - N / 2)) * Math.exp(-((x - N / 2) ** 2 + (z - N / 2) ** 2) / 800);
            const centre = (N / 2) * N + N / 2;
            const crossings: number[] = [];
            let prev = grid.eta[centre];
            for (let s = 1; s <= 80 && crossings.length < 2; s++) {
                stepWaveSim(grid, { kernel });
                const v = grid.eta[centre];
                if ((prev > 0) !== (v > 0)) crossings.push((s - 1 + prev / (prev - v)) * WAVE_SIM_DT);
                prev = v;
            }
            const k = q / WAVE_SIM_CELL, want = Math.sqrt(WAVE_SIM_GRAVITY * k * Math.tanh(k * depth));
            expect(Math.abs(Math.PI / (crossings[1] - crossings[0]) / want - 1)).toBeLessThan(within);
        }
    });

    it('leaves a wake that stands still, downstream, behind a push that stands still in a current', () => {
        // What the shader's stones are (waterWaveStep.wgsl): up over the top, down round it, no water added.
        const nx = 110, nz = 64, kernel = waveSimKernel(0.6), speed = 2;
        const force = new Float32Array(nx * nz), sx = 30, sz = nz / 2, radius = 0.25 / WAVE_SIM_CELL;
        let total = 0, strongest = 0;
        for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
            const d2 = ((x - sx) ** 2 + (z - sz) ** 2) / (radius * radius);
            force[z * nx + x] = 3 * speed * speed * (1 - d2) * Math.exp(-d2);
            total += force[z * nx + x]; strongest = Math.max(strongest, force[z * nx + x]);
        }
        expect(Math.abs(total)).toBeLessThan(strongest * 1e-3);
        const energy = (eta: Float32Array, from: number, to: number) => {
            let e = 0;
            for (let z = 0; z < nz; z++) for (let x = from; x < to; x++) e += eta[z * nx + x] ** 2;
            return e;
        };
        const step = { kernel, force, damping: 0.35, viscosity: 0.04 };

        const river = createWaveSimGrid(nx, nz);
        for (let s = 0; s < 210; s++) stepWaveSim(river, { ...step, flowX: speed });
        // All of it below the stone: the waves it makes cannot run up a current this fast.
        expect(energy(river.eta, sx + 5, sx + 24)).toBeGreaterThan(100 * energy(river.eta, sx - 24, sx - 5));
        // And it stands: half a second on, the water below the stone is where it was.
        const then = Float32Array.from(river.eta);
        for (let s = 0; s < 30; s++) stepWaveSim(river, { ...step, flowX: speed });
        let moved = 0, stood = 0;
        for (let z = 0; z < nz; z++) for (let x = sx + 5; x < sx + 18; x++) {
            moved += (river.eta[z * nx + x] - then[z * nx + x]) ** 2; stood += then[z * nx + x] ** 2;
        }
        expect(Math.sqrt(moved / stood)).toBeLessThan(0.1);
        // The pillow over the stone: a share of the velocity head (speed squared over 2 g, 20 cm here), not a spout.
        let peak = 0;
        for (let i = 0; i < river.eta.length; i++) peak = Math.max(peak, Math.abs(river.eta[i]));
        expect(peak).toBeGreaterThan(0.03);
        expect(peak).toBeLessThan(0.3);

        // In still water the same push sends its rings out all round.
        const pond = createWaveSimGrid(nx, nz);
        for (let s = 0; s < 120; s++) stepWaveSim(pond, step);
        const lopsided = energy(pond.eta, sx + 5, sx + 24) / energy(pond.eta, sx - 24, sx - 5);
        expect(lopsided).toBeGreaterThan(0.7);
        expect(lopsided).toBeLessThan(1.4);
    }, 60_000);

    it('throws back a wave that reaches something standing in the water, and holds none inside it', () => {
        // A wall across a still channel (what waterWaveStep.wgsl makes of a static collider), a wave train
        // 1.8 m long heading for it; and the same channel open.
        const nx = 220, nz = 16, kernel = waveSimKernel(0.8), wall = 120;
        const solid = new Uint8Array(nx * nz);
        for (let z = 0; z < nz; z++) for (let x = wall; x < nx; x++) solid[z * nx + x] = 1;
        const q = 2 * Math.PI / 12, k = WAVE_SIM_GRAVITY / WAVE_SIM_CELL;
        const omega = Math.sqrt(k * Math.abs(waveKernelSymbol(kernel, q, 0)));
        const launch = () => {
            const grid = createWaveSimGrid(nx, nz);
            for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
                const env = Math.exp(-(((x - 95) / 10) ** 2));
                grid.eta[z * nx + x] = 0.02 * env * Math.cos(q * x);
                grid.vel[z * nx + x] = 0.02 * env * omega * Math.sin(q * x);
            }
            return grid;
        };
        const energy = (g: { eta: Float32Array }, from: number, to: number) => {
            let e = 0;
            for (let z = 0; z < nz; z++) for (let x = from; x < to; x++) e += g.eta[z * nx + x] ** 2;
            return e;
        };
        const walled = launch(), open = launch();
        const before = energy(walled, 0, wall);
        for (let s = 0; s < 420; s++) { stepWaveSim(walled, { kernel, solid }); stepWaveSim(open, { kernel }); }
        for (let i = 0; i < solid.length; i++) if (solid[i]) expect(walled.eta[i]).toBe(0);
        // Open, most of it has run on past where the wall would be; walled, it is all still on this side.
        expect(energy(open, 0, wall)).toBeLessThan(0.5 * before);
        expect(energy(walled, 0, wall)).toBeGreaterThan(0.7 * before);
    }, 60_000);
});

describe('the water foam texture', () => {
    const n = WATER_FOAM_SIZE;
    const pixels = waterFoamPixels();

    it('is the same every time, and tiles', () => {
        const again = waterFoamPixels();
        let same = again.length === pixels.length;
        for (let i = 0; same && i < pixels.length; i++) same = again[i] === pixels[i];
        expect(same).toBe(true);
        // The step from the last column to the first, and from the last row to the first, is no rougher than
        // the roughest step between two columns, or two rows, inside (the bubbles' rims are sharp: a step
        // that runs along a row of them is rough wherever it is).
        const step = (c: number, i: number, across: boolean) => {
            let sum = 0;
            for (let j = 0; j < n; j++) {
                const a = across ? j * n + i : i * n + j, b = across ? j * n + (i + 1) % n : ((i + 1) % n) * n + j;
                sum += Math.abs(pixels[a * 4 + c] - pixels[b * 4 + c]);
            }
            return sum;
        };
        for (let c = 0; c < 4; c++) for (const across of [true, false]) {
            let roughest = 0;
            for (let i = 0; i < n - 1; i++) roughest = Math.max(roughest, step(c, i, across));
            expect(step(c, n - 1, across)).toBeLessThanOrEqual(roughest);
        }
    });

    it('spreads its web and its thick places evenly, so an amount of foam covers that share of the water', () => {
        // water.wgsl foamCover draws foam where a channel is above one less the amount. Both channels are
        // ranked: every tenth of their range holds a tenth of the image.
        for (const channel of [1, 2]) {
            const tenths = new Array(10).fill(0);
            for (let i = 0; i < n * n; i++) tenths[Math.min(9, Math.floor(pixels[i * 4 + channel] / 25.6))]++;
            for (const count of tenths) expect(Math.abs(count / (n * n) - 0.1)).toBeLessThan(0.01);
        }
    });

    it('has a web of strands, not clouds, in its lace', () => {
        // The lace changes from texel to texel far faster than the thick-and-thin places do: strands a few
        // texels wide against clouds a hundred across.
        const rough = (channel: number) => {
            let sum = 0;
            for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
                sum += Math.abs(pixels[(y * n + x) * 4 + channel] - pixels[(y * n + (x + 1) % n) * 4 + channel]);
            return sum / (n * n);
        };
        expect(rough(1)).toBeGreaterThan(2 * rough(2));
        // A little foam is strands and the knots where they meet: of the texels above nine tenths, a good
        // share have open water (under a half) ten texels off. Clouds' tops are wide: next to none have.
        const beside = (channel: number) => {
            let top = 0, edged = 0;
            for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
                if (pixels[(y * n + x) * 4 + channel] < 230) continue;
                top++;
                const open = (dx: number, dy: number) => pixels[((((y + dy) % n) + n) % n * n + (((x + dx) % n) + n) % n) * 4 + channel] < 128;
                if (open(10, 0) || open(-10, 0) || open(0, 10) || open(0, -10)) edged++;
            }
            return edged / top;
        };
        expect(beside(1)).toBeGreaterThan(0.3);
        expect(beside(2)).toBeLessThan(0.02);
    });
});

// What moves through the water (water/waveSim.ts bodyWavePush; waterWaveStep.wgsl adds the same push): the
// rings a body throws, carried off by the current, and still water that keeps them.
describe('the waves a body raises', { timeout: 60_000 }, () => {
    const N = 100, cell = WAVE_SIM_CELL, C = N * cell / 2;
    const kernel = waveSimKernel(WAVE_SIM_DEPTHS[1]);

    /** A half-metre body dropped in at (x0, C), 3 m/s for 0.3 s, then left: the grid after each step. */
    function drop(x0: number, flow: number, damping: number, steps: number, each: (step: number, eta: Float32Array) => void): void {
        const grid = createWaveSimGrid(N, N, cell);
        const force = new Float32Array(N * N);
        const body: WaveSimBody = { x: x0, z: C, radius: 0.5, share: 1, vx: 0, vy: -3, vz: 0 };
        for (let s = 0; s < steps; s++) {
            force.fill(0);
            if (s * WAVE_SIM_DT < 0.3) for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) force[z * N + x] = bodyWavePush(x * cell, z * cell, body);
            stepWaveSim(grid, { kernel, force, flowX: flow, damping, viscosity: 0.04 });
            each(s, grid.eta);
        }
    }

    it('pushes only where it moves against the water: down as it sinks, up ahead of it and down behind', () => {
        const still: WaveSimBody = { x: 0, z: 0, radius: 0.4, share: 1, vx: 0, vy: 0, vz: 0 };
        for (const [x, z] of [[0, 0], [0.3, 0], [0, -0.5], [1, 1]]) expect(bodyWavePush(x, z, still)).toBe(0);
        const sinking = { ...still, vy: -2 };
        expect(bodyWavePush(0, 0, sinking)).toBeLessThan(0);
        expect(bodyWavePush(0, 0, { ...sinking, share: 0 })).toBe(0);
        const moving = { ...still, vx: 1.5 };
        expect(bodyWavePush(0.3, 0, moving)).toBeGreaterThan(0);
        expect(bodyWavePush(-0.3, 0, moving)).toBeCloseTo(-bodyWavePush(0.3, 0, moving), 10);
        expect(bodyWavePush(0, 0.3, moving)).toBeCloseTo(0, 10);
        // Nothing past its reach; and a splash faster than the grid can hold is taken at the cap.
        expect(bodyWavePush(1.3, 0, moving)).toBe(0);
        expect(bodyWavePush(0, 0, { ...still, vy: -40 })).toBe(bodyWavePush(0, 0, { ...still, vy: -BODY_SPEED_CAP }));
    });

    it('throws a ring a few centimetres high that runs outward', () => {
        const peakAt: number[] = [];
        let ringAt2m = 0;
        drop(C, 0, waveDamping(0), 91, (s, eta) => {
            if (s === 45 || s === 90) {
                // The radius of the highest water off the centre.
                let best = 0, r = 0;
                for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
                    const d = Math.hypot(x * cell - C, z * cell - C);
                    if (d > 0.6 && Math.abs(eta[z * N + x]) > best) { best = Math.abs(eta[z * N + x]); r = d; }
                }
                peakAt.push(r);
            }
            for (let a = 0; a < 32; a++) {
                const x = Math.round((C + 2 * Math.cos(a / 32 * 2 * Math.PI)) / cell), z = Math.round((C + 2 * Math.sin(a / 32 * 2 * Math.PI)) / cell);
                ringAt2m = Math.max(ringAt2m, Math.abs(eta[z * N + x]));
            }
        });
        expect(peakAt[1]).toBeGreaterThan(peakAt[0] + 0.5);
        expect(ringAt2m).toBeGreaterThan(0.015);
        expect(ringAt2m).toBeLessThan(0.08);
    });

    it('lets the current carry the rings off downstream', () => {
        const drift = (flow: number, x0: number) => {
            let cx = 0;
            drop(x0, flow, waveDamping(0), 121, (s, eta) => {
                if (s !== 120) return;
                let sw = 0, sx = 0;
                for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) { const w = eta[z * N + x] ** 2; sw += w; sx += w * x * cell; }
                cx = sx / sw;
            });
            return cx - x0;
        };
        expect(Math.abs(drift(0, C))).toBeLessThan(0.05);
        // Two seconds in a current of 1 m/s: about two metres on (the drop itself took the first 0.3 s).
        const carried = drift(1, C - 3);
        expect(carried).toBeGreaterThan(1.4);
        expect(carried).toBeLessThan(2.2);
    });

    it('keeps them for seconds on still water, where running water forgets them', () => {
        expect(waveDamping(0)).toBe(WAVE_DAMPING_STILL);
        expect(waveDamping(1.5)).toBe(WAVE_DAMPING_RUNNING);
        const energyAt4s = (damping: number) => {
            let e = 0;
            drop(C, 0, damping, 241, (s, eta) => { if (s === 240) for (let i = 0; i < N * N; i++) e += eta[i] * eta[i]; });
            return e;
        };
        expect(energyAt4s(waveDamping(0))).toBeGreaterThan(3 * energyAt4s(waveDamping(1.5)));
    });
});

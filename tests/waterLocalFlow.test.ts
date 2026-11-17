import { describe, it, expect } from 'vitest';
import {
    createLocalFlow, createLocalFlowGround, footprintDistance, localFlowOutput, stepLocalFlow,
    LOCAL_FLOW_GRAVITY, LOCAL_FLOW_SOLID, type LocalFlowGround, type LocalFlowState,
} from '../src/water/localFlow';

// The local flow (water/localFlow.ts; run on the GPU by graphics/render/localFlow.ts): the shallow-water
// equations solved finely round the camera, with the flow bake as their reference. What it is for: water that
// piles up against what stands in it, parts round it and speeds past its sides, leaves a wake behind; that rises
// over a boulder just under the surface, pours over it, drops into a hole and jumps back up. The shaders cannot
// run here, so it is held to account through its CPU reference, which they mirror.

const G = LOCAL_FLOW_GRAVITY;

/** A straight river along +x across the window, `width` wide, its bed falling as Manning's friction asks of `speed` at `depth`. */
function river(n: number, o: { depth?: number; speed?: number; width?: number; manning?: number } = {}) {
    const depth = o.depth ?? 0.8, speed = o.speed ?? 1.5, width = o.width ?? 9, manning = o.manning ?? 0.02;
    const g = createLocalFlowGround(n);
    const slope = manning * manning * speed * speed / Math.pow(depth, 4 / 3);
    const zc = n * g.cell / 2;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const c = j * n + i, x = i * g.cell, z = j * g.cell;
        const inside = Math.abs(z - zc) < width / 2;
        g.refSurface[c] = -slope * x + depth;
        g.bed[c] = -slope * x + (inside ? 0 : depth + 0.5);
        g.refU[c] = inside ? speed : 0;
        g.manning[c] = manning;
    }
    return { g, zc, depth, speed, head: speed * speed / (2 * G) };
}

/** Cells a footprint covers over half of (2 x 2 samples, as waterFlowGround.wgsl) made solid. */
function stand(g: LocalFlowGround, f: { x: number; z: number; ax?: number; az?: number; a?: number; b?: number; r?: number }) {
    const fp = { ax: 1, az: 0, a: 0, b: 0, r: 0, ...f };
    for (let j = 0; j < g.n; j++) for (let i = 0; i < g.n; i++) {
        let inside = 0;
        for (let s = 0; s < 4; s++) inside += footprintDistance(fp, (i + (s & 1 ? 0.25 : -0.25)) * g.cell, (j + (s & 2 ? 0.25 : -0.25)) * g.cell) < 0 ? 1 : 0;
        if (inside >= 2) g.drag[j * g.n + i] = LOCAL_FLOW_SOLID;
    }
}

function run(g: LocalFlowGround, steps: number): LocalFlowState {
    const s = createLocalFlow(g);
    for (let k = 0; k < steps; k++) stepLocalFlow(s, g);
    return s;
}

const probe = (g: LocalFlowGround, s: LocalFlowState) => {
    const out = localFlowOutput(s, g);
    const at = (x: number, z: number) => {
        const c = Math.round(z / g.cell) * g.n + Math.round(x / g.cell);
        return { lift: out.lift[c], u: out.u[c], w: out.w[c], speed: Math.hypot(out.u[c], out.w[c]), white: out.white[c], h: s.h[c] };
    };
    return { out, at };
};

const largest = (a: ArrayLike<number>) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return m; };

describe('the local flow', { timeout: 120_000 }, () => {
    it('leaves level water level, and a closed basin keeps its water', () => {
        const n = 48, g = createLocalFlowGround(n);
        g.refSurface.fill(1);
        const still = run(g, 200);
        expect(Math.max(largest(still.u), largest(still.w))).toBeLessThan(1e-6);
        expect(largest(still.h.map(h => h - 1))).toBeLessThan(1e-6);
        // Walled round, a hump of water in the middle, left to itself: it spreads and none is lost.
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (Math.min(i, j, n - 1 - i, n - 1 - j) === 0) g.drag[j * n + i] = LOCAL_FLOW_SOLID;
        const s = createLocalFlow(g);
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (g.drag[j * n + i] >= 0) s.h[j * n + i] += 0.05 * Math.exp(-((i - 24) ** 2 + (j - 24) ** 2) / 20);
        const volume = () => s.h.reduce((a, b) => a + b, 0);
        const before = volume();
        for (let k = 0; k < 600; k++) stepLocalFlow(s, g, { nudge: false });
        expect(Math.abs(volume() / before - 1)).toBeLessThan(1e-4);
        expect(largest(s.h) - 1).toBeLessThan(0.03);
    });

    it('keeps a river with nothing in it as the bake has it', () => {
        const { g, zc, speed } = river(96);
        const { at } = probe(g, run(g, 1000));
        for (const x of [8, 14, 20]) {
            expect(Math.abs(at(x, zc).u - speed)).toBeLessThan(0.06);
            expect(Math.abs(at(x, zc).lift)).toBeLessThan(0.01);
            expect(Math.abs(at(x, zc).w)).toBeLessThan(0.01);
        }
    });

    it('piles water against a post, parts it, draws it down and speeds it past the sides, and leaves a wake', () => {
        // A post a metre across in a river 0.8 m deep running 1.5 m/s (its velocity head 11.5 cm).
        const { g, zc, head } = river(128);
        const px = 13, R = 0.5;
        stand(g, { x: px, z: zc, r: R });
        const s = run(g, 1200);
        const { out, at } = probe(g, s);
        const approach = at(px - 8, zc).speed;
        // The cushion against the face it meets.
        expect(at(px - R - 0.15, zc).lift).toBeGreaterThan(0.7 * head);
        expect(at(px - R - 0.15, zc).lift).toBeLessThan(1.6 * head);
        // Ahead of it the water turns aside, away from the axis on either side.
        expect(at(px - R - 0.3, zc + 0.6).w).toBeGreaterThan(0.2);
        expect(at(px - R - 0.3, zc - 0.6).w).toBeLessThan(-0.2);
        // Past its sides it runs faster than it came, and lower.
        expect(at(px, zc + R + 0.3).speed).toBeGreaterThan(1.12 * approach);
        expect(at(px, zc + R + 0.3).lift).toBeLessThan(-0.02);
        // Behind it, slack water, the river's speed coming back over a few metres.
        expect(at(px + 2, zc).speed).toBeLessThan(0.5 * approach);
        expect(at(px + 8, zc).speed).toBeGreaterThan(0.5 * approach);
        // And white where it tears past.
        let whitest = 0;
        for (let j = 0; j < g.n; j++) for (let i = 0; i < g.n; i++) if (Math.hypot(i * g.cell - px, j * g.cell - zc) < 2) whitest = Math.max(whitest, out.white[j * g.n + i]);
        expect(whitest).toBeGreaterThan(0.15);
    });

    it('raises a pillow over a boulder just under the surface, pours over it into a hole, and jumps back up white', () => {
        // A boulder 1.2 m across whose top lies 0.2 m under a river 0.6 m deep running 2 m/s (head 20 cm).
        const { g, zc, head } = river(128, { depth: 0.6, speed: 2 });
        const bx = 13, half = 0.6;
        for (let j = 0; j < g.n; j++) for (let i = 0; i < g.n; i++) {
            const c = j * g.n + i;
            if (Math.abs(i * g.cell - bx) < half && Math.abs(j * g.cell - zc) < half) g.bed[c] = g.refSurface[c] - 0.2;
        }
        const s = run(g, 1200);
        const { at } = probe(g, s);
        const froude = (x: number) => { const p = at(x, zc); return p.speed / Math.sqrt(G * Math.max(p.h, 0.01)); };
        // The pillow before it.
        expect(at(bx - half - 0.1, zc).lift).toBeGreaterThan(0.6 * head);
        // Over it the water runs faster than a wave can (supercritical), and drops into a hole behind it.
        let fastest = 0, hole = 0, holeAt = bx;
        for (let x = bx - half; x <= bx + half + 1; x += g.cell) {
            fastest = Math.max(fastest, froude(x));
            if (at(x, zc).lift < hole) { hole = at(x, zc).lift; holeAt = x; }
        }
        expect(fastest).toBeGreaterThan(1.2);
        expect(hole).toBeLessThan(-0.06);
        // Then a hydraulic jump: within two metres it is slow again (subcritical), well up from the hole, and white.
        let back = -Infinity, slow = Infinity, white = 0;
        for (let x = holeAt; x <= holeAt + 2; x += g.cell) { back = Math.max(back, at(x, zc).lift); slow = Math.min(slow, froude(x)); }
        for (let x = bx; x <= bx + half + 2; x += g.cell) white = Math.max(white, at(x, zc).white);
        expect(back - hole).toBeGreaterThan(0.06);
        expect(slow).toBeLessThan(0.8);
        expect(white).toBeGreaterThan(0.5);
    });

    it('does the same at a bridge pier’s scale: a cushion at its nose, faster water down its sides', () => {
        const { g, zc, head } = river(128, { width: 14 });
        const px = 13;
        // A pier 4 m long and 1.5 m wide, rounded, along the current.
        stand(g, { x: px, z: zc, a: 1.25, b: 0, r: 0.75 });
        const { at } = probe(g, run(g, 1200));
        const approach = at(px - 9, zc).speed;
        expect(at(px - 2 - 0.15, zc).lift).toBeGreaterThan(0.7 * head);
        expect(at(px, zc + 0.75 + 0.3).speed).toBeGreaterThan(1.05 * approach);
        expect(at(px + 4, zc).speed).toBeLessThan(0.5 * approach);
    });

    it('stays stable and comes out the same every time', () => {
        const { g, zc } = river(64);
        stand(g, { x: 8, z: zc, r: 0.5 });
        const a = run(g, 3000), b = run(g, 3000);
        expect(a.h.every(Number.isFinite) && a.u.every(Number.isFinite) && a.w.every(Number.isFinite)).toBe(true);
        expect(Math.max(largest(a.u), largest(a.w))).toBeLessThan(6);
        expect(Array.from(a.h)).toEqual(Array.from(b.h));
        expect(Array.from(a.u)).toEqual(Array.from(b.u));
    });
});

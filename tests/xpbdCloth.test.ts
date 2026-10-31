import { describe, it, expect } from 'vitest';
import { XpbdCloth, gridIndices, windGust, type ClothSettings } from '../src/physics/cloth/xpbdCloth';

/** A cols x rows panel in the XY plane, top row pinned at y = 0, hanging toward -Y, `size` metres a side. */
function panel(cols = 8, rows = 10, size = 1, settings: Partial<ClothSettings> = {}) {
    const rest: number[] = [], pinned: boolean[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        rest.push((c / (cols - 1) - 0.5) * size, -r / (rows - 1) * size, 0);
        pinned.push(r === 0);
    }
    return XpbdCloth.grid(cols, rows, rest, pinned, 1, settings);
}

const at = (cloth: XpbdCloth, i: number) => Array.from(cloth.positions.subarray(i * 3, i * 3 + 3));
const hem = (cloth: XpbdCloth) => (cloth.rows - 1) * cloth.cols + Math.floor(cloth.cols / 2);
const run = (cloth: XpbdCloth, seconds: number) => { for (let t = 0; t < seconds; t += 1 / 60) cloth.step(1 / 60); };

describe('XPBD cloth', () => {
    it('hangs from its pinned edge without stretching, and the pins stay put', () => {
        // Start it lying flat out sideways (along +Z), so gravity has to swing it down.
        const cols = 8, rows = 10;
        const rest: number[] = [], pinned: boolean[] = [];
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            rest.push((c / (cols - 1) - 0.5), 0, r / (rows - 1));
            pinned.push(r === 0);
        }
        const cloth = XpbdCloth.grid(cols, rows, rest, pinned, 1);
        run(cloth, 4);
        // Hanging straight down now: the hem a metre under the pins (tethers keep the stretch tiny).
        const y = at(cloth, hem(cloth))[1];
        expect(y).toBeLessThan(-0.95);
        expect(y).toBeGreaterThan(-1.05);
        expect(at(cloth, 0)).toEqual([-0.5, 0, 0]);
        // Every structural edge within a few percent of its rest length.
        const cell = 1 / (rows - 1);
        for (let r = 0; r + 1 < rows; r++) {
            const a = at(cloth, r * cols), b = at(cloth, (r + 1) * cols);
            expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / cell).toBeLessThan(1.05);
        }
    });

    it('is pushed out of a capsule, to its thickness', () => {
        const cloth = panel(8, 10, 1, { thickness: 0.02 });
        // A horizontal capsule just behind the panel's middle, pushing into it.
        cloth.colliders = [{ a: [-1, -0.5, 0.05], b: [1, -0.5, 0.05], radius: 0.15 }];
        run(cloth, 1);
        for (let i = cloth.cols; i < cloth.particleCount; i++) {
            const [, y, z] = at(cloth, i);
            const d = Math.hypot(y + 0.5, z - 0.05);
            expect(d).toBeGreaterThanOrEqual(0.15 + 0.02 - 1e-3);
        }
    });

    it('is blown downwind', () => {
        const calm = panel();
        const windy = panel();
        windy.wind[2] = 8;
        run(calm, 2);
        run(windy, 2);
        expect(Math.abs(at(calm, hem(calm))[2])).toBeLessThan(0.02);
        expect(at(windy, hem(windy))[2]).toBeGreaterThan(0.2);
    });

    it('moves its free particles with a moved pin edge', () => {
        const cloth = panel();
        run(cloth, 1);
        for (let k = 0; k < 60; k++) {
            for (let c = 0; c < cloth.cols; c++) cloth.setPin(c, (c / (cloth.cols - 1) - 0.5) + k / 60, 0, 0);
            cloth.step(1 / 60);
        }
        expect(at(cloth, hem(cloth))[0]).toBeGreaterThan(0.5);
    });

    it('is deterministic for a fixed step', () => {
        const a = panel(), b = panel();
        a.wind[0] = b.wind[0] = 5;
        run(a, 1.5);
        run(b, 1.5);
        expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    });

    it('triangulates the grid with two triangles a cell, and gusts stay within 0..1', () => {
        expect(gridIndices(3, 4).length).toBe((3 - 1) * (4 - 1) * 2 * 3);
        for (let t = 0; t < 10; t += 0.7) {
            const g = windGust(t * 3, -t, t, 0.8, 0.6, 18, 4);
            expect(g).toBeGreaterThanOrEqual(0);
            expect(g).toBeLessThanOrEqual(1);
        }
    });
});

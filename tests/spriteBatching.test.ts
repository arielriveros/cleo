import { describe, it, expect } from 'vitest';
import { SpriteBatchPlanner, type BatchBoundsFn } from '../src/graphics/spriteBatching';

/** A scripted layout: per item a key, additive flag and a rectangle (null = unbounded). */
interface Item { key: number; add?: boolean; rect: [number, number, number, number] | null }

function run(items: Item[], window?: number, maxSkipped?: number) {
    const planner = new SpriteBatchPlanner();
    const keys = Int32Array.from(items.map(i => i.key));
    const additive = Uint8Array.from(items.map(i => (i.add ? 1 : 0)));
    const asked: number[] = [];
    const bounds: BatchBoundsFn = (i, out, o) => {
        asked.push(i);
        const r = items[i].rect;
        if (!r) return false;
        out[o] = r[0]; out[o + 1] = r[1]; out[o + 2] = r[2]; out[o + 3] = r[3];
        return true;
    };
    const runs = planner.plan(items.length, keys, additive, bounds, window, maxSkipped);
    const batches: number[][] = [];
    for (let b = 0; b < runs; b++)
        batches.push(Array.from(planner.order.subarray(planner.runStart[b], planner.runStart[b] + planner.runCount[b])));
    return { batches, asked };
}

const at = (x: number): [number, number, number, number] => [x, 0, x + 1, 1];

describe('SpriteBatchPlanner', () => {
    it('merges consecutive items with one key and asks for no bounds', () => {
        const { batches, asked } = run([{ key: 1, rect: at(0) }, { key: 1, rect: at(0) }, { key: 1, rect: at(0) }]);
        expect(batches).toEqual([[0, 1, 2]]);
        expect(asked).toEqual([]);
    });

    it('splits on a key change when the skipped item overlaps', () => {
        const { batches } = run([{ key: 1, rect: at(0) }, { key: 2, rect: at(0) }, { key: 1, rect: at(0) }]);
        expect(batches).toEqual([[0], [1], [2]]);
    });

    it('jumps an alpha item over a disjoint one', () => {
        const { batches } = run([{ key: 1, rect: at(0) }, { key: 2, rect: at(5) }, { key: 1, rect: at(0) }]);
        expect(batches).toEqual([[0, 2], [1]]);
    });

    it('lets additive pass additive even where they overlap, but not an alpha item', () => {
        const a = (key: number, x: number): Item => ({ key, add: true, rect: at(x) });
        expect(run([a(1, 0), a(2, 0), a(1, 0)]).batches).toEqual([[0, 2], [1]]);
        expect(run([a(1, 0), { key: 2, rect: at(0) }, a(1, 0)]).batches).toEqual([[0], [1], [2]]);
    });

    it('treats an unbounded item as a barrier', () => {
        const { batches } = run([{ key: 1, rect: at(0) }, { key: -1, rect: null }, { key: 1, rect: at(9) }]);
        expect(batches).toEqual([[0], [1], [2]]);
    });

    it('never merges a negative key, even with itself', () => {
        const { batches } = run([{ key: -1, rect: at(0) }, { key: -1, rect: at(5) }]);
        expect(batches).toEqual([[0], [1]]);
    });

    it('keeps a batch\'s members in their original order', () => {
        const items: Item[] = [{ key: 1, rect: at(0) }, { key: 2, rect: at(10) }, { key: 1, rect: at(2) },
                               { key: 2, rect: at(12) }, { key: 1, rect: at(4) }];
        expect(run(items).batches).toEqual([[0, 2, 4], [1, 3]]);
    });

    it('stops at the look-ahead window and the skip limit', () => {
        const items: Item[] = [{ key: 1, rect: at(0) }];
        for (let i = 0; i < 5; i++) items.push({ key: 2 + i, rect: at(10 + 2 * i) });
        items.push({ key: 1, rect: at(0) });
        expect(run(items, 3).batches[0]).toEqual([0]);        // the second key-1 item is 6 positions on
        expect(run(items, 64, 2).batches[0]).toEqual([0]);    // five items to jump, two allowed
        expect(run(items).batches[0]).toEqual([0, 6]);
    });

    it('only reorders pairs that commute, on random layouts', () => {
        let seed = 12345;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
        for (let trial = 0; trial < 200; trial++) {
            const n = 1 + Math.floor(rnd() * 60);
            const items: Item[] = [];
            for (let i = 0; i < n; i++) {
                const x = rnd() * 10, y = rnd() * 10;
                items.push({
                    key: rnd() < 0.08 ? -1 : Math.floor(rnd() * 3),
                    add: rnd() < 0.4,
                    rect: rnd() < 0.05 ? null : [x, y, x + rnd() * 2, y + rnd() * 2],
                });
            }
            const { batches } = run(items);
            const drawn = batches.flat();
            expect([...drawn].sort((a, b) => a - b)).toEqual(items.map((_, i) => i));
            for (const batch of batches) {
                expect(new Set(batch.map(i => items[i].key)).size).toBe(1);
                if (batch.length > 1) expect(items[batch[0]].key).toBeGreaterThanOrEqual(0);
                for (let m = 1; m < batch.length; m++) expect(batch[m]).toBeGreaterThan(batch[m - 1]);
            }
            const pos = new Map(drawn.map((item, p) => [item, p]));
            const commute = (a: Item, b: Item) => {
                if (a.add && b.add) return true;
                if (!a.rect || !b.rect) return false;
                return a.rect[2] < b.rect[0] || b.rect[2] < a.rect[0] || a.rect[3] < b.rect[1] || b.rect[3] < a.rect[1];
            };
            for (let a = 0; a < n; a++)
                for (let b = a + 1; b < n; b++)
                    if (pos.get(b)! < pos.get(a)!) expect(commute(items[a], items[b]), `trial ${trial}: ${a} <-> ${b}`).toBe(true);
        }
    });
});

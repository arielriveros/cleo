import { describe, it, expect } from 'vitest';
import { applyPreset, definePresets } from '../src/core/presets';

// The helper every preset table goes through. Its contract is what makes a table safe to apply twice in
// a row: each entry carries every field, and nothing the target holds afterwards is shared with the table.

interface Opts { a?: number; b?: number; list?: number[]; obj?: { x: number } }

const TABLE = definePresets<Opts>({ a: 1, b: 2, list: [0, 0], obj: { x: 0 } }, [
    ['one', 'One', '', { a: 10 }],
    ['two', 'Two', '', { b: 20, list: [5, 6] }],
]);

describe('presets', () => {
    it('spreads every entry over the base, so a preset never inherits the previous one', () => {
        const target: Opts = {};
        applyPreset(target, TABLE, 'one');
        applyPreset(target, TABLE, 'two');
        expect(target.a).toBe(1);
        expect(target.b).toBe(20);
    });

    it('copies arrays and plain objects instead of aliasing the table', () => {
        const target: Opts = {};
        applyPreset(target, TABLE, 'two');
        target.list![0] = 99;
        target.obj!.x = 99;
        expect(TABLE[1].options.list![0]).toBe(5);
        expect(TABLE[1].options.obj!.x).toBe(0);
    });

    it('keeps a typed-array field the same class', () => {
        const target = { list: new Float32Array(2) };
        applyPreset(target, TABLE, 'two');
        expect(target.list).toBeInstanceOf(Float32Array);
        expect(Array.from(target.list)).toEqual([5, 6]);
    });

    it('assigns through setters in key order', () => {
        const order: string[] = [];
        const target = {
            set a(_: number) { order.push('a'); },
            set b(_: number) { order.push('b'); },
            set list(_: number[]) { order.push('list'); },
            set obj(_: object) { order.push('obj'); },
        };
        applyPreset(target, TABLE, 'one');
        expect(order).toEqual(['a', 'b', 'list', 'obj']);
    });

    it('accepts a preset object and rejects an unknown id', () => {
        const target: Opts = {};
        expect(applyPreset(target, TABLE, TABLE[0])).toBe(true);
        expect(target.a).toBe(10);
        expect(applyPreset(target, TABLE, 'nope')).toBe(false);
    });
});

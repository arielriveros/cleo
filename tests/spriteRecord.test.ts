import { describe, it, expect } from 'vitest';
import { OBJECT_RECORD_FLOATS, packObjectRecord, packSpriteRecord } from '../src/graphics/objectData';
import { ObjectTable, type ObjectTableBackend } from '../src/graphics/objectTable';

// A batched sprite draw reads N contiguous records of the per-object table, one per instance, so a run of
// records must be exactly that: contiguous, never shared, never rewritten within a submission, and intact
// when the table grows to fit it. Every per-sprite value lives in the record.

function fakeTable() {
    let epoch = 0;
    let written = new Map<string, string>();
    const textures: { id: number; rows: number }[] = [];
    const backend: ObjectTableBackend = {
        get submissionEpoch() { return epoch; },
        writeTexture: (tex, data, w, h, _m, _l, x = 0, y = 0) => {
            const t = tex as unknown as { id: number };
            const f = data as Float32Array;
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
                const key = `${t.id}:${x + i},${y + j}`;
                const value = Array.from(f.subarray((j * w + i) * 4, (j * w + i) * 4 + 4)).join(',');
                const before = written.get(key);
                if (before !== undefined && before !== value) throw new Error(`texel ${key} rewritten in one epoch`);
                written.set(key, value);
            }
        },
    };
    const allocate = (rows: number) => {
        const t = { id: textures.length + 1, rows };
        textures.push(t);
        return { rhiTexture: t, delete: () => {} } as never;
    };
    return { table: new ObjectTable(allocate, () => backend), textures, submit: () => { epoch++; written = new Map(); } };
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('packSpriteRecord', () => {
    it('lays a sprite out where the sprite programs read it', () => {
        const out = new Float32Array(OBJECT_RECORD_FLOATS + 8).fill(9);
        const pool = new Float32Array(32);
        const m = Array.from({ length: 16 }, (_, i) => i + 0.5);
        pool.set(m, 16);
        packSpriteRecord(out, 4, pool, 16, 0.25, [0.25, 0.5, 0.75, 1], 0.125, [1, 0.5, 0.25], 0.75, 3, [0.1, 0.2, 0.3]);
        expect(Array.from(out.subarray(4, 20))).toEqual(m);
        expect(Array.from(out.subarray(20, 24))).toEqual([0.25, 0, 0, 0.125]);        // dissolve .. soft fade
        expect(Array.from(out.subarray(24, 28))).toEqual([0.5, 0.5, 0.25, 0.5]);       // t5 = uv scale, offset
        expect(Array.from(out.subarray(28, 32))).toEqual([1, 0.5, 0.25, 0.75]);        // t6 = tint, opacity
        expect(Array.from(out.subarray(32, 36)).map(v => +v.toFixed(6))).toEqual([3, 0.1, 0.2, 0.3]); // t7
        expect(out[3]).toBe(9);
        expect(out[36]).toBe(9);
    });

    it('agrees with packObjectRecord on everything a model record also carries', () => {
        const sprite = new Float32Array(OBJECT_RECORD_FLOATS);
        const model = new Float32Array(OBJECT_RECORD_FLOATS);
        packSpriteRecord(sprite, 0, identity, 0, 0.5, [0.1, 0.2, 0.4, 0.6], 0, [1, 1, 1], 1, 1, null);
        packObjectRecord(model, 0, identity, 0.5, false, 0, 0.4 - 0.1, 0.6 - 0.2, 0.1, 0.2);
        expect(Array.from(sprite.subarray(0, 24))).toEqual(Array.from(model.subarray(0, 24)));
        expect(Array.from(sprite.subarray(29, 32))).toEqual([0, 0, 0]);
    });
});

describe('ObjectTable.appendRun', () => {
    it('claims contiguous records that no later record shares', () => {
        const { table } = fakeTable();
        table.ensure({}, identity, 0, false);
        const first = table.appendRun(3);
        expect(first).toBe(1);
        expect(table.count).toBe(4);
        // An object identical to the run's (zeroed) last record still gets a record of its own.
        expect(table.ensure({}, new Array(16).fill(0), 0, false, 0, 0, 0, 0, 0)).toBe(4);
    });

    it('grows to fit the whole run first, keeping what was written', () => {
        const { table, textures } = fakeTable();
        const before = table.appendRun(2000);
        const staging = table.staging;
        packSpriteRecord(staging, 1999 * OBJECT_RECORD_FLOATS, identity, 0, 0, [0, 0, 1, 1], 0, [0.5, 0.5, 0.5], 1, 7, null);
        table.flush();
        const generation = table.generation;
        const first = table.appendRun(100);
        expect(before).toBe(0);
        expect(first).toBe(2000);
        expect(table.generation).toBeGreaterThan(generation);
        expect(textures.length).toBe(2);
        expect(table.staging[1999 * OBJECT_RECORD_FLOATS + 28]).toBe(7);
        // The flush after growth re-uploads every record into the new texture, never twice into one.
        expect(() => table.flush()).not.toThrow();
    });

    it('starts again at record 0 after a submission', () => {
        const { table, submit } = fakeTable();
        table.appendRun(10);
        submit();
        expect(table.appendRun(5)).toBe(0);
    });
});

import { describe, expect, it } from 'vitest';
import { quat } from 'gl-matrix';
import { ByteReader, ByteWriter } from '../src/netsync/bytes';
import {
    POSITION_SCALE, packQuaternion, quantizeState, readRow, rowSize, sameState, unpackQuaternion, writeRow,
} from '../src/netsync/sync/quantize';
import { seededRandom } from '../src/core/math';

const angleBetween = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    return 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
};

describe('NetSync quantization', () => {
    it('packs any rotation into 32 bits within a quarter of a degree', () => {
        const rand = seededRandom(9);
        let worst = 0;
        for (let i = 0; i < 2000; i++) {
            const q = quat.normalize(quat.create(), quat.fromValues(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1));
            const packed = packQuaternion(q);
            expect(packed).toBeGreaterThanOrEqual(0);
            expect(packed).toBeLessThan(2 ** 32);
            worst = Math.max(worst, angleBetween(q, unpackQuaternion(packed)));
        }
        expect(worst).toBeLessThan(0.25);
    });

    it('treats q and -q as the same rotation', () => {
        const q = quat.normalize(quat.create(), quat.fromValues(0.1, -0.7, 0.2, -0.6));
        const neg = quat.scale(quat.create(), q, -1);
        expect(packQuaternion(q)).toBe(packQuaternion(neg));
        expect(packQuaternion([0, 0, 0, 1])).toBe(packQuaternion([0, 0, 0, -1]));
    });

    it('round-trips a row through the wire, within the quantization step', () => {
        const q = quat.normalize(quat.create(), quat.fromValues(0.3, 0.2, -0.1, 0.9));
        const s = quantizeState([12.3456, -0.0021, 987.654], q, [-3.21, 9.81, 0.015], false);
        const w = new ByteWriter();
        writeRow(w, 300, s);
        const bytes = w.finish();
        expect(bytes.length).toBe(rowSize(300, s));
        const { netId, state } = readRow(new ByteReader(bytes));
        expect(netId).toBe(300);
        expect(sameState(s, state)).toBe(true);
        expect(state.px / POSITION_SCALE).toBeCloseTo(12.3456, 3);
        expect(state.py / POSITION_SCALE).toBeCloseTo(-0.0021, 3);
        expect(state.vy).toBe(Math.round(9.81 * 64));
        expect(state.vz).toBe(1);
    });

    it('keeps a row without a body small, and remembers sleep', () => {
        const s = quantizeState([0, 1, 2], [0, 0, 0, 1], null, false);
        expect(rowSize(5, s)).toBe(18);
        const asleep = quantizeState([0, 1, 2], [0, 0, 0, 1], [0, 0, 0], true);
        const { state } = readRow(new ByteReader((() => { const w = new ByteWriter(); writeRow(w, 5, asleep); return w.finish(); })()));
        expect(state.sleeping).toBe(true);
        expect(rowSize(5, asleep)).toBe(24);
    });

    it('calls states equal only when a player could not tell them apart', () => {
        const a = quantizeState([1, 2, 3], [0, 0, 0, 1], null, false);
        expect(sameState(a, quantizeState([1.0001, 2, 3], [0, 0, 0, 1], null, false))).toBe(true); // 0.1 mm
        expect(sameState(a, quantizeState([1.002, 2, 3], [0, 0, 0, 1], null, false))).toBe(false); // 2 mm
        expect(sameState(undefined, a)).toBe(false);
    });
});

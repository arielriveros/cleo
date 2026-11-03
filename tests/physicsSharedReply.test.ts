import { describe, it, expect } from 'vitest';
import { SharedReplyReader, SharedReplyWriter, sharedReplyBytes } from '../src/physics/worker/sharedReply';
import type { Snapshot } from '../src/physics/worker/protocol';

// The physics worker's replies through shared memory (src/physics/worker/sharedReply.ts): what the main
// thread reads at the start of its frame must be exactly the snapshot the worker wrote, once.

function snapshot(seq: number, bodies: number): Snapshot {
    return {
        kind: 'snapshot', epoch: 3, seq, dt: 1 / 60, time: seq / 60,
        bodies: Float64Array.from({ length: bodies * 15 }, (_, i) => i * 0.5 + seq), bodyCount: bodies,
        contacts: Float64Array.from([0, 1, 0, 1, 0]), contactCount: 1,
        overlaps: Int32Array.from([1, 0, 2]), collides: Int32Array.from([4, 5]),
        submerged: Float64Array.from([0, 2, 0.75]),
        stats: { stepMs: 1.5, broadphaseMs: 0.1, narrowphaseMs: 0.4, solveMs: 0.8, integrateMs: 0.2 },
    };
}

describe('physics replies through shared memory', () => {
    it('reads back exactly what the worker wrote, once', () => {
        const buffer = new SharedArrayBuffer(64 * 1024);
        const writer = new SharedReplyWriter(buffer), reader = new SharedReplyReader(buffer);
        expect(reader.read()).toBeNull();                      // nothing published yet
        const sent = snapshot(7, 20);
        expect(writer.fits(sent)).toBe(true);
        writer.write(sent);
        const got = reader.read()!;
        expect(got).not.toBeNull();
        const { doneAt, ...rest } = got;
        expect(rest).toEqual(sent);
        expect(Number.isFinite(doneAt)).toBe(true);
        expect(got.bodies.buffer).not.toBe(buffer);            // a copy the executor may keep and recycle
        expect(reader.read()).toBeNull();                      // and only once
        writer.write(snapshot(8, 3));
        expect(reader.read()!.seq).toBe(8);
    });

    it('says when a snapshot outgrows the channel', () => {
        const small = new SharedReplyWriter(new SharedArrayBuffer(1024));
        const big = snapshot(1, 200);
        expect(sharedReplyBytes(big)).toBeGreaterThan(1024);
        expect(small.fits(big)).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter } from '../src/netsync/bytes';
import { FixedTicker, ManualScheduler } from '../src/netsync/time';
import { ClockSync } from '../src/netsync/session/clockSync';
import { frame, frameReader } from '../src/netsync/link/netLink';

describe('ByteWriter / ByteReader', () => {
    it('round-trips every field type', () => {
        const w = new ByteWriter(4); // small on purpose: the writer must grow
        w.u8(250).u16(65000).u32(4_000_000_000).f64(-1234.5678).varUint(0).varUint(127).varUint(128)
            .varUint(2 ** 40 + 3).string('héllo ✓').bytes(new Uint8Array([1, 2, 3])).raw(new Uint8Array([9]));
        const r = new ByteReader(w.finish());
        expect(r.u8()).toBe(250);
        expect(r.u16()).toBe(65000);
        expect(r.u32()).toBe(4_000_000_000);
        expect(r.f64()).toBe(-1234.5678);
        expect(r.varUint()).toBe(0);
        expect(r.varUint()).toBe(127);
        expect(r.varUint()).toBe(128);
        expect(r.varUint()).toBe(2 ** 40 + 3);
        expect(r.string()).toBe('héllo ✓');
        expect(Array.from(r.bytes())).toEqual([1, 2, 3]);
        expect(Array.from(r.raw(1))).toEqual([9]);
        expect(r.remaining).toBe(0);
    });

    it('uses one byte for a varUint below 128', () => {
        expect(new ByteWriter().varUint(127).length).toBe(1);
        expect(new ByteWriter().varUint(128).length).toBe(2);
    });

    it('throws instead of reading past the end', () => {
        const r = new ByteReader(new Uint8Array([1, 2]));
        expect(() => r.u32()).toThrow(RangeError);
    });

    it('rejects a negative or fractional varUint', () => {
        expect(() => new ByteWriter().varUint(-1)).toThrow(RangeError);
        expect(() => new ByteWriter().varUint(1.5)).toThrow(RangeError);
    });
});

describe('frameReader', () => {
    it('reassembles messages split and merged across chunks', () => {
        const got: number[][] = [];
        const feed = frameReader((m) => got.push(Array.from(m)));
        const stream = new Uint8Array([...frame(new Uint8Array([1, 2, 3])), ...frame(new Uint8Array([])), ...frame(new Uint8Array([4]))]);
        // Byte by byte, then all at once: both must give the same three messages.
        for (const b of stream) feed(new Uint8Array([b]));
        feed(stream);
        expect(got).toEqual([[1, 2, 3], [], [4], [1, 2, 3], [], [4]]);
    });

    it('refuses a frame over the size limit', () => {
        const feed = frameReader(() => {}, 10);
        expect(() => feed(frame(new Uint8Array(11)))).toThrow(RangeError);
    });
});

describe('ManualScheduler', () => {
    it('runs timers in due order, reading each timer’s own time', async () => {
        const s = new ManualScheduler();
        const seen: string[] = [];
        s.setTimeout(() => seen.push(`b@${s.now()}`), 20);
        s.setTimeout(() => seen.push(`a@${s.now()}`), 10);
        const cancelled = s.setTimeout(() => seen.push('never'), 15);
        s.clearTimeout(cancelled);
        await s.advance(25);
        expect(seen).toEqual(['a@10', 'b@20']);
        expect(s.now()).toBe(25);
    });

    it('runs timers that other timers set, within the same advance', async () => {
        const s = new ManualScheduler();
        const seen: number[] = [];
        s.setTimeout(() => s.setTimeout(() => seen.push(s.now()), 5), 5);
        await s.advance(10);
        expect(seen).toEqual([10]);
    });
});

describe('FixedTicker', () => {
    it('keeps an exact rate whatever the timer granularity', async () => {
        const s = new ManualScheduler();
        const ticks: number[] = [];
        const t = new FixedTicker(30, (n) => ticks.push(n), s);
        t.start();
        await s.advance(1000);
        // Ticks 0..30 inclusive are due by t = 1000 ms (tick 30 is due at exactly 1000).
        expect(ticks.length).toBe(31);
        expect(ticks[ticks.length - 1]).toBe(30);
        t.stop();
        await s.advance(1000);
        expect(ticks.length).toBe(31);
    });

    it('catches up after a stall, but only so far', async () => {
        const s = new ManualScheduler();
        const ticks: number[] = [];
        const t = new FixedTicker(10, (n) => ticks.push(n), s, 3);
        t.start();
        await s.advance(0);
        expect(ticks).toEqual([0]);
        // Simulate a 1 s stall: no timers run while the host is blocked, then time has moved.
        (s as any)._time += 1000;
        await s.advance(0);
        expect(t.skipped).toBe(7);
        expect(ticks).toEqual([0, 8, 9, 10]);
    });
});

describe('ClockSync', () => {
    it('finds the host clock offset from round trips', () => {
        let peerNow = 0;
        const c = new ClockSync(() => peerNow);
        const offset = 5000; // host clock = peer clock + 5000
        for (let i = 0; i < 10; i++) {
            const sent = i * 100;
            const up = 40, down = 40;
            c.addSample(sent, sent + up + offset, sent + up + down);
        }
        peerNow = 2000;
        expect(c.synced).toBe(true);
        expect(c.offsetMs).toBeCloseTo(offset, 6);
        expect(c.hostTimeNow()).toBeCloseTo(7000, 6);
        expect(c.rttMs).toBeCloseTo(80, 6);
    });

    it('trusts the fastest round trips over delayed ones', () => {
        const c = new ClockSync(() => 0);
        const offset = 1000;
        // Fast symmetric samples, then several slowed down on the way back only (biased by +-100 ms).
        for (let i = 0; i < 6; i++) c.addSample(i * 100, i * 100 + 20 + offset, i * 100 + 40);
        for (let i = 6; i < 12; i++) c.addSample(i * 100, i * 100 + 20 + offset, i * 100 + 240);
        expect(Math.abs(c.offsetMs - offset)).toBeLessThan(1);
    });

    it('never runs the host clock backwards when the estimate moves down', () => {
        let peerNow = 1000;
        const c = new ClockSync(() => peerNow);
        c.addSample(0, 600, 200); // offset 500
        const first = c.hostTimeNow(); // 1500
        c.addSample(900, 1290, 1000); // a faster sample with offset 340
        expect(c.hostTimeNow()).toBeGreaterThanOrEqual(first);
        peerNow = 2000;
        expect(c.hostTimeNow()).toBeCloseTo(2340, 6);
    });
});

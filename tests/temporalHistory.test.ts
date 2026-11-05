import { describe, it, expect, vi } from 'vitest';

// A framebuffer that records its size and allocations instead of touching a GPU.
vi.mock('../src/graphics/framebuffer', () => ({
    Framebuffer: class {
        public width = 0;
        public height = 0;
        public resizes = 0;
        constructor(public readonly options: unknown) {}
        resize(w: number, h: number) { this.width = w; this.height = h; this.resizes++; }
    },
}));

import { TemporalHistory } from '../src/graphics/render/temporalHistory';

type Fake = { width: number; height: number; resizes: number; options: unknown };

/**
 * TemporalHistory is the ping-pong storage TAA, the cloud and fluid reprojection and SSIL share. What
 * must hold: nothing is allocated before first use, a resize drops validity (resized storage is
 * uninitialized memory), and a swap turns this frame's target into next frame's history.
 */
describe('TemporalHistory', () => {
    it('allocates two targets on first use, with the options it was given', () => {
        const options = { depth: false };
        const h = new TemporalHistory(options as never);
        expect(h.allocated).toBe(false);
        expect(h.ensure(64, 32)).toBe(true);
        expect(h.targets).toHaveLength(2);
        for (const t of h.targets as unknown as Fake[]) {
            expect(t.options).toBe(options);
            expect([t.width, t.height]).toEqual([64, 32]);
        }
    });

    it('reallocates, and drops validity, only when the size changes', () => {
        const h = new TemporalHistory({} as never);
        h.ensure(64, 32);
        h.swap();
        expect(h.valid).toBe(true);
        expect(h.ensure(64, 32)).toBe(false);
        expect(h.valid).toBe(true);
        expect((h.targets[0] as unknown as Fake).resizes).toBe(1);
        expect(h.ensure(128, 64)).toBe(true);
        expect(h.valid).toBe(false);
    });

    it('reads last frame and writes this frame, trading places on swap', () => {
        const h = new TemporalHistory({} as never);
        h.ensure(8, 8);
        const [a, b] = h.targets;
        expect(h.read).toBe(a);
        expect(h.write).toBe(b);
        expect(h.valid).toBe(false);
        h.swap();
        expect(h.read).toBe(b);
        expect(h.write).toBe(a);
        expect(h.valid).toBe(true);
        h.invalidate();
        expect(h.valid).toBe(false);
        expect(h.read).toBe(b);
    });
});

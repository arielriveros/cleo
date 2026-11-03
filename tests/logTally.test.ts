import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '../src/core/logger';
import { LogTally, plural } from '../src/core/logTally';

// A burst of textures or animators is summarized in ONE log line once it goes quiet, instead of a line each.

const lines = () => Logger.logs.filter(l => l.scope === 'Tally').map(l => l.data[0]);

describe('LogTally', () => {
    beforeEach(() => { vi.useFakeTimers(); Logger.clear(); vi.spyOn(console, 'info').mockImplementation(() => {}); });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    const tally = () => new LogTally('Tally', ['items', 'parts'] as const,
        c => `Made ${plural(c.items, 'item')}, ${plural(c.parts, 'part')}`, 500);

    it('logs the totals once, after the burst goes quiet', () => {
        const t = tally();
        for (let i = 0; i < 5; i++) { t.add({ items: 1, parts: 3 }); vi.advanceTimersByTime(100); }
        expect(lines()).toEqual([]);
        vi.advanceTimersByTime(500);
        expect(lines()).toEqual(['Made 5 items, 15 parts']);
    });

    it('starts a new burst after each summary', () => {
        const t = tally();
        t.add({ items: 2 });
        vi.advanceTimersByTime(500);
        t.add({ items: 1 });
        vi.advanceTimersByTime(500);
        // A count nothing added reads 0.
        expect(lines()).toEqual(['Made 2 items, 0 parts', 'Made 1 item, 0 parts']);
    });

    it('writes nothing when nothing was counted', () => {
        tally().flush();
        vi.advanceTimersByTime(1000);
        expect(lines()).toEqual([]);
    });
});

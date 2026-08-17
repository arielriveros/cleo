import { describe, it, expect } from 'vitest';
import { HistoryManager, HistoryEntry } from '../src/core/history';

/** A recorder over a single mutable value, so a test can assert on the state undo actually restores. */
function counter() {
    const state = { value: 0, log: [] as string[] };
    let clock = 0;
    const set = (next: number, label = `set ${next}`, coalesceKey?: string): HistoryEntry => {
        const prev = state.value;
        state.value = next;
        return {
            label, coalesceKey, time: (clock += 1000),
            undo: () => { state.value = prev; state.log.push(`undo ${label}`); },
            redo: () => { state.value = next; state.log.push(`redo ${label}`); },
        };
    };
    const at = (t: number) => { clock = t; };
    return { state, set, at };
}

describe('HistoryManager', () => {
    it('undo and redo walk the stack and restore state', () => {
        const h = new HistoryManager();
        const c = counter();
        h.push(c.set(1));
        h.push(c.set(2));
        expect(c.state.value).toBe(2);

        expect(h.undo()).toBe(true);
        expect(c.state.value).toBe(1);
        expect(h.undo()).toBe(true);
        expect(c.state.value).toBe(0);
        expect(h.undo()).toBe(false);

        expect(h.redo()).toBe(true);
        expect(c.state.value).toBe(1);
        expect(h.redo()).toBe(true);
        expect(c.state.value).toBe(2);
        expect(h.redo()).toBe(false);
    });

    it('undo -> redo -> undo is idempotent', () => {
        const h = new HistoryManager();
        const c = counter();
        h.push(c.set(5));
        for (let i = 0; i < 4; i++) {
            h.undo();
            expect(c.state.value).toBe(0);
            h.redo();
            expect(c.state.value).toBe(5);
        }
    });

    it('a new edit discards the redo branch', () => {
        const h = new HistoryManager();
        const c = counter();
        h.push(c.set(1));
        h.push(c.set(2));
        h.undo();
        expect(h.canRedo).toBe(true);
        h.push(c.set(9));
        expect(h.canRedo).toBe(false);
    });

    it('evicts the oldest entry past the limit', () => {
        const h = new HistoryManager({ limit: 3 });
        const c = counter();
        for (let i = 1; i <= 5; i++) h.push(c.set(i));
        expect(h.depth).toBe(3);
        while (h.undo()) { /* drain */ }
        // Only the last three are reversible, so it winds back to the state before edit 3.
        expect(c.state.value).toBe(2);
    });

    it('coalesces same-key pushes inside the window, keeping the oldest undo and newest redo', () => {
        const h = new HistoryManager({ coalesceMs: 400 });
        const c = counter();
        c.at(0);
        h.push({ ...c.set(1, 'drag', 'node:transform'), time: 0 });
        h.push({ ...c.set(2, 'drag', 'node:transform'), time: 100 });
        h.push({ ...c.set(3, 'drag', 'node:transform'), time: 300 });
        expect(h.depth).toBe(1);
        h.undo();
        expect(c.state.value).toBe(0);
        h.redo();
        expect(c.state.value).toBe(3);
    });

    it('does not coalesce past the window, or across different keys', () => {
        const h = new HistoryManager({ coalesceMs: 400 });
        const c = counter();
        h.push({ ...c.set(1, 'a', 'k1'), time: 0 });
        h.push({ ...c.set(2, 'b', 'k1'), time: 5000 });
        h.push({ ...c.set(3, 'c', 'k2'), time: 5010 });
        expect(h.depth).toBe(3);
    });

    it('never coalesces entries with no key', () => {
        const h = new HistoryManager({ coalesceMs: 10000 });
        const c = counter();
        h.push({ ...c.set(1), time: 0 });
        h.push({ ...c.set(2), time: 1 });
        expect(h.depth).toBe(2);
    });

    it('batches collapse to one entry and undo in reverse order', () => {
        const h = new HistoryManager();
        const c = counter();
        h.beginBatch('Paint');
        h.push(c.set(1, 'a'));
        h.push(c.set(2, 'b'));
        h.push(c.set(3, 'c'));
        h.endBatch();

        expect(h.depth).toBe(1);
        expect(h.undoLabel).toBe('Paint');
        h.undo();
        expect(c.state.value).toBe(0);
        expect(c.state.log).toEqual(['undo c', 'undo b', 'undo a']);
        h.redo();
        expect(c.state.value).toBe(3);
    });

    it('beginBatch is a re-entrant depth counter', () => {
        const h = new HistoryManager();
        const c = counter();
        h.beginBatch('Outer');
        h.push(c.set(1));
        h.beginBatch('Inner');
        h.push(c.set(2));
        h.endBatch();
        expect(h.depth).toBe(0);            // inner end must not close the outer group
        expect(h.batching).toBe(true);
        h.push(c.set(3));
        h.endBatch();
        expect(h.depth).toBe(1);
        expect(h.undoLabel).toBe('Outer');
    });

    it('an empty batch pushes nothing', () => {
        const h = new HistoryManager();
        h.beginBatch('Nothing');
        h.endBatch();
        expect(h.depth).toBe(0);
        h.endBatch();                        // unbalanced end is a no-op, not a crash
        expect(h.depth).toBe(0);
    });

    it('a one-entry batch takes the batch label', () => {
        const h = new HistoryManager();
        const c = counter();
        h.beginBatch('Move');
        h.push(c.set(1, 'set position'));
        h.endBatch();
        expect(h.undoLabel).toBe('Move');
    });

    it('silently suppresses recording, and is re-entrant', () => {
        const h = new HistoryManager();
        const c = counter();
        h.silently(() => {
            h.push(c.set(1));
            h.silently(() => h.push(c.set(2)));
            h.push(c.set(3));
        });
        expect(h.depth).toBe(0);
        expect(h.suspended).toBe(false);
        h.push(c.set(4));
        expect(h.depth).toBe(1);
    });

    it('silently restores its counter even when the body throws', () => {
        const h = new HistoryManager();
        expect(() => h.silently(() => { throw new Error('boom'); })).toThrow('boom');
        expect(h.suspended).toBe(false);
    });

    it('an undo does not record the edits its own inverse performs', () => {
        const h = new HistoryManager();
        const c = counter();
        // An inverse that itself goes through the recorded API is the normal case for a scene edit.
        h.push({
            label: 'reentrant', time: 0,
            undo: () => { h.push(c.set(99)); c.state.value = 0; },
            redo: () => { c.state.value = 7; },
        });
        h.undo();
        expect(h.depth).toBe(0);
        expect(h.canRedo).toBe(true);
    });

    it('undo/redo abort an open batch rather than interleaving with it', () => {
        const h = new HistoryManager();
        const c = counter();
        h.push(c.set(1));
        h.beginBatch('Half-finished');
        h.push(c.set(2));
        h.undo();
        expect(h.batching).toBe(false);
        expect(c.state.value).toBe(0);
        expect(h.depth).toBe(0);
    });

    it('clear empties both stacks', () => {
        const h = new HistoryManager();
        const c = counter();
        h.push(c.set(1));
        h.undo();
        h.push(c.set(2));
        h.clear();
        expect(h.canUndo).toBe(false);
        expect(h.canRedo).toBe(false);
        expect(h.undoLabel).toBeNull();
        expect(h.redoLabel).toBeNull();
    });

    it('notifies subscribers and honours unsubscribe', () => {
        const h = new HistoryManager();
        const c = counter();
        let calls = 0;
        const off = h.onChange(() => { calls++; });
        h.push(c.set(1));
        h.undo();
        h.redo();
        expect(calls).toBe(3);
        off();
        h.push(c.set(2));
        expect(calls).toBe(3);
    });

    it('a listener that unsubscribes during dispatch does not disturb the others', () => {
        const h = new HistoryManager();
        const c = counter();
        let other = 0;
        const offA = h.onChange(() => offA());
        h.onChange(() => { other++; });
        h.push(c.set(1));
        expect(other).toBe(1);
    });
});

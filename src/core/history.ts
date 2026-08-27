// Undo/redo stack. An entry is just a label plus an undo and a redo closure, so this never has to know
// what an "edit" is. No DOM, no GL, no scene imports.

/** One reversible edit. `undo` must restore exactly the state `redo` produces from. */
export interface HistoryEntry {
    label: string;
    undo(): void;
    redo(): void;
    /**
     * Entries pushed within `coalesceMs` of each other under the same key merge into one: the older
     * entry's `undo` is kept and the newer one's `redo`, so a slider drag is a single undo step.
     */
    coalesceKey?: string;
    /** Milliseconds, supplied by the pusher so the manager stays free of a clock dependency. */
    time: number;
}

export interface HistoryOptions {
    /** Entries retained before the oldest is dropped. */
    limit?: number;
    /** Coalescing window in milliseconds. */
    coalesceMs?: number;
}

export class HistoryManager {
    private _undoStack: HistoryEntry[] = [];
    private _redoStack: HistoryEntry[] = [];
    private _limit: number;
    private _coalesceMs: number;
    private _silent = 0;
    private _batchDepth = 0;
    private _batchLabel = '';
    private _batch: HistoryEntry[] = [];
    private _listeners = new Set<() => void>();

    constructor(opts?: HistoryOptions) {
        this._limit = Math.max(1, opts?.limit ?? 200);
        this._coalesceMs = Math.max(0, opts?.coalesceMs ?? 400);
    }

    public get canUndo(): boolean { return this._undoStack.length > 0; }
    public get canRedo(): boolean { return this._redoStack.length > 0; }
    public get undoLabel(): string | null { return this._undoStack[this._undoStack.length - 1]?.label ?? null; }
    public get redoLabel(): string | null { return this._redoStack[this._redoStack.length - 1]?.label ?? null; }
    public get depth(): number { return this._undoStack.length; }
    /** True while an undo/redo (or an explicitly silenced block) is running. */
    public get suspended(): boolean { return this._silent > 0; }
    public get batching(): boolean { return this._batchDepth > 0; }

    public push(entry: HistoryEntry): void {
        if (this._silent > 0) return;

        if (this._batchDepth > 0) { this._batch.push(entry); return; }

        this._redoStack.length = 0;

        const top = this._undoStack[this._undoStack.length - 1];
        if (top && entry.coalesceKey && top.coalesceKey === entry.coalesceKey
            && entry.time - top.time <= this._coalesceMs) {
            // Keep the OLDER undo (the state before the whole gesture) and the NEWER redo (its result).
            this._undoStack[this._undoStack.length - 1] = {
                label: top.label,
                undo: top.undo,
                redo: entry.redo,
                coalesceKey: entry.coalesceKey,
                time: entry.time,
            };
            this._emit();
            return;
        }

        this._undoStack.push(entry);
        if (this._undoStack.length > this._limit) this._undoStack.shift();
        this._emit();
    }

    /**
     * Group everything pushed until the matching `endBatch` into one entry. Re-entrant: a nested
     * begin/end pair does not close the outer group.
     */
    public beginBatch(label: string): void {
        if (this._batchDepth === 0) { this._batch = []; this._batchLabel = label; }
        this._batchDepth++;
    }

    public endBatch(): void {
        if (this._batchDepth === 0) return;
        this._batchDepth--;
        if (this._batchDepth > 0) return;

        const entries = this._batch;
        this._batch = [];
        if (entries.length === 0) return;
        if (entries.length === 1) { this.push({ ...entries[0], label: this._batchLabel || entries[0].label }); return; }

        const label = this._batchLabel || entries[0].label;
        const time = entries[entries.length - 1].time;
        this.push({
            label,
            time,
            undo: () => { for (let i = entries.length - 1; i >= 0; i--) entries[i].undo(); },
            redo: () => { for (const e of entries) e.redo(); },
        });
    }

    /** Discard whatever the open batch has collected without pushing it. */
    public abortBatch(): void {
        this._batchDepth = 0;
        this._batch = [];
    }

    /**
     * Run `fn` with recording off — how undo/redo avoid recording themselves, and how a caller keeps
     * its own bookkeeping out of the user's history. Re-entrant.
     */
    public silently<T>(fn: () => T): T {
        this._silent++;
        try { return fn(); } finally { this._silent--; }
    }

    public undo(): boolean {
        if (this._batchDepth > 0) this.abortBatch();
        const entry = this._undoStack.pop();
        if (!entry) return false;
        this.silently(() => entry.undo());
        this._redoStack.push(entry);
        this._emit();
        return true;
    }

    public redo(): boolean {
        if (this._batchDepth > 0) this.abortBatch();
        const entry = this._redoStack.pop();
        if (!entry) return false;
        this.silently(() => entry.redo());
        this._undoStack.push(entry);
        this._emit();
        return true;
    }

    public clear(): void {
        this._undoStack = [];
        this._redoStack = [];
        this.abortBatch();
        this._emit();
    }

    /** Subscribe to stack changes. Returns the unsubscribe function. */
    public onChange(cb: () => void): () => void {
        this._listeners.add(cb);
        return () => { this._listeners.delete(cb); };
    }

    private _emit(): void {
        // Iterate a copy so a listener that unsubscribes during dispatch cannot disturb it.
        for (const cb of [...this._listeners]) cb();
    }
}

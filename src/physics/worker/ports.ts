import { PhysicsWorkerCore } from './workerCore';
import type { FromWorker, ToWorker } from './protocol';
import { SharedReplyReader } from './sharedReply';

/** How the main thread talks to the physics worker: a real Worker, or the same core in-process (tests). */
export interface PhysicsPort {
    post(msg: ToWorker, transfer: Transferable[]): void;
    /** Deliver whatever has arrived. A real Worker delivers on its own; the loopback delivers here. */
    poll(): void;
    onMessage: ((msg: FromWorker) => void) | null;
    onError: ((error: unknown) => void) | null;
    dispose(): void;
}

/**
 * A dedicated Worker running physics/worker/physicsWorker.ts. Replies arrive as messages, or — once the
 * worker has sent a shared reply channel (a cross-origin isolated page) — are read from shared memory at
 * `poll`, without waiting for the message task a busy frame holds back (see sharedReply.ts).
 */
export class WorkerPort implements PhysicsPort {
    public onMessage: ((msg: FromWorker) => void) | null = null;
    public onError: ((error: unknown) => void) | null = null;
    private _channel: SharedReplyReader | null = null;

    constructor(private readonly _worker: Worker) {
        _worker.onmessage = (e: MessageEvent<FromWorker>) => {
            if (e.data.kind === 'channel') { this._channel = new SharedReplyReader(e.data.buffer); return; }
            this.onMessage?.(e.data);
        };
        _worker.onerror = (e: ErrorEvent) => { e.preventDefault?.(); this.onError?.(e.message || e); };
        _worker.onmessageerror = (e) => this.onError?.(e);
    }

    /** Whether replies come through shared memory. */
    public get shared(): boolean { return this._channel !== null; }

    public post(msg: ToWorker, transfer: Transferable[]): void { this._worker.postMessage(msg, transfer); }
    public poll(): void {
        const snap = this._channel?.read();
        if (snap) this.onMessage?.(snap);
    }
    public dispose(): void { this._worker.terminate(); }
}

/**
 * The worker core run in this thread, with the real thing's semantics: every message is copied
 * (structuredClone) both ways, and a reply can be held back `delayFrames` polls to stand for a worker that
 * has not finished yet — or `delayFor(seq)` polls, per step. `failAt` makes the step with that sequence
 * number throw, for the fallback path.
 */
export class LoopbackPort implements PhysicsPort {
    public onMessage: ((msg: FromWorker) => void) | null = null;
    public onError: ((error: unknown) => void) | null = null;
    public readonly core = new PhysicsWorkerCore();
    private readonly _queue: { reply: FromWorker; due: number }[] = [];
    private _polls = 0;

    constructor(private readonly _options: { delayFrames?: number; delayFor?: (seq: number) => number; failAt?: number } = {}) {}

    public post(msg: ToWorker, _transfer: Transferable[]): void {
        if (msg.kind === 'step' && this._options.failAt !== undefined && msg.seq === this._options.failAt) {
            this.onError?.(new Error('physics worker: injected failure'));
            return;
        }
        const reply = this.core.handle(structuredClone(msg));
        const delay = (msg.kind === 'step' ? this._options.delayFor?.(msg.seq) : undefined) ?? this._options.delayFrames ?? 0;
        const deliver = (r: FromWorker | null) => {
            if (!r) return;
            if (delay <= 0) this.onMessage?.(structuredClone(r));
            else this._queue.push({ reply: structuredClone(r), due: this._polls + delay });
        };
        // A promise while a backend's library loads in the core: delivered when it resolves, as a real
        // worker's reply would arrive.
        if (reply instanceof Promise) reply.then(deliver);
        else deliver(reply);
    }

    public poll(): void {
        this._polls++;
        while (this._queue.length && this._queue[0].due <= this._polls) this.onMessage?.(this._queue.shift()!.reply);
    }

    public dispose(): void { this._queue.length = 0; }
}

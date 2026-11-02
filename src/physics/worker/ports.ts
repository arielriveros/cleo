import { PhysicsWorkerCore } from './workerCore';
import type { FromWorker, ToWorker } from './protocol';

/** How the main thread talks to the physics worker: a real Worker, or the same core in-process (tests). */
export interface PhysicsPort {
    post(msg: ToWorker, transfer: Transferable[]): void;
    /** Deliver whatever has arrived. A real Worker delivers on its own; the loopback delivers here. */
    poll(): void;
    onMessage: ((msg: FromWorker) => void) | null;
    onError: ((error: unknown) => void) | null;
    dispose(): void;
}

/** A dedicated Worker running physics/worker/physicsWorker.ts. */
export class WorkerPort implements PhysicsPort {
    public onMessage: ((msg: FromWorker) => void) | null = null;
    public onError: ((error: unknown) => void) | null = null;

    constructor(private readonly _worker: Worker) {
        _worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage?.(e.data);
        _worker.onerror = (e: ErrorEvent) => { e.preventDefault?.(); this.onError?.(e.message || e); };
        _worker.onmessageerror = (e) => this.onError?.(e);
    }

    public post(msg: ToWorker, transfer: Transferable[]): void { this._worker.postMessage(msg, transfer); }
    public poll(): void {}
    public dispose(): void { this._worker.terminate(); }
}

/**
 * The worker core run in this thread, with the real thing's semantics: every message is copied
 * (structuredClone) both ways, and a reply can be held back `delayFrames` polls to stand for a worker that
 * has not finished yet. `failAt` makes the step with that sequence number throw, for the fallback path.
 */
export class LoopbackPort implements PhysicsPort {
    public onMessage: ((msg: FromWorker) => void) | null = null;
    public onError: ((error: unknown) => void) | null = null;
    public readonly core = new PhysicsWorkerCore();
    private readonly _queue: { reply: FromWorker; due: number }[] = [];
    private _polls = 0;

    constructor(private readonly _options: { delayFrames?: number; failAt?: number } = {}) {}

    public post(msg: ToWorker, _transfer: Transferable[]): void {
        if (msg.kind === 'step' && this._options.failAt !== undefined && msg.seq === this._options.failAt) {
            this.onError?.(new Error('physics worker: injected failure'));
            return;
        }
        const reply = this.core.handle(structuredClone(msg));
        if (!reply) return;
        const delay = this._options.delayFrames ?? 0;
        if (delay <= 0) this.onMessage?.(structuredClone(reply));
        else this._queue.push({ reply: structuredClone(reply), due: this._polls + delay });
    }

    public poll(): void {
        this._polls++;
        while (this._queue.length && this._queue[0].due <= this._polls) this.onMessage?.(this._queue.shift()!.reply);
    }

    public dispose(): void { this._queue.length = 0; }
}

/// <reference lib="webworker" />
import { PhysicsWorkerCore } from './workerCore';
import type { FromWorker, ToWorker } from './protocol';
import { canShareReplies, SharedReplyWriter, sharedReplyBytes } from './sharedReply';

// The physics worker's entry point: one PhysicsWorkerCore answering the main thread's step messages with
// snapshots. Everything it does is in workerCore.ts; see protocol.ts for the conversation. Hosts create it
// with their bundler's worker syntax (PhysicsSystem.setWorkerMode takes a factory).

const core = new PhysicsWorkerCore();
const scope = self as unknown as DedicatedWorkerGlobalScope;
/** Where snapshots go when the page is cross-origin isolated (see sharedReply.ts); null: by message. */
let channel: SharedReplyWriter | null = null;
const sharing = canShareReplies();

scope.onmessage = (e: MessageEvent<ToWorker>) => {
    const reply = core.handle(e.data);
    // A promise while a backend's library loads (Rapier's WASM): later replies wait behind it, in order.
    if (reply instanceof Promise) reply.then(send);
    else send(reply);
};

function send(reply: FromWorker | null): void {
    if (!reply) return;
    if (reply.kind !== 'snapshot') { scope.postMessage(reply); return; }
    if (channel?.fits(reply)) {
        channel.write(reply);
        core.reclaim(reply);
        return;
    }
    // No channel yet, or this snapshot outgrew it: a bigger one for the next replies, and this one by
    // message (the main thread cannot read the new channel before the message carrying it arrives).
    if (sharing) {
        channel = new SharedReplyWriter(new SharedArrayBuffer(Math.max(256 * 1024, 2 * sharedReplyBytes(reply))));
        scope.postMessage({ kind: 'channel', buffer: channel.buffer });
    }
    scope.postMessage(reply, PhysicsWorkerCore.transfers(reply));
}

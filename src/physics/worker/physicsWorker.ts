/// <reference lib="webworker" />
import { PhysicsWorkerCore } from './workerCore';
import type { ToWorker } from './protocol';

// The physics worker's entry point: one PhysicsWorkerCore answering the main thread's step messages with
// snapshots. Everything it does is in workerCore.ts; see protocol.ts for the conversation. Hosts create it
// with their bundler's worker syntax (PhysicsSystem.setWorkerMode takes a factory).

const core = new PhysicsWorkerCore();
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<ToWorker>) => {
    const reply = core.handle(e.data);
    if (!reply) return;
    if (reply.kind === 'snapshot') scope.postMessage(reply, PhysicsWorkerCore.transfers(reply));
    else scope.postMessage(reply);
};

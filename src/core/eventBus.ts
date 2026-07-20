import { EventEmitter } from 'events';

/**
 * The engine-wide event bus, in its own module so lightweight producers can reach it without importing
 * the whole engine.
 *
 * `CleoEngine.eventEmitter` is exactly this object (engine.ts assigns it), so every existing
 * `CleoEngine.eventEmitter.on(...)` consumer is unaffected. The reason it lives here rather than on the
 * engine class: `Logger` emits through it, and if `Logger` imported `engine.ts` to reach it, then any
 * module that logs — including pure, WebGL-free algorithm modules like physics/convexHull.ts — would
 * transitively pull in the entire renderer graph (and the vendored assimpjs blob), which breaks their
 * isolated unit tests. Importing this one-line module keeps `Logger` cheap.
 */
export const engineEventBus = new EventEmitter();

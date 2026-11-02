// The physics worker, as this app's bundler builds it: the engine's own worker module (cannon-es and the
// physics leaf modules only — see src/physics/worker/). It lives here, beside the other workers, because
// Vite only bundles a worker it is pointed at with a relative `new URL('./x.ts', import.meta.url)`.
import 'cleo/physics/worker/physicsWorker';

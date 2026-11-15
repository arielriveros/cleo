// The engine's optional features (src/modules/<id>), installed: what a test needs to parse, step or draw their
// nodes when it imports engine modules directly rather than the full barrel (src/cleo.ts installs them all).
// Import it before anything that parses a scene. The runtime barrel first: it settles the engine's import order
// the way every real program loads it, before the features import into it.
import '../../src/cleoCore';
import '../../src/modules/all';

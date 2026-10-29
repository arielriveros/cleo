import { fileURLToPath } from 'node:url';
import type { AliasOptions } from 'vite';

/**
 * How an application resolves the app-kit: `@cleo/app-kit/<area>/<module>` -> app-kit/src/<area>/<module>.
 * Source, not a build, for the same reasons the engine is aliased to source (HMR across the boundary,
 * one set of module identities). npm's workspace link puts the package on the resolution path, which is
 * what lets app-kit files find react, dockview and the rest from the shared node_modules.
 */
export const APP_KIT_SRC = fileURLToPath(new URL('./src/', import.meta.url));

export const appKitAlias: AliasOptions = [
  { find: /^@cleo\/app-kit\/(.+)$/, replacement: APP_KIT_SRC + '$1' },
];


import { fileURLToPath } from 'node:url';
import type { AliasOptions, Connect, Plugin } from 'vite';

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

/**
 * Response headers that make a page cross-origin isolated, which is what unlocks SharedArrayBuffer: the
 * physics worker then hands each step back through shared memory instead of a message the busy main
 * thread can only take between frames (src/physics/worker/sharedReply.ts). `credentialless` rather than
 * `require-corp`, so a cross-origin image or font still loads (without cookies) without opting in.
 * Every app served on the editor's origin sends them, so a window one opens for another (the Creator)
 * stays in the same browsing context group.
 */
export const crossOriginIsolation: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

/**
 * Sends {@link crossOriginIsolation} on EVERY response of the dev and preview servers. Not `server.headers`:
 * Vite leaves those off a 304, and a browser that cached a page from before keeps revalidating it to a
 * 304 whose (missing) headers never replace the stored ones, so the page stays un-isolated until a hard
 * reload. Set first, they also ride on what the editor's /creator proxy passes through.
 */
export function crossOriginIsolationPlugin(): Plugin {
  const isolate: Connect.NextHandleFunction = (_req, res, next) => {
    for (const [name, value] of Object.entries(crossOriginIsolation)) res.setHeader(name, value);
    next();
  };
  return {
    name: 'cleo:cross-origin-isolation',
    configureServer(server) { server.middlewares.use(isolate); },
    configurePreviewServer(server) { server.middlewares.use(isolate); },
  };
}


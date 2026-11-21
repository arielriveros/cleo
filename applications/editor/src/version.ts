// The build's product version, injected by Vite's `define` (see vite.config.ts / buildVersion.js).
// In dev Vite supplies these as globals through /@vite/env instead of substituting them in place.
// `__APP_VERSION__` comes from the ROOT package.json, never from `cleo`/dist. `__BUILD_TAGGED__` is
// `git describe --exact-match` on HEAD and fails safe to false, so anything untagged is marked -dev.
declare const __APP_VERSION__: string;
declare const __BUILD_TAGGED__: boolean;
declare const __APP_CHANGELOG__: { title: string; markdown: string }[] | undefined;

/** Bare product version, e.g. `1.0.156.27`. */
export const APP_VERSION = __APP_VERSION__;

/** What the UI shows: `v1.0.156.27`, or `v1.0.156.27-dev` for any build not made from a release tag. */
export const VERSION_LABEL = `v${__APP_VERSION__}${__BUILD_TAGGED__ ? '' : '-dev'}`;

/**
 * What changed, for Help ▸ About: this release's CHANGELOG.md section, or for a -dev build what is Unreleased and
 * the release it sits on (buildVersion.js `changelogSections`). Guarded: the vitest configs do not run the define.
 */
export const APP_CHANGELOG: { title: string; markdown: string }[] =
  typeof __APP_CHANGELOG__ !== 'undefined' && Array.isArray(__APP_CHANGELOG__) ? __APP_CHANGELOG__ : [];

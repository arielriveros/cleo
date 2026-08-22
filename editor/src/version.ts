// The build's product version, injected by webpack's DefinePlugin (see webpack.config.js).
//
// Read from the ROOT package.json at build time rather than from `cleo`/dist, so a stale engine build
// can never make the editor report the wrong version. `__BUILD_TAGGED__` is `git describe --exact-match`
// on HEAD: only a build made from the exact commit a release tag points at is allowed to call itself
// that version — everything else (local dev, a feature branch, a mid-cycle merge to main, a PR preview
// deploy) is marked `-dev`. Both defines fail safe: no git, a shallow clone or an untagged commit all
// resolve to `false`, so an unmarked version string is always a real release.
//
// Declared here rather than in a global .d.ts: this module is the only consumer, and keeping the
// ambients next to it means there is no second file to remember when the defines change.
declare const __APP_VERSION__: string;
declare const __BUILD_TAGGED__: boolean;

/** Bare product version, e.g. `1.0.156.27`. */
export const APP_VERSION = __APP_VERSION__;

/** What the UI shows: `v1.0.156.27`, or `v1.0.156.27-dev` for any build not made from a release tag. */
export const VERSION_LABEL = `v${__APP_VERSION__}${__BUILD_TAGGED__ ? '' : '-dev'}`;

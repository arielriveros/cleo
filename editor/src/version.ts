// The build's product version, injected by webpack's DefinePlugin (see webpack.config.js).
// `__APP_VERSION__` comes from the ROOT package.json, never from `cleo`/dist. `__BUILD_TAGGED__` is
// `git describe --exact-match` on HEAD and fails safe to false, so anything untagged is marked -dev.
declare const __APP_VERSION__: string;
declare const __BUILD_TAGGED__: boolean;

/** Bare product version, e.g. `1.0.156.27`. */
export const APP_VERSION = __APP_VERSION__;

/** What the UI shows: `v1.0.156.27`, or `v1.0.156.27-dev` for any build not made from a release tag. */
export const VERSION_LABEL = `v${__APP_VERSION__}${__BUILD_TAGGED__ ? '' : '-dev'}`;

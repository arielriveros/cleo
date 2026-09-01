// Product version, scheme 1.<breaking>.<feature>.<fix>: breaking changes, major features, fixes/refactors.
//
// Rewritten by tools/bump-version.mjs alongside the three package.json files, which hold the same number
// WITHOUT the fixed `1.` product-line prefix (npm requires three-component semver). CI runs
// `bump-version.mjs --check` so the two representations can never drift.
export const VERSION = '1.1.2.4';

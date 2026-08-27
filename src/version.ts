// Product version, scheme 1.<breaking>.<feature>.<fix>. Rewritten by tools/bump-version.mjs alongside
// the three package.json files, which hold the same number WITHOUT the `1.` product-line prefix (npm
// requires three-component semver). `bump-version.mjs --check` guards the two against drifting.
export const VERSION = '1.0.156.27';

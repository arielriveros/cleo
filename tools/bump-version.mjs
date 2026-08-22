#!/usr/bin/env node
// The single place that knows the product-version scheme.
//
// The product version is FOUR components -- 1.<breaking>.<feature>.<fix> -- but npm's `version` field
// must be valid semver, which is three. The leading `1.` is therefore a fixed product-line prefix that
// lives nowhere but here: package.json stores the remainder `x.y.z`, whose major/minor/patch already
// mean exactly breaking/feature/fix. Display strings and git tags prepend the `1.`.
//
//   package.json "0.156.26"   <->   v1.0.156.26
//
// Four things must agree at all times: the three package.json files (root/editor/desktop, kept in
// lockstep so the Electron installer version tracks releases too), their lockfiles, and src/version.ts
// -- which is what the engine exports and what the editor's splash renders. `--check` runs in CI.
//
// Edits are surgical regex replacements rather than JSON.parse/stringify round-trips: the lockfiles are
// tens of thousands of lines and a re-serialize would produce an unreviewable diff. Every replacement
// asserts the value it is replacing, so a drifted file fails loudly instead of being silently rewritten.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Root first -- it is the one read to decide the bump; the other two only follow it.
const PACKAGES = ['.', 'editor', 'desktop'];
const VERSION_TS = join(ROOT, 'src', 'version.ts');

// Matches a "version" key. Line-anchored and searched in order, so the first match in a package.json is
// the top-level one, and the first TWO in a package-lock.json are `.version` and `.packages[""].version`
// -- both of which sit above the first dependency entry. Hence the explicit occurrence counts below.
const VERSION_KEY = /^(\s*"version":\s*")([^"]+)(")/gm;

const LEVELS = { breaking: 0, feature: 1, fix: 2 };

const pkgPath = (dir, file) => (dir === '.' ? join(ROOT, file) : join(ROOT, dir, file));

function readVersionTs() {
    const m = readFileSync(VERSION_TS, 'utf8').match(/export const VERSION = '([^']+)'/);
    if (!m) throw new Error("src/version.ts: no `export const VERSION = '...'` found");
    return m[1];
}

// The first `count` "version" keys in `file`, in file order.
function readVersions(file, count) {
    const found = [...readFileSync(file, 'utf8').matchAll(VERSION_KEY)].slice(0, count).map((m) => m[2]);
    if (found.length !== count) throw new Error(`${file}: expected ${count} "version" key(s), found ${found.length}`);
    return found;
}

// Rewrites the first `count` "version" keys, asserting each currently holds `from`.
function replaceVersions(file, from, to, count) {
    let n = 0;
    const text = readFileSync(file, 'utf8').replace(VERSION_KEY, (full, pre, cur, post) => {
        if (n >= count) return full;
        if (cur !== from) throw new Error(`${file}: occurrence ${n + 1} of "version" is "${cur}", expected "${from}"`);
        n++;
        return `${pre}${to}${post}`;
    });
    if (n !== count) throw new Error(`${file}: expected ${count} "version" key(s), found ${n}`);
    writeFileSync(file, text);
}

function check() {
    const root = readVersions(pkgPath('.', 'package.json'), 1)[0];
    const problems = [];

    for (const dir of PACKAGES) {
        if (dir !== '.') {
            const v = readVersions(pkgPath(dir, 'package.json'), 1)[0];
            if (v !== root) problems.push(`${dir}/package.json is "${v}" but package.json is "${root}"`);
        }
        // npm ci compares the lockfile's version against package.json's, so both copies must move too.
        for (const [i, v] of readVersions(pkgPath(dir, 'package-lock.json'), 2).entries()) {
            if (v !== root) problems.push(`${dir}/package-lock.json occurrence ${i + 1} is "${v}", expected "${root}"`);
        }
    }

    const display = readVersionTs();
    if (display !== `1.${root}`) problems.push(`src/version.ts is "${display}" but package.json implies "1.${root}"`);

    if (problems.length) {
        console.error('Version drift:\n' + problems.map((p) => `  - ${p}`).join('\n'));
        console.error('\nAll of these are rewritten together by `node tools/bump-version.mjs <breaking|feature|fix>`.');
        process.exit(1);
    }
    console.log(`Version consistent: v${display} (package.json "${root}")`);
}

function bump(level) {
    const from = readVersions(pkgPath('.', 'package.json'), 1)[0];
    const parts = from.split('.').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`package.json version "${from}" is not x.y.z`);

    const i = LEVELS[level];
    parts[i]++;
    // A bump zeroes everything below it: without this, v1.0.156.26 + feature would read v1.0.157.26.
    for (let j = i + 1; j < parts.length; j++) parts[j] = 0;

    const to = parts.join('.');
    const display = `1.${to}`;

    for (const dir of PACKAGES) {
        replaceVersions(pkgPath(dir, 'package.json'), from, to, 1);
        replaceVersions(pkgPath(dir, 'package-lock.json'), from, to, 2);
    }
    writeFileSync(VERSION_TS, versionTsSource(display));

    console.log(display);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${display}\n`);
}

export function versionTsSource(display) {
    return `// Product version, scheme 1.<breaking>.<feature>.<fix>: breaking changes, major features, fixes/refactors.
//
// Rewritten by tools/bump-version.mjs alongside the three package.json files, which hold the same number
// WITHOUT the fixed \`1.\` product-line prefix (npm requires three-component semver). CI runs
// \`bump-version.mjs --check\` so the two representations can never drift.
export const VERSION = '${display}';
`;
}

const arg = process.argv[2];
if (arg === '--check') check();
else if (arg in LEVELS) bump(arg);
else {
    console.error('usage: node tools/bump-version.mjs <breaking|feature|fix>\n       node tools/bump-version.mjs --check');
    process.exit(2);
}

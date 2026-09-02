#!/usr/bin/env node
// Turns a merged pull request into the two things a release is cut from: how far to bump, and what
// the changelog says.
//
// The changelog used to be a list of commit subjects between two tags, which is not what CHANGELOG.md
// actually reads like -- its entries are prose, and prose is what a reviewer already wrote in the pull
// request. So the PR DESCRIPTION is the release note now, and this file is the one place that reads a
// PR. `changelog.mjs` still owns the file's shape; nothing about a PR leaks into it.
//
// Both CLI modes read `PR_BODY` and `PR_LABELS` from the ENVIRONMENT. That is not a style choice: a PR
// body is untrusted text written by whoever opened it, and a workflow that interpolated it into a
// shell line would be handing that person the runner.
import { writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** The bump levels `tools/bump-version.mjs` accepts, ordered most significant first. */
export const LEVELS = ['breaking', 'feature', 'fix'];

/** What a PR that says nothing gets. Most merges here are fixes; a feature is worth stating. */
export const DEFAULT_LEVEL = 'fix';

/** Any of these on a PR means it is not released, whatever else it says. */
export const SKIP_LABEL = 'no-release';

const MARKER = /^[ \t]*Release:[ \t]*(breaking|feature|fix)[ \t]*$/im;

/**
 * How far to bump, from the PR's labels first and its body second.
 *
 * A `release:<level>` label wins because it is visible on the PR list and editable after the fact
 * without touching the description. Two of them is an error rather than a coin toss -- the version
 * number is not something to guess at, and the mistake is thirty seconds to fix while the workflow is
 * still red. A `Release: <level>` line in the body is the fallback for anyone who would rather not
 * manage labels, and `fix` is what silence means.
 *
 * @param {string[]} labels label names, as `github.event.pull_request.labels.*.name` gives them
 * @param {string} body the PR description
 */
export function resolveBump(labels = [], body = '') {
    const named = LEVELS.filter(level => labels.includes('release:' + level));
    if (named.length > 1)
        throw new Error('PR carries more than one release label: ' + named.map(l => 'release:' + l).join(', '));
    if (named.length === 1) return named[0];

    const marked = MARKER.exec(body || '');
    return marked ? marked[1].toLowerCase() : DEFAULT_LEVEL;
}

/** Whether this PR should cut a release at all. */
export function shouldRelease(labels = []) {
    return !labels.includes(SKIP_LABEL);
}

/**
 * The PR description, as a changelog section body.
 *
 * Three transforms, all of them about the description being written for a REVIEWER and read by
 * someone six months later:
 *
 *  - HTML comments go. A PR template is mostly comments, and they are invisible on the PR page --
 *    a checklist nobody meant to publish would otherwise land in CHANGELOG.md verbatim.
 *  - The `Release:` marker line goes. It is an instruction to this pipeline, not release notes.
 *  - Top-level headings are demoted to `###`. `## v1.x.y.z` is the version heading in CHANGELOG.md
 *    and `#` is the file title; a description that opened with `## Summary` would otherwise render
 *    as a sibling of the release it belongs to. `###` is also what the generated sections used, so a
 *    hand-written entry and an older generated one nest the same way.
 *
 * Fenced code blocks are tracked, so a `# comment` on the first line of a shell snippet survives.
 *
 * Throws on an empty result. A release whose notes are blank is a mistake every time -- either the
 * description was never written or this stripped too much, and both are worth a red workflow rather
 * than a silent empty section.
 */
export function prNotes(body = '') {
    const withoutComments = String(body)
        .split('\r\n').join('\n')
        .replace(/<!--[\s\S]*?-->/g, '');

    let fenced = false;
    const lines = [];
    for (const line of withoutComments.split('\n')) {
        const fence = line.trimStart().startsWith('```') || line.trimStart().startsWith('~~~');
        if (fence) { fenced = !fenced; lines.push(line); continue; }
        if (fenced) { lines.push(line); continue; }
        if (MARKER.test(line)) continue;
        lines.push(line.replace(/^(#{1,2})(\s|$)/, '###$2'));
    }

    // Collapse the runs of blank lines that stripping comments and markers leaves behind, and trim.
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('the pull request description is empty -- there are no release notes to write');
    return text;
}

/** `PR_LABELS` as an array of names. Accepts the raw label objects or a plain array of strings. */
function labelsFromEnv() {
    const raw = process.env.PR_LABELS;
    if (!raw || !raw.trim()) return [];
    // `toJSON(github.event.pull_request.labels.*.name)` is the string "null" on any event that has no
    // pull request, which is not a malformed value -- it is "there are no labels".
    const parsed = JSON.parse(raw);
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) throw new Error('PR_LABELS is not a JSON array');
    return parsed.map(l => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
}

function main() {
    const [mode, out] = process.argv.slice(2);
    const body = process.env.PR_BODY ?? '';

    if (mode === '--level') {
        const labels = labelsFromEnv();
        const level = shouldRelease(labels) ? resolveBump(labels, body) : '';
        console.log(level || 'skip');
        if (process.env.GITHUB_OUTPUT) {
            appendFileSync(process.env.GITHUB_OUTPUT,
                           'release=' + (level ? 'true' : 'false') + '\nbump=' + level + '\n');
        }
        return;
    }

    if (mode === '--notes') {
        if (!out) throw new Error('usage: node tools/release-pr.mjs --notes <out-file>');
        writeFileSync(out, prNotes(body) + '\n');
        console.log('release notes: ' + out + ' (' + prNotes(body).split('\n').length + ' lines)');
        return;
    }

    console.error('usage: node tools/release-pr.mjs --level\n       node tools/release-pr.mjs --notes <out-file>');
    process.exit(2);
}

// Only when run as a script, so the pure halves can be imported by tests without the CLI firing.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();

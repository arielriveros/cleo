import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * What release.yml must do for the desktop editor's updater (app-kit/desktop/desktopUpdater.js) to find a release.
 *
 * None of this fails a run when it goes wrong. A release with no latest.yml is simply never offered; one marked
 * latest before its installers are attached is a 404 every editor shrugs off; a breaking-only installer job means
 * fix and feature releases never reach anyone. The run is green in every one of those cases.
 *
 * Read as text, cut into jobs and steps by indentation (the repo has no YAML parser, and this file's layout is
 * regular: jobs at two spaces, their steps at six).
 */
const ROOT = join(__dirname, '..');
const TEXT = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf-8').replace(/\r\n/g, '\n');

/** One job's block: its header line to the next job (or the end). */
function job(name: string): string {
  const at = TEXT.search(new RegExp(`^  ${name}:\\n`, 'm'));
  if (at < 0) throw new Error(`no job ${name}`);
  const rest = TEXT.slice(at + 1);
  const next = rest.search(/^  [\w-]+:\n/m);
  return next < 0 ? TEXT.slice(at) : TEXT.slice(at, at + 1 + next);
}

/** One step's block within a job, by its name: up to the next step, or the comment heading one. */
function step(jobName: string, name: string): string {
  const text = job(jobName);
  const at = text.indexOf(`      - name: ${name}\n`);
  if (at < 0) throw new Error(`no step ${name} in ${jobName}`);
  const rest = text.slice(at + 8);
  const next = rest.search(/^      - |^      #/m);
  return next < 0 ? text.slice(at) : text.slice(at, at + 8 + next);
}

const stepNames = (jobName: string) => [...job(jobName).matchAll(/^      - name: (.+)$/gm)].map(m => m[1]);

describe("release.yml: the updater's release", () => {
  it('creates the release without marking it latest', () => {
    const create = step('release', 'Create GitHub Release');
    expect(create).toContain('gh release create');
    expect(create).toContain('--latest=false');
  });

  it('builds installers on every release, not only breaking ones', () => {
    const installers = job('installers');
    expect(installers).not.toMatch(/^    if:/m);
    expect(installers).toMatch(/^    needs: \[gate, release\]$/m);
    expect(installers).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
  });

  it('builds what extraResources ships: the editor, the SDK and the host', () => {
    expect(step('installers', 'Build engine and editor')).toContain('npm run editor:build');
    expect(step('installers', 'Build the SDK and the host')).toContain('run: npm run build:sdk && npm run host:install && npm run build:host');
  });

  it('keeps the examples the installer ships', () => {
    expect(step('installers', "Fetch the examples' data")).toContain('npm run examples:fetch');
    expect(step('installers', 'Build engine and editor')).toContain("CLEO_EXAMPLES_REQUIRED: '1'");
  });

  it("writes this version's changelog section as the updater's release notes, before building", () => {
    const notes = step('installers', 'Release notes for the updater');
    expect(notes).toContain('node tools/changelogSection.mjs');
    expect(notes).toContain('applications/app-kit/desktop/build/release-notes.md');
    const names = stepNames('installers');
    expect(names).toContain('Release notes for the updater');
    expect(names.indexOf('Release notes for the updater')).toBeLessThan(names.indexOf('Build installer'));
  });

  it('builds with `npm run dist`, which never publishes on its own', () => {
    expect(step('installers', 'Build installer')).toContain('npm run dist');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'applications', 'app-kit', 'desktop', 'package.json'), 'utf-8'));
    expect(pkg.scripts.dist).toContain('--publish never');
  });

  it('attaches the installers with their latest*.yml, checked to name this version, and their block maps', () => {
    const attach = step('installers', 'Attach to release');
    expect(attach).toContain('feeds=("$dist"/latest*.yml)');
    expect(attach).toContain('blockmaps=("$dist"/*"$pkg"*.blockmap)');
    expect(attach).toContain('grep -q "^version: $pkg\\$" "$feed"');
    expect(attach).toContain('--clobber "${installers[@]}" "${feeds[@]}" "${blockmaps[@]}"');
  });

  it('marks the release latest only after the installers, even when one platform failed', () => {
    const latest = job('publish-latest');
    expect(latest).toMatch(/^    needs: \[release, installers\]$/m);
    expect(latest).toContain("if: always() && needs.release.result == 'success'");
    expect(latest).toMatch(/gh release edit '[^']+' --latest/);
  });
});

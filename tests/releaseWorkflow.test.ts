import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * What release.yml must do for a merge to ship what it changed, and for the desktop editor's updater
 * (app-kit/desktop/desktopUpdater.js) to find a release.
 *
 * None of this fails a run when it goes wrong. A release with no latest.yml is simply never offered; one marked
 * latest before its installers are attached is a 404 every editor shrugs off; a notes-only release marked latest
 * hides the last real one from every updater; an app built off the branch head instead of the tag ships labelled
 * `-dev`. The run is green in every one of those cases.
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
const ifOf = (jobName: string) => /^    if: (.+)$/m.exec(job(jobName))?.[1] ?? '';
const needsOf = (jobName: string) => /^    needs: (.+)$/m.exec(job(jobName))?.[1] ?? '';

describe('release.yml: what a merge ships', () => {
  it('asks affected.mjs what the pull request changed, and ships nothing when none of it ships', () => {
    const affected = step('gate', 'Which areas changed');
    expect(affected).toContain('node tools/ci/affected.mjs --base "$BASE" --head "$HEAD"');
    expect(affected).toContain('node tools/ci/affected.mjs --all');
    expect(step('gate', 'Decide')).toContain("[ \"$SHIPS\" = true ] || decline");
    expect(job('gate')).toContain('fetch-depth: 0');
  });

  it('still releases only from development, and honours no-release', () => {
    const decide = step('gate', 'Decide');
    expect(decide).toContain('[ "$HEAD_REF" = development ] || decline');
    expect(decide).toContain('"no-release"');
  });

  it('tests the same areas it ships, through the same tests.yml as ci.yml', () => {
    const tests = job('tests');
    expect(tests).toContain('uses: ./.github/workflows/tests.yml');
    for (const area of ['engine', 'appkit', 'editor', 'creator', 'examples'])
      expect(tests).toContain(`${area}: \${{ needs.gate.outputs.${area} == 'true' }}`);
  });

  it('cuts the release without building anything, and never as the latest', () => {
    const create = step('release', 'Create GitHub Release');
    expect(create).toContain('gh release create');
    expect(create).toContain('--latest=false');
    expect(job('release')).not.toContain('npm run editor:build');
    expect(job('release')).not.toContain('action-hosting-deploy');
  });

  it('builds each app only for its own area', () => {
    expect(ifOf('build-editor')).toBe("needs.gate.outputs.editor == 'true'");
    expect(ifOf('build-creator')).toBe("needs.gate.outputs.creator == 'true'");
    expect(ifOf('installers')).toBe("needs.gate.outputs.editor == 'true'");
    expect(ifOf('examples')).toBe("needs.gate.outputs.examples == 'true'");
    expect(ifOf('worker')).toBe("needs.gate.outputs.worker == 'true'");
  });

  it('builds every app off the tag, so none of them ships labelled -dev', () => {
    for (const name of ['build-editor', 'build-creator', 'installers'])
      expect(job(name), name).toContain('ref: v${{ needs.release.outputs.version }}');
  });

  it('builds the web editor before embedding the Creator, and keeps the two builds apart', () => {
    const names = stepNames('build-editor');
    expect(names.indexOf('Upload the web build')).toBeLessThan(names.indexOf('Embed the Creator for the desktop app'));
    expect(names.indexOf('Embed the Creator for the desktop app')).toBeLessThan(names.indexOf('Upload the desktop build'));
    expect(step('build-editor', 'Build the editor')).toContain('VITE_CLEO_EXAMPLES_URL: ${{ vars.CLEO_EXAMPLES_URL }}');
    expect(step('build-creator', 'Build the Creator for its own site')).toContain('VITE_CLEO_EDITOR_ORIGIN: ${{ vars.CLEO_EDITOR_ORIGIN }}');
  });

  it('deploys each app to its own Firebase site, live', () => {
    expect(job('deploy-editor')).toContain('entryPoint: ./applications/editor');
    expect(job('deploy-creator')).toContain('entryPoint: ./applications/creator');
    for (const name of ['deploy-editor', 'deploy-creator']) expect(job(name), name).toContain('channelId: live');
    const editorSite = JSON.parse(readFileSync(join(ROOT, 'applications', 'editor', 'firebase.json'), 'utf-8'));
    const creatorSite = JSON.parse(readFileSync(join(ROOT, 'applications', 'creator', 'firebase.json'), 'utf-8'));
    expect(editorSite.hosting.site).toBe('cleo-editor');
    expect(creatorSite.hosting.site).toBe('cleo-creator');
  });

  it('publishes the examples it touched to the examples release', () => {
    const publish = step('examples', 'Build and publish');
    expect(publish).toContain('npm run examples:release -- --publish "$@"');
    expect(publish).toContain('set -- --all');
  });
});

describe("release.yml: the updater's release", () => {
  it('packages Windows and Linux from the one editor build', () => {
    const installers = job('installers');
    expect(needsOf('installers')).toBe('[gate, release, build-editor]');
    expect(installers).toContain('os: [ubuntu-latest, windows-latest]');
    expect(installers).toContain('name: desktop-editor');
    expect(installers).not.toContain('npm run editor:build');
  });

  it('builds what else extraResources ships: the SDK and the host', () => {
    expect(step('installers', 'Build the SDK and the host')).toContain('npm run build:sdk && npm run host:install && npm run build:host');
  });

  it('no longer ships the examples inside the installer', () => {
    expect(job('installers')).not.toContain('examples:fetch');
    expect(job('installers')).not.toContain('CLEO_EXAMPLES_REQUIRED');
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
    expect(attach).toContain('installers=("$dist"/*"$pkg"*.exe "$dist"/*"$pkg"*.AppImage)');
    expect(attach).toContain('feeds=("$dist"/latest*.yml)');
    expect(attach).toContain('blockmaps=("$dist"/*"$pkg"*.blockmap)');
    expect(attach).toContain('grep -q "^version: $pkg\\$" "$feed"');
    expect(attach).toContain('--clobber "${installers[@]}" "${feeds[@]}" "${blockmaps[@]}"');
  });

  it('marks the release latest only after the installers, even when one platform failed, and never without them', () => {
    const latest = job('publish-latest');
    expect(needsOf('publish-latest')).toBe('[gate, release, installers]');
    const cond = ifOf('publish-latest');
    expect(cond).toContain("always() && needs.release.result == 'success'");
    expect(cond).toContain("needs.gate.outputs.editor == 'true'");
    expect(cond).toContain("needs.installers.result != 'skipped'");
    expect(latest).toMatch(/gh release edit '[^']+' --latest/);
  });
});

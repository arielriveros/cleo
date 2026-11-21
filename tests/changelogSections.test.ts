import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

/**
 * Help ▸ About shows what changed in the running version, read from CHANGELOG.md when the editor is built
 * (applications/editor/buildVersion.js → `__APP_CHANGELOG__`), and release.yml feeds the same parser's output to
 * electron-builder as latest.yml's release notes (tools/changelogSection.mjs). If the heading shape tools/changelog.mjs
 * writes ever drifts from what this parser reads, About goes quiet and the Update button shows no notes, both
 * without an error: these tests are where that shows.
 */
const ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);
const { parseChangelog, changelogSections, changelogSection } = require(join(ROOT, 'applications/editor/buildVersion.js'));

const SAMPLE = [
  '# Changelog',
  '',
  'Intro paragraph.',
  '',
  '## Unreleased',
  '',
  'Next things.',
  '',
  '### Features',
  '',
  '- **A thing.** It does.',
  '',
  '## v1.1.2.5 — 2026-11-30',
  '',
  'The update release.',
  '',
  '### Fixes & refactors',
  '',
  '- fixed',
  '',
  '## v1.1.2.4 — 2026-09-01',
  '',
  'The relief release.',
  '',
].join('\r\n');

describe('CHANGELOG.md sections', () => {
  it('reads Unreleased and each release, without the file header', () => {
    const s = parseChangelog(SAMPLE);
    expect(s.map((x: any) => x.kind)).toEqual(['unreleased', 'release', 'release']);
    expect(s[1]).toMatchObject({ version: '1.1.2.5', date: '2026-11-30', title: 'v1.1.2.5 — 2026-11-30' });
    // A ### heading stays inside its section, and CRLF is read as LF.
    expect(s[1].markdown).toBe('The update release.\n\n### Fixes & refactors\n\n- fixed');
  });

  it('a release build shows its own version', () => {
    expect(changelogSections(SAMPLE, '1.1.2.4', true)).toEqual([{ title: 'v1.1.2.4 — 2026-09-01', markdown: 'The relief release.' }]);
  });

  it('a release build missing from the file falls back to the newest release', () => {
    expect(changelogSections(SAMPLE, '9.9.9.9', true).map((s: any) => s.title)).toEqual(['v1.1.2.5 — 2026-11-30']);
  });

  it('a -dev build shows what is unreleased, then the release it sits on', () => {
    expect(changelogSections(SAMPLE, '1.1.2.5', false).map((s: any) => s.title)).toEqual(['Unreleased', 'v1.1.2.5 — 2026-11-30']);
  });

  it('an empty Unreleased section is left out', () => {
    const text = SAMPLE.replace(/## Unreleased[\s\S]*?(?=## v1\.1\.2\.5)/, '## Unreleased\r\n\r\n');
    expect(changelogSections(text, '1.1.2.5', false).map((s: any) => s.title)).toEqual(['v1.1.2.5 — 2026-11-30']);
  });

  it('a file with no sections shows nothing', () => {
    expect(changelogSections('# Changelog\n', '1.0.0.0', true)).toEqual([]);
    expect(changelogSections('', '1.0.0.0', false)).toEqual([]);
  });

  it('one release\'s notes, for latest.yml', () => {
    expect(changelogSection(SAMPLE, '1.1.2.4')).toBe('The relief release.');
    expect(changelogSection(SAMPLE, '1.0.0.0')).toBeNull();
  });

  it('reads the real CHANGELOG.md: every version tools/changelog.mjs wrote has a section', () => {
    const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const releases = parseChangelog(text).filter((s: any) => s.kind === 'release');
    expect(releases.length).toBeGreaterThan(0);
    // The heading shape: `## v<version> — <date>`. A line that looks like a release but did not parse means the
    // writer and this reader disagree.
    const looksLikeRelease = text.split(/\r?\n/).filter(l => /^## v\d/.test(l)).length;
    expect(releases.length).toBe(looksLikeRelease);
    // The running package version (`1.` + package.json, see buildVersion.js) is a released one.
    const version = '1.' + JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    expect(changelogSection(text, version)).not.toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * What ci.yml and tests.yml must keep true for the pull-request gate to mean anything. A job that runs for the
 * wrong areas is either wasted time or a change merged untested; a `CI result` that does not run when something
 * it needs failed is a red pull request that branch protection waves through.
 *
 * Read as text, cut into jobs by indentation (jobs at two spaces), as releaseWorkflow.test.ts does.
 */
const ROOT = join(__dirname, '..');
const read = (name: string) => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf-8').replace(/\r\n/g, '\n');
const CI = read('ci.yml');
const TESTS = read('tests.yml');

function job(text: string, name: string): string {
  const at = text.search(new RegExp(`^  ${name}:\\n`, 'm'));
  if (at < 0) throw new Error(`no job ${name}`);
  const rest = text.slice(at + 1);
  const next = rest.search(/^  [\w-]+:\n/m);
  return next < 0 ? text.slice(at) : text.slice(at, at + 1 + next);
}
const ifOf = (text: string, name: string) => /^    if: (.+)$/m.exec(job(text, name))?.[1] ?? '';

describe('ci.yml: the pull-request gate', () => {
  it('runs for pull requests to main, and deploys nothing', () => {
    expect(CI).toMatch(/^  pull_request:\n    branches: \[main\]$/m);
    expect(CI).not.toMatch(/^  push:/m);
    expect(CI).not.toContain('action-hosting-deploy');
  });

  it("reads the pull request's own changes", () => {
    expect(job(CI, 'changes')).toContain('node tools/ci/affected.mjs --base "$BASE" --head "$HEAD"');
    expect(job(CI, 'changes')).toContain('fetch-depth: 0');
  });

  it('gates every typecheck on its area', () => {
    expect(ifOf(CI, 'typecheck-engine')).toBe("needs.changes.outputs.engine == 'true'");
    expect(ifOf(CI, 'typecheck-apps')).toContain("needs.changes.outputs.editor == 'true'");
    expect(ifOf(CI, 'typecheck-apps')).toContain("needs.changes.outputs.creator == 'true'");
    expect(ifOf(CI, 'typecheck-apps')).toContain("needs.changes.outputs.appkit == 'true'");
  });

  it('passes every area to the tests', () => {
    const tests = job(CI, 'tests');
    for (const area of ['engine', 'appkit', 'editor', 'creator', 'examples'])
      expect(tests).toContain(`${area}: \${{ needs.changes.outputs.${area} == 'true' }}`);
  });

  it('has one result job that always runs and fails on any failed or cancelled job', () => {
    const result = job(CI, 'ci-result');
    expect(ifOf(CI, 'ci-result')).toBe('always()');
    expect(result).toContain('needs: [changes, typecheck-engine, typecheck-apps, tests]');
    expect(result).toContain('*failure*|*cancelled*');
  });
});

describe('tests.yml: one suite per area', () => {
  it('runs each suite for its own area', () => {
    expect(ifOf(TESTS, 'test-engine')).toBe('inputs.engine');
    expect(ifOf(TESTS, 'test-editor')).toBe('inputs.editor');
    expect(ifOf(TESTS, 'test-app-kit')).toBe('inputs.appkit');
    expect(ifOf(TESTS, 'test-creator')).toBe('inputs.creator');
  });

  it("runs the examples' suites for an examples or editor change, unless the engine job already does", () => {
    expect(ifOf(TESTS, 'test-examples')).toBe('${{ !inputs.engine && (inputs.examples || inputs.editor) }}');
    expect(job(TESTS, 'test-examples')).toContain('npm run test:examples');
  });

  it('defaults every area to on, so a caller that passes nothing gets the whole gate', () => {
    const inputs = TESTS.slice(TESTS.indexOf('inputs:'), TESTS.indexOf('jobs:'));
    for (const area of ['engine', 'appkit', 'editor', 'creator', 'examples'])
      expect(inputs).toMatch(new RegExp(`${area}:\\n\\s+type: boolean\\n\\s+default: true`));
  });
});

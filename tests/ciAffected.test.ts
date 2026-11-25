import { describe, it, expect } from 'vitest';
// @ts-ignore -- a plain .mjs tool, no declarations
import { affected, everything, outputLines, AREAS } from '../tools/ci/affected.mjs';
// @ts-ignore
import { TOOL_SOURCES } from '../tools/examples/toolSources.mjs';

/**
 * tools/ci/affected.mjs decides what a pull request tests and what a merge ships (ci.yml, tests.yml, release.yml).
 * A wrong answer fails silently in one of two ways: a change that ships nothing (an app whose fix never deploys),
 * or every merge rebuilding everything (the cost this pipeline exists to avoid).
 */

const on = (r: Record<string, unknown>) => AREAS.filter((a: string) => r[a]);

describe('affected: which areas a change touches', () => {
  it('an engine change turns on every app and every example', () => {
    const r = affected(['src/graphics/renderer.ts']);
    expect(on(r)).toEqual(['engine', 'appkit', 'editor', 'creator', 'examples']);
    expect(r.exampleSlugs).toBe('all');
    expect(r.any).toBe(true);
  });

  it('treats the root tests, tooling, config and the pipeline itself as the engine', () => {
    for (const p of ['tests/foo.test.ts', 'tools/buildDist.mjs', 'package.json', 'package-lock.json', 'vite.config.ts',
      'vitest.config.ts', 'tsconfig.json', '.nvmrc', '.github/workflows/ci.yml', 'tools/ci/affected.mjs'])
      expect(affected([p]).engine, p).toBe(true);
  });

  it('a Creator change is the Creator alone', () => {
    const r = affected(['applications/creator/src/app.tsx']);
    expect(on(r)).toEqual(['creator']);
    expect(r.exampleSlugs).toEqual([]);
  });

  it('an editor change is the editor alone; the desktop shell, host, SDK, MCP and docs ship with it', () => {
    for (const p of ['applications/editor/src/app.tsx', 'applications/app-kit/desktop/main.js', 'applications/host/src/x.ts',
      'applications/sdk/src/x.ts', 'applications/mcp/src/x.ts', 'docs/editor/options.md'])
      expect(on(affected([p])), p).toEqual(['editor']);
  });

  it('the app-kit is shared: it turns on both apps', () => {
    expect(on(affected(['applications/app-kit/src/creatorLibrary/frame.ts']))).toEqual(['appkit', 'editor', 'creator']);
    expect(on(affected(['applications/package-lock.json']))).toEqual(['appkit', 'editor', 'creator']);
  });

  it('an example folder re-publishes that example only', () => {
    const r = affected(['examples/duskwell/Assets/main.scene.json', 'examples/valley/project.cleo']);
    expect(on(r)).toEqual(['examples']);
    expect(r.exampleSlugs).toEqual(['duskwell', 'valley']);
  });

  it('the shared example assets and the bundle tools re-publish every example', () => {
    for (const p of ['examples/assets/dirtmask.jpg', 'tools/examples/gallery.mjs', 'tools/exampleKit/folder.mjs'])
      expect(affected([p]).exampleSlugs, p).toBe('all');
  });

  it('the editor codec the bundles are written with is the editor and every example', () => {
    const codec = TOOL_SOURCES.filter((f: string) => f.startsWith('applications/'));
    expect(codec.length).toBeGreaterThan(0);
    for (const p of codec) {
      const r = affected([p]);
      expect(on(r), p).toEqual(['editor', 'examples']);
      expect(r.exampleSlugs).toBe('all');
    }
  });

  it('the examples Worker is its own area', () => {
    expect(on(affected(['tools/ci/examples-worker/worker.mjs']))).toEqual(['worker']);
  });

  it('prose, the PR template and generated output ship nothing', () => {
    const r = affected(['README.md', 'CHANGELOG.md', 'CLAUDE.md', 'examples/README.md', 'applications/README.md',
      '.github/pull_request_template.md', 'graphify-out/graph.json', '.gitignore']);
    expect(on(r)).toEqual([]);
    expect(r.any).toBe(false);
  });

  it('a path no rule names is the engine, so a new folder runs everything until someone decides otherwise', () => {
    expect(affected(['newthing/x.ts']).engine).toBe(true);
  });

  it('takes Windows separators and a leading ./', () => {
    expect(on(affected(['applications\\creator\\src\\a.ts', './applications/creator/b.ts']))).toEqual(['creator']);
  });

  it('writes one GITHUB_OUTPUT line per area, then any and the example slugs', () => {
    expect(outputLines(affected(['examples/duskwell/a', 'examples/island/b']))).toEqual([
      'engine=false', 'appkit=false', 'editor=false', 'creator=false', 'examples=true', 'worker=false',
      'any=true', 'example_slugs=duskwell island',
    ]);
    expect(outputLines(everything()).at(-1)).toBe('example_slugs=all');
  });
});

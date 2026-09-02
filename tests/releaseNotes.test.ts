import { describe, it, expect } from 'vitest';
import { resolveBump, prNotes, shouldRelease, DEFAULT_LEVEL } from '../tools/release-pr.mjs';

/**
 * The two decisions a merged pull request makes for the release pipeline: how far the version moves,
 * and what CHANGELOG.md says about it.
 *
 * Worth testing precisely because neither is observable until it is too late. A wrong level ships a
 * version number that cannot be moved once tagged, and a body that strips wrong publishes whatever a
 * PR template left behind — a checklist, a reviewer's HTML comment — into a permanent file.
 */

describe('resolveBump', () => {
    it('takes the release label over anything in the body', () => {
        expect(resolveBump(['release:feature'], 'Release: fix')).toBe('feature');
    });

    it('reads the body marker when there is no label', () => {
        expect(resolveBump([], 'Summary\n\nRelease: breaking\n')).toBe('breaking');
        expect(resolveBump(['bug', 'editor'], 'Release: feature')).toBe('feature');
    });

    it('is case-insensitive about the marker and tolerates surrounding whitespace', () => {
        expect(resolveBump([], '  release:   Feature  ')).toBe('feature');
    });

    it('ignores a marker that is not a line of its own', () => {
        // "...and we should Release: breaking soon" is a sentence, not an instruction.
        expect(resolveBump([], 'We will Release: breaking once the API settles')).toBe(DEFAULT_LEVEL);
    });

    it('defaults to fix when the PR says nothing', () => {
        expect(resolveBump([], 'Fixed the thing.')).toBe('fix');
        expect(resolveBump()).toBe('fix');
    });

    it('refuses to guess between two release labels', () => {
        // A coin toss here writes a version number that a tag then makes permanent.
        expect(() => resolveBump(['release:fix', 'release:breaking'], '')).toThrow(/more than one release label/);
    });
});

describe('shouldRelease', () => {
    it('is false only for the skip label', () => {
        expect(shouldRelease(['release:fix'])).toBe(true);
        expect(shouldRelease([])).toBe(true);
        expect(shouldRelease(['no-release'])).toBe(false);
    });
});

describe('prNotes', () => {
    it('strips HTML comments, which is most of a PR template', () => {
        const body = '<!-- Delete anything that does not apply -->\nReal notes.\n<!--\nmultiline\n-->';
        expect(prNotes(body)).toBe('Real notes.');
    });

    it('drops the Release marker line', () => {
        expect(prNotes('Release: feature\n\nWhat changed.')).toBe('What changed.');
    });

    it('demotes the headings that would compete with the version heading', () => {
        // `## v1.2.3.4` is the version heading and `#` is the file title, so a body that opened with
        // `## Summary` would render as a sibling of the release it belongs to.
        const out = prNotes('# Title\n\n## Summary\n\nText\n\n### Detail\n\n#### Deeper');
        expect(out).toContain('### Title');
        expect(out).toContain('### Summary');
        expect(out).toContain('### Detail');
        expect(out).toContain('#### Deeper');
        expect(out).not.toMatch(/^#{1,2}\s/m);
    });

    it('leaves a comment inside a fenced block alone', () => {
        const body = ['Notes.', '', '```sh', '# not a heading', 'npm run build', '```'].join('\n');
        expect(prNotes(body)).toContain('# not a heading');
    });

    it('collapses the blank runs that stripping leaves behind', () => {
        const body = 'One.\n\n<!-- gone -->\n\n<!-- also gone -->\n\nTwo.';
        expect(prNotes(body)).toBe('One.\n\nTwo.');
    });

    it('normalizes CRLF, which is what a browser textarea posts', () => {
        expect(prNotes('One.\r\n\r\nTwo.')).toBe('One.\n\nTwo.');
    });

    it('throws rather than write an empty section', () => {
        // Both cases are a mistake every time: the description was never written, or this stripped
        // everything there was. A red workflow says so; a blank changelog entry does not.
        expect(() => prNotes('')).toThrow(/empty/);
        expect(() => prNotes('<!-- template only -->\nRelease: fix\n')).toThrow(/empty/);
    });
});

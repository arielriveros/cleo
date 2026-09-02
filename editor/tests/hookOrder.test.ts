import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `TerrainMaterialInspector` must call every hook before its early return.
 *
 * React identifies hooks by CALL ORDER, so a component that returns early on some renders and calls a
 * hook on others corrupts its own state — and it does not fail where the mistake is. It fails on the
 * render *after* the condition flips, with "Rendered more hooks than during the previous render",
 * pointing at whichever hook happened to be first past the return, and it takes the whole panel down.
 *
 * This file carried exactly that: `if (!isTerrain) return <div>…</div>` sat above a `useMemo` looking up
 * the active landscape. Six hooks ran while the panel had no terrain material, seven ran once it did, so
 * it crashed the first time someone opened a terrain material with the inspector already mounted. The
 * code looked completely ordinary and survived every render where the condition did not change.
 *
 * SCOPED TO THIS FILE ON PURPOSE. The general version of this check needs to know which function a
 * statement belongs to, and a regex does not: a first attempt at scanning every component flagged ten
 * files, and all ten were module-level helpers whose two-space-indented bodies looked like component
 * bodies — `SceneSettings` among them, whose hooks are in fact all above its `if (!meta) return null`.
 * The tool for the general case is `eslint-plugin-react-hooks`, which parses rather than matches; this
 * repo has no eslint set up, and standing one up is a bigger change than the bug warrants.
 */

const FILE = join(__dirname, '..', 'src', 'features', 'terrainMaterials', 'TerrainMaterialInspector.tsx');
// Line endings normalised: core.autocrlf checks this tree out with CRLF on Windows, while the offset
// and blank-line patterns below are all written against \n.
const SOURCE = readFileSync(FILE, 'utf-8').replace(/\r\n/g, '\n');

describe('TerrainMaterialInspector calls its hooks unconditionally', () => {
    /** Offsets of every top-level hook call in the component body. */
    const hookOffsets = () =>
        [...SOURCE.matchAll(/\n {2}(?:const|let) [^\n=]+= use(?:Memo|State|Callback|Effect|Ref|Context|Reducer)\(/g)]
            .map(m => m.index!);

    const guardOffset = () => {
        const i = SOURCE.indexOf('  if (!isTerrain) {');
        expect(i, 'the isTerrain guard is gone — this test needs rewriting, not deleting').toBeGreaterThan(-1);
        return i;
    };

    it('finds the hooks and the guard at all', () => {
        // A floor, so the assertion below cannot pass because the patterns stopped matching.
        expect(hookOffsets().length).toBeGreaterThanOrEqual(3);
    });

    it('has every hook above the early return', () => {
        const guard = guardOffset();
        const below = hookOffsets().filter(o => o > guard)
            .map(o => SOURCE.slice(0, o).split('\n').length + 1);
        expect(below, `hook(s) below the isTerrain guard, at line(s) ${below.join(', ')} — React counts `
            + `hooks by call order, so this crashes on the first render after the panel gains a terrain `
            + `material`).toEqual([]);
    });

    it('keeps the landscape lookup off the non-null alias', () => {
        // Lifting the hook above the guard means it runs when there is no terrain material, so it cannot
        // read `mat` — the alias that only exists past the guard.
        const hook = SOURCE.slice(SOURCE.indexOf('const landscape = useMemo('));
        expect(hook.slice(0, hook.indexOf('\n\n'))).not.toContain('mat.');
    });
});

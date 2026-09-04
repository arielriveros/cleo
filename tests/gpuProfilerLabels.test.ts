import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PASS_LABEL_TO_SCOPE, RENDER_PASSES, scopeForPassLabel } from '../src/graphics/gpuProfiler';

/**
 * The label/scope contract, checked against renderer.ts's actual source text.
 *
 * `types.ts` used to assert this correspondence in a docstring — "Name matching a `RenderPass` in
 * gpuProfiler.ts, so a pass boundary and a profiler scope are one thing rather than two lists that
 * drift apart" — and it was false when written: ~40 pass labels against 29 scopes. The docstring is
 * fixed; this file is what keeps the half of the claim that IS true from rotting, because
 * `PASS_LABEL_TO_SCOPE` is the thing WebGPU timings are attributed through and a stale key there is a
 * silent hole in the readout rather than a build error.
 *
 * Source-text scanning rather than instrumentation, because the alternative is a live renderer: the
 * labels are literals at ~45 call sites, several of them behind an editor-only or hardware-only
 * branch that no headless run reaches.
 */

const RENDERER = readFileSync(join(__dirname, '../src/graphics/renderer.ts'), 'utf8');

/**
 * Every pass label renderer.ts passes as a literal.
 *
 * Three helpers take a label and one descriptor spells it inline, so all four are read:
 * `_beginFullscreenPass(target, label, …)`, `_beginDepthPass(target, label, layer)`,
 * `_runForwardQueue(label, queue)` and a bare `{ label: '…' }`. Arguments are split at paren depth 0
 * rather than by a comma regex, because the first argument is routinely a call of its own
 * (`this._cubeFBO.targetFor(cube, face, 0, false)`) and a naive split lands in the middle of it.
 */
function passLabels(source: string): Set<string> {
    return new Set(passLabelList(source));
}

/** The same labels, with duplicates kept, so a label used at two call sites can be counted. */
function passLabelList(source: string): string[] {
    const found: string[] = [];
    const helpers: [string, number][] = [
        ['_beginFullscreenPass(', 1],
        ['_beginDepthPass(', 1],
        ['_runForwardQueue(', 0],
        // The editor overlay layer's own opener. It wraps `_beginFullscreenPass` to clear the buffer
        // lazily, so its callers name their label here rather than at the wrapped call.
        ['_beginOverlayPass(', 0],
    ];

    for (const [helper, argIndex] of helpers) {
        let at = source.indexOf(helper);
        while (at !== -1) {
            const args = splitArgs(source, at + helper.length);
            const arg = args[argIndex]?.trim();
            const literal = arg?.match(/^'([^']*)'$/);
            if (literal) found.push(literal[1]);
            at = source.indexOf(helper, at + helper.length);
        }
    }

    for (const m of source.matchAll(/^\s*label: '([^']+)',$/gm)) found.push(m[1]);
    return found;
}

/** Argument texts of the call whose '(' has just been consumed, split at depth 0. */
function splitArgs(source: string, from: number): string[] {
    const args: string[] = [];
    let depth = 0, start = from;
    for (let i = from; i < source.length; i++) {
        const c = source[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' && depth === 0) { args.push(source.slice(start, i)); break; }
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) { args.push(source.slice(start, i)); start = i + 1; }
    }
    return args;
}

const LABELS = passLabels(RENDERER);
const LABEL_LIST = passLabelList(RENDERER);

describe('PASS_LABEL_TO_SCOPE', () => {
    it('finds the renderer pass labels at all', () => {
        // Guards the scanner itself: a helper rename would otherwise empty the set and make every
        // check below vacuously true.
        expect(LABELS.size).toBeGreaterThan(30);
        expect(LABELS.has('geometry')).toBe(true);
        expect(LABELS.has('deferredLighting')).toBe(true);
    });

    it('maps every label to a real profiler scope', () => {
        for (const scope of Object.values(PASS_LABEL_TO_SCOPE))
            expect(RENDER_PASSES).toContain(scope);
    });

    it('has no key the renderer does not actually pass', () => {
        // The drift this exists for: renaming a pass label leaves its entry here pointing at nothing,
        // and the pass silently starts reporting as `pass:<newLabel>` instead of under its scope.
        const orphans = Object.keys(PASS_LABEL_TO_SCOPE).filter(label => !LABELS.has(label));
        expect(orphans).toEqual([]);
    });

    it('reports an unmapped label under its own pass: row', () => {
        // Not every pass belongs to a scope — `brdf` and `outline` run outside all of them — and
        // guessing a scope for those is exactly what this table is not for.
        expect(scopeForPassLabel('brdf')).toBe('pass:brdf');
        expect(scopeForPassLabel('geometry')).toBe('geometry');
    });
});

describe('the compose labels', () => {
    it('names the three passes that shared one label', () => {
        // Four passes wrote a compose buffer under the single label `compose`, so on a backend that
        // times passes rather than scopes their costs arrived indistinguishable. Three were renamed to
        // the scopes they belong to; only the plain scene copy still answers to `compose`.
        for (const label of ['bloom.composite', 'chromatic', 'motionBlur'])
            expect(LABELS.has(label)).toBe(true);
        expect(LABELS.has('compose')).toBe(true);
        // Counted in pass-LABEL position rather than over the file's text: `compose` is also the id of
        // the render-graph node that owns this step, and a raw match would count that too and then
        // fail for a reason that has nothing to do with what this guards.
        expect(LABEL_LIST.filter(label => label === 'compose')).toHaveLength(1);
    });

    it('files each renamed label under its own scope', () => {
        expect(PASS_LABEL_TO_SCOPE['bloom.composite']).toBe('bloom.composite');
        expect(PASS_LABEL_TO_SCOPE['chromatic']).toBe('chromatic');
        expect(PASS_LABEL_TO_SCOPE['motionBlur']).toBe('motionBlur');
        expect(PASS_LABEL_TO_SCOPE['compose']).toBe('present');
    });
});

describe('what WebGPU cannot see', () => {
    it('has no pass for frameEnd, and that is deliberate', () => {
        // `frameEnd` is a sacrificial WebGL2 scope wrapping no draws at all — it exists to absorb the
        // driver's end-of-frame drain out of `present`. Per-pass timestamps exclude the drain, so
        // there is nothing for it to be. Asserted rather than assumed because a future pass named
        // `frameEnd` would quietly turn a documented gap into a wrong number.
        expect(LABELS.has('frameEnd')).toBe(false);
    });

    it('does keep forwardOpaque and transparent', () => {
        // Recorded because the design note that led here claimed the opposite. `_runForwardQueue`
        // opens a real pass labelled with the queue name, in BOTH pipelines — and the forward
        // pipeline's calls have no profiler scope around them at all, so these two report on WebGPU
        // in a path where WebGL2 reports nothing.
        expect(LABELS.has('forwardOpaque')).toBe(true);
        expect(LABELS.has('transparent')).toBe(true);
        expect(PASS_LABEL_TO_SCOPE['forwardOpaque']).toBe('forwardOpaque');
        expect(PASS_LABEL_TO_SCOPE['transparent']).toBe('transparent');
    });
});

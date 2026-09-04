import { describe, it, expect } from 'vitest';
import {
    EMPTY_FUZZY_MODEL, FuzzyBrain, buildFuzzyModule, isDefaultFuzzyModel, parseFuzzyModel,
    parseFuzzyTerm,
} from '../src/ai/fuzzy';
import type { FuzzyModel } from '../src/ai/fuzzy';

// The load-bearing test in this file is the CLAMP, and it is worth stating why rather than trusting
// the name. Yuka's FuzzyVariable.fuzzify neither throws nor clamps on an out-of-range input: it logs
// a warning and RETURNS, leaving the previous call's degrees of membership in place. So the next
// defuzzify answers the previous question.
//
// Measured on this exact model: fuzzify(350) gave 87.50, and fuzzify(-50) -- which should read as
// "close" and give about 12.5 -- ALSO returned 87.50. Out-of-domain input does not degrade toward a
// neutral answer; it returns the previous answer, which can be the exact opposite of correct.

/** Distance 0..400 in three bands, driving desirability 0..100 in three bands. */
function model(over: Partial<FuzzyModel> = {}): FuzzyModel {
    return parseFuzzyModel({
        variables: [
            {
                name: 'distance',
                sets: [
                    { name: 'close', shape: 'leftShoulder', left: 0, mid: 25, right: 150 },
                    { name: 'medium', shape: 'triangular', left: 25, mid: 150, right: 300 },
                    { name: 'far', shape: 'rightShoulder', left: 150, mid: 300, right: 400 },
                ],
            },
            {
                name: 'desirability',
                sets: [
                    { name: 'undesirable', shape: 'leftShoulder', left: 0, mid: 25, right: 50 },
                    { name: 'desirable', shape: 'triangular', left: 25, mid: 50, right: 75 },
                    { name: 'veryDesirable', shape: 'rightShoulder', left: 50, mid: 75, right: 100 },
                ],
            },
        ],
        rules: [
            { antecedent: { op: 'is', variable: 'distance', set: 'close' }, variable: 'desirability', set: 'undesirable' },
            { antecedent: { op: 'is', variable: 'distance', set: 'medium' }, variable: 'desirability', set: 'desirable' },
            { antecedent: { op: 'is', variable: 'distance', set: 'far' }, variable: 'desirability', set: 'veryDesirable' },
        ],
        ...over,
    });
}

describe('FuzzyBrain', () => {
    it('maps a crisp input onto a crisp output through the rules', () => {
        const brain = buildFuzzyModule(model());
        expect(brain.ruleCount).toBe(3);
        expect(brain.inputs).toEqual(['distance']);
        expect(brain.outputs).toEqual(['desirability']);

        // Monotone across the domain: close is undesirable, far is very.
        const near = brain.evaluate({ distance: 0 }).desirability;
        const mid = brain.evaluate({ distance: 200 }).desirability;
        const far = brain.evaluate({ distance: 400 }).desirability;
        expect(near).toBeLessThan(mid);
        expect(mid).toBeLessThan(far);
    });

    // THE test. Without the clamp both of these return the value from the call before.
    it('clamps an out-of-range input instead of answering the previous question', () => {
        const brain = buildFuzzyModule(model());

        const atFar = brain.evaluate({ distance: 350 }).desirability;
        // Below the domain. Should read as "close", which is the OPPOSITE end of the output range.
        const belowDomain = brain.evaluate({ distance: -50 }).desirability;
        expect(belowDomain).not.toBeCloseTo(atFar, 3);
        expect(belowDomain).toBeCloseTo(brain.evaluate({ distance: 0 }).desirability, 5);

        const atClose = brain.evaluate({ distance: 0 }).desirability;
        const aboveDomain = brain.evaluate({ distance: 9999 }).desirability;
        expect(aboveDomain).not.toBeCloseTo(atClose, 3);
        expect(aboveDomain).toBeCloseTo(brain.evaluate({ distance: 400 }).desirability, 5);
    });

    it('treats a non-finite input as the bottom of the range rather than poisoning the module', () => {
        const brain = buildFuzzyModule(model());
        expect(Number.isFinite(brain.evaluate({ distance: NaN }).desirability)).toBe(true);
        expect(Number.isFinite(brain.evaluate({ distance: Infinity }).desirability)).toBe(true);
    });

    it('reports the authored range of a variable', () => {
        const brain = buildFuzzyModule(model());
        expect(brain.rangeOf('distance')).toEqual({ min: 0, max: 400 });
        expect(brain.rangeOf('nope')).toBeNull();
    });

    it('refuses an input it has no variable for, and answers 0 for an output nothing writes', () => {
        const brain = buildFuzzyModule(model());
        expect(brain.set('nope', 1)).toBe(false);
        expect(brain.get('distance')).toBe(0);
        expect(brain.get('nope')).toBe(0);
    });

    it('is a harmless no-op when it has no rules at all', () => {
        const brain = buildFuzzyModule(EMPTY_FUZZY_MODEL);
        expect(brain.ruleCount).toBe(0);
        expect(brain.evaluate({ distance: 5 })).toEqual({});
    });

    it('offers both defuzzifications, and they agree on direction', () => {
        const maxav = buildFuzzyModule(model({ defuzzification: 'maxav' }));
        const centroid = buildFuzzyModule(model({ defuzzification: 'centroid' }));

        for (const distance of [0, 200, 400]) {
            const a = maxav.evaluate({ distance }).desirability;
            const b = centroid.evaluate({ distance }).desirability;
            expect(Number.isFinite(a)).toBe(true);
            expect(Number.isFinite(b)).toBe(true);
        }
        // Both must rank near below far, even though they disagree on the exact number.
        expect(maxav.evaluate({ distance: 0 }).desirability)
            .toBeLessThan(maxav.evaluate({ distance: 400 }).desirability);
        expect(centroid.evaluate({ distance: 0 }).desirability)
            .toBeLessThan(centroid.evaluate({ distance: 400 }).desirability);
    });
});

describe('combining terms', () => {
    /**
     * Two inputs, so AND/OR have something to combine, plus a COMPETING baseline rule.
     *
     * The second rule is not decoration. MAXAV is the average of each output set's peak weighted by
     * its firing strength, so with a single rule the answer is that set's peak no matter how weakly it
     * fired -- and a hedge, which only changes the strength, would be invisible.
     */
    function twoInput(antecedent: unknown): FuzzyBrain {
        return buildFuzzyModule(parseFuzzyModel({
            variables: [
                { name: 'distance', sets: [
                    { name: 'close', shape: 'leftShoulder', left: 0, mid: 25, right: 150 },
                    { name: 'far', shape: 'rightShoulder', left: 25, mid: 150, right: 400 },
                ] },
                { name: 'health', sets: [
                    { name: 'low', shape: 'leftShoulder', left: 0, mid: 25, right: 100 },
                    { name: 'high', shape: 'rightShoulder', left: 0, mid: 75, right: 100 },
                ] },
                { name: 'aggression', sets: [
                    { name: 'none', shape: 'leftShoulder', left: 0, mid: 10, right: 50 },
                    { name: 'lots', shape: 'rightShoulder', left: 50, mid: 90, right: 100 },
                ] },
            ],
            rules: [
                { antecedent, variable: 'aggression', set: 'lots' },
                { antecedent: { op: 'is', variable: 'distance', set: 'far' }, variable: 'aggression', set: 'none' },
            ],
        }));
    }

    it('takes the weaker term for AND', () => {
        const brain = twoInput({ op: 'and', children: [
            { op: 'is', variable: 'distance', set: 'close' },
            { op: 'is', variable: 'health', set: 'high' },
        ] });
        // Close and healthy: fires. Close but hurt: the weaker term holds it down.
        const both = brain.evaluate({ distance: 0, health: 100 }).aggression;
        const one = brain.evaluate({ distance: 0, health: 0 }).aggression;
        expect(both).toBeGreaterThan(one);
    });

    it('takes the stronger term for OR', () => {
        const brain = twoInput({ op: 'or', children: [
            { op: 'is', variable: 'distance', set: 'close' },
            { op: 'is', variable: 'health', set: 'high' },
        ] });
        const neither = brain.evaluate({ distance: 400, health: 0 }).aggression;
        const one = brain.evaluate({ distance: 400, health: 100 }).aggression;
        expect(one).toBeGreaterThan(neither);
    });

    it('concentrates with very and dilates with fairly', () => {
        const plain = twoInput({ op: 'is', variable: 'distance', set: 'close' });
        const very = twoInput({ op: 'very', child: { op: 'is', variable: 'distance', set: 'close' } });
        const fairly = twoInput({ op: 'fairly', child: { op: 'is', variable: 'distance', set: 'close' } });

        // Partway down the shoulder, where the hedges actually differ: very squares a membership
        // below 1 (smaller), fairly takes its root (larger).
        const at = { distance: 100 };
        expect(very.evaluate(at).aggression).toBeLessThan(plain.evaluate(at).aggression);
        expect(fairly.evaluate(at).aggression).toBeGreaterThan(plain.evaluate(at).aggression);
    });
});

describe('the tolerant reader', () => {
    it('reads junk as a model that decides nothing', () => {
        for (const junk of [null, undefined, 42, 'nope', {}, { variables: 3, rules: 'x' }]) {
            const parsed = parseFuzzyModel(junk);
            expect(parsed.variables).toHaveLength(0);
            expect(parsed.rules).toHaveLength(0);
            expect(isDefaultFuzzyModel(junk)).toBe(true);
        }
    });

    it('drops a variable with no sets, since every input to it is out of range', () => {
        expect(parseFuzzyModel({ variables: [{ name: 'empty', sets: [] }] }).variables).toHaveLength(0);
    });

    it('drops duplicate names that a rule could not disambiguate', () => {
        const parsed = parseFuzzyModel({
            variables: [
                { name: 'a', sets: [{ name: 's', left: 0, mid: 1, right: 2 }, { name: 's', left: 5, mid: 6, right: 7 }] },
                { name: 'a', sets: [{ name: 't', left: 0, mid: 1, right: 2 }] },
            ],
        });
        expect(parsed.variables).toHaveLength(1);
        expect(parsed.variables[0].sets).toHaveLength(1);
    });

    // A rule that can never fire would otherwise show as a row in the editor that does nothing.
    it('drops a rule naming a variable or set that does not exist', () => {
        const parsed = parseFuzzyModel({
            variables: [{ name: 'a', sets: [{ name: 's', left: 0, mid: 1, right: 2 }] }],
            rules: [
                { antecedent: { op: 'is', variable: 'a', set: 's' }, variable: 'a', set: 's' },
                { antecedent: { op: 'is', variable: 'ghost', set: 's' }, variable: 'a', set: 's' },
                { antecedent: { op: 'is', variable: 'a', set: 'ghost' }, variable: 'a', set: 's' },
                { antecedent: { op: 'is', variable: 'a', set: 's' }, variable: 'a', set: 'ghost' },
            ],
        });
        expect(parsed.rules).toHaveLength(1);
    });

    // A midpoint outside its own set makes every membership zero -- a rule that silently never fires.
    it('clamps a midpoint into its own span', () => {
        const set = parseFuzzyModel({
            variables: [{ name: 'a', sets: [{ name: 's', left: 0, mid: 99, right: 10 }] }],
        }).variables[0].sets[0];
        expect(set.mid).toBe(10);
    });

    it('defaults a shape and a midpoint', () => {
        const set = parseFuzzyModel({
            variables: [{ name: 'a', sets: [{ name: 's', left: 0, right: 10 }] }],
        }).variables[0].sets[0];
        expect(set.shape).toBe('triangular');
        expect(set.mid).toBe(5);
    });

    it('collapses a single-child AND to the child, and drops an empty one', () => {
        const single = parseFuzzyTerm({ op: 'and', children: [{ op: 'is', variable: 'a', set: 's' }] });
        expect(single).toEqual({ op: 'is', variable: 'a', set: 's' });
        expect(parseFuzzyTerm({ op: 'and', children: [] })).toBeNull();
        expect(parseFuzzyTerm({ op: 'very', child: null })).toBeNull();
    });

    it('falls back to maxav for an unknown defuzzification', () => {
        expect(parseFuzzyModel({ defuzzification: 'nonsense' }).defuzzification).toBe('maxav');
    });
});

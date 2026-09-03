import { describe, it, expect } from 'vitest';
import {
    CONDITION_OPS, conditionMet, conditionNodeMet, consumeTriggers, createConditionContext,
    forEachCondition, gateMet, isConditionGroup, latchKey, parseCondition, parseConditionNode, updateLatch,
} from '../src/core/conditions';
import type { Condition, ConditionContext, ConditionGroup } from '../src/core/conditions';

// This module used to live inside animator.ts, where it was reachable only through a machine that needed
// a skinned model to build. Extracted, the interesting cases become three lines each — and they are cases
// worth having, because every one of them presents as "the state machine ping-pongs" or "the transition
// never fires", with nothing in a stack trace to say which condition was responsible.
//
// `tests/animatorTransitions.test.ts` is the other half of this suite's job: it proves the extraction
// did not change animation behaviour. This file pins the semantics themselves.

function ctxWith(values: Record<string, number | boolean>): ConditionContext {
    const ctx = createConditionContext();
    for (const [k, v] of Object.entries(values)) ctx.values.set(k, v);
    return ctx;
}

describe('the operators', () => {
    it('reads a boolean parameter through true/false, and a missing one as neither', () => {
        const ctx = ctxWith({ grounded: true });
        expect(conditionMet(ctx, { param: 'grounded', op: 'true' })).toBe(true);
        expect(conditionMet(ctx, { param: 'grounded', op: 'false' })).toBe(false);
        // A parameter that does not exist must not satisfy EITHER arm — a dangling binding should stop
        // its transition, not make the opposite one fire.
        expect(conditionMet(ctx, { param: 'ghost', op: 'true' })).toBe(false);
        expect(conditionMet(ctx, { param: 'ghost', op: 'false' })).toBe(false);
    });

    it('compares numbers, and refuses to compare a boolean as one', () => {
        const ctx = ctxWith({ speed: 3, flag: true });
        expect(conditionMet(ctx, { param: 'speed', op: 'gt', value: 2 })).toBe(true);
        expect(conditionMet(ctx, { param: 'speed', op: 'lt', value: 2 })).toBe(false);
        expect(conditionMet(ctx, { param: 'speed', op: 'eq', value: 3 })).toBe(true);
        expect(conditionMet(ctx, { param: 'speed', op: 'neq', value: 3 })).toBe(false);
        expect(conditionMet(ctx, { param: 'flag', op: 'gt', value: 0 })).toBe(false);
    });

    it('treats a missing threshold as zero', () => {
        const ctx = ctxWith({ speed: 1 });
        expect(conditionMet(ctx, { param: 'speed', op: 'gt' })).toBe(true);
        expect(conditionMet(ctx, { param: 'speed', op: 'eq' })).toBe(false);
    });

    it('reads a trigger as a one-shot boolean', () => {
        const ctx = ctxWith({ fire: true });
        expect(conditionMet(ctx, { param: 'fire', op: 'trigger' })).toBe(true);
        ctx.values.set('fire', false);
        expect(conditionMet(ctx, { param: 'fire', op: 'trigger' })).toBe(false);
    });
});

describe('hysteresis', () => {
    const band: Condition = { param: 'speed', op: 'gt', value: 1, hysteresis: 0.2 };

    it('centres the band on the threshold', () => {
        // Engage at 1.1, release at 0.9. Centring is the whole point: widening only the release would
        // leave a `>`/`<` pair both satisfiable at the same value.
        const ctx = ctxWith({ speed: 1.05 });
        updateLatch(ctx, band);
        expect(conditionMet(ctx, band)).toBe(false);       // above the threshold, below the engage point

        ctx.values.set('speed', 1.15);
        updateLatch(ctx, band);
        expect(conditionMet(ctx, band)).toBe(true);

        ctx.values.set('speed', 0.95);
        updateLatch(ctx, band);
        expect(conditionMet(ctx, band)).toBe(true);        // engaged, and not yet below the release point

        ctx.values.set('speed', 0.85);
        updateLatch(ctx, band);
        expect(conditionMet(ctx, band)).toBe(false);
    });

    it('never lets a > / < pair sharing a band both hold', () => {
        // The failure this exists to prevent: a Locomotion/Idle pair that both think they should fire,
        // which reads as a machine flickering between two states for no visible reason.
        const gt: Condition = { param: 'speed', op: 'gt', value: 1, hysteresis: 0.4 };
        const lt: Condition = { param: 'speed', op: 'lt', value: 1, hysteresis: 0.4 };
        const ctx = createConditionContext();
        for (let v = 0; v <= 2; v += 0.05) {
            ctx.values.set('speed', v);
            updateLatch(ctx, gt);
            updateLatch(ctx, lt);
            expect(conditionMet(ctx, gt) && conditionMet(ctx, lt)).toBe(false);
        }
    });

    it('is idempotent within a frame, so evaluating after a refresh cannot flip it', () => {
        const ctx = ctxWith({ speed: 1.15 });
        updateLatch(ctx, band);
        const after = new Map(ctx.latches);
        updateLatch(ctx, band);
        updateLatch(ctx, band);
        expect([...ctx.latches]).toEqual([...after]);
    });

    it('ignores a non-positive band, a non-numeric value and a non-threshold operator', () => {
        const ctx = ctxWith({ speed: 5, flag: true });
        updateLatch(ctx, { param: 'speed', op: 'gt', value: 1, hysteresis: 0 });
        updateLatch(ctx, { param: 'flag', op: 'gt', value: 1, hysteresis: 1 });
        updateLatch(ctx, { param: 'speed', op: 'eq', value: 1, hysteresis: 1 });
        expect(ctx.latches.size).toBe(0);
    });

    it('gives two conditions asking the same question one latch, and different questions two', () => {
        const a: Condition = { param: 'speed', op: 'gt', value: 1, hysteresis: 0.2 };
        expect(latchKey(a)).toBe(latchKey({ ...a }));
        expect(latchKey(a)).not.toBe(latchKey({ ...a, value: 2 }));
        expect(latchKey(a)).not.toBe(latchKey({ ...a, hysteresis: 0.4 }));
        expect(latchKey(a)).not.toBe(latchKey({ ...a, op: 'lt' }));
    });
});

describe('groups', () => {
    it('matches an empty group for BOTH and and or', () => {
        // A half-authored group must not block its transition forever, and an empty condition list has
        // always meant "always fires".
        const ctx = createConditionContext();
        expect(conditionNodeMet(ctx, { op: 'and', children: [] })).toBe(true);
        expect(conditionNodeMet(ctx, { op: 'or', children: [] })).toBe(true);
    });

    it('ands and ors, and nests', () => {
        const ctx = ctxWith({ speed: 3, grounded: true, tired: false });
        const tree: ConditionGroup = {
            op: 'and',
            children: [
                { param: 'grounded', op: 'true' },
                {
                    op: 'or',
                    children: [{ param: 'speed', op: 'gt', value: 10 }, { param: 'tired', op: 'false' }],
                },
            ],
        };
        expect(conditionNodeMet(ctx, tree)).toBe(true);
        ctx.values.set('tired', true);
        expect(conditionNodeMet(ctx, tree)).toBe(false);
    });

    it('discriminates a group from a leaf by its children, not its op', () => {
        // Both shapes carry an `op`, which is exactly why `isConditionGroup` cannot switch on it.
        expect(isConditionGroup({ op: 'and', children: [] })).toBe(true);
        expect(isConditionGroup({ param: 'x', op: 'gt' })).toBe(false);
    });
});

describe('gateMet', () => {
    it('prefers the tree and ignores the legacy flat list when both are present', () => {
        const ctx = ctxWith({ a: true, b: false });
        const flat: Condition[] = [{ param: 'b', op: 'true' }];
        expect(gateMet(ctx, { op: 'and', children: [{ param: 'a', op: 'true' }] }, flat)).toBe(true);
    });

    it('ands the legacy flat list, and an empty one always fires', () => {
        const ctx = ctxWith({ a: true, b: false });
        expect(gateMet(ctx, undefined, [{ param: 'a', op: 'true' }, { param: 'b', op: 'false' }])).toBe(true);
        expect(gateMet(ctx, undefined, [{ param: 'a', op: 'true' }, { param: 'b', op: 'true' }])).toBe(false);
        expect(gateMet(ctx, undefined, [])).toBe(true);
        expect(gateMet(ctx, undefined, undefined)).toBe(true);
    });
});

describe('forEachCondition / consumeTriggers', () => {
    const tree: ConditionGroup = {
        op: 'or',
        children: [
            { param: 'fireA', op: 'trigger' },
            { op: 'and', children: [{ param: 'fireB', op: 'trigger' }, { param: 'speed', op: 'gt', value: 1 }] },
        ],
    };

    it('visits every leaf, however deep', () => {
        const seen: string[] = [];
        forEachCondition(tree, undefined, c => seen.push(c.param));
        expect(seen).toEqual(['fireA', 'fireB', 'speed']);
    });

    it('lowers every trigger in the tree, including under a branch that did not contribute', () => {
        // The one left raised is the bug: it fires some unrelated transition next frame, which presents
        // as a machine skipping a state at random.
        const ctx = ctxWith({ fireA: true, fireB: true, speed: 0 });
        consumeTriggers(ctx, tree, undefined);
        expect(ctx.values.get('fireA')).toBe(false);
        expect(ctx.values.get('fireB')).toBe(false);
        // Non-triggers are left alone.
        expect(ctx.values.get('speed')).toBe(0);
    });

    it('falls back to the flat list when there is no tree', () => {
        const ctx = ctxWith({ fire: true });
        consumeTriggers(ctx, undefined, [{ param: 'fire', op: 'trigger' }]);
        expect(ctx.values.get('fire')).toBe(false);
    });
});

describe('the tolerant reader', () => {
    it('drops a leaf with no parameter, and nothing else', () => {
        expect(parseCondition(null)).toBeNull();
        expect(parseCondition('speed')).toBeNull();
        expect(parseCondition({ op: 'gt' })).toBeNull();
        expect(parseCondition({ param: '   ', op: 'gt' })).toBeNull();
        expect(parseCondition({ param: 'speed', op: 'gt', value: 2 }))
            .toEqual({ param: 'speed', op: 'gt', value: 2 });
    });

    it('falls back to `true` for an unknown operator rather than dropping the leaf', () => {
        // A condition that never holds silently disables the transition it guards; one that always holds
        // is at least visible in the editor.
        expect(parseCondition({ param: 'speed', op: 'approximately' })).toEqual({ param: 'speed', op: 'true' });
    });

    it('repairs a non-numeric threshold and drops a non-positive band', () => {
        expect(parseCondition({ param: 's', op: 'gt', value: NaN })).toEqual({ param: 's', op: 'gt', value: 0 });
        expect(parseCondition({ param: 's', op: 'gt', value: 1, hysteresis: -1 }))
            .toEqual({ param: 's', op: 'gt', value: 1 });
        expect(parseCondition({ param: 's', op: 'gt', value: 1, hysteresis: 'wide' }))
            .toEqual({ param: 's', op: 'gt', value: 1 });
    });

    it('writes no threshold or band where the operator has no use for one', () => {
        // Keeps a round trip byte-identical, so re-saving a project cannot grow its diff.
        const parsed = parseCondition({ param: 'g', op: 'true', value: 5, hysteresis: 2 })!;
        expect('value' in parsed).toBe(false);
        expect('hysteresis' in parsed).toBe(false);
    });

    it('reads a tree, dropping unreadable leaves while their siblings keep order', () => {
        const tree = parseConditionNode({
            op: 'or',
            children: [{ param: 'a', op: 'true' }, { op: 'gt' }, { param: 'b', op: 'false' }],
        }) as ConditionGroup;
        expect(tree.op).toBe('or');
        expect(tree.children.map(c => (c as Condition).param)).toEqual(['a', 'b']);
    });

    it('keeps a group whose children all dropped, which reads as "no constraint"', () => {
        const tree = parseConditionNode({ op: 'and', children: [{ nonsense: true }] }) as ConditionGroup;
        expect(tree.children).toEqual([]);
        expect(conditionNodeMet(createConditionContext(), tree)).toBe(true);
    });

    it('defaults an unreadable group operator to `and`', () => {
        expect((parseConditionNode({ children: [] }) as ConditionGroup).op).toBe('and');
        expect((parseConditionNode({ op: 'xor', children: [] }) as ConditionGroup).op).toBe('and');
    });

    it('is idempotent — parsing its own output changes nothing', () => {
        const once = parseConditionNode({
            op: 'and',
            children: [{ param: 'a', op: 'gt', value: 1, hysteresis: 0.2 }, { op: 'or', children: [] }],
        });
        expect(parseConditionNode(once)).toEqual(once);
    });

    it('reads every operator it declares', () => {
        for (const op of CONDITION_OPS)
            expect(parseCondition({ param: 'p', op })!.op).toBe(op);
    });
});

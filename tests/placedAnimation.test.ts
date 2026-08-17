import { describe, it, expect } from 'vitest';
import {
    captureAnimationState, restoreAnimationState, NodeLike, PlacedAnimationState,
} from '../editor/src/utils/placedAnimation';

// A placed instance is rebuilt FROM ITS ASSET whenever that asset's content hash changes — and a model asset
// never carries an animation state machine, because machines are authored onto the placed node. Without this
// carry-over, one asset edit silently strips every configured character in every scene. These tests pin that
// it survives, because the failure is invisible: the character still exists, still renders, and simply never
// animates again.

const animator = (sm: any = null, mappings: any[] = []) => {
    let _sm = sm;
    let _m = mappings;
    return {
        getStateMachine: () => _sm,
        getAnimationMappings: () => _m,
        setStateMachine: (v: any) => { _sm = v },
        setAnimationMappings: (v: any[]) => { _m = v },
    };
};

/** A holder root with skinned children, mirroring what an imported model instantiates as. */
const holder = (children: NodeLike[]): NodeLike => ({ children });
const modelNode = (over: Partial<NodeLike> = {}): NodeLike =>
    ({ animator: animator(), ragdollConfig: null, children: [], ...over });

const SM = { parameters: [], states: [{ name: 'Idle', clipName: 'idle', loop: true, speed: 1 }], transitions: [], events: [] };
const MAPPINGS = [{ trigger: 'key', animationName: 'walk' }];
const RAGDOLL = { mass: 3 };

describe('captureAnimationState / restoreAnimationState', () => {
    it('carries a state machine across a rebuild', () => {
        const old = holder([modelNode({ animator: animator(SM) })]);
        const saved = captureAnimationState(old);

        const rebuilt = holder([modelNode()]);
        expect(rebuilt.children[0].animator!.getStateMachine()).toBeNull();  // as the asset produced it

        restoreAnimationState(rebuilt, saved);
        expect(rebuilt.children[0].animator!.getStateMachine()).toEqual(SM);
    });

    it('carries animation mappings and the ragdoll config too', () => {
        const old = holder([modelNode({ animator: animator(null, MAPPINGS), ragdollConfig: RAGDOLL })]);
        const rebuilt = holder([modelNode()]);
        restoreAnimationState(rebuilt, captureAnimationState(old));
        expect(rebuilt.children[0].animator!.getAnimationMappings()).toEqual(MAPPINGS);
        expect(rebuilt.children[0].ragdollConfig).toEqual(RAGDOLL);
    });

    /**
     * A multi-submesh import produces several ModelNodes under one holder. They are paired by POSITION, which
     * is exact because the rebuild deep-clones the same nodeJson — but it means a bug here shows up as one
     * character wearing another's animation setup rather than as an obvious crash.
     */
    it('pairs several model nodes in order, not by identity', () => {
        const smB = { ...SM, states: [{ name: 'Run', clipName: 'run', loop: true, speed: 1 }] };
        const old = holder([
            modelNode({ animator: animator(SM) }),
            modelNode({ animator: animator(smB) }),
        ]);
        const rebuilt = holder([modelNode(), modelNode()]);
        restoreAnimationState(rebuilt, captureAnimationState(old));

        expect(rebuilt.children[0].animator!.getStateMachine()).toEqual(SM);
        expect(rebuilt.children[1].animator!.getStateMachine()).toEqual(smB);
    });

    it('walks nested children, not just direct ones', () => {
        const old = holder([{ children: [modelNode({ animator: animator(SM) })] }]);
        const rebuilt = holder([{ children: [modelNode()] }]);
        restoreAnimationState(rebuilt, captureAnimationState(old));
        expect((rebuilt.children[0].children[0] as NodeLike).animator!.getStateMachine()).toEqual(SM);
    });

    // A node that never had a machine must not acquire an empty one — setStateMachine resets parameters and
    // re-enters the entry state, so applying a null-ish machine is not a no-op.
    it('does not invent state on a node that had none', () => {
        const old = holder([modelNode()]);
        const rebuilt = holder([modelNode()]);
        restoreAnimationState(rebuilt, captureAnimationState(old));
        expect(rebuilt.children[0].animator!.getStateMachine()).toBeNull();
        expect(rebuilt.children[0].animator!.getAnimationMappings()).toEqual([]);
        expect(rebuilt.children[0].ragdollConfig).toBeNull();
    });

    it('counts a model node with no animator, so later siblings still line up', () => {
        // A non-skinned ModelNode has `animator === null` but still occupies a slot. Skipping it would shift
        // every subsequent pairing by one and hand the wrong machine to the wrong mesh.
        const old = holder([
            modelNode({ animator: null }),
            modelNode({ animator: animator(SM) }),
        ]);
        const saved = captureAnimationState(old);
        expect(saved).toHaveLength(2);

        const rebuilt = holder([modelNode({ animator: null }), modelNode()]);
        restoreAnimationState(rebuilt, saved);
        expect(rebuilt.children[1].animator!.getStateMachine()).toEqual(SM);
    });

    it('ignores plain nodes that cannot carry animation', () => {
        const old = holder([{ children: [] }, modelNode({ animator: animator(SM) })]);
        expect(captureAnimationState(old)).toHaveLength(1);
    });

    // Only reachable if the asset's own hierarchy changed under the placement. Carrying over what still lines
    // up beats discarding all of it, and it must not throw.
    it('tolerates the rebuilt subtree having a different node count', () => {
        const old = holder([modelNode({ animator: animator(SM) }), modelNode({ animator: animator(SM) })]);
        const saved = captureAnimationState(old);

        const fewer = holder([modelNode()]);
        expect(() => restoreAnimationState(fewer, saved)).not.toThrow();
        expect(fewer.children[0].animator!.getStateMachine()).toEqual(SM);

        const more = holder([modelNode(), modelNode(), modelNode()]);
        expect(() => restoreAnimationState(more, saved)).not.toThrow();
        expect(more.children[2].animator!.getStateMachine()).toBeNull();
    });

    it('does nothing with an empty snapshot', () => {
        const rebuilt = holder([modelNode()]);
        restoreAnimationState(rebuilt, [] as PlacedAnimationState[]);
        expect(rebuilt.children[0].animator!.getStateMachine()).toBeNull();
    });

    /**
     * The rebuild source wins where it has an opinion. Model assets carry no machine, so the tests above are
     * the whole story for them — but a TEMPLATE serializes its subtree and does carry one, and the same
     * rebuild path serves both. Restoring over a template's own machine would mean editing a machine in the
     * template editor and having the edit reach nothing, which is exactly the class of silent failure this
     * whole file exists to prevent.
     */
    describe('when the rebuilt node already has state of its own (template rebuild)', () => {
        const TEMPLATE_SM = { ...SM, states: [{ name: 'Edited', clipName: 'edited', loop: true, speed: 1 }] };

        it('keeps the rebuilt machine rather than the placement\'s older copy', () => {
            const old = holder([modelNode({ animator: animator(SM) })]);
            const rebuilt = holder([modelNode({ animator: animator(TEMPLATE_SM) })]);
            restoreAnimationState(rebuilt, captureAnimationState(old));
            expect(rebuilt.children[0].animator!.getStateMachine()).toEqual(TEMPLATE_SM);
        });

        it('keeps rebuilt mappings and a rebuilt ragdoll config too', () => {
            const tplMappings = [{ trigger: 'hit', animationName: 'flinch' }];
            const tplRagdoll = { mass: 99 };
            const old = holder([modelNode({ animator: animator(null, MAPPINGS), ragdollConfig: RAGDOLL })]);
            const rebuilt = holder([modelNode({
                animator: animator(null, tplMappings), ragdollConfig: tplRagdoll,
            })]);
            restoreAnimationState(rebuilt, captureAnimationState(old));
            expect(rebuilt.children[0].animator!.getAnimationMappings()).toEqual(tplMappings);
            expect(rebuilt.children[0].ragdollConfig).toEqual(tplRagdoll);
        });

        // Per-field, not all-or-nothing: a template carrying a machine but no ragdoll must still let the
        // placement's ragdoll through.
        it('fills only the fields the rebuild left empty', () => {
            const old = holder([modelNode({ animator: animator(SM, MAPPINGS), ragdollConfig: RAGDOLL })]);
            const rebuilt = holder([modelNode({ animator: animator(TEMPLATE_SM) })]);
            restoreAnimationState(rebuilt, captureAnimationState(old));
            expect(rebuilt.children[0].animator!.getStateMachine()).toEqual(TEMPLATE_SM);
            expect(rebuilt.children[0].animator!.getAnimationMappings()).toEqual(MAPPINGS);
            expect(rebuilt.children[0].ragdollConfig).toEqual(RAGDOLL);
        });
    });
});

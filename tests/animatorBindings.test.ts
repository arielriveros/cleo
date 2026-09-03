import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import { Logger } from '../src/core/logger';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import type { AnimationStateMachine } from '../src/animation/animator';

// How a 'variable' parameter finds the node it reads from — and what happens when it cannot.
//
// This is the failure that cost five rounds of diagnosis: the picker stored "the parent with the body" as
// that node's ID, ids are regenerated on every re-instantiation, and a binding whose node has vanished
// silently writes the parameter's DEFAULT for the rest of the session. The machine still runs, still poses
// its entry state correctly, and never transitions again. From the outside a broken binding is
// indistinguishable from a working one that happens to read zero, so what is pinned here is not just the
// repair but the fact that it SAYS SO.

const SKIN: Skin = {
    joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }],
    nodeTransforms: new Map([[0, mat4.create()]]),
};

function clip(name: string): Animation {
    return {
        name,
        samplers: [{ input: [0, 1], output: [0, 0, 0, 1, 0, 0], interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
    };
}

/** The standard character rig: `Playable(body) -> holder -> ModelNode(animator)`. */
function makeRig(opts: { speed?: number; withBody?: boolean; knownIds?: Record<string, any> } = {}) {
    const bodied: any = {
        id: 'bodied-old-id',
        name: 'Player',
        body: opts.withBody === false ? null : {},
        parent: null,
        position: vec3.create(),
        planarSpeed: opts.speed ?? 0,
        variables: new Map(),
        getVariable: () => undefined,
    };
    const holder: any = {
        id: 'holder', name: 'Holder', body: null, parent: bodied, position: vec3.create(),
    };
    const modelNode: any = {
        id: 'model', name: 'Model', body: null, parent: holder, position: vec3.create(),
        worldTransform: mat4.create(),
        // A stale id resolves to nothing — which is exactly the state a re-created node leaves behind.
        scene: { getNodeById: (id: string) => opts.knownIds?.[id] ?? null },
    };
    holder.children = [modelNode];
    bodied.children = [holder];

    const model = { skin: SKIN, animations: [clip('idle'), clip('run')] } as unknown as AnimatedModel;
    const animator = new Animator(model);
    animator.setNode(modelNode);
    return { animator, bodied, holder, modelNode };
}

/** Idle -> Run gated on `Speed > 1`, with `Speed` bound to a built-in on `nodeRef`. */
function machine(nodeRef: string, source: 'builtin' | 'variable' = 'builtin'): AnimationStateMachine {
    return {
        parameters: [{
            name: 'Speed', type: 'variable', default: 0,
            variable: { nodeRef, varName: source === 'builtin' ? 'planarSpeed' : 'mySpeed', varType: 'number', source },
        }],
        states: [
            { name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true },
            { name: 'Run', clipName: 'run', loop: true, speed: 1 },
        ],
        transitions: [{ from: 'Idle', to: 'Run', conditions: [{ param: 'Speed', op: 'gt', value: 1 }] }],
        events: [],
    } as unknown as AnimationStateMachine;
}

function step(a: Animator, seconds: number, dt = 1 / 60) {
    for (let t = 0; t < seconds - 1e-9; t += dt) { a.checkTriggers(); a.update(dt); }
}

/**
 * Warnings this animator emitted, read off the console mirror rather than `Logger.logs`.
 *
 * The ring buffer holds 500 entries and a thrashing machine can fill it in seconds, so a test that runs long
 * enough to provoke the fault can also evict the warning proving it — which reads as "no warning" and is a
 * false pass waiting to happen. The spy records every call regardless.
 */
let warned: ReturnType<typeof vi.spyOn>;
const animationWarnings = () =>
    warned.mock.calls.filter(c => c[0] === '[Animation]').map(c => String(c[1]));

beforeEach(() => {
    Logger.clear();
    // Also stops the deliberately-provoked warnings scribbling over the reporter's output.
    warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a built-in bound to a node id that no longer exists', () => {
    it('re-resolves to the bodied ancestor and drives the parameter', () => {
        const { animator } = makeRig({ speed: 4 });
        animator.setStateMachine(machine('bodied-old-id'));   // an id nothing in the scene answers to

        step(animator, 0.2);

        expect(animator.getParam('Speed')).toBe(4);
        expect(animator.currentStateName).toBe('Run');
    });

    it('names the parameter and the node it re-bound to', () => {
        const { animator } = makeRig({ speed: 4 });
        animator.setStateMachine(machine('bodied-old-id'));
        step(animator, 0.2);

        const warnings = animationWarnings();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Speed');
        expect(warnings[0]).toContain('Player');   // the node it fell back to
    });

    /**
     * The repair runs inside the per-frame parameter refresh, so an un-deduplicated warning is 60 lines a
     * second — which floods the console badly enough that it hides the very message it is trying to deliver.
     */
    it('warns once, not once per frame', () => {
        const { animator } = makeRig({ speed: 4 });
        animator.setStateMachine(machine('bodied-old-id'));
        step(animator, 3);
        expect(animationWarnings()).toHaveLength(1);
    });

    it('keeps the default, and says so, when there is no bodied ancestor either', () => {
        const { animator } = makeRig({ speed: 4, withBody: false });
        animator.setStateMachine(machine('bodied-old-id'));
        step(animator, 0.2);

        expect(animator.getParam('Speed')).toBe(0);
        expect(animator.currentStateName).toBe('Idle');
        const warnings = animationWarnings();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('default');
    });

    it('re-arms the warnings when a different machine is installed', () => {
        const { animator } = makeRig({ speed: 4 });
        animator.setStateMachine(machine('bodied-old-id'));
        step(animator, 0.2);
        expect(animationWarnings()).toHaveLength(1);

        animator.setStateMachine(machine('another-dead-id'));
        step(animator, 0.2);
        expect(animationWarnings()).toHaveLength(2);
    });
});

describe('a user VARIABLE bound to a node that no longer exists', () => {
    /**
     * No fallback here, deliberately. Built-ins are only ever offered for self / parent / the bodied
     * ancestor, so a dangling one has exactly one thing it could have meant. A user variable can live on any
     * node in the scene, and guessing would drive the machine off some unrelated object — a wrong answer
     * that looks like a working one, which is strictly worse than a stalled parameter that announces itself.
     */
    it('keeps the default rather than guessing', () => {
        const { animator } = makeRig({ speed: 4 });
        animator.setStateMachine(machine('some-deleted-node', 'variable'));
        step(animator, 0.2);

        expect(animator.getParam('Speed')).toBe(0);
        expect(animator.currentStateName).toBe('Idle');
    });

    it('still warns, naming the parameter', () => {
        const { animator } = makeRig({ speed: 4 });
        animator.setStateMachine(machine('some-deleted-node', 'variable'));
        step(animator, 0.2);

        const warnings = animationWarnings();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Speed');
    });
});

describe("nodeRef: 'bodied'", () => {
    /**
     * The relationship, rather than the identity. The character's rig puts the body two levels above the
     * animator, so neither 'self' nor 'parent' reaches it — an id was previously the only way to name it,
     * and an id is precisely what a rebuild invalidates.
     */
    it('resolves through the intermediate holder node', () => {
        const { animator } = makeRig({ speed: 4 });
        animator.setStateMachine(machine('bodied'));
        step(animator, 0.2);

        expect(animator.getParam('Speed')).toBe(4);
        expect(animator.currentStateName).toBe('Run');
    });

    it('does not warn — it resolved, it did not dangle', () => {
        const { animator } = makeRig({ speed: 4 });
        animator.setStateMachine(machine('bodied'));
        step(animator, 0.2);
        expect(animationWarnings()).toEqual([]);
    });

    // The point of the whole change: the SAME serialized machine, re-attached to a freshly built node tree
    // with entirely different ids, still finds its source.
    it('survives a rebuild that regenerates every node id', () => {
        const sm = machine('bodied');

        const first = makeRig({ speed: 4 });
        first.animator.setStateMachine(sm);
        step(first.animator, 0.2);
        expect(first.animator.currentStateName).toBe('Run');

        const rebuilt = makeRig({ speed: 4 });
        rebuilt.bodied.id = 'bodied-brand-new-id';
        rebuilt.animator.setStateMachine(sm);
        step(rebuilt.animator, 0.2);

        expect(rebuilt.animator.getParam('Speed')).toBe(4);
        expect(rebuilt.animator.currentStateName).toBe('Run');
        expect(animationWarnings()).toEqual([]);
    });

    it('falls back to the default when nothing in the chain has a body', () => {
        const { animator } = makeRig({ speed: 4, withBody: false });
        animator.setStateMachine(machine('bodied'));
        step(animator, 0.2);
        expect(animator.getParam('Speed')).toBe(0);
    });
});

describe('the reference forms that already worked', () => {
    it("still reads through 'self'", () => {
        const { animator, modelNode } = makeRig();
        modelNode.planarSpeed = 7;
        animator.setStateMachine(machine('self'));
        step(animator, 0.2);
        expect(animator.getParam('Speed')).toBe(7);
    });

    it("still reads through 'parent'", () => {
        const { animator, holder } = makeRig();
        holder.planarSpeed = 7;
        animator.setStateMachine(machine('parent'));
        step(animator, 0.2);
        expect(animator.getParam('Speed')).toBe(7);
    });

    // An id that DOES resolve keeps working untouched — the repair only engages on a miss, so no saved
    // machine changes meaning.
    it('still reads through a node id that resolves', () => {
        const other: any = { id: 'other', name: 'Other', planarSpeed: 9, body: null, parent: null };
        const { animator } = makeRig({ knownIds: { other } });
        animator.setStateMachine(machine('other'));
        step(animator, 0.2);
        expect(animator.getParam('Speed')).toBe(9);
        expect(animationWarnings()).toEqual([]);
    });
});

/**
 * A Speed parameter that goes negative.
 *
 * The clamp is right — there is no reverse playback — but on its own it is silent, and what it does is not
 * small: the rate pins to 0 and the clip FREEZES. With a blend field still re-mixing underneath, that reads
 * on screen as the whole pose vibrating rather than as an animation that stopped, and only on one side of the
 * parameter's range. The signed built-ins are the obvious things to bind here and every one of them is a trap:
 * `forwardSpeed` and `lateralSpeed` are signed by design, `planarAngle` is negative across half its range.
 */
describe('a Speed parameter bound to a signed value', () => {
    const rated = (rate: number): AnimationStateMachine => ({
        parameters: [{ name: 'Rate', type: 'float', default: rate }],
        states: [{ name: 'Locomotion', clipName: 'run', loop: true, speed: 1, isEntry: true, speedParam: 'Rate' }],
        transitions: [],
        events: [],
    } as unknown as AnimationStateMachine);

    it('still clamps the rate to zero — the reporting changed, not the behaviour', () => {
        const { animator } = makeRig();
        animator.setStateMachine(rated(-2.5));
        step(animator, 0.2);
        expect(animator.speed).toBe(0);
    });

    it('names the state and the parameter, and says the clip is frozen', () => {
        const { animator } = makeRig();
        animator.setStateMachine(rated(-2.5));
        step(animator, 0.2);

        const warnings = animationWarnings();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Locomotion');
        expect(warnings[0]).toContain('Rate');
        expect(warnings[0]).toContain('freezes');
        expect(warnings[0]).toContain('planarSpeed');   // names the fix, not just the fault
    });

    // _applyStateSpeed runs every frame, so an un-deduplicated warning is 60 lines a second.
    it('warns once, not once per frame', () => {
        const { animator } = makeRig();
        animator.setStateMachine(rated(-2.5));
        step(animator, 3);
        expect(animationWarnings()).toHaveLength(1);
    });

    it('says nothing at all for a rate that stays at or above zero', () => {
        const { animator } = makeRig();
        animator.setStateMachine(rated(1.5));
        step(animator, 1);
        expect(animator.speed).toBe(1.5);
        expect(animationWarnings()).toEqual([]);

        animator.setFloat('Rate', 0);   // a deliberate halt is not a mistake
        step(animator, 1);
        expect(animator.speed).toBe(0);
        expect(animationWarnings()).toEqual([]);
    });

    it('re-arms when a different machine is installed, so a fix can be seen to have taken', () => {
        const { animator } = makeRig();
        animator.setStateMachine(rated(-2.5));
        step(animator, 0.2);
        expect(animationWarnings()).toHaveLength(1);

        animator.setStateMachine(rated(-1));
        step(animator, 0.2);
        expect(animationWarnings()).toHaveLength(2);
    });
});

/**
 * A machine that changes state several times a second is fighting itself, and it does not look like a state
 * problem on screen — every entry re-arms a cross-fade from a pose that has barely moved, and if one of the
 * two states plays a field and the other a clip, the whole blend is torn down and rebuilt each frame. It
 * reads as the character vibrating, so people go looking in the blend. Naming the PAIR is the deliverable:
 * the rate alone does not say which two transitions to go and fix.
 */
describe('a state machine that ping-pongs', () => {
    /** Two states with an ungated transition each way — the degenerate bounce, one flip per frame. */
    const bouncing = (): AnimationStateMachine => ({
        parameters: [],
        states: [
            { name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true },
            { name: 'Run', clipName: 'run', loop: true, speed: 1 },
        ],
        transitions: [
            { from: 'Idle', to: 'Run', conditions: [] },
            { from: 'Run', to: 'Idle', conditions: [] },
        ],
        events: [],
    } as unknown as AnimationStateMachine);

    it('reports itself, naming the pair it is bouncing between', () => {
        const { animator } = makeRig();
        animator.setStateMachine(bouncing());
        step(animator, 0.5);

        const warnings = animationWarnings();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('ping-pong');
        expect(warnings[0]).toMatch(/Idle -> Run|Run -> Idle/);
        expect(warnings[0]).toContain('hysteresis');   // names the fix
    });

    it('says it once, not on every flip', () => {
        const { animator } = makeRig();
        animator.setStateMachine(bouncing());
        step(animator, 5);
        expect(animationWarnings()).toHaveLength(1);
    });

    /**
     * The threshold has to clear honest play or it is noise. A player slamming the controls can genuinely
     * walk a machine through several states in a second; only a per-frame bounce is pathological.
     */
    it('stays quiet for a machine changing state at a human rate', () => {
        const { animator } = makeRig();
        const gated: AnimationStateMachine = {
            parameters: [{ name: 'Go', type: 'bool', default: false }],
            states: [
                { name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true },
                { name: 'Run', clipName: 'run', loop: true, speed: 1 },
            ],
            transitions: [
                { from: 'Idle', to: 'Run', conditions: [{ param: 'Go', op: 'true' }] },
                { from: 'Run', to: 'Idle', conditions: [{ param: 'Go', op: 'false' }] },
            ],
            events: [],
        } as unknown as AnimationStateMachine;
        animator.setStateMachine(gated);

        // Four round trips over four seconds — twice the rate of a busy player, still nothing like a bounce.
        for (let i = 0; i < 8; i++) {
            animator.setBool('Go', i % 2 === 0);
            step(animator, 0.5);
        }
        expect(animationWarnings()).toEqual([]);
    });

    it('re-arms on a new machine, so a fix can be seen to have taken', () => {
        const { animator } = makeRig();
        animator.setStateMachine(bouncing());
        step(animator, 0.5);
        expect(animationWarnings()).toHaveLength(1);

        animator.setStateMachine(bouncing());
        step(animator, 0.5);
        expect(animationWarnings()).toHaveLength(2);
    });
});

/**
 * The report has to be self-contained. Four rounds of this were lost to reasoning about a machine nobody
 * reading the log could see — so the warning carries the transitions, their conditions, the live value of
 * each, and whether it currently passes. An unconditional transition is called out by name because it is the
 * single most common cause and is invisible in a graph that looks perfectly wired.
 */
describe('the ping-pong report', () => {
    const sm = (fwd: any[], bwd: any[]): AnimationStateMachine => ({
        parameters: [{ name: 'Speed', type: 'float', default: 0.42 }],
        states: [
            { name: 'Idle', clipName: 'idle', loop: true, speed: 1, isEntry: true },
            { name: 'State2', clipName: 'run', loop: true, speed: 1 },
        ],
        transitions: [
            { from: 'Idle', to: 'State2', conditions: fwd },
            { from: 'State2', to: 'Idle', conditions: bwd },
        ],
        events: [],
    } as unknown as AnimationStateMachine);

    it('names an unconditional transition as such', () => {
        const { animator } = makeRig();
        animator.setStateMachine(sm([], []));
        step(animator, 0.5);
        const w = animationWarnings()[0];
        expect(w).toContain('NO CONDITIONS');
        expect(w).toContain('Idle -> State2');
        expect(w).toContain('State2 -> Idle');
    });

    it('prints each condition with its live value and whether it passes', () => {
        const { animator } = makeRig();
        // Overlapping bands: both are satisfiable at 0.42, which is the other classic shape.
        animator.setStateMachine(sm(
            [{ param: 'Speed', op: 'gt', value: 0.1 }],
            [{ param: 'Speed', op: 'lt', value: 0.9 }],
        ));
        step(animator, 0.5);

        const w = animationWarnings()[0];
        expect(w).toContain('Speed gt 0.1');
        expect(w).toContain('Speed lt 0.9');
        expect(w).toContain('Speed=0.420');
        expect(w).toContain('MET');
        expect(w).toContain('parameters: Speed=0.420');
    });

    it('reports the hysteresis band and the dwell gate when they are set', () => {
        const { animator } = makeRig();
        const m = sm(
            [{ param: 'Speed', op: 'gt', value: 0.1, hysteresis: 0.1 }],
            [{ param: 'Speed', op: 'lt', value: 0.9 }],
        );
        (m.transitions[0] as any).minDwell = 0.001;   // small enough to still thrash, but present
        animator.setStateMachine(m);
        step(animator, 0.5);

        const w = animationWarnings()[0];
        expect(w).toContain('±0.1');
        expect(w).toContain('minDwell');
        expect(w).toContain('no dwell/exit-time gate');   // the other direction has none
    });
});

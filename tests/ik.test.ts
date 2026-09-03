import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
    solveTwoBone, applyTwoBone, ikTuning, validateIkRig, swingReleaseWeight,
    IK_DEFAULTS, DEFAULT_MAX_REACH, TwoBoneSolve, IkRig,
} from '../src/animation/ik';
import { skeletonTopology, isAncestorJoint } from '../src/animation/skeletonTopology';
import { mat4 } from 'gl-matrix';
import type { Skin } from '../src/animation/animatedModel';

// The two-bone solve, tested by its PROPERTIES rather than its arithmetic: the tip lands on the target, the
// bones keep their lengths, the knee keeps pointing the way it was pointing, and none of the degenerate
// inputs a real skeleton produces yield NaN. Testing the closed form against hand-computed angles would only
// restate the implementation.

const V = (x: number, y: number, z: number) => vec3.fromValues(x, y, z);
const dist = (a: vec3, b: vec3) => vec3.distance(a, b);

/** A leg hanging straight down: hip at the origin, knee 1 below, ankle 2 below. Both bones length 1. */
const leg = (target: vec3, over: Partial<TwoBoneSolve> = {}): TwoBoneSolve => ({
    root: V(0, 0, 0), mid: V(0, -1, 0), tip: V(0, -2, 0), target, ...over,
});

/** A leg already bent forward (+Z), which is what an animated pose actually looks like. */
const bentLeg = (target: vec3, over: Partial<TwoBoneSolve> = {}): TwoBoneSolve => ({
    root: V(0, 0, 0), mid: V(0, -1, 0.3), tip: V(0, -2, 0), target, ...over,
});

const solved = (s: TwoBoneSolve) => applyTwoBone(s, solveTwoBone(s));

describe('solveTwoBone', () => {
    it('puts the tip on a reachable target', () => {
        for (const target of [V(0, -1.5, 0), V(0.5, -1.5, 0), V(0, -1.2, 0.8), V(-0.7, -1.0, 0.4)]) {
            const s = bentLeg(target);
            const out = solved(s);
            expect(dist(out.tip, target)).toBeLessThan(1e-5);
        }
    });

    /**
     * The whole contract, over a lattice covering the limb's entire reachable volume in 3D — not just the
     * plane it happens to be bent in. Out-of-plane targets are where a plausible-looking solver stops being
     * exact: the bend axis has to be perpendicular to the limb axis, and if it is merely *near*
     * perpendicular the rotation sweeps a cone and the tip lands short by a few centimetres. In one plane
     * that error is identically zero, so a planar test cannot see it.
     */
    it('reaches every reachable target in the volume, exactly', () => {
        const s0 = bentLeg(V(0, 0, 0));
        const a = dist(s0.root, s0.mid), b = dist(s0.mid, s0.tip);
        const full = (a + b) * DEFAULT_MAX_REACH;
        let checked = 0;

        for (let x = -1.6; x <= 1.6001; x += 0.4) {
            for (let y = -2.0; y <= -0.2001; y += 0.3) {
                for (let z = -1.6; z <= 1.6001; z += 0.4) {
                    const target = V(x, y, z);
                    if (vec3.length(target) > full) continue;   // unreachable is covered by its own test
                    const s = bentLeg(target);
                    const out = solved(s);
                    expect(dist(out.tip, target)).toBeLessThan(1e-5);
                    expect(dist(out.root, out.mid)).toBeCloseTo(a, 5);
                    expect(dist(out.mid, out.tip)).toBeCloseTo(b, 5);
                    checked++;
                }
            }
        }
        expect(checked).toBeGreaterThan(150);   // the lattice must actually be covering something
    });

    it('never stretches or shortens a bone', () => {
        const s = bentLeg(V(0.6, -1.1, 0.5));
        const out = solved(s);
        expect(dist(out.root, out.mid)).toBeCloseTo(dist(s.root, s.mid), 6);
        expect(dist(out.mid, out.tip)).toBeCloseTo(dist(s.mid, s.tip), 6);
    });

    /**
     * Out of reach is the case that has to degrade well, not throw. A leg reaching for something further than
     * it is long should end up straight and pointing at it — never stretched, never NaN, never folded back.
     */
    it('points a straight limb at an unreachable target instead of stretching', () => {
        const s = bentLeg(V(0, -8, 0));
        const a = dist(s.root, s.mid), b = dist(s.mid, s.tip);
        const r = solveTwoBone(s);
        expect(r.reached).toBe(false);

        const out = applyTwoBone(s, r);
        for (const v of [...out.mid, ...out.tip]) expect(Number.isFinite(v)).toBe(true);
        expect(dist(out.root, out.mid)).toBeCloseTo(a, 6);
        expect(dist(out.mid, out.tip)).toBeCloseTo(b, 6);

        // Straight: root -> mid -> tip collinear, and aimed down the target direction.
        expect(dist(out.tip, out.root)).toBeCloseTo((a + b) * DEFAULT_MAX_REACH, 4);
        const dir = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), out.tip, out.root));
        expect(dir[1]).toBeCloseTo(-1, 4);
    });

    it('reports reached honestly at the limit', () => {
        const s = bentLeg(V(0, 0, 0));
        const full = dist(s.root, s.mid) + dist(s.mid, s.tip);
        expect(solveTwoBone(bentLeg(V(0, -full * DEFAULT_MAX_REACH * 0.99, 0))).reached).toBe(true);
        expect(solveTwoBone(bentLeg(V(0, -full * 1.001, 0))).reached).toBe(false);
    });

    /**
     * A perfectly straight limb has no bend plane — the cross product of its two bones vanishes — and that is
     * the pose a standing character is in, so it is the common path rather than an edge case. It must still
     * solve, and it must not produce NaN.
     */
    it('solves a limb that starts perfectly straight', () => {
        const s = leg(V(0, -1.5, 0.3));
        const out = solved(s);
        for (const v of [...out.mid, ...out.tip]) expect(Number.isFinite(v)).toBe(true);
        expect(dist(out.tip, s.target)).toBeLessThan(1e-5);
    });

    it('bends a straight limb towards the pole when given one', () => {
        // Same straight leg, same target, opposite poles: the knee must end up on opposite sides.
        const front = solved(leg(V(0, -1.5, 0), { pole: V(0, -1, 5) }));
        const back = solved(leg(V(0, -1.5, 0), { pole: V(0, -1, -5) }));
        expect(Math.abs(front.mid[2])).toBeGreaterThan(0.1);
        expect(Math.sign(front.mid[2])).toBe(-Math.sign(back.mid[2]));
    });

    /**
     * With no pole, the solver must keep the knee on the side the ANIMATION put it. Foot placement depends on
     * this: the animator chose which way the knee points, and IK moving the ankle is no reason to revisit it.
     * A solver that silently flips the knee produces the classic backwards-bending leg.
     */
    it('preserves the existing bend direction when no pole is given', () => {
        const s = bentLeg(V(0.2, -1.4, 0.1));
        const out = solved(s);
        expect(out.mid[2]).toBeGreaterThan(0);   // knee started forward (+Z) and must stay forward
    });

    /**
     * The sweep stays inside the range a foot actually occupies. Reaching almost straight down at almost full
     * extension, the knee legitimately sits ON the limb axis — there is nowhere forward left for it to be —
     * so demanding a forward knee out there would be demanding the wrong answer, not catching a bug.
     */
    it('keeps the knee forward across a sweep of plausible foot positions', () => {
        for (let z = -0.3; z <= 0.3001; z += 0.15) {
            for (let y = -1.8; y <= -0.9; y += 0.15) {
                const out = solved(bentLeg(V(0, y, z)));
                expect(out.mid[2]).toBeGreaterThan(0);
                for (const v of [...out.mid, ...out.tip]) expect(Number.isFinite(v)).toBe(true);
            }
        }
    });

    it('produces finite output even reaching backwards or straight down at full stretch', () => {
        for (let z = -0.9; z <= 0.9001; z += 0.1) {
            for (let y = -2.05; y <= -0.2; y += 0.15) {
                const s = bentLeg(V(0, y, z));
                const out = solved(s);
                for (const v of [...out.mid, ...out.tip]) expect(Number.isFinite(v)).toBe(true);
                expect(dist(out.root, out.mid)).toBeCloseTo(dist(s.root, s.mid), 5);
                expect(dist(out.mid, out.tip)).toBeCloseTo(dist(s.mid, s.tip), 5);
            }
        }
    });

    // Every one of these is reachable from real data: a target on top of the hip, a zero-length bone from a
    // rig with a duplicated joint, a chain the editor has only half-assigned.
    it('returns identity for degenerate input rather than NaN', () => {
        const identity = (r: { rootDelta: Float32Array | number[]; midDelta: Float32Array | number[] }) => {
            expect(Array.from(r.rootDelta)).toEqual([0, 0, 0, 1]);
            expect(Array.from(r.midDelta)).toEqual([0, 0, 0, 1]);
        };
        identity(solveTwoBone(bentLeg(V(0, 0, 0))));                                    // target on the root
        identity(solveTwoBone({ root: V(0, 0, 0), mid: V(0, 0, 0), tip: V(0, -1, 0), target: V(0, -0.5, 0) }));
        identity(solveTwoBone({ root: V(0, 0, 0), mid: V(0, -1, 0), tip: V(0, -1, 0), target: V(0, -0.5, 0) }));
    });

    it('is unaffected by where the limb sits in space', () => {
        // Same relative geometry, translated far from the origin: the deltas are rotations, so they must not
        // depend on absolute position.
        const offset = V(120, -37, 8);
        const near = solveTwoBone(bentLeg(V(0.4, -1.3, 0.2)));
        const far = solveTwoBone({
            root: vec3.add(vec3.create(), V(0, 0, 0), offset),
            mid: vec3.add(vec3.create(), V(0, -1, 0.3), offset),
            tip: vec3.add(vec3.create(), V(0, -2, 0), offset),
            target: vec3.add(vec3.create(), V(0.4, -1.3, 0.2), offset),
        });
        for (let i = 0; i < 4; i++) {
            expect(far.rootDelta[i]).toBeCloseTo(near.rootDelta[i], 5);
            expect(far.midDelta[i]).toBeCloseTo(near.midDelta[i], 5);
        }
    });

    it('does nothing when the target is already where the tip is', () => {
        const s = bentLeg(V(0, -2, 0));
        const out = solved(s);
        expect(dist(out.tip, s.tip)).toBeLessThan(1e-6);
        expect(dist(out.mid, s.mid)).toBeLessThan(1e-6);
    });
});

describe('ikTuning', () => {
    it('fills in every value and rejects nonsense', () => {
        expect(ikTuning(null)).toEqual(IK_DEFAULTS);
        expect(ikTuning({ feet: [] })).toEqual(IK_DEFAULTS);
        expect(ikTuning({ feet: [], footHeight: 0.2 }).footHeight).toBe(0.2);
        expect(ikTuning({ feet: [], footHeight: -1 }).footHeight).toBe(IK_DEFAULTS.footHeight);
        expect(ikTuning({ feet: [], maxHipDrop: NaN }).maxHipDrop).toBe(IK_DEFAULTS.maxHipDrop);
        // 0 is a legitimate authored value for several of these — "no hip drop", "no smoothing" — so it must
        // survive rather than being treated as absent.
        expect(ikTuning({ feet: [], maxHipDrop: 0 }).maxHipDrop).toBe(0);
        expect(ikTuning({ feet: [], smoothing: 0 }).smoothing).toBe(0);
        expect(ikTuning({ feet: [], swingRelease: 0 }).swingRelease).toBe(0);
    });
});

/**
 * The stance/swing split. Without it a foot the animation lifted mid-step still finds ground under it — the
 * ground ray reaches further down than a stride lifts — and is pulled back to it, which destroys the swing and
 * reads on screen as the animation fighting the IK.
 */
describe('swingReleaseWeight', () => {
    it('keeps the full correction for a foot at or through the ground', () => {
        // Pushing a foot out of the floor is the whole point of the feature; nothing may fade it.
        expect(swingReleaseWeight(0, 0.2)).toBe(1);
        expect(swingReleaseWeight(-0.05, 0.2)).toBe(1);
        expect(swingReleaseWeight(-10, 0.2)).toBe(1);
    });

    it('lets go completely at and beyond the threshold', () => {
        expect(swingReleaseWeight(0.2, 0.2)).toBe(0);
        expect(swingReleaseWeight(0.5, 0.2)).toBe(0);
    });

    it('is half applied at the midpoint, and flat at both ends', () => {
        expect(swingReleaseWeight(0.1, 0.2)).toBeCloseTo(0.5, 6);
        // Flat at t=0 is what keeps uneven ground planted rather than half-abandoned: a foot a centimetre up
        // still gets nearly all of its correction, where a linear ramp would already have given away 5%.
        expect(swingReleaseWeight(0.01, 0.2)).toBeGreaterThan(0.98);
        // And flat at t=1, so there is no crease at the moment the foot is released.
        expect(swingReleaseWeight(0.19, 0.2)).toBeLessThan(0.02);
    });

    it('is monotone non-increasing across the range', () => {
        let prev = 1;
        for (let lift = -0.1; lift <= 0.4; lift += 0.005) {
            const w = swingReleaseWeight(lift, 0.2);
            expect(w).toBeLessThanOrEqual(prev + 1e-12);
            expect(w).toBeGreaterThanOrEqual(0);
            expect(w).toBeLessThanOrEqual(1);
            prev = w;
        }
    });

    it('is off — IK owns the foot throughout — when the threshold is 0 or nonsense', () => {
        // The escape hatch, and the behaviour this had before the value existed.
        expect(swingReleaseWeight(5, 0)).toBe(1);
        expect(swingReleaseWeight(5, -1)).toBe(1);
        expect(swingReleaseWeight(5, NaN)).toBe(1);
    });
});

/**
 * Rig validation. Bone NAMES cannot tell a leg from three bones that merely sound like one — a control rig
 * routinely ships a `thigh`, a `shin` and a `foot` in three unrelated places, and solving those yields a
 * mathematically fine pose with no relation to the character. On screen that reads as thrashing rather than
 * as an error, which is exactly why it has to be caught and named instead of solved.
 */
describe('validateIkRig', () => {
    // hips(10) -> thighL(40) -> shinL(50) -> footL(60) -> toeL(70); hips -> spine(20); root(1) -> hips
    const SPEC = [
        { node: 1, name: 'root' }, { node: 10, parent: 1, name: 'Hips' }, { node: 20, parent: 10, name: 'Spine' },
        { node: 40, parent: 10, name: 'LeftUpLeg' }, { node: 50, parent: 40, name: 'LeftLeg' },
        { node: 60, parent: 50, name: 'LeftFoot' }, { node: 70, parent: 60, name: 'LeftToeBase' },
    ];
    const skin: Skin = {
        joints: SPEC.map(s => ({ nodeIndex: s.node, inverseBindMatrix: mat4.create(), parentIndex: s.parent })),
        nodeNames: new Map(SPEC.map(s => [s.node, s.name])),
    };
    const topo = skeletonTopology(skin);
    const check = (rig: IkRig) => validateIkRig(rig, topo, isAncestorJoint, n => skin.nodeNames!.get(n) ?? `node ${n}`);
    const LEG = { thigh: 40, shin: 50, foot: 60, toe: 70 };

    it('accepts a well-formed leg', () => {
        const r = check({ hips: 10, feet: [LEG] });
        expect(r.feet).toEqual([LEG]);
        expect(r.hips).toBe(10);
        expect(r.problems).toEqual([]);
    });

    it('accepts a leg with no toe — not every rig has one', () => {
        const r = check({ hips: 10, feet: [{ thigh: 40, shin: 50, foot: 60 }] });
        expect(r.feet).toHaveLength(1);
        expect(r.problems).toEqual([]);
    });

    it('rejects a chain whose bones are not connected', () => {
        // Spine is not beneath the thigh, so rotating the thigh would never move it.
        const r = check({ feet: [{ thigh: 40, shin: 20, foot: 60 }] });
        expect(r.feet).toEqual([]);
        expect(r.problems[0].message).toMatch(/not beneath/);
        expect(r.problems[0].message).toContain('Spine');
    });

    it('rejects a chain in the wrong order', () => {
        const r = check({ feet: [{ thigh: 60, shin: 50, foot: 40 }] });
        expect(r.feet).toEqual([]);
        expect(r.problems[0].message).toMatch(/not beneath/);
    });

    it('rejects a bone used for two roles', () => {
        const r = check({ feet: [{ thigh: 40, shin: 40, foot: 60 }] });
        expect(r.feet).toEqual([]);
        expect(r.problems[0].message).toMatch(/more than one role/);
    });

    it('rejects a bone that is not in this skeleton', () => {
        const r = check({ feet: [{ thigh: 40, shin: 50, foot: 999 }] });
        expect(r.feet).toEqual([]);
        expect(r.problems[0].message).toMatch(/not a bone of this skeleton/);
    });

    // The normal state while someone is picking bones — reported as unfinished, not as broken.
    it('reports a half-assigned chain as incomplete', () => {
        const r = check({ feet: [{ thigh: 40, shin: -1, foot: -1 }] });
        expect(r.feet).toEqual([]);
        expect(r.problems[0].message).toMatch(/incomplete/);
        expect(r.problems[0].message).toContain('shin');
    });

    it('rejects a second leg that reuses the first leg’s bones', () => {
        const r = check({ feet: [LEG, LEG] });
        expect(r.feet).toHaveLength(1);
        expect(r.problems[0].message).toMatch(/already used by leg 1/);
    });

    /**
     * `root` is a synonym for `hips` in the bone-name table and is usually joint 0, so a name-based guess
     * hands back the bone at the character's FEET. It is a genuine ancestor of the thighs, so it passes —
     * the defence against it is choosing the nearest common ancestor instead, not this check. What this
     * catches is a hips that is not above the legs at all, where lowering it would do nothing.
     */
    it('drops a hips that is not above the legs, keeping the legs', () => {
        const r = check({ hips: 20, feet: [LEG] });   // spine: a sibling of the thigh, not an ancestor
        expect(r.feet).toHaveLength(1);
        expect(r.hips).toBeUndefined();
        expect(r.problems[0].message).toMatch(/not above/);
    });

    it('drops a hips that is not a bone of this skeleton', () => {
        const r = check({ hips: 999, feet: [LEG] });
        expect(r.hips).toBeUndefined();
        expect(r.problems[0].message).toMatch(/not a bone of this skeleton/);
    });

    it('keeps a good leg when a second one is bad', () => {
        const r = check({ hips: 10, feet: [LEG, { thigh: 40, shin: 20, foot: 60 }] });
        expect(r.feet).toEqual([LEG]);
        expect(r.problems).toHaveLength(1);
        expect(r.problems[0].leg).toBe(1);
    });

    it('handles an absent rig', () => {
        expect(validateIkRig(null, topo, isAncestorJoint).feet).toEqual([]);
        expect(validateIkRig({ feet: [] }, topo, isAncestorJoint).problems).toEqual([]);
    });
});


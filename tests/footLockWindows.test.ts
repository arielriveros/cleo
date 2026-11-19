import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import type { Animation, Skin } from '../src/animation/animatedModel';
import { detectFootLockWindows, footLockAt, footLockKey, humanoidFeet, normalizeFootLockSpans } from '../src/animation/footLockWindows';
import { retargetAnimation, buildBoneMapping } from '../src/animation/animationRetarget';

// Foot-lock windows: when a clip says each foot is planted. Detection reads the clip's own foot heights: a span
// runs from the ball of the foot coming down to the heel rising `heelLift`, so a lock holds the flat foot and lets
// the push-off follow the animation.

const HIPS = 0, FOOT_L = 1, TOE_L = 2, FOOT_R = 3, TOE_R = 4;

function skin(): Skin {
    const t = (x: number, y: number, z: number) => mat4.fromTranslation(mat4.create(), [x, y, z]);
    return {
        joints: [HIPS, FOOT_L, TOE_L, FOOT_R, TOE_R].map(n => ({ nodeIndex: n, inverseBindMatrix: mat4.create() })),
        nodeTransforms: new Map([[HIPS, t(0, 1, 0)], [FOOT_L, t(0.1, -0.9, 0)], [TOE_L, t(0, -0.08, 0.12)], [FOOT_R, t(-0.1, -0.9, 0)], [TOE_R, t(0, -0.08, 0.12)]]),
        nodeParents: new Map([[FOOT_L, HIPS], [TOE_L, FOOT_L], [FOOT_R, HIPS], [TOE_R, FOOT_R]]),
        nodeNames: new Map([[HIPS, 'Hips'], [FOOT_L, 'LeftFoot'], [TOE_L, 'LeftToeBase'], [FOOT_R, 'RightFoot'], [TOE_R, 'RightToeBase']]),
    };
}

/**
 * One second. The left foot: down until 0.4 s, then its heel rising 1 cm every 0.05 s (the toe joint sinking
 * under it to keep the ball on the ground), then lifted whole from 0.7. The right foot never moves.
 */
function stepClip(): Animation {
    const times: number[] = [], foot: number[] = [], toe: number[] = [];
    for (let k = 0; k <= 20; k++) {
        const t = k / 20;
        times.push(t);
        const heel = t <= 0.4 ? 0 : t <= 0.7 ? (t - 0.4) / 0.05 * 0.01 : 0.06 + (t - 0.7) * 0.5;
        const ballDrop = t <= 0.4 ? 0 : t <= 0.7 ? -heel : -0.06 + (t - 0.7) * 0.2;
        foot.push(0.1, -0.9 + heel, 0);
        toe.push(0, -0.08 + ballDrop, 0.12);
    }
    return {
        name: 'step',
        samplers: [{ input: times, output: foot, interpolation: 'LINEAR' }, { input: times, output: toe, interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: FOOT_L, targetPath: 'translation' }, { samplerIndex: 1, targetNodeIndex: TOE_L, targetPath: 'translation' }],
    };
}

/**
 * Two seconds of a stair climb with its rise kept: the left foot stands on a tread at 0 until 0.6 s, swings up
 * over 0.3 s (to 0.4) and stands on the next tread, 0.25 higher, from 0.9 to 1.6 s, then lifts again.
 */
function stairClip(): Animation {
    const times: number[] = [], foot: number[] = [];
    for (let k = 0; k <= 80; k++) {
        const t = k / 40;
        times.push(t);
        const h = t <= 0.6 ? 0
            : t <= 0.9 ? 0.25 * (t - 0.6) / 0.3 + 0.6 * Math.sin(Math.PI * (t - 0.6) / 0.3) * 0.25
            : t <= 1.6 ? 0.25
            : 0.25 + (t - 1.6) * 0.8;
        foot.push(0.1, -0.9 + h, 0);
    }
    return {
        name: 'stairs',
        samplers: [{ input: times, output: foot, interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: FOOT_L, targetPath: 'translation' }],
    };
}

describe('foot-lock windows', () => {
    it('finds every stance of a stair climb against its own height (ground: stance)', () => {
        // Against the clip's lowest, only the first tread is "down".
        const flat = detectFootLockWindows(stairClip(), skin(), { heelLift: 0.03 })['foot.L'];
        expect(flat).toHaveLength(1);
        const w = detectFootLockWindows(stairClip(), skin(), { heelLift: 0.03, ground: 'stance' })['foot.L'];
        expect(w).toHaveLength(2);
        expect(w[0][0]).toBeCloseTo(0, 5);
        expect(w[0][1]).toBeGreaterThan(0.55);
        expect(w[0][1]).toBeLessThan(0.66);
        // The upper tread: from the landing (within contact of it) to the lift.
        expect(w[1][0]).toBeGreaterThan(0.8);
        expect(w[1][0]).toBeLessThan(0.92);
        expect(w[1][1]).toBeGreaterThan(1.58);
        expect(w[1][1]).toBeLessThan(1.66);
        // A foot standing still on the flat is down throughout either way.
        expect(detectFootLockWindows(stepClip(), skin(), { heelLift: 0.03, ground: 'stance' })['foot.R']).toEqual([[0, 1]]);
    });

    it('keys a humanoid foot by its slot, anything else by its name', () => {
        expect(footLockKey('mixamorig1:LeftFoot')).toBe('foot.L');
        expect(footLockKey('RightFoot')).toBe('foot.R');
        expect(footLockKey('claw_front')).toBe('claw_front');
        expect(humanoidFeet(skin())).toEqual([{ foot: FOOT_L, toe: TOE_L }, { foot: FOOT_R, toe: TOE_R }]);
    });

    it('ends a span when the heel has risen heelLift, though the ball is still down', () => {
        const w = detectFootLockWindows(stepClip(), skin(), { heelLift: 0.03 });
        expect(w['foot.L']).toHaveLength(1);
        const [a, b] = w['foot.L'][0];
        expect(a).toBeCloseTo(0, 5);
        // The heel reaches 3 cm at 0.55 s.
        expect(b).toBeGreaterThan(0.52);
        expect(b).toBeLessThan(0.56);
        // A foot that never moves is down the whole clip.
        expect(w['foot.R']).toEqual([[0, 1]]);
    });

    it('ends it when the ball lifts first, with a generous heel lift', () => {
        const [, b] = detectFootLockWindows(stepClip(), skin(), { heelLift: 0.5 })['foot.L'][0];
        expect(b).toBeGreaterThan(0.69);
        expect(b).toBeLessThan(0.76);
    });

    it('reads 1 inside a span, 0 outside, and null for a foot the clip does not list', () => {
        const clip = { footLocks: { 'foot.L': [[0.2, 0.4], [0.8, 1]] as [number, number][], 'foot.R': [] } };
        expect(footLockAt(clip, 'foot.L', 0.3)).toBe(1);
        expect(footLockAt(clip, 'foot.L', 0.5)).toBe(0);
        expect(footLockAt(clip, 'foot.L', 0.9)).toBe(1);
        expect(footLockAt(clip, 'foot.R', 0.3)).toBe(0);
        expect(footLockAt(clip, 'foot.X', 0.3)).toBeNull();
        expect(footLockAt({}, 'foot.L', 0.3)).toBeNull();
    });

    it('normalizes spans: sorted, clamped, merged, empty ones dropped', () => {
        expect(normalizeFootLockSpans([[0.5, 0.7], [0.1, 0.2], [0.65, 0.9], [0.3, 0.3], [1.2, 0.95]], 1))
            .toEqual([[0.1, 0.2], [0.5, 0.9], [0.95, 1]]);
    });

    it('survives a retarget onto another humanoid skeleton', () => {
        const clip = { ...stepClip(), footLocks: { 'foot.L': [[0, 0.55]] as [number, number][] } };
        const target = skin();
        const out = retargetAnimation(clip, skin(), target, buildBoneMapping([clip], skin(), target));
        expect(out.footLocks).toEqual({ 'foot.L': [[0, 0.55]] });
    });
});

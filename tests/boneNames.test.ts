import { describe, it, expect } from 'vitest';
import { normalizeBoneName, humanoidSlotOf } from '../src/graphics/boneNames';

// Bone-name matching is the difference between a Mixamo clip driving a custom rig and driving nothing at
// all. It is exact-token, not substring, on purpose: the classic failure is `forearm` being swallowed by an
// `arm` rule and the elbow ending up on the shoulder.

describe('normalizeBoneName', () => {
    it('drops namespace prefixes', () => {
        expect(normalizeBoneName('mixamorig:LeftForeArm')).toBe('leftforearm');
        expect(normalizeBoneName('Armature|Hips')).toBe('hips');
    });

    it('drops rig-specific prefixes', () => {
        expect(normalizeBoneName('DEF-upper_arm.L')).toBe('upperarm.l'.replace(/[._-]/g, ''));
        expect(normalizeBoneName('ORG-spine')).toBe('spine');
        expect(normalizeBoneName('Bip01 L Forearm')).toBe('lforearm');
        expect(normalizeBoneName('b_Head')).toBe('head');
        expect(normalizeBoneName('bone_Hips')).toBe('hips');
    });

    it('removes separators and lowercases', () => {
        expect(normalizeBoneName('Left_Fore_Arm')).toBe('leftforearm');
        expect(normalizeBoneName('spine.02')).toBe('spine02');
        expect(normalizeBoneName('Upper Arm R')).toBe('upperarmr');
    });

    it('keeps side markers (l/r are not decoration)', () => {
        expect(normalizeBoneName('LeftHand')).toContain('left');
        expect(normalizeBoneName('hand.R')).toBe('handr');
    });

    it('is idempotent', () => {
        const once = normalizeBoneName('mixamorig:RightUpLeg');
        expect(normalizeBoneName(once)).toBe(once);
    });
});

describe('humanoidSlotOf', () => {
    // The headline: three exporters' spelling of the same joint all land on one slot, which is what lets the
    // retargeter pair them.
    it('resolves the left forearm across naming conventions', () => {
        expect(humanoidSlotOf('mixamorig:LeftForeArm')).toBe('foreArm.L');
        expect(humanoidSlotOf('DEF-forearm.L')).toBe('foreArm.L');
        expect(humanoidSlotOf('Bip01 L Forearm')).toBe('foreArm.L');
        expect(humanoidSlotOf('arm_lower_l')).toBe('foreArm.L');
    });

    it('detects side from a prefix or a suffix', () => {
        expect(humanoidSlotOf('LeftHand')).toBe('hand.L');
        expect(humanoidSlotOf('Hand_R')).toBe('hand.R');
        expect(humanoidSlotOf('hand.l')).toBe('hand.L');
        expect(humanoidSlotOf('RightUpLeg')).toBe('upLeg.R');
    });

    it('maps centre bones with no side', () => {
        expect(humanoidSlotOf('Hips')).toBe('hips');
        expect(humanoidSlotOf('pelvis')).toBe('hips');
        expect(humanoidSlotOf('mixamorig:Spine')).toBe('spine');
        expect(humanoidSlotOf('Neck')).toBe('neck');
        expect(humanoidSlotOf('Head')).toBe('head');
    });

    it('does not confuse forearm with upper arm', () => {
        expect(humanoidSlotOf('LeftArm')).toBe('upperArm.L');
        expect(humanoidSlotOf('LeftForeArm')).toBe('foreArm.L');
        expect(humanoidSlotOf('LeftForeArm')).not.toBe('upperArm.L');
    });

    it('distinguishes thigh from shin', () => {
        expect(humanoidSlotOf('LeftUpLeg')).toBe('upLeg.L');
        expect(humanoidSlotOf('LeftLeg')).toBe('leg.L');
        expect(humanoidSlotOf('thigh.R')).toBe('upLeg.R');
        expect(humanoidSlotOf('shin.R')).toBe('leg.R');
    });

    it('maps fingers with their joint number', () => {
        expect(humanoidSlotOf('LeftHandIndex1')).toBe('index1.L');
        expect(humanoidSlotOf('RightHandThumb3')).toBe('thumb3.R');
        expect(humanoidSlotOf('pinky2.L')).toBe('pinky2.L');
    });

    // A wrong slot drives the wrong joint, which is worse than leaving it for the manual mapping UI.
    it('returns null for an unrecognized bone rather than guessing', () => {
        expect(humanoidSlotOf('WeaponSocket')).toBeNull();
        expect(humanoidSlotOf('IK_Target_L')).toBeNull();
        expect(humanoidSlotOf('twist_01')).toBeNull();
    });

    it('does not read a side token out of a centre bone name', () => {
        // 'head' must stay 'head', not lose an 'l'/'r' and miss. (Guards the centre-first ordering.)
        expect(humanoidSlotOf('Head')).toBe('head');
    });
});

/**
 * A single-letter side marker is ambiguous with the first letter of the bone's own name, and the split used
 * to commit to the leading reading. That silently dropped an entire naming convention: `leg.L` starts with
 * `l`, so the core became `egl`, matched nothing, and returned null — in the function whose job is
 * recognizing legs. Blender's `leg.L` and Unreal's `calf_l` are the two most common leg names there are.
 */
describe('humanoidSlotOf — ambiguous single-letter side markers', () => {
    it('reads a trailing side marker even when the bone name starts with l or r', () => {
        expect(humanoidSlotOf('leg.L')).toBe('leg.L');
        expect(humanoidSlotOf('leg.R')).toBe('leg.R');
        expect(humanoidSlotOf('Leg_L')).toBe('leg.L');
        expect(humanoidSlotOf('lowerleg.L')).toBe('leg.L');
        expect(humanoidSlotOf('lowerleg.R')).toBe('leg.R');
        expect(humanoidSlotOf('leglower.L')).toBe('leg.L');
        expect(humanoidSlotOf('legupper.L')).toBe('upLeg.L');
        expect(humanoidSlotOf('lowerarm.L')).toBe('foreArm.L');
        expect(humanoidSlotOf('ring1.R')).toBe('ring1.R');
        expect(humanoidSlotOf('little1.L')).toBe('pinky1.L');
    });

    // The other reading has to keep working: these are only correct as a LEADING marker.
    it('still reads a leading side marker', () => {
        expect(humanoidSlotOf('lThigh')).toBe('upLeg.L');
        expect(humanoidSlotOf('rShin')).toBe('leg.R');
        expect(humanoidSlotOf('l_foot')).toBe('foot.L');
        expect(humanoidSlotOf('LeftLeg')).toBe('leg.L');
        expect(humanoidSlotOf('RightUpLeg')).toBe('upLeg.R');
    });

    /**
     * The regression table. This function is shared with retargeting, where a changed answer silently
     * re-pairs bones between two skeletons — so every naming convention the codebase claims to support is
     * pinned here rather than only the ones this change touched.
     */
    it('leaves every previously-recognized name on the same slot', () => {
        const table: [string, string | null][] = [
            // Mixamo
            ['mixamorig:Hips', 'hips'], ['mixamorig:LeftUpLeg', 'upLeg.L'], ['mixamorig:LeftLeg', 'leg.L'],
            ['mixamorig:LeftFoot', 'foot.L'], ['mixamorig:LeftToeBase', 'toe.L'],
            ['mixamorig:RightForeArm', 'foreArm.R'], ['mixamorig:Spine', 'spine'],
            // Unreal
            ['pelvis', 'hips'], ['thigh_l', 'upLeg.L'], ['calf_l', 'leg.L'], ['foot_l', 'foot.L'],
            ['ball_r', 'toe.R'], ['upperarm_r', 'upperArm.R'],
            // Rigify (deform tier)
            ['DEF-thigh.L', 'upLeg.L'], ['DEF-shin.L', 'leg.L'], ['DEF-foot.L', 'foot.L'], ['DEF-toe.L', 'toe.L'],
            // 3ds Max Biped
            ['Bip01 L Thigh', 'upLeg.L'], ['Bip01 L Calf', 'leg.L'], ['Bip01 L Foot', 'foot.L'],
            // Centre bones, which must never lose a letter to the side split
            ['Head', 'head'], ['Neck', 'neck'], ['chest', 'chest'], ['Root', 'hips'], ['COG', 'hips'],
            // Still-unrecognized: a wrong slot drives the wrong joint, so these must stay null
            ['WeaponSocket', null], ['IK_Target_L', null], ['twist_01', null], ['thigh_twist.L', null],
            ['foot_ik.L', null], ['LeftLegRoll', null], ['Armature', null], ['toes.L', null],
        ];
        for (const [name, slot] of table) expect([name, humanoidSlotOf(name)]).toEqual([name, slot]);
    });
});


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

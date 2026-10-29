import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { buildBoneMapping, retargetAnimation } from '../src/animation/animationRetarget';
import type { Animation, Skin } from '../src/animation/animatedModel';
import { normalizeBoneName, humanoidSlotOf } from '../src/animation/boneNames';
import { Sprite } from '../src/graphics/sprite';
import { packEmitter } from '../src/particles/particlePack';
import { defaultRenderSettings, moduleDefinition } from '../src/particles/particleModules';

// The pieces the Valley's knight and its effects lean on: Sketchfab's numbered bone names matching a
// Mixamo rig, a sprite's soft fade surviving a save, and a circle emitter's orbit reaching the shader.

describe('numbered bone names', () => {
    it('strip a Sketchfab node number under a namespace', () => {
        expect(normalizeBoneName('mixamorig:Hips_01')).toBe(normalizeBoneName('mixamorig1:Hips'));
        expect(normalizeBoneName('mixamorig:LeftHandRing3_00')).toBe('lefthandring3');
        expect(normalizeBoneName('mixamorig:Spine2_04')).toBe('spine2');
    });

    it('keep a bare numbered name, which is the bone itself (Unreal spine_01..03)', () => {
        expect(normalizeBoneName('spine_01')).not.toBe(normalizeBoneName('spine_02'));
    });

    it('read the numbered hands and hips as humanoid slots', () => {
        expect(humanoidSlotOf('mixamorig:RightHand_030')).toBe('hand.R');
        expect(humanoidSlotOf('mixamorig:LeftHand_011')).toBe('hand.L');
        expect(humanoidSlotOf('mixamorig:Hips_01')).toBe('hips');
    });
});

describe('sprite soft fade', () => {
    it('round-trips, and stays out of a save that does not use it', () => {
        const soft = new Sprite({ softness: 0.25 });
        expect(Sprite.parse(soft.serialize()).softness).toBe(0.25);
        expect('softness' in new Sprite().serialize()).toBe(false);
    });

    it('clamps to non-negative metres', () => {
        const s = new Sprite();
        s.softness = -1;
        expect(s.softness).toBe(0);
        s.softness = Number.NaN;
        expect(s.softness).toBe(0);
    });
});

describe('orbiting circle spawn', () => {
    const emitterWith = (shape: Record<string, unknown>) => ({
        id: 'e', name: 'e', enabled: true, capacity: 16, simSpace: 'world', duration: 1, looping: true,
        prewarm: false, startDelay: 0, seed: 1,
        spawn: [], init: [{ id: 'shape', type: 'shape', enabled: true, params: { ...moduleDefinition('shape')!.defaults(), ...shape } }],
        update: [], render: defaultRenderSettings(),
    }) as any;

    it('packs a circle\'s turns per second into the shape offset\'s w', () => {
        const packed = packEmitter(emitterWith({ shape: 'circle', radius: 0.2, orbit: 8 }));
        expect(packed.sim.u_shapeOffset[3]).toBe(8);
    });

    it('ignores the orbit on any other shape', () => {
        const packed = packEmitter(emitterWith({ shape: 'sphere', orbit: 8 }));
        expect(packed.sim.u_shapeOffset[3]).toBe(0);
    });
});

describe('retarget from a root hips onto a child hips', () => {
    // The mannequin's hips is its ROOT joint, posed under a Z-up armature (the hips' own rest turns it back
    // upright); the knight's is a CHILD of Sketchfab's `_rootJoint`, under a Y-up chain. The two bones'
    // local rests differ by the armature's quarter turn, and comparing them as if their parents agreed laid
    // the knight flat on its back.
    type N = { name: string; parent: number; r?: number[]; t?: number[]; joint?: boolean };
    const skinOfNodes = (nodes: N[]): Skin => {
        const nodeNames = new Map<number, string>(), nodeParents = new Map<number, number>(), nodeTransforms = new Map<number, mat4>();
        const world: mat4[] = [];
        nodes.forEach((n, i) => {
            nodeNames.set(i, n.name);
            if (n.parent >= 0) nodeParents.set(i, n.parent);
            const local = mat4.fromRotationTranslation(mat4.create(), (n.r ?? [0, 0, 0, 1]) as any, (n.t ?? [0, 0, 0]) as any);
            nodeTransforms.set(i, local);
            world[i] = n.parent >= 0 ? mat4.multiply(mat4.create(), world[n.parent], local) : local;
        });
        const joints = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.joint).map(({ n, i }) => ({
            nodeIndex: i, inverseBindMatrix: mat4.invert(mat4.create(), world[i])!, parentIndex: n.parent >= 0 ? n.parent : undefined,
        }));
        return { joints, nodeNames, nodeParents, nodeTransforms } as Skin;
    };
    const qx = (deg: number) => Array.from(quat.setAxisAngle(quat.create(), [1, 0, 0], deg * Math.PI / 180));

    it('keeps the character upright', () => {
        const source = skinOfNodes([
            { name: 'Armature', parent: -1, r: qx(90) },
            { name: 'mixamorig1:Hips', parent: 0, r: qx(-90), t: [0, 0, 100], joint: true },
            { name: 'mixamorig1:Spine', parent: 1, t: [0, 10, 0], joint: true },
        ]);
        const target = skinOfNodes([
            { name: 'Sketchfab_model', parent: -1, r: qx(-90) },
            { name: 'model.fbx', parent: 0, r: qx(90) },
            { name: '_rootJoint', parent: 1, joint: true },
            { name: 'mixamorig:Hips_01', parent: 2, t: [0, 160, 0], joint: true },
            { name: 'mixamorig:Spine_02', parent: 3, t: [0, 12, 0], joint: true },
        ]);
        // The source standing at rest.
        const clip: Animation = {
            name: 'Idle', samplers: [{ input: [0], output: qx(-90), interpolation: 'LINEAR' }],
            channels: [{ samplerIndex: 0, targetNodeIndex: 1, targetPath: 'rotation' }],
        };
        const mapping = buildBoneMapping([clip], source, target);
        const out = retargetAnimation(clip, source, target, mapping);
        const ch = out.channels.find(c => c.targetNodeIndex === 3 && c.targetPath === 'rotation')!;
        const q = out.samplers[ch.samplerIndex].output;
        // The knight's hips at ITS rest: no rotation.
        expect(Math.abs(q[3])).toBeGreaterThan(0.999);
    });
});

describe('retarget between bind poses', () => {
    // The mannequin was bound in a T-pose, the knight in an A-pose (arms 45° down), with the same bone
    // axes. A clip that lowers the arm 90° from T must leave the target's arm hanging straight down — not
    // lowered 90° from the A-pose as well, 135° in all, into the chest.
    const qz = (deg: number) => quat.setAxisAngle(quat.create(), [0, 0, 1], deg * Math.PI / 180);
    const skin = (armRest: quat): Skin => {
        const bones = [
            { name: 'mixamorig:Hips', parent: -1, r: quat.create(), t: [0, 1, 0] },
            { name: 'mixamorig:LeftArm', parent: 0, r: armRest, t: [0.2, 0.4, 0] },
            { name: 'mixamorig:LeftForeArm', parent: 1, r: quat.create(), t: [0.3, 0, 0] },
        ];
        const nodeNames = new Map<number, string>(), nodeParents = new Map<number, number>(), nodeTransforms = new Map<number, mat4>();
        const world: mat4[] = [];
        bones.forEach((b, i) => {
            nodeNames.set(i, b.name);
            if (b.parent >= 0) nodeParents.set(i, b.parent);
            const l = mat4.fromRotationTranslation(mat4.create(), b.r, b.t as any);
            nodeTransforms.set(i, l);
            world[i] = b.parent >= 0 ? mat4.multiply(mat4.create(), world[b.parent], l) : l;
        });
        const joints = bones.map((b, i) => ({ nodeIndex: i, inverseBindMatrix: mat4.invert(mat4.create(), world[i])!, parentIndex: b.parent >= 0 ? b.parent : undefined }));
        return { joints, nodeNames, nodeParents, nodeTransforms } as Skin;
    };

    it('reproduces the source arm\'s direction, not its offset from bind', () => {
        const source = skin(quat.create());     // T: the arm along +X
        const target = skin(qz(-45));           // A: 45° down
        const clip: Animation = {
            name: 'Idle',
            samplers: [{ input: [0], output: Array.from(qz(-90)), interpolation: 'LINEAR' }, { input: [0], output: [0, 0, 0, 1], interpolation: 'LINEAR' }],
            channels: [{ samplerIndex: 0, targetNodeIndex: 1, targetPath: 'rotation' }, { samplerIndex: 1, targetNodeIndex: 2, targetPath: 'rotation' }],
        };
        const out = retargetAnimation(clip, source, target, buildBoneMapping([clip], source, target));
        const ch = out.channels.find(c => c.targetNodeIndex === 1 && c.targetPath === 'rotation')!;
        const o = out.samplers[ch.samplerIndex].output;
        const dir = vec3.transformQuat(vec3.create(), [1, 0, 0], quat.fromValues(o[0], o[1], o[2], o[3]));
        expect(dir[1]).toBeLessThan(-0.99);   // straight down
    });

    it('leaves rigs bound in the same pose as they were', () => {
        const source = skin(qz(-45)), target = skin(qz(-45));
        const clip: Animation = {
            name: 'Idle', samplers: [{ input: [0], output: Array.from(qz(-70)), interpolation: 'LINEAR' }],
            channels: [{ samplerIndex: 0, targetNodeIndex: 1, targetPath: 'rotation' }],
        };
        const out = retargetAnimation(clip, source, target, buildBoneMapping([clip], source, target));
        const o = out.samplers[out.channels.find(c => c.targetNodeIndex === 1)!.samplerIndex].output;
        expect(Math.abs(quat.dot(quat.fromValues(o[0], o[1], o[2], o[3]), qz(-70)))).toBeGreaterThan(0.9999);
    });
});

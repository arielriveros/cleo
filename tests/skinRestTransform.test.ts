import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { skinRestTransform } from '../src/core/scene/nodes/modelNode';
import type { Skin } from '../src/animation/animatedModel';

// A skinned mesh is culled by its raw vertex bounds. When the skin draws those vertices somewhere else --
// a Sketchfab glTF of an FBX keeps centimetre vertices under a 0.01 armature node -- the bounds must be
// carried there first, or parts of the character are culled from where they are not.

const skinOf = (armature: mat4, jointLocal: mat4, inverseBind: mat4): Skin => ({
  joints: [{ nodeIndex: 1, inverseBindMatrix: inverseBind }],
  nodeParents: new Map([[1, 0]]),
  nodeTransforms: new Map([[0, armature], [1, jointLocal]]),
});

describe('skinRestTransform', () => {
  it('is null when the skin draws its vertices where they are', () => {
    const local = mat4.fromTranslation(mat4.create(), [0, 1, 0]);
    expect(skinRestTransform(skinOf(mat4.create(), local, mat4.invert(mat4.create(), local)))).toBeNull();
  });

  it('carries centimetre vertices under a 0.01 armature into metres', () => {
    // The hips 100 cm up in the mesh's units; the armature scales the skeleton to metres.
    const armature = mat4.fromScaling(mat4.create(), [0.01, 0.01, 0.01]);
    const local = mat4.fromTranslation(mat4.create(), [0, 100, 0]);
    const m = skinRestTransform(skinOf(armature, local, mat4.invert(mat4.create(), local)))!;
    expect(m).not.toBeNull();
    expect(m[0]).toBeCloseTo(0.01);
    expect(m[5]).toBeCloseTo(0.01);
    expect(m[13]).toBeCloseTo(0);
  });

  it('is null for a skin with no joints', () => {
    expect(skinRestTransform({ joints: [] })).toBeNull();
  });
});

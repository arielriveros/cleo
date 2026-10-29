import { describe, it, expect } from 'vitest';
import {
    skinnedModelJsonOf, uniqueClipName, assetClipNames,
    assetWithClipAdded, assetWithClipRenamed, assetWithClipRemoved, assetWithClipRootMotion, assetWithBoneNames,
    assetWithIkRig, assetIkRig, flattenModelJson,
} from '../src/utils/modelClips';

// Patching a model asset's serialized clip list. This is the half of "clips belong to the asset" that has
// to agree, byte for byte, with what AnimatedModel would have written itself — the live model and the asset
// are mutated in parallel, and any disagreement shows up as a clip that reappears, vanishes, or acquires a
// second name after a save/load round trip.

/** An imported model's shape: a plain holder root with the skinned ModelNode as a CHILD. */
const asset = (clips: string[] | null, nodeNames?: [number, string][]) => ({
    id: 'm1',
    name: 'Rogue',
    nodeJson: {
        id: 'holder', name: 'Rogue', type: 'node',
        children: [{
            id: 'mesh', name: 'Rogue_Mesh', type: 'model',
            model: {
                geometry: {},
                skin: { joints: [], ...(nodeNames ? { nodeNames } : {}) },
                animations: clips ? clips.map(name => ({ name, samplers: [], channels: [] })) : null,
            },
        }],
    },
});

describe('skinnedModelJsonOf', () => {
    // The whole reason this walks: __modelId is stamped on the holder, but the skin is on a child.
    it('finds the skinned model on a child, not the holder root', () => {
        const found = skinnedModelJsonOf(asset(['idle']).nodeJson);
        expect(found).not.toBeNull();
        expect(found.skin).toBeDefined();
    });

    it('returns null when nothing in the subtree is skinned', () => {
        expect(skinnedModelJsonOf({ id: 'a', children: [{ id: 'b', model: { geometry: {} } }] })).toBeNull();
        expect(skinnedModelJsonOf(null)).toBeNull();
        expect(skinnedModelJsonOf(undefined)).toBeNull();
    });

    it('finds one nested several levels down', () => {
        const deep = { children: [{ children: [{ model: { skin: { joints: [] } } }] }] };
        expect(skinnedModelJsonOf(deep)).not.toBeNull();
    });
});

describe('uniqueClipName', () => {
    // Must match AnimatedModel.addAnimation's suffixing exactly, or the live model and the asset end up
    // holding the same clip under two different names.
    it('suffixes " (2)", " (3)", … only on collision', () => {
        expect(uniqueClipName('run', new Set())).toBe('run');
        expect(uniqueClipName('run', new Set(['run']))).toBe('run (2)');
        expect(uniqueClipName('run', new Set(['run', 'run (2)']))).toBe('run (3)');
        expect(uniqueClipName('run', new Set(['walk']))).toBe('run');
    });

    it('falls back to "clip" for an empty name', () => {
        expect(uniqueClipName('', new Set())).toBe('clip');
    });
});

describe('assetWithClipAdded', () => {
    it('appends the clip', () => {
        expect(assetClipNames(assetWithClipAdded(asset(['idle']), { name: 'run' }))).toEqual(['idle', 'run']);
    });

    it('de-dupes a colliding name', () => {
        expect(assetClipNames(assetWithClipAdded(asset(['run']), { name: 'run' }))).toEqual(['run', 'run (2)']);
    });

    it('works from an empty (null) clip list', () => {
        expect(assetClipNames(assetWithClipAdded(asset(null), { name: 'idle' }))).toEqual(['idle']);
    });

    // The libraries are React state; mutating an asset in place would edit the previous render's value.
    it('never mutates the input', () => {
        const original = asset(['idle']);
        const before = JSON.stringify(original);
        assetWithClipAdded(original, { name: 'run' });
        expect(JSON.stringify(original)).toBe(before);
    });

    it('leaves an asset with no skinned model untouched', () => {
        const flat = { id: 'x', name: 'Rock', nodeJson: { id: 'r', model: { geometry: {} } } };
        expect(assetWithClipAdded(flat, { name: 'run' })).toBe(flat); // same reference — nothing to patch
    });
});

describe('assetWithClipRenamed', () => {
    it('renames in place, keeping order', () => {
        expect(assetClipNames(assetWithClipRenamed(asset(['idle', 'run']), 'idle', 'stand')))
            .toEqual(['stand', 'run']);
    });

    it('de-dupes against the other clips', () => {
        expect(assetClipNames(assetWithClipRenamed(asset(['idle', 'run']), 'idle', 'run')))
            .toEqual(['run (2)', 'run']);
    });

    it('is a no-op for a name that is not there', () => {
        const a = asset(['idle']);
        expect(assetWithClipRenamed(a, 'nope', 'x')).toBe(a);
    });

    it('keeps the old name when the new one is blank', () => {
        expect(assetClipNames(assetWithClipRenamed(asset(['idle']), 'idle', '   '))).toEqual(['idle']);
    });

    it('renaming to itself is not treated as a collision', () => {
        expect(assetClipNames(assetWithClipRenamed(asset(['idle']), 'idle', 'idle'))).toEqual(['idle']);
    });
});

describe('assetWithClipRemoved', () => {
    it('drops the clip', () => {
        expect(assetClipNames(assetWithClipRemoved(asset(['idle', 'run']), 'idle'))).toEqual(['run']);
    });

    // AnimatedModel.serialize writes null, not [], for an empty list — a round trip has to produce the same
    // JSON the engine would have.
    it('writes null rather than [] when the last clip goes', () => {
        const emptied = assetWithClipRemoved(asset(['idle']), 'idle');
        expect(skinnedModelJsonOf(emptied.nodeJson).animations).toBeNull();
        expect(assetClipNames(emptied)).toEqual([]);
    });

    it('never mutates the input', () => {
        const original = asset(['idle', 'run']);
        const before = JSON.stringify(original);
        assetWithClipRemoved(original, 'idle');
        expect(JSON.stringify(original)).toBe(before);
    });
});

describe('assetWithBoneNames', () => {
    // Serialized as entry PAIRS, not a Map — a Map does not survive JSON, and AnimatedModel.parse reads
    // pairs back.
    it('writes entry pairs onto the serialized skin', () => {
        const patched = assetWithBoneNames(asset(['idle']), new Map([[0, 'Hips'], [1, 'Spine']]));
        expect(skinnedModelJsonOf(patched.nodeJson).skin.nodeNames).toEqual([[0, 'Hips'], [1, 'Spine']]);
    });

    it('merges with names already present rather than replacing them', () => {
        const patched = assetWithBoneNames(asset(['idle'], [[0, 'Hips']]), new Map([[1, 'Spine']]));
        expect(skinnedModelJsonOf(patched.nodeJson).skin.nodeNames).toEqual([[0, 'Hips'], [1, 'Spine']]);
    });

    it('overwrites a name for an index it already had', () => {
        const patched = assetWithBoneNames(asset(['idle'], [[0, 'Bone_0']]), new Map([[0, 'Hips']]));
        expect(skinnedModelJsonOf(patched.nodeJson).skin.nodeNames).toEqual([[0, 'Hips']]);
    });

    it('leaves an unskinned asset untouched', () => {
        const flat = { id: 'x', name: 'Rock', nodeJson: { id: 'r', model: { geometry: {} } } };
        expect(assetWithBoneNames(flat, new Map([[0, 'Hips']]))).toBe(flat);
    });
});

describe('assetClipNames', () => {
    it('handles a null clip list and a missing asset', () => {
        expect(assetClipNames(asset(null))).toEqual([]);
        expect(assetClipNames(undefined)).toEqual([]);
    });
});

describe('assetWithClipRootMotion', () => {
    const rootMotionOf = (a: any, name: string) =>
        skinnedModelJsonOf(a.nodeJson).animations.find((c: any) => c.name === name)?.rootMotion;

    it('sets the flag on the named clip only', () => {
        const patched = assetWithClipRootMotion(asset(['idle', 'turn']), 'turn', true);
        expect(rootMotionOf(patched, 'turn')).toBe(true);
        expect(rootMotionOf(patched, 'idle')).toBeUndefined();
    });

    it('clears the flag back off', () => {
        const on = assetWithClipRootMotion(asset(['turn']), 'turn', true);
        const off = assetWithClipRootMotion(on, 'turn', false);
        expect(rootMotionOf(off, 'turn')).toBe(false);
    });

    it('is a no-op (same reference) for an unknown name', () => {
        const a = asset(['idle']);
        expect(assetWithClipRootMotion(a, 'nope', true)).toBe(a);
    });

    it('is a no-op when the value already matches', () => {
        const on = assetWithClipRootMotion(asset(['turn']), 'turn', true);
        expect(assetWithClipRootMotion(on, 'turn', true)).toBe(on);
    });

    it('never mutates the input', () => {
        const original = asset(['turn']);
        const before = JSON.stringify(original);
        assetWithClipRootMotion(original, 'turn', true);
        expect(JSON.stringify(original)).toBe(before);
    });
});

// The IK rig is joint indices into ONE skin, so it belongs with the skeleton and travels the same way clips
// do — patch the asset, then propagate to live instances. These cover the asset half.
describe('assetWithIkRig / assetIkRig', () => {
    const rig = { hips: 0, feet: [{ thigh: 1, shin: 2, foot: 3, toe: 4 }], footHeight: 0.12 };

    it('writes the rig into the nested skinned model, not the holder root', () => {
        const next = assetWithIkRig(asset(['idle']), rig);
        expect(skinnedModelJsonOf(next.nodeJson).skin.ikRig).toEqual(rig);
        expect((next.nodeJson as any).skin).toBeUndefined();
        expect(assetIkRig(next)).toEqual(rig);
    });

    it('leaves the clips alone', () => {
        const next = assetWithIkRig(asset(['idle', 'walk']), rig);
        expect(assetClipNames(next)).toEqual(['idle', 'walk']);
    });

    it('does not mutate the input — asset libraries are React state', () => {
        const original = asset(['idle']);
        const before = JSON.stringify(original);
        assetWithIkRig(original, rig);
        expect(JSON.stringify(original)).toBe(before);
    });

    /**
     * A new-but-equal object marks the library dirty and triggers a full IndexedDB rewrite for a no-op, so
     * "nothing changed" has to be answerable by identity.
     */
    it('returns the ORIGINAL object when nothing changed', () => {
        const withRig = assetWithIkRig(asset(['idle']), rig);
        expect(assetWithIkRig(withRig, rig)).toBe(withRig);
        // Equal by value but a different object: still a no-op.
        expect(assetWithIkRig(withRig, JSON.parse(JSON.stringify(rig)))).toBe(withRig);

        const plain = asset(['idle']);
        expect(assetWithIkRig(plain, null)).toBe(plain);
    });

    it('clears the rig with null, writing what the engine itself would write', () => {
        const withRig = assetWithIkRig(asset(['idle']), rig);
        const cleared = assetWithIkRig(withRig, null);
        expect(skinnedModelJsonOf(cleared.nodeJson).skin.ikRig).toBeNull();
        expect(assetIkRig(cleared)).toBeNull();
    });

    it('reports null for an asset that has never had one', () => {
        expect(assetIkRig(asset(['idle']))).toBeNull();
        expect(assetIkRig(undefined)).toBeNull();
    });

    it('leaves an asset with no skinned model untouched', () => {
        const unskinned = { id: 'm2', name: 'Crate', nodeJson: { id: 'r', type: 'node', children: [] } };
        expect(assetWithIkRig(unskinned, rig)).toBe(unskinned);
    });
});

describe('flattenModelJson — collapsing the import holder', () => {
  const holder = (over: any = {}, child: any = {}) => ({
    id: 'h', name: 'Character', type: 'node',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [
      { id: 'c', name: 'Ch10_Body', type: 'model', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], model: { skin: {} }, ...child },
    ], ...over,
  });

  it('keeps the ModelNode, its id and its payload, under the asset name', () => {
    const flat = flattenModelJson(holder());
    expect(flat.id).toBe('c');                 // the id anything referencing the model resolves by
    expect(flat.type).toBe('model');
    expect(flat.name).toBe('Character');       // the holder's name is the asset name the user sees
    expect(flat.model).toEqual({ skin: {} });
    expect(flat.children).toEqual([]);
  });

  it('folds the holder scale into the child — the rigged-import case', () => {
    // normalizeRootScale cannot bake a fit-to-size factor into skinned vertices, so it puts the whole
    // factor on the holder. Losing it would show the character at its raw file scale.
    const flat = flattenModelJson(holder({ scale: [0.01, 0.01, 0.01] }, { position: [0, 2, 0], scale: [2, 2, 2] }));
    expect(flat.scale).toEqual([0.02, 0.02, 0.02]);
    expect(flat.position).toEqual([0, 0.02, 0]);   // the child's offset is scaled by the holder too
  });

  it('folds the holder position in', () => {
    const flat = flattenModelJson(holder({ position: [1, 2, 3] }, { position: [0, 1, 0] }));
    expect(flat.position).toEqual([1, 3, 3]);
  });

  it('leaves a MULTI-part model alone — the holder is what groups it', () => {
    const two = holder();
    two.children.push({ ...two.children[0], id: 'c2', name: 'part2' });
    expect(flattenModelJson(two)).toBe(two);
  });

  it('leaves a rotated holder alone rather than guess a decomposition', () => {
    const rotated = holder({ rotation: [0, 90, 0] });
    expect(flattenModelJson(rotated)).toBe(rotated);
  });

  it('is idempotent and returns the SAME object when there is nothing to do', () => {
    const once = flattenModelJson(holder());
    expect(flattenModelJson(once)).toBe(once);          // already a ModelNode root
    const plain = { id: 'x', name: 'n', type: 'node', children: [] };
    expect(flattenModelJson(plain)).toBe(plain);        // no child
  });

  it('does not collapse a holder that carries behaviour of its own', () => {
    const scripted = holder({ script: 'class X {}' });
    expect(flattenModelJson(scripted)).toBe(scripted);
  });

  it('merges holder variables in, letting the child win on a clash', () => {
    const flat = flattenModelJson(
      holder({ variables: { a: { type: 'string', value: '1' }, b: { type: 'string', value: 'h' } } },
             { variables: { b: { type: 'string', value: 'c' } } }));
    expect(flat.variables.a.value).toBe('1');
    expect(flat.variables.b.value).toBe('c');
  });
});

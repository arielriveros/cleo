import { describe, it, expect } from 'vitest';
import {
    skinnedModelJsonOf, uniqueClipName, assetClipNames,
    assetWithClipAdded, assetWithClipRenamed, assetWithClipRemoved, assetWithBoneNames,
} from '../editor/src/utils/modelClips';

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

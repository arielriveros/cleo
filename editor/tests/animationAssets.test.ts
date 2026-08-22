import { describe, it, expect } from 'vitest';
import {
  storeSkin, loadSkin, buildAnimationAsset, clipFingerprint, assetFingerprint,
  findEquivalentAnimation, withAnimationRef, withoutAnimationRef, extractEmbeddedClips,
  type StoredClip,
} from '../src/utils/animationAssets';
import { skinnedModelJsonOf, assetWithoutEmbeddedClips } from '../src/utils/modelClips';

// Animation clips as a SHARED asset: stored once, in the source rig's space, and retargeted per model at
// use. The two things that have to hold for that to be worth anything are (a) the stored skin survives a
// JSON round trip — Maps do not, and losing one silently disables retargeting — and (b) two identical
// clips are recognised as identical even when they were renamed, which is what actually removes the
// duplication.

const clipOf = (name: string, at = 0): StoredClip => ({
  name,
  samplers: [{ input: [0, 1], output: [0, 0, 0, 1, 0, at, 0, 1], interpolation: 'LINEAR' }],
  channels: [{ samplerIndex: 0, targetNodeIndex: 3, targetPath: 'rotation' }],
});

const liveSkin = () => ({
  name: 'rig',
  joints: [
    { nodeIndex: 0, inverseBindMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), parentIndex: undefined },
    { nodeIndex: 1, inverseBindMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2, 0, 1]), parentIndex: 0 },
  ],
  nodeParents: new Map([[1, 0]]),
  nodeTransforms: new Map([[0, new Float32Array(16)], [1, new Float32Array(16)]]),
  nodeNames: new Map([[0, 'Hips'], [1, 'Spine']]),
});

describe('storeSkin / loadSkin — the JSON round trip', () => {
  it('survives JSON.stringify, which a live Skin does not', () => {
    // The whole reason this pair exists: nodeNames/nodeParents/nodeTransforms are Maps, and
    // JSON.stringify turns a Map into {}. A skin that lost them cannot be retargeted at all.
    const live = liveSkin();
    expect(JSON.parse(JSON.stringify(live)).nodeNames).toEqual({});

    const round = JSON.parse(JSON.stringify(storeSkin(live)));
    const back = loadSkin(round, a => Float32Array.from(a));
    expect(back.nodeNames.get(1)).toBe('Spine');
    expect(back.nodeParents.get(1)).toBe(0);
    expect(back.joints).toHaveLength(2);
    expect(Array.from(back.joints[1].inverseBindMatrix)).toEqual(Array.from(live.joints[1].inverseBindMatrix));
  });

  it('writes matrices as plain arrays, not index-keyed objects', () => {
    // A Float32Array stringifies as {"0":1,"1":0,...}, which reads back as garbage.
    const stored = storeSkin(liveSkin())!;
    expect(Array.isArray(stored.joints[0].inverseBindMatrix)).toBe(true);
    expect(JSON.parse(JSON.stringify(stored)).joints[0].inverseBindMatrix).toHaveLength(16);
  });

  it('is null-safe at both ends', () => {
    expect(storeSkin(null)).toBeNull();
    expect(loadSkin(null, a => a)).toBeNull();
  });
});

describe('clip fingerprints — what makes two clips "the same walk"', () => {
  it('ignores the NAME, which is the whole point', () => {
    // The same Mixamo download is called "mixamo.com" in one import and "Walk" in the next. Those are
    // exactly the copies worth collapsing, so matching on name would find nothing.
    expect(clipFingerprint(clipOf('mixamo.com'))).toBe(clipFingerprint(clipOf('Walk')));
  });

  it('separates clips whose keyframes differ', () => {
    expect(clipFingerprint(clipOf('a', 0))).not.toBe(clipFingerprint(clipOf('a', 0.5)));
  });

  it('ignores channel ORDER, which two exporters can disagree on', () => {
    const a = clipOf('a');
    const b: StoredClip = {
      ...a,
      samplers: [a.samplers[0], { input: [0], output: [1, 1, 1], interpolation: 'LINEAR' }],
      channels: [{ samplerIndex: 1, targetNodeIndex: 4, targetPath: 'scale' }, a.channels[0]],
    };
    const c: StoredClip = { ...b, channels: [b.channels[1], b.channels[0]] };
    expect(clipFingerprint(b)).toBe(clipFingerprint(c));
  });

  it('finds an equivalent asset regardless of clip order', () => {
    const asset = buildAnimationAsset('walk', [clipOf('a', 1), clipOf('b', 2)], null);
    expect(findEquivalentAnimation([asset], [clipOf('x', 2), clipOf('y', 1)])).toBe(asset);
    expect(findEquivalentAnimation([asset], [clipOf('x', 3)])).toBeUndefined();
  });
});

describe('animation references on a model asset', () => {
  it('adds, is idempotent, and removes', () => {
    const m = { id: 'm' };
    const one = withAnimationRef(m, 'a');
    expect(one.animationIds).toEqual(['a']);
    expect(withAnimationRef(one, 'a')).toBe(one);         // same object: no pointless library write
    expect(withAnimationRef(one, 'b').animationIds).toEqual(['a', 'b']);
    expect(withoutAnimationRef(one, 'a').animationIds).toEqual([]);
    expect(withoutAnimationRef(one, 'zzz')).toBe(one);
  });
});

describe('extractEmbeddedClips — the one-shot migration', () => {
  const modelWith = (id: string, clips: StoredClip[]) => ({
    id, name: id,
    nodeJson: {
      id: `${id}-root`, name: id, type: 'model', children: [],
      model: { skin: { joints: [], nodeNames: [[0, 'Hips']] }, animations: clips },
    },
  });

  it('collapses the same clip on two characters onto ONE asset', () => {
    // The duplication this whole asset type exists to remove.
    const models = [modelWith('a', [clipOf('mixamo.com', 1)]), modelWith('b', [clipOf('Walk', 1)])];
    const r = extractEmbeddedClips(models, [], skinnedModelJsonOf, assetWithoutEmbeddedClips);
    expect(r.animations).toHaveLength(1);
    expect(r.extracted).toBe(1);
    expect(r.shared).toBe(1);
    expect(r.models[0].animationIds).toEqual(r.models[1].animationIds);
  });

  it('keeps clip NAMES, so state machines and field samples still resolve', () => {
    // Both reference clips by name and neither is rewritten by this migration.
    const r = extractEmbeddedClips([modelWith('a', [clipOf('Run', 2)])], [], skinnedModelJsonOf, assetWithoutEmbeddedClips);
    expect(r.animations[0].clips[0].name).toBe('Run');
    expect(r.animations[0].name).toBe('Run');
  });

  it('strips the clips out of the model and leaves a reference behind', () => {
    const r = extractEmbeddedClips([modelWith('a', [clipOf('Run', 2)])], [], skinnedModelJsonOf, assetWithoutEmbeddedClips);
    expect(skinnedModelJsonOf(r.models[0].nodeJson).animations).toBeNull();
    expect(r.models[0].animationIds).toEqual([r.animations[0].id]);
  });

  it('records the MODEL\'S OWN skin, so re-resolving onto it cannot move anything', () => {
    const r = extractEmbeddedClips([modelWith('a', [clipOf('Run', 2)])], [], skinnedModelJsonOf, assetWithoutEmbeddedClips);
    expect(r.animations[0].sourceSkin?.nodeNames).toEqual([[0, 'Hips']]);
  });

  it('leaves a model with no clips completely untouched', () => {
    const bare = modelWith('a', []);
    const r = extractEmbeddedClips([bare], [], skinnedModelJsonOf, assetWithoutEmbeddedClips);
    expect(r.models[0]).toBe(bare);
    expect(r.animations).toEqual([]);
  });

  it('leaves a STATIC model untouched — no skin, nothing to retarget against', () => {
    const staticModel = { id: 's', name: 's', nodeJson: { id: 'r', type: 'model', children: [], model: {} } };
    const r = extractEmbeddedClips([staticModel], [], skinnedModelJsonOf, assetWithoutEmbeddedClips);
    expect(r.models[0]).toBe(staticModel);
  });

  it('links to an already-extracted asset rather than storing a second copy', () => {
    const existing = buildAnimationAsset('Walk', [clipOf('Walk', 1)], null);
    const r = extractEmbeddedClips([modelWith('a', [clipOf('renamed', 1)])], [existing], skinnedModelJsonOf, assetWithoutEmbeddedClips);
    expect(r.animations).toHaveLength(1);
    expect(r.extracted).toBe(0);
    expect(r.models[0].animationIds).toEqual([existing.id]);
  });

  it('is a no-op on a second run — the ids are already there and the clips are gone', () => {
    const first = extractEmbeddedClips([modelWith('a', [clipOf('Run', 2)])], [], skinnedModelJsonOf, assetWithoutEmbeddedClips);
    const second = extractEmbeddedClips(first.models, first.animations, skinnedModelJsonOf, assetWithoutEmbeddedClips);
    expect(second.extracted).toBe(0);
    expect(second.shared).toBe(0);
    expect(second.animations).toHaveLength(1);
  });
});

describe('assetFingerprint', () => {
  it('treats clips as a set', () => {
    expect(assetFingerprint({ clips: [clipOf('a', 1), clipOf('b', 2)] }))
      .toBe(assetFingerprint({ clips: [clipOf('b', 2), clipOf('a', 1)] }));
  });
});

import { describe, it, expect } from 'vitest';
import { hashAsset, hashesComparable, ASSET_HASH_VERSION } from '../editor/src/utils/assetHash';

// The asset hash decides whether opening a scene RE-INSTANTIATES its placed instances. That rebuild comes
// from the asset, which knows nothing about how a placement was configured — so a hash that changes when it
// need not is not a wasted cycle, it is data loss. These tests pin both directions: what must never trigger a
// rebuild, and what must always still trigger one.

/** An imported character: holder root, skinned ModelNode child, the shape the real assets have. */
const asset = (over: { ikRig?: any; nodeNames?: any; positions?: number[]; name?: string; matId?: string } = {}) => ({
    id: 'm1',
    name: over.name ?? 'Rogue',
    thumbnail: 'data:image/png;base64,AAAA',
    nodeJson: {
        id: 'holder', name: 'Rogue', type: 'node',
        children: [{
            id: 'mesh', name: 'Rogue_Mesh', type: 'model',
            variables: over.matId ? { __materialId: { type: 'string', value: over.matId } } : {},
            model: {
                geometry: { positions: over.positions ?? [0, 0, 0, 1, 1, 1] },
                skin: {
                    joints: [{ nodeIndex: 0 }, { nodeIndex: 1 }],
                    ...(over.nodeNames ? { nodeNames: over.nodeNames } : {}),
                    ...(over.ikRig !== undefined ? { ikRig: over.ikRig } : {}),
                },
                animations: [{ name: 'idle' }],
            },
        }],
    },
});

const RIG = { hips: 0, feet: [{ thigh: 1, shin: 2, foot: 3 }] };

describe('hashAsset — what must NOT count as a change', () => {
    it('ignores the thumbnail', () => {
        const a = asset();
        const b = { ...asset(), thumbnail: 'data:image/png;base64,ZZZZ' };
        expect(hashAsset(b)).toBe(hashAsset(a));
    });

    /**
     * The regression this exists for. Assigning an IK rig used to change the hash, which made every scene
     * rebuild its placed characters from the asset on open — and the asset carries no state machine, so every
     * character silently lost its animation setup.
     */
    it('ignores skin.ikRig', () => {
        expect(hashAsset(asset({ ikRig: RIG }))).toBe(hashAsset(asset()));
        expect(hashAsset(asset({ ikRig: RIG }))).toBe(hashAsset(asset({ ikRig: null })));
        expect(hashAsset(asset({ ikRig: { ...RIG, footHeight: 0.3 } }))).toBe(hashAsset(asset({ ikRig: RIG })));
    });

    // Same class: bone names are backfilled onto the asset by the skeleton importer and propagated to live
    // instances in place. Rebuilding for them carried the identical hazard.
    it('ignores skin.nodeNames', () => {
        expect(hashAsset(asset({ nodeNames: [[0, 'Hips'], [1, 'Spine']] }))).toBe(hashAsset(asset()));
    });
});

describe('hashAsset — what must STILL count as a change', () => {
    // If any of these stopped changing the hash, edits would silently fail to reach closed scenes, which is
    // the opposite failure and just as bad.
    it('sees geometry', () => {
        expect(hashAsset(asset({ positions: [9, 9, 9] }))).not.toBe(hashAsset(asset()));
    });

    it('sees a material relink', () => {
        expect(hashAsset(asset({ matId: 'mat-2' }))).not.toBe(hashAsset(asset({ matId: 'mat-1' })));
    });

    it('sees a rename', () => {
        expect(hashAsset(asset({ name: 'Rogue 2' }))).not.toBe(hashAsset(asset()));
    });

    it('sees the clip list', () => {
        const a = asset();
        const b = asset();
        b.nodeJson.children[0].model.animations = [{ name: 'idle' }, { name: 'walk' }];
        expect(hashAsset(b)).not.toBe(hashAsset(a));
    });

    it('sees the node hierarchy', () => {
        const a = asset();
        const b = asset();
        (b.nodeJson.children as any[]).push({ id: 'extra', name: 'Extra', type: 'node', children: [] });
        expect(hashAsset(b)).not.toBe(hashAsset(a));
    });

    it('sees the skin itself', () => {
        const a = asset();
        const b = asset();
        b.nodeJson.children[0].model.skin.joints = [{ nodeIndex: 0 }];
        expect(hashAsset(b)).not.toBe(hashAsset(a));
    });
});

/**
 * Changing what hashAsset hashes is a FORMAT BREAK, and treating it as anything less detonates the project.
 * Every scene already on disk stores hashes from the old function, so on the first load afterwards every
 * lookup misses, every asset reads as changed, and every placed template and character in every scene is
 * rebuilt at once — each one losing the per-placement state its asset knows nothing about. That is exactly
 * what happened when `ikRig` joined the exclusion set.
 */
describe('hashesComparable — the format-version gate', () => {
    const HASHES = { 'model:m1': 'deadbeef' };

    it('compares hashes written by this version', () => {
        expect(hashesComparable(HASHES, ASSET_HASH_VERSION)).toBe(true);
    });

    it('refuses hashes written by any other version', () => {
        expect(hashesComparable(HASHES, ASSET_HASH_VERSION - 1)).toBe(false);
        expect(hashesComparable(HASHES, ASSET_HASH_VERSION + 1)).toBe(false);
    });

    // Scenes saved before the version field existed were hashed by the original function, so a missing
    // version means 1 — not "trust it".
    it('reads a missing version as 1', () => {
        expect(hashesComparable(HASHES, undefined)).toBe(ASSET_HASH_VERSION === 1);
    });

    /**
     * The one case that is NOT a version problem: no hashes at all is a pre-hashing blob that has never had
     * the propagation applied, and it still means "resync everything". Collapsing it into the mismatch case
     * would leave legacy scenes permanently stale.
     */
    it('lets a scene with no stored hashes through, whatever the version says', () => {
        expect(hashesComparable(undefined, undefined)).toBe(true);
        expect(hashesComparable(undefined, ASSET_HASH_VERSION - 1)).toBe(true);
    });
});

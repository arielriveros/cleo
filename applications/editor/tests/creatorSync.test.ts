import { describe, expect, it } from 'vitest';
import type { CreatorAssetMeta } from '@cleo/app-kit/creatorLibrary';
import { creatorFolder, creatorIds, planCreatorSync, type CreatorLinks } from '../src/features/creator/creatorLinks';
import { isCreatorPath } from '../src/features/creator/creatorPins';
import { reconcileVfs, type LibSnapshot } from '../src/utils/vfs';
import { impostorBillboardOf } from '../src/utils/foliageRules';

// The Creator sync's decisions, without IndexedDB or an engine: which library assets a project must
// rebuild or retire, the ids it derives (stable across reloads and projects), and the explorer's pinning
// of synced assets into /Creator.

const meta = (over: Partial<CreatorAssetMeta> = {}): CreatorAssetMeta => ({
  id: 'foliage_a', kind: 'foliage', name: 'Pine', doc: {}, revision: 3, contentHash: 'h', updatedAt: 0,
  sidecar: null, fileNames: ['pine_LOD0.glb'], privateFileNames: [], ...over,
});
const link = (over: Partial<CreatorLinks[string]> = {}): CreatorLinks[string] => ({
  kind: 'foliage', name: 'Pine', revision: 3, folder: '/Creator/Foliage/Pine', materialIds: [], textureIds: [], ...over,
});

describe('planCreatorSync', () => {
  it('builds what the project lacks or is behind on, and skips what it has', () => {
    const plan = planCreatorSync([
      meta({ id: 'new' }),
      meta({ id: 'behind', revision: 5 }),
      meta({ id: 'current', revision: 3 }),
      meta({ id: 'empty', fileNames: [] }),          // saved, not built yet
    ], { behind: link({ revision: 4 }), current: link({ revision: 3 }) });
    expect(plan.upsert.map(a => a.id)).toEqual(['new', 'behind']);
    expect(plan.retire).toEqual([]);
  });

  it('retires what was deleted or vanished, once', () => {
    const plan = planCreatorSync([meta({ id: 'gone', deleted: true }), meta({ id: 'kept', deleted: true })],
                                 { gone: link(), kept: link({ removed: true }), vanished: link() });
    expect(plan.retire.sort()).toEqual(['gone', 'vanished']);
    expect(plan.upsert).toEqual([]);
  });

  it('rebuilds an asset saved again after a project kept it as removed', () => {
    expect(planCreatorSync([meta({ id: 'back', revision: 9 })], { back: link({ removed: true, revision: 9 }) }).upsert).toHaveLength(1);
  });
});

describe('Creator ids and folders', () => {
  it('derives the same ids every time', () => {
    expect(creatorIds.model('foliage_a')).toBe('cr_foliage_a');
    expect(creatorIds.material('foliage_a', 'Grass card')).toBe('cr_foliage_a_grass_card');
    expect(creatorIds.texture('fx_b', 'fx_flipbook.png')).toBe('cr_fx_b_fx_flipbook');
    expect(creatorFolder('fx', 'Camp/fire')).toBe('/Creator/FX/Camp-fire');
    expect(isCreatorPath('/Creator/FX/x.vfx')).toBe(true);
    expect(isCreatorPath('/Creatures/x.model')).toBe(false);
  });
});

describe('reconcileVfs pinned folders', () => {
  const libs = (over: Partial<LibSnapshot> = {}): LibSnapshot => ({
    materials: [], terrainMaterials: [], templates: [], models: [],
    scripts: [], animationFields: [], animations: [], rigs: [], tilesets: [], aiBrains: [], particleSystems: [], animControllers: [], boneMasks: [], poseAssets: [], scenes: [],
    images: [], textures: [], audioSources: [], soundSamples: [], textureIds: [],
    ...over,
  });
  const pins = new Map([['model:cr_a', '/Creator/Foliage/Pine'], ['image:tex1', '/Creator/Foliage/Pine']]);
  const pinnedFolder = (kind: string, id: string) => pins.get(`${kind}:${id}`);

  it('files a synced asset in its folder rather than the landing folder, and puts it back when moved', () => {
    const models = [{ id: 'cr_a', name: 'Pine' } as any, { id: 'mine', name: 'Rock' } as any];
    const images = [{ id: 'tex1', name: 'Pine Bark.png' } as any];
    const first = reconcileVfs({ version: 1, folders: [], entries: [] }, libs({ models, images }), { landingFolder: '/Props', pinnedFolder });
    const paths = first.next.entries.map(e => e.path).sort();
    expect(paths).toEqual(['/Creator/Foliage/Pine/Pine.model', '/Creator/Foliage/Pine/Source/Pine Bark.png', '/Props/Rock.model']);
    const moved = { ...first.next, entries: first.next.entries.map(e => e.assetId === 'cr_a' ? { ...e, path: '/Props/Pine.model' } : e) };
    const back = reconcileVfs(moved, libs({ models, images }), { pinnedFolder });
    expect(back.changed).toBe(true);
    expect(back.next.entries.find(e => e.assetId === 'cr_a')!.path).toBe('/Creator/Foliage/Pine/Pine.model');
    // An unpinned asset the user moved stays where it was put.
    expect(back.next.entries.find(e => e.assetId === 'mine')!.path).toBe('/Props/Rock.model');
  });
});

describe('impostorBillboardOf', () => {
  it('turns a model\'s own impostor into a foliage billboard', () => {
    expect(impostorBillboardOf({})).toBeNull();
    expect(impostorBillboardOf({ impostor: { distance: 60, textureId: 't', normalId: 'n', octahedral: { frames: 8 }, size: 2048 } }))
      .toEqual({ textureId: 't', distance: 60, octahedral: { frames: 8 }, textures: { normal: 'n' } });
  });
});

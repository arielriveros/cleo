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

describe('Motion Creator clips', () => {
  it('become an .anim asset on the rig their skeleton already is in the project, linked to it, and are replaced in place', async () => {
    const { CreatorSync } = await import('../src/features/creator/creatorSync');
    const skin = { joints: [{ nodeIndex: 1, inverseBindMatrix: Array(16).fill(0) }], nodeNames: [[1, 'mixamorig1:Hips']] };
    const clip = { name: 'x', samplers: [{ input: [0, 1], output: [0, 0, 0, 1, 0, 0, 0, 1], interpolation: 'LINEAR' }],
                   channels: [{ samplerIndex: 0, targetNodeIndex: 1, targetPath: 'rotation' }], events: [{ time: 1, name: 'hit' }] };
    const anim = new Blob([JSON.stringify({ clips: [clip], sourceSkin: skin, rigName: 'Mannequin' })], { type: 'application/json' });
    const animations: any[] = [];
    const links: [string, string][] = [];
    const rig = { id: 'rig_mannequin', name: 'Mannequin' };
    const host: any = {
      animations: () => animations,
      putAnimation: (a: any) => { const i = animations.findIndex(x => x.id === a.id); if (i >= 0) animations[i] = a; else animations.push(a); },
      ensureRig: (s: any, name: string) => { expect(s).toEqual(skin); expect(name).toBe('Mannequin'); return rig; },
      linkAnimationToRig: (r: string, a: string) => links.push([r, a]),
      nameTextures: () => {},
    };
    const sync = new CreatorSync(host) as any;
    const m = meta({ id: 'motion_a', kind: 'motion', name: 'Wave', sidecar: { output: { anim: 'Wave.anim.json', rig: 'Mannequin' } }, fileNames: ['Wave.anim.json'] });
    const link = await sync.upsertMotion(m, [{ name: 'Wave.anim.json', mime: 'application/json', blob: anim }]);
    expect(link).toMatchObject({ kind: 'motion', animationId: 'cr_motion_a', folder: '/Creator/Motion/Wave' });
    expect(animations).toHaveLength(1);
    expect(animations[0]).toMatchObject({ id: 'cr_motion_a', name: 'Wave', rigId: 'rig_mannequin', sourceSkin: skin });
    expect(animations[0].clips[0]).toMatchObject({ name: 'Wave', events: [{ time: 1, name: 'hit' }] });
    expect(links).toEqual([['rig_mannequin', 'cr_motion_a']]);
    // A newer bake replaces the same record.
    await sync.upsertMotion({ ...m, revision: 4 }, [{ name: 'Wave.anim.json', mime: 'application/json', blob: anim }]);
    expect(animations).toHaveLength(1);
  });
});

describe('Creator characters', () => {
  it('become one .anim per kept clip on the skeleton\'s rig and a Pose asset; dropped clips go on the next revision', async () => {
    const { CreatorSync } = await import('../src/features/creator/creatorSync');
    const skin = { joints: [{ nodeIndex: 1, inverseBindMatrix: Array(16).fill(0) }], nodeNames: [[1, 'mixamorig:Hips']] };
    const clip = (name: string) => ({ name, samplers: [{ input: [0, 1], output: [0, 0, 0, 1, 0, 0, 0, 1], interpolation: 'LINEAR' }],
                                     channels: [{ samplerIndex: 0, targetNodeIndex: 1, targetPath: 'rotation' }] });
    const files = (clips: string[]) => [
      { name: 'Hero.anim.json', mime: 'application/json', blob: new Blob([JSON.stringify({ clips: clips.map(clip), sourceSkin: skin, rigName: 'Hero' })]) },
      { name: 'Hero.poses.json', mime: 'application/json', blob: new Blob([JSON.stringify({ name: 'Hero Poses', poses: [{ id: 'p', name: 'Crouch', bones: [{ name: 'mixamorig:Hips', translation: [0, -20, 0] }] }] })]) },
    ];
    const animations: any[] = [], poseAssets: any[] = [], removed: string[] = [], links: [string, string][] = [];
    const rig = { id: 'rig_hero', name: 'Hero' };
    const host: any = {
      animations: () => animations,
      putAnimation: (a: any) => { const i = animations.findIndex(x => x.id === a.id); if (i >= 0) animations[i] = a; else animations.push(a); },
      removeAnimation: (id: string) => { removed.push(id); const i = animations.findIndex(x => x.id === id); if (i >= 0) animations.splice(i, 1); },
      ensureRig: (_s: any, name: string) => { expect(name).toBe('Hero'); return rig; },
      linkAnimationToRig: (r: string, a: string) => links.push([r, a]),
      putPoseAsset: (p: any) => { const i = poseAssets.findIndex(x => x.id === p.id); if (i >= 0) poseAssets[i] = p; else poseAssets.push(p); },
      isUsed: () => false,
      nameTextures: () => {},
    };
    const sync = new CreatorSync(host) as any;
    const m = meta({ id: 'char_a', kind: 'character', name: 'Hero', sidecar: { output: { anim: 'Hero.anim.json', poses: 'Hero.poses.json' } } });
    const link = await sync.upsertCharacter(m, files(['Idle', 'Wave']), undefined);
    expect(link).toMatchObject({ kind: 'character', folder: '/Creator/Characters/Hero', animationIds: ['cr_char_a_idle', 'cr_char_a_wave'], poseAssetId: 'cr_char_a_poses' });
    expect(animations.map(a => [a.id, a.name, a.rigId])).toEqual([['cr_char_a_idle', 'Idle', 'rig_hero'], ['cr_char_a_wave', 'Wave', 'rig_hero']]);
    expect(links).toHaveLength(2);
    expect(poseAssets).toEqual([{ id: 'cr_char_a_poses', name: 'Hero Poses', rigId: 'rig_hero', poses: [{ id: 'p', name: 'Crouch', bones: [{ name: 'mixamorig:Hips', translation: [0, -20, 0] }] }] }]);
    // Wave hidden in the Creator: the next revision drops its .anim.
    await sync.upsertCharacter({ ...m, revision: 4 }, files(['Idle']), link);
    expect(removed).toEqual(['cr_char_a_wave']);
    expect(animations.map(a => a.id)).toEqual(['cr_char_a_idle']);
  });
});

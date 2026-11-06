import { describe, expect, it } from 'vitest';
import type { CreatorAssetMeta } from '@cleo/app-kit/creatorLibrary';
import { creatorFolder, creatorIds, isWorldImportData, keepClipEvents, planCreatorSync, type CreatorLinks } from '../src/features/creator/creatorLinks';
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

// The Creator does not author events: they are placed in the editor, on the clip. A re-sync replaces a
// clip with its new bake and must carry the project's events across.
describe('keepClipEvents', () => {
  const bake = (name: string, events?: { time: number; name: string }[]) => ({ name, samplers: [], ...(events ? { events } : {}) });

  it('keeps each existing clip\'s events by name', () => {
    const out = keepClipEvents([bake('Walk'), bake('Run', [{ time: 9, name: 'old' }])],
                               [bake('Run', [{ time: 0.2, name: 'foot' }]), bake('Walk', [{ time: 0.5, name: 'step' }])]);
    expect(out.map(c => [c.name, c.events])).toEqual([['Walk', [{ time: 0.5, name: 'step' }]], ['Run', [{ time: 0.2, name: 'foot' }]]]);
  });

  it('follows a single clip across a rename (a Motion asset renamed in the Creator)', () => {
    expect(keepClipEvents([bake('Swing B')], [bake('Swing A', [{ time: 0.3, name: 'hit' }])])[0].events).toEqual([{ time: 0.3, name: 'hit' }]);
  });

  it('takes the incoming events only where the project never set any; an emptied list stays empty', () => {
    const incoming = [bake('Idle', [{ time: 1, name: 'blink' }])];
    expect(keepClipEvents(incoming, undefined)[0].events).toEqual([{ time: 1, name: 'blink' }]);
    expect(keepClipEvents(incoming, [bake('Idle')])[0].events).toEqual([{ time: 1, name: 'blink' }]);
    expect(keepClipEvents(incoming, [bake('Idle', [])])[0].events).toEqual([]);
  });

  it('does not share the arrays it copies', () => {
    const prev = [bake('Walk', [{ time: 0.5, name: 'step' }])];
    const out = keepClipEvents([bake('Walk')], prev);
    out[0].events![0].time = 9;
    expect(prev[0].events![0].time).toBe(0.5);
  });
});

describe('a re-sync keeps the events placed in the editor', () => {
  const skin = { joints: [{ nodeIndex: 1, inverseBindMatrix: Array(16).fill(0) }], nodeNames: [[1, 'mixamorig:Hips']] };
  const clipOf = (name: string, events?: { time: number; name: string }[]) => ({
    name, samplers: [{ input: [0, 1], output: [0, 0, 0, 1, 0, 0, 0, 1], interpolation: 'LINEAR' }],
    channels: [{ samplerIndex: 0, targetNodeIndex: 1, targetPath: 'rotation' }], ...(events ? { events } : {}),
  });
  const json = (name: string, data: unknown) => ({ name, mime: 'application/json', blob: new Blob([JSON.stringify(data)]) });
  const hostWith = (animations: any[]) => ({
    animations: () => animations,
    putAnimation: (a: any) => { const i = animations.findIndex(x => x.id === a.id); if (i >= 0) animations[i] = a; else animations.push(a); },
    removeAnimation: () => {},
    ensureRig: () => ({ id: 'rig_a', name: 'Rig' }),
    linkAnimationToRig: () => {},
    putPoseAsset: () => {},
    removePoseAsset: () => {},
    isUsed: () => false,
    nameTextures: () => {},
  });

  it('a Motion clip: the new bake replaces the curves, the events stay', async () => {
    const { CreatorSync } = await import('../src/features/creator/creatorSync');
    const animations: any[] = [];
    const sync = new CreatorSync(hostWith(animations) as any) as any;
    const m = meta({ id: 'motion_b', kind: 'motion', name: 'Slash', sidecar: { output: { anim: 'Slash.anim.json' } }, fileNames: ['Slash.anim.json'] });
    await sync.upsertMotion(m, [json('Slash.anim.json', { clips: [clipOf('x')], sourceSkin: skin })]);
    // Placed in the editor.
    animations[0] = { ...animations[0], clips: [{ ...animations[0].clips[0], events: [{ time: 0.2, name: 'hit' }, { time: 0.5, name: 'hitEnd' }] }] };
    const rebake = { ...clipOf('x'), samplers: [{ input: [0, 2], output: [0, 0, 0, 1, 0, 0, 0, 1], interpolation: 'LINEAR' }] };
    await sync.upsertMotion({ ...m, revision: 4 }, [json('Slash.anim.json', { clips: [rebake], sourceSkin: skin })]);
    expect(animations[0].clips[0].samplers[0].input).toEqual([0, 2]);
    expect(animations[0].clips[0].events).toEqual([{ time: 0.2, name: 'hit' }, { time: 0.5, name: 'hitEnd' }]);
  });

  it('a Character clip: per clip, by its own .anim', async () => {
    const { CreatorSync } = await import('../src/features/creator/creatorSync');
    const animations: any[] = [];
    const sync = new CreatorSync(hostWith(animations) as any) as any;
    const m = meta({ id: 'char_b', kind: 'character', name: 'Hero', sidecar: { output: { anim: 'Hero.anim.json' } } });
    const files = () => [json('Hero.anim.json', { clips: [clipOf('Idle', [{ time: 1, name: 'blink' }]), clipOf('Walk')], sourceSkin: skin })];
    const link = await sync.upsertCharacter(m, files(), undefined);
    // Imported events pass through on the first sync.
    expect(animations.find(a => a.id === 'cr_char_b_idle').clips[0].events).toEqual([{ time: 1, name: 'blink' }]);
    const walk = animations.find(a => a.id === 'cr_char_b_walk');
    walk.clips = [{ ...walk.clips[0], events: [{ time: 0.4, name: 'foot' }] }];
    await sync.upsertCharacter({ ...m, revision: 4 }, files(), link);
    expect(animations.find(a => a.id === 'cr_char_b_walk').clips[0].events).toEqual([{ time: 0.4, name: 'foot' }]);
    expect(animations.find(a => a.id === 'cr_char_b_idle').clips[0].events).toEqual([{ time: 1, name: 'blink' }]);
  });
});

describe('Creator poses', () => {
  const skin = { joints: [{ nodeIndex: 1, inverseBindMatrix: Array(16).fill(0) }], nodeNames: [[1, 'mixamorig:RightHand']] };
  const poseFile = (name: string, bones: unknown[]) => ({
    name: 'Grip.pose.json', mime: 'application/json',
    blob: new Blob([JSON.stringify({ name, rigName: 'Mannequin', sourceSkin: skin, poses: [{ id: 'local_1', name, bones }] })]),
  });

  it('become one pose asset holding one pose, on the skeleton\'s rig, under ids that survive a re-sync and a rename', async () => {
    const { CreatorSync } = await import('../src/features/creator/creatorSync');
    const poseAssets: any[] = [];
    const host: any = {
      ensureRig: (s: any, name: string) => { expect(s).toEqual(skin); expect(name).toBe('Mannequin'); return { id: 'rig_m', name }; },
      putPoseAsset: (p: any) => { const i = poseAssets.findIndex(x => x.id === p.id); if (i >= 0) poseAssets[i] = p; else poseAssets.push(p); },
      nameTextures: () => {},
    };
    const sync = new CreatorSync(host) as any;
    const m = meta({ id: 'pose_a', kind: 'pose', name: 'Grip', sidecar: { output: { pose: 'Grip.pose.json' } }, fileNames: ['Grip.pose.json'] });
    const bones = [{ name: 'mixamorig:RightHand', rotation: [0, 0, 0.38, 0.92] }];
    const link = await sync.upsertPose(m, [poseFile('Grip', bones)]);
    expect(link).toMatchObject({ kind: 'pose', poseAssetId: 'cr_pose_a', folder: '/Creator/Poses/Grip', materialIds: [], textureIds: [] });
    expect(poseAssets).toEqual([{ id: 'cr_pose_a', name: 'Grip', rigId: 'rig_m', poses: [{ id: 'cr_pose_a_pose', name: 'Grip', bones }] }]);
    // Renamed in the Creator and re-baked: same record, same pose id (an animator state holds both).
    await sync.upsertPose({ ...m, name: 'Fist', revision: 4 }, [poseFile('Fist', bones)]);
    expect(poseAssets).toHaveLength(1);
    expect(poseAssets[0]).toMatchObject({ id: 'cr_pose_a', name: 'Fist', poses: [{ id: 'cr_pose_a_pose', name: 'Fist' }] });
  });

  it('skip an asset with no pose file yet', async () => {
    const { CreatorSync } = await import('../src/features/creator/creatorSync');
    const sync = new CreatorSync({ nameTextures: () => {} } as any) as any;
    expect(await sync.upsertPose(meta({ id: 'p', kind: 'pose', name: 'P' }), [])).toBeNull();
  });

  it('are filed under /Creator/Poses', () => {
    expect(creatorFolder('pose', 'Grip')).toBe('/Creator/Poses/Grip');
    expect(creatorIds.pose('x')).toBe('cr_x');
    expect(creatorIds.poseEntry('x')).toBe('cr_x_pose');
  });

  const retireHost = (used: boolean, removed: string[]) => ({
    isUsed: (kind: string) => used && kind === 'pose',
    removePoseAsset: (id: string) => removed.push(id),
    removeAnimation: () => {}, removeModel: () => {}, removeParticleSystem: () => {}, removeMaterial: () => {},
    texturesChanged: () => {}, nameTextures: () => {}, forgetTextures: () => {},
  });
  const poseLink = link({ kind: 'pose', name: 'Grip', folder: '/Creator/Poses/Grip', poseAssetId: 'cr_pose_a' });

  it('deleted in the Creator: removed when nothing holds them', async () => {
    const { CreatorSync } = await import('../src/features/creator/creatorSync');
    const removed: string[] = [];
    const sync = new CreatorSync(retireHost(false, removed) as any) as any;
    sync.links = { pose_a: poseLink };
    await sync.retire('pose_a', poseLink);
    expect(removed).toEqual(['cr_pose_a']);
    expect(sync.links.pose_a).toBeUndefined();
  });

  it('deleted in the Creator while a state holds one: kept, in /Creator/Removed', async () => {
    const { CreatorSync } = await import('../src/features/creator/creatorSync');
    const removed: string[] = [];
    const sync = new CreatorSync(retireHost(true, removed) as any) as any;
    sync.links = { pose_a: poseLink };
    await sync.retire('pose_a', poseLink);
    expect(removed).toEqual([]);
    expect(sync.links.pose_a).toMatchObject({ removed: true, folder: '/Creator/Removed/Grip', poseAssetId: 'cr_pose_a' });
  });

  it('a Character\'s old pose library goes once a revision stops exporting it, unless a state holds one of its poses', async () => {
    const { CreatorSync } = await import('../src/features/creator/creatorSync');
    const skinC = { joints: [{ nodeIndex: 1, inverseBindMatrix: Array(16).fill(0) }], nodeNames: [[1, 'Hips']] };
    const files = [{ name: 'Hero.anim.json', mime: 'application/json', blob: new Blob([JSON.stringify({ clips: [], sourceSkin: skinC })]) }];
    const m = meta({ id: 'char_c', kind: 'character', name: 'Hero', sidecar: { output: { anim: 'Hero.anim.json' } } });
    const prev = link({ kind: 'character', name: 'Hero', animationIds: [], poseAssetId: 'cr_char_c_poses' });
    for (const used of [false, true]) {
      const removed: string[] = [];
      const sync = new CreatorSync({
        ensureRig: () => ({ id: 'rig_h' }), animations: () => [], isUsed: (kind: string) => used && kind === 'pose',
        removePoseAsset: (id: string) => removed.push(id), nameTextures: () => {},
      } as any) as any;
      const next = await sync.upsertCharacter({ ...m, revision: 5 }, files, prev);
      expect(removed).toEqual(used ? [] : ['cr_char_c_poses']);
      expect(next.poseAssetId).toBe(used ? 'cr_char_c_poses' : undefined);
    }
  });
});

describe('FX Creator liquids', () => {
  it('bring their floor decal as two PBR decal materials over the bake\'s maps: the settled pool, and the animated atlases', async () => {
    const { CreatorSync } = await import('../src/features/creator/creatorSync');
    const materials: any[] = [];
    const host: any = {
      materials: () => materials,
      putMaterial: (m: any) => { const i = materials.findIndex(x => x.id === m.id); if (i >= 0) materials[i] = m; else materials.push(m); },
    };
    const sync = new CreatorSync(host) as any;
    const m = meta({ id: 'fx_blood', kind: 'fx', name: 'Blood' });
    const decal = {
      atlas: { color: 'blood_decal_flipbook.png', normal: 'blood_decal_normal_flipbook.png', orm: 'blood_decal_orm_flipbook.png' },
      still: { color: 'blood_decal.png', normal: 'blood_decal_normal.png', orm: 'blood_decal_orm.png' },
    };
    const ids = sync.putDecalMaterials(m, decal);
    expect(ids).toEqual(['cr_fx_blood_decal', 'cr_fx_blood_decal_anim']);
    expect(materials.map(x => x.name)).toEqual(['Blood Decal', 'Blood Decal (animated)']);
    const still = materials[0].material;
    expect(still.type).toBe('pbr');
    expect(materials[0].textureIds).toEqual(expect.arrayContaining(['cr_fx_blood_blood_decal', 'cr_fx_blood_blood_decal_normal', 'cr_fx_blood_blood_decal_orm']));
    expect(materials[1].textureIds).toContain('cr_fx_blood_blood_decal_flipbook');
    // A re-sync replaces them in place; a gas effect (no decal block) brings none.
    sync.putDecalMaterials(m, decal);
    expect(materials).toHaveLength(2);
    expect(sync.putDecalMaterials(m, undefined)).toEqual([]);
  });

  it('draw their surface maps when the bake made them, lit, and go back to the colour flipbook when it stops', async () => {
    const { CreatorSync } = await import('../src/features/creator/creatorSync');
    let systems: any[] = [];
    const host: any = {
      particleSystems: () => systems,
      commitParticleSystem: (s: any) => { systems = [s]; },
      materials: () => [], putMaterial: () => {}, removeMaterial: () => {},
      isUsed: () => false, texturesChanged: () => {},
    };
    const sync = new CreatorSync(host) as any;
    sync.putTexture = async () => {};
    sync.dropTextures = async () => {};
    sync.publishPins = () => {};
    const png = (name: string) => ({ name, mime: 'image/png', blob: new Blob() });
    const flipbook = { columns: 4, rows: 4, frames: 16, mode: 'life', fps: 30, cycles: 1, randomStart: false, blend: true };
    const surface = { albedo: 'hg_albedo_flipbook.png', normal: 'hg_normal_flipbook.png', orm: 'hg_orm_flipbook.png' };
    const withMaps = meta({ id: 'fx_hg', kind: 'fx', name: 'Mercury', revision: 1,
      sidecar: { output: { medium: 'liquid', particleFlipbook: flipbook, outputs: { surface } } } as any });
    // The surface atlases share the `_flipbook.png` suffix; the colour atlas is still the one drawn without maps.
    const files = [png(surface.albedo), png(surface.normal), png(surface.orm), png('hg_flipbook.png')];
    const first = await sync.upsertFx(withMaps, files, undefined);
    const render = systems[0].system.emitters[0].render;
    expect(render.textureId).toBe(creatorIds.texture('fx_hg', surface.albedo));
    expect(render.normalTextureId).toBe(creatorIds.texture('fx_hg', surface.normal));
    expect(render.ormTextureId).toBe(creatorIds.texture('fx_hg', surface.orm));
    expect([render.lit, render.roughness, render.metallic]).toEqual([true, 1, 1]);

    const plain = meta({ ...withMaps, revision: 2, sidecar: { output: { medium: 'liquid', particleFlipbook: flipbook } } as any });
    await sync.upsertFx(plain, [png('hg_flipbook.png')], first);
    const after = systems[0].system.emitters[0].render;
    expect(after.textureId).toBe(creatorIds.texture('fx_hg', 'flipbook'));
    expect([after.normalTextureId, after.ormTextureId, after.metallic]).toEqual([null, null, 0]);
  });
});

describe('Creator worlds', () => {
  it('register the heightmap and the data masks as textures, but not the splat and weight maps Import world reads', async () => {
    const { CreatorSync } = await import('../src/features/creator/creatorSync');
    const sync = new CreatorSync({ isUsed: () => false, texturesChanged: () => {} } as any) as any;
    const put: string[] = [];
    sync.putTexture = async (_id: string, f: { name: string }) => { put.push(f.name); };
    sync.dropTextures = async () => {};
    sync.publishPins = () => {};
    const png = (name: string) => ({ name, mime: 'image/png', blob: new Blob() });
    const files = ['world_height.png', 'world_slope.png', 'world_splat_0.png', 'world_splat_1.png',
                   'world_weight_00_grass.png', 'world_weight_03_forest-floor.png'].map(png);
    files.push({ name: 'world.json', mime: 'application/json', blob: new Blob() });
    const link = await sync.upsertWorld(meta({ id: 'world_v', kind: 'world', name: 'Valley' }), files, undefined);
    expect(put).toEqual(['world_height.png', 'world_slope.png']);
    expect(link.textureIds).toEqual([creatorIds.texture('world_v', 'world_height.png'), creatorIds.texture('world_v', 'world_slope.png')]);
  });

  it('tell import data from textures by name alone', () => {
    expect(['valley_splat_2.png', 'valley_weight_12_snow.png', 'X_WEIGHT_01_A.PNG'].every(isWorldImportData)).toBe(true);
    // A mask or a heightmap whose world happens to be called "splat" or "weight" is still a texture.
    expect(['splat_height.png', 'weight_slope.png', 'world_wetness.png', 'world_splat.png', 'world_weight_x.png'].some(isWorldImportData)).toBe(false);
  });
});

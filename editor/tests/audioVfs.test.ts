import { describe, it, expect } from 'vitest';
import {
  AUDIO_EXTS, KIND_EXT, SOURCE_FOLDER, EMPTY_VFS, ensureExt, kindOfExt, isRawByteKind, reconcileVfs,
  type LibSnapshot,
} from '../src/utils/vfs';
import { buildAudioSourceAsset } from '../src/utils/audioSources';
import { buildSoundSampleAsset } from '../src/utils/soundSamples';

// Adding a SECOND raw-byte kind is the interesting part of the audio split for the VFS. Before it, the
// rule was simply "everything unknown is an image", and `kindOfExt`'s default arm carried that. A `.wav`
// filed as a picture is the failure this file exists to prevent.

const libs = (over: Partial<LibSnapshot> = {}): LibSnapshot => ({
  materials: [], terrainMaterials: [], templates: [], models: [],
  scripts: [], animationFields: [], animations: [], tilesets: [], scenes: [],
  images: [], textures: [], audioSources: [], soundSamples: [], textureIds: [],
  ...over,
});

const source = (id: string, name: string) => buildAudioSourceAsset({ id, name, mime: 'audio/wav' });
const sample = (id: string, name: string) =>
  buildSoundSampleAsset(id, name, { kind: 'audio', audioId: id });

describe('kindOfExt', () => {
  it('routes every audio extension the importer accepts to audioSource', () => {
    for (const ext of AUDIO_EXTS) expect(kindOfExt(ext)).toBe('audioSource');
  });

  it('is case-insensitive, since an OS filename is not', () => {
    expect(kindOfExt('.WAV')).toBe('audioSource');
    expect(kindOfExt('.Mp3')).toBe('audioSource');
  });

  it('routes the sample extension to soundSample', () => {
    expect(kindOfExt(KIND_EXT.soundSample)).toBe('soundSample');
  });

  it('still falls back to image for anything unknown, and still routes the other kinds', () => {
    expect(kindOfExt('.png')).toBe('image');
    expect(kindOfExt('.whatever')).toBe('image');
    expect(kindOfExt('.tex')).toBe('texture');
    expect(kindOfExt('.mat')).toBe('material');
  });
});

describe('isRawByteKind', () => {
  it('names exactly the two kinds that keep their real file extension', () => {
    expect(isRawByteKind('image')).toBe(true);
    expect(isRawByteKind('audioSource')).toBe(true);
    expect(isRawByteKind('texture')).toBe(false);
    expect(isRawByteKind('soundSample')).toBe(false);
  });
});

describe('ensureExt', () => {
  it('leaves an audio source whatever the user typed — the extension is the real one', () => {
    expect(ensureExt('footstep.wav', 'audioSource')).toBe('footstep.wav');
    expect(ensureExt('footstep.mp3', 'audioSource')).toBe('footstep.mp3');
  });

  it('forces a sample back onto .sound, so renaming can never reclassify it', () => {
    expect(ensureExt('Footstep', 'soundSample')).toBe('Footstep.sound');
    expect(ensureExt('Footstep.wav', 'soundSample')).toBe('Footstep.sound');
  });
});

describe('reconcileVfs — audio', () => {
  it('files a sample flat and its audio source under Source/', () => {
    const { next } = reconcileVfs(EMPTY_VFS, libs({
      audioSources: [source('footstep.wav', 'footstep.wav')],
      soundSamples: [sample('footstep.wav', 'footstep')],
    }), { pruneTextures: true });

    const paths = next.entries.map(e => e.path).sort();
    expect(paths).toEqual([`/${SOURCE_FOLDER}/footstep.wav`, '/footstep.sound']);
  });

  it('keeps a source and a sample of the same id as two separate entries', () => {
    // They share a string on purpose — one id, two namespaces — so the index must not collapse them.
    const { next } = reconcileVfs(EMPTY_VFS, libs({
      audioSources: [source('shared', 'shared.wav')],
      soundSamples: [sample('shared', 'shared')],
    }), { pruneTextures: true });

    expect(next.entries).toHaveLength(2);
    expect(new Set(next.entries.map(e => e.kind))).toEqual(new Set(['audioSource', 'soundSample']));
  });

  it('follows a sample rename but never rewrites an audio source path from its record name', () => {
    const first = reconcileVfs(EMPTY_VFS, libs({
      audioSources: [source('a.wav', 'a.wav')],
      soundSamples: [sample('a.wav', 'Original')],
    }), { pruneTextures: true }).next;

    const renamed = reconcileVfs(first, libs({
      // Both records renamed; only the SAMPLE's path is expected to move. An audio source's name IS the
      // filename its bytes arrived under, so the explorer leaves it where the user put it.
      audioSources: [source('a.wav', 'renamed-file.wav')],
      soundSamples: [sample('a.wav', 'Renamed')],
    }), { pruneTextures: true }).next;

    const byKind = Object.fromEntries(renamed.entries.map(e => [e.kind, e.path]));
    expect(byKind.soundSample).toBe('/Renamed.sound');
    expect(byKind.audioSource).toBe(`/${SOURCE_FOLDER}/a.wav`);
  });

  it('holds both audio kinds until pruneTextures is armed', () => {
    // Both halves are minted by a reconciler reading the AudioManager, so they are only trustworthy once
    // preloadAudio has settled — exactly the gate images and textures sit behind.
    const seeded = reconcileVfs(EMPTY_VFS, libs({
      audioSources: [source('a.wav', 'a.wav')],
      soundSamples: [sample('a.wav', 'A')],
    }), { pruneTextures: true }).next;

    const held = reconcileVfs(seeded, libs(), { prune: true }).next;
    expect(held.entries).toHaveLength(2);

    const pruned = reconcileVfs(seeded, libs(), { pruneTextures: true }).next;
    expect(pruned.entries).toHaveLength(0);
  });

  it('lands audio in the folder the user is browsing, not at the root', () => {
    const { next } = reconcileVfs(EMPTY_VFS, libs({
      audioSources: [source('a.wav', 'a.wav')],
      soundSamples: [sample('a.wav', 'A')],
    }), { pruneTextures: true, landingFolder: '/SFX' });

    const paths = next.entries.map(e => e.path).sort();
    expect(paths).toEqual(['/SFX/A.sound', `/SFX/${SOURCE_FOLDER}/a.wav`]);
  });
});

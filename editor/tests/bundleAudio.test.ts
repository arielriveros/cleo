import { describe, it, expect } from 'vitest';
import { packBundleAssets, inflateBundleAssets } from '../src/utils/bundleAssets';
import { planMerge } from '../src/utils/bundleMerge';
import { BUNDLE_FORMAT_VERSION } from '../src/utils/bundle';
import type { BundleData } from '../src/utils/bundle';
import type { LocalState } from '../src/utils/bundleMerge';
import { buildSoundSampleAsset } from '../src/utils/soundSamples';
import { buildAudioSourceAsset } from '../src/utils/audioSources';
import { defaultEffect } from 'cleo';

/**
 * The audio half of the bundle contract, and the one place the audio split DIVERGES from images/textures.
 *
 * Image and texture RECORDS do not travel in a bundle: the importer re-derives both from the bytes, using
 * the sampler `config` frozen into each stored payload. Nothing equivalent is true of audio — volume,
 * loop points, fades, the bus and the whole effect rack are authored, and a `.wav` says nothing about
 * any of them. So both audio record halves ride in `BundleLibraries`, and this file is what stops that
 * quietly regressing into "every sound resets to defaults on import".
 */

function bytes(n: number, seed = 1): ArrayBuffer {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * seed) % 251;
  return out.buffer;
}

const authoredSample = () => {
  const sample = buildSoundSampleAsset('footstep.wav', 'Footstep', { kind: 'audio', audioId: 'footstep.wav' });
  sample.settings = {
    ...sample.settings,
    volume: 0.42, rate: 1.25, pan: -0.5, loop: true, loopStart: 0.5, loopEnd: 2.25,
    fadeIn: 0.1, fadeOut: 0.3, bus: 'music', preload: false,
    effects: [
      { ...defaultEffect('filter'), frequency: 900, q: 3 },
      { ...defaultEffect('reverb'), mix: 0.7, enabled: false },
      defaultEffect('compressor'),
    ],
  };
  return sample;
};

function bundleWith(over: Partial<BundleData> = {}): BundleData {
  return {
    manifest: { formatVersion: BUNDLE_FORMAT_VERSION, kind: 'project', createdAt: 0 },
    scenes: {},
    libraries: {
      materials: [], terrainMaterials: [], templates: [], models: [],
      scripts: [], animationFields: [], animations: [], tilesets: [],
      audioSources: [buildAudioSourceAsset({ id: 'footstep.wav', name: 'footstep.wav', mime: 'audio/wav', byteSize: 64 })],
      soundSamples: [authoredSample()],
    },
    vfs: { version: 1, folders: [], entries: [] } as any,
    textures: [],
    audio: [{ id: 'footstep.wav', mime: 'audio/wav', bytes: bytes(64) }],
    ...over,
  };
}

/** Pack a bundle and inflate a fresh copy of the packed JSON, as an export/import round trip does. */
async function roundTrip(bundle: BundleData): Promise<BundleData> {
  const { blob, index } = await packBundleAssets(bundle);
  // Re-parse: the real path writes the JSON into a zip and reads it back, so anything that only survives
  // as a live object reference would pass here otherwise.
  const reparsed: BundleData = JSON.parse(JSON.stringify({
    manifest: bundle.manifest, scenes: bundle.scenes, libraries: bundle.libraries, vfs: bundle.vfs,
  }));
  reparsed.textures = [];
  reparsed.audio = [];
  await inflateBundleAssets(reparsed, blob, JSON.parse(JSON.stringify(index)));
  return reparsed;
}

describe('assets.bin round-trip — audio', () => {
  it('restores the payload bytes exactly', async () => {
    const source = bytes(64);
    const out = await roundTrip(bundleWith());
    expect(out.audio).toHaveLength(1);
    expect(out.audio![0].id).toBe('footstep.wav');
    expect(out.audio![0].mime).toBe('audio/wav');
    expect(new Uint8Array(out.audio![0].bytes)).toEqual(new Uint8Array(source));
  });

  it('preserves every authored setting, including the whole effect rack in order', async () => {
    // THE regression this file exists for. If the sample libraries ever stop travelling, this is what
    // catches it — and it would otherwise only be noticed by a user whose sounds all went back to 1.0.
    const before = authoredSample();
    const out = await roundTrip(bundleWith());
    const after = out.libraries.soundSamples![0];

    expect(after.settings).toEqual(before.settings);
    expect(after.settings.effects.map(e => e.kind)).toEqual(['filter', 'reverb', 'compressor']);
    expect(after.settings.effects[1].enabled).toBe(false);
    expect(after.settings.bus).toBe('music');
    expect(after.settings.loopStart).toBe(0.5);
    expect(after.settings.loopEnd).toBe(2.25);
  });

  it('keeps the sample pointed at its audio source', async () => {
    const out = await roundTrip(bundleWith());
    const sample = out.libraries.soundSamples![0];
    expect(sample.source).toEqual({ kind: 'audio', audioId: 'footstep.wav' });
    expect(sample.audioIds).toEqual(['footstep.wav']);
    expect(out.libraries.audioSources![0].id).toBe('footstep.wav');
  });

  it('stores one copy when two samples share a file', async () => {
    // The storage half of what the split buys: the writer interns identical byte runs.
    const second = buildSoundSampleAsset('footstep-quiet', 'Footstep Quiet', { kind: 'audio', audioId: 'footstep.wav' });
    const bundle = bundleWith();
    bundle.libraries.soundSamples!.push(second);
    bundle.audio = [
      { id: 'footstep.wav', mime: 'audio/wav', bytes: bytes(64) },
      { id: 'copy.wav', mime: 'audio/wav', bytes: bytes(64) },
    ];
    const { blob, index } = await packBundleAssets(bundle);
    expect(index.audio).toHaveLength(2);
    // Same offset and length: interned, not written twice.
    expect(index.audio![0].o).toBe(index.audio![1].o);
    expect(blob.byteLength).toBeLessThan(200);
  });

  it('reads a bundle written before audio existed as one with no sounds', async () => {
    // The compatibility arm. An older bundle has no `audio` table and no audio libraries at all.
    const bundle = bundleWith({ audio: undefined });
    delete (bundle.libraries as any).audioSources;
    delete (bundle.libraries as any).soundSamples;
    const out = await roundTrip(bundle);
    expect(out.audio).toEqual([]);
    expect(out.libraries.soundSamples).toBeUndefined();
  });

  it('skips a zero-length payload rather than indexing an empty chunk', async () => {
    const bundle = bundleWith({ audio: [{ id: 'empty.wav', mime: 'audio/wav', bytes: new ArrayBuffer(0) }] });
    const { index } = await packBundleAssets(bundle);
    expect(index.audio).toEqual([]);
  });
});

describe('planMerge — audio', () => {
  const local = (over: Partial<LocalState> = {}): LocalState => ({
    materialIds: new Set(), terrainMaterialIds: new Set(), templateIds: new Set(), modelIds: new Set(),
    scriptIds: new Set(), animationFieldIds: new Set(), animationIds: new Set(), tilesetIds: new Set(),
    sceneIds: new Set(), sceneNames: new Set(),
    textures: new Map(), audio: new Map(), audioSourceIds: new Set(), soundSampleIds: new Set(),
    vfsPaths: new Set(), vfsFolders: new Set(),
    ...over,
  });

  it('imports audio as-is into a project that has none', () => {
    const plan = planMerge(bundleWith(), local());
    expect(plan.audio).toHaveLength(1);
    expect(plan.audio[0].id).toBe('footstep.wav');
    expect(plan.soundSamples[0].id).toBe('footstep.wav');
  });

  it('reuses an identical payload already stored under that id', () => {
    const plan = planMerge(bundleWith(), local({
      audio: new Map([['footstep.wav', { size: 64, mime: 'audio/wav' }]]),
    }));
    // Nothing to write: the bytes are already there.
    expect(plan.audio).toHaveLength(0);
  });

  it('re-mints a colliding payload and carries every reference to the new id', () => {
    const plan = planMerge(bundleWith(), local({
      // Same id, DIFFERENT bytes — a genuine collision between two projects' files.
      audio: new Map([['footstep.wav', { size: 999, mime: 'audio/wav' }]]),
      audioSourceIds: new Set(['footstep.wav']),
    }));

    expect(plan.audio).toHaveLength(1);
    const newId = plan.audio[0].id;
    expect(newId).not.toBe('footstep.wav');
    // The record's id must follow its payload, and the sample must follow the record — otherwise the
    // import lands a sample pointing at a file that is not there.
    expect(plan.audioSources[0].id).toBe(newId);
    expect(plan.soundSamples[0].source).toEqual({ kind: 'audio', audioId: newId });
    expect(plan.soundSamples[0].audioIds).toEqual([newId]);
  });

  it('re-mints a colliding sample id and rewrites the SoundNodes that play it', () => {
    const bundle = bundleWith({
      scenes: {
        s1: {
          scene: {
            name: 'root',
            children: [{ type: 'sound', name: 'emitter', sound: { mode: 'spatial', sampleId: 'footstep.wav' }, children: [] }],
          },
          savedAt: 0,
        } as any,
      },
    });

    const plan = planMerge(bundle, local({ soundSampleIds: new Set(['footstep.wav']) }));
    const newId = plan.soundSamples[0].id;
    expect(newId).not.toBe('footstep.wav');

    const emitter = (plan.scenes[0].data as any).scene.children[0];
    expect(emitter.sound.sampleId).toBe(newId);
    expect(plan.soundSamples[0].soundIds).toEqual([newId]);
  });

  it('leaves a non-colliding sample id alone', () => {
    const plan = planMerge(bundleWith(), local());
    expect(plan.soundSamples[0].id).toBe('footstep.wav');
    expect(plan.soundSamples[0].settings.bus).toBe('music');
  });
});

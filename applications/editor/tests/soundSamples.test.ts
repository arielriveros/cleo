import { describe, it, expect } from 'vitest';
import {
  buildSoundSampleAsset, withSoundSource, readsAudio, reconcileSoundAssets, audioIdsMissingInfo,
  DEFAULT_SOUND_SETTINGS,
} from '../src/utils/soundSamples';
import type { LiveSound, SoundSampleAsset } from '../src/utils/soundSamples';
import { buildAudioSourceAsset, withAudioInfo, formatDuration } from '../src/utils/audioSources';
import type { AudioSourceAsset } from '../src/utils/audioSources';

// `reconcileSoundAssets` is the ONLY place an audio asset record is minted — every ingestion path (drop,
// import, scene parse, bundle import) just registers bytes with the AudioManager and lets this catch up.
// That makes idempotence the property everything else rests on: it runs on every library change, so a
// second pass that minted anything would double the project's assets a few frames after the first.

const live = (over: Partial<LiveSound> = {}): LiveSound => ({
  id: 'footstep.wav',
  settings: undefined,
  duration: 1.5,
  source: { mime: 'audio/wav', byteLength: 4096 },
  ...over,
});

describe('reconcileSoundAssets', () => {
  it('mints both halves under the same id for a sample with retained bytes', () => {
    const out = reconcileSoundAssets([live()], [], []);
    expect(out.changed).toBe(true);
    expect(out.sources).toHaveLength(1);
    expect(out.samples).toHaveLength(1);
    // One id, two namespaces — the same arrangement images and textures use, and what makes the split
    // move no bytes and re-key no rows.
    expect(out.sources[0].id).toBe('footstep.wav');
    expect(out.samples[0].id).toBe('footstep.wav');
    expect(out.samples[0].source).toEqual({ kind: 'audio', audioId: 'footstep.wav' });
  });

  it('names the sample by its stem but leaves the id alone', () => {
    // The id is what a serialized SoundNode references, so it keeps the extension it was registered under.
    const out = reconcileSoundAssets([live()], [], []);
    expect(out.samples[0].name).toBe('footstep');
    expect(out.samples[0].id).toBe('footstep.wav');
  });

  it('is idempotent — a second pass mints nothing and returns the same arrays', () => {
    const first = reconcileSoundAssets([live()], [], []);
    const second = reconcileSoundAssets([live()], first.sources, first.samples);
    expect(second.changed).toBe(false);
    expect(second.sources).toBe(first.sources);
    expect(second.samples).toBe(first.samples);
  });

  it('mints a runtime-sourced sample and NO source record when there are no bytes', () => {
    // A sample registered by a script or an embedder: authorable, but there is no file to file away.
    const out = reconcileSoundAssets([live({ source: null })], [], []);
    expect(out.sources).toHaveLength(0);
    expect(out.samples[0].source).toEqual({ kind: 'runtime' });
    expect(out.samples[0].audioIds).toEqual([]);
  });

  it('adopts the live settings rather than resetting to defaults', () => {
    const out = reconcileSoundAssets([live({ settings: { volume: 0.25, bus: 'music' } })], [], []);
    expect(out.samples[0].settings.volume).toBe(0.25);
    expect(out.samples[0].settings.bus).toBe('music');
  });

  it('repairs hostile live settings instead of storing them', () => {
    const out = reconcileSoundAssets([live({ settings: { volume: 99, bus: 'nope' } })], [], []);
    expect(out.samples[0].settings.volume).toBe(1);
    expect(out.samples[0].settings.bus).toBe(DEFAULT_SOUND_SETTINGS.bus);
  });

  it('leaves an existing record alone and only mints for the new id', () => {
    const existing = reconcileSoundAssets([live()], [], []);
    const out = reconcileSoundAssets(
      [live(), live({ id: 'impact.mp3', source: { mime: 'audio/mpeg', byteLength: 900 } })],
      existing.sources, existing.samples,
    );
    expect(out.changed).toBe(true);
    expect(out.samples).toHaveLength(2);
    expect(out.samples[0]).toBe(existing.samples[0]); // untouched, same object
    expect(out.samples[1].id).toBe('impact.mp3');
  });

  it('skips an id-less live entry rather than minting a nameless asset', () => {
    const out = reconcileSoundAssets([live({ id: '' })], [], []);
    expect(out.changed).toBe(false);
  });

  it('does not mint a second source when one already exists for that id', () => {
    const sources: AudioSourceAsset[] = [buildAudioSourceAsset({ id: 'footstep.wav', mime: 'audio/wav' })];
    const out = reconcileSoundAssets([live()], sources, []);
    expect(out.sources).toBe(sources); // unchanged array — nothing to add
    expect(out.samples[0].source).toEqual({ kind: 'audio', audioId: 'footstep.wav' });
  });
});

describe('withSoundSource', () => {
  const sample = (): SoundSampleAsset =>
    buildSoundSampleAsset('sample-1', 'Footstep', { kind: 'audio', audioId: 'a.wav' });

  it('re-derives audioIds, which is the whole reason it exists', () => {
    // A spread would leave the OLD audioIds in place — and those are exactly what the bundle exporter and
    // the delete-confirm dialog read, so the sample would keep the previous file alive and ship it.
    const next = withSoundSource(sample(), { kind: 'audio', audioId: 'b.wav' });
    expect(next.audioIds).toEqual(['b.wav']);
    expect(next.source).toEqual({ kind: 'audio', audioId: 'b.wav' });
  });

  it('empties audioIds for a runtime source', () => {
    expect(withSoundSource(sample(), { kind: 'runtime' }).audioIds).toEqual([]);
  });

  it('leaves the id and name alone', () => {
    const next = withSoundSource(sample(), { kind: 'runtime' });
    expect(next.id).toBe('sample-1');
    expect(next.name).toBe('Footstep');
  });
});

describe('buildSoundSampleAsset', () => {
  it('carries its own id in soundIds so the bundle walkers find it by field name', () => {
    const s = buildSoundSampleAsset('x', 'X', { kind: 'audio', audioId: 'f.wav' });
    expect(s.soundIds).toEqual(['x']);
    expect(s.audioIds).toEqual(['f.wav']);
  });

  it('normalizes the settings it is given', () => {
    const s = buildSoundSampleAsset('x', 'X', { kind: 'runtime' }, { volume: 42 } as never);
    expect(s.settings.volume).toBe(1);
  });
});

describe('readsAudio', () => {
  it('is true only for the file a sample actually sources', () => {
    const s = buildSoundSampleAsset('x', 'X', { kind: 'audio', audioId: 'f.wav' });
    expect(readsAudio(s, 'f.wav')).toBe(true);
    expect(readsAudio(s, 'other.wav')).toBe(false);
    expect(readsAudio(buildSoundSampleAsset('y', 'Y', { kind: 'runtime' }), 'f.wav')).toBe(false);
  });
});

describe('audio source records', () => {
  it('backfills decoded info and returns the SAME array when nothing changed', () => {
    // The same-array contract lets a caller use it as a React state updater directly, without forcing a
    // render on every poll.
    const list = [buildAudioSourceAsset({ id: 'a', mime: 'audio/wav' })];
    const filled = withAudioInfo(list, 'a', 2.5, 44100, 2);
    expect(filled).not.toBe(list);
    expect(filled[0]).toMatchObject({ duration: 2.5, sampleRate: 44100, channels: 2 });
    expect(withAudioInfo(filled, 'a', 2.5, 44100, 2)).toBe(filled);
  });

  it('ignores a zero duration and an unknown id', () => {
    const list = [buildAudioSourceAsset({ id: 'a', mime: 'audio/wav' })];
    expect(withAudioInfo(list, 'a', 0, 44100, 2)).toBe(list);
    expect(withAudioInfo(list, 'missing', 1, 44100, 2)).toBe(list);
  });

  it('reports which sources still need decoding', () => {
    const list = [
      buildAudioSourceAsset({ id: 'a', mime: 'audio/wav', duration: 1 }),
      buildAudioSourceAsset({ id: 'b', mime: 'audio/wav' }),
    ];
    expect(audioIdsMissingInfo(list)).toEqual(['b']);
  });

  it('formats a duration, and says so when there is none', () => {
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(9.25)).toBe('0:09.3');
    expect(formatDuration(75)).toBe('1:15.0');
  });
});

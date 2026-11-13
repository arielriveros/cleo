import { describe, it, expect, afterEach } from 'vitest';
import { packGameBin } from '../src/features/publish/pack';
import { unpackGameBin } from '../src/player/unpack';
import { extractScripts } from '../src/features/publish/extractScripts';
import { registerSequenceWorkingCopies, applySequenceWorkingCopiesToJson } from '../src/features/sequencer/workingCopies';
import { staleSessionIds, STALE_SESSION_MS } from '../src/features/playWindow/sessionStore';
import { encodeLogEntry, encodeLogValue, isMessageFor, newSessionId } from '../src/features/playWindow/protocol';

// Play in window boots the published player's runtime (src/player/boot.tsx) from a packed game.bin, but
// one whose scripts stay SOURCE — the game window compiles them, as editor Play does. These are the data
// paths that differ from Publish.

const game = (extra: Record<string, unknown> = {}) => ({
  version: 2,
  entry: 'main',
  scenes: { main: { name: 'Main', scene: { name: 'root', children: [{ name: 'Hero', script: 'export default class Hero {}', scriptPath: '/Player/Hero', children: [] }] } } },
  ...extra,
});

describe('the pack a play window boots from', () => {
  it('keeps script module sources, which an un-extracted game imports at runtime', () => {
    const modules = { '/Shared/Math': 'export const clamp01 = (x: number) => Math.min(1, Math.max(0, x))' };
    const { manifest } = unpackGameBin(packGameBin(game({ modules })).buffer);
    expect(manifest.modules).toEqual(modules);
    // ...and each node's own script, with the path its relative imports resolve against.
    const hero = manifest.scenes.main.scene.children[0];
    expect(hero.script).toContain('class Hero');
    expect(hero.scriptPath).toBe('/Player/Hero');
  });

  it('a published game still carries no module sources: extractScripts moves them into game.scripts.js', () => {
    const data: any = game({ modules: { '/Shared/Math': 'export const one = 1' } });
    const { modules } = extractScripts(data);
    expect(Object.keys(modules)).toEqual(['/Shared/Math']);
    expect(unpackGameBin(packGameBin(data).buffer).manifest.modules).toBeUndefined();
  });

  // The player has always read `retargets` (player/animations.ts); the packer used to drop it, so every
  // published game played its corrected clips uncorrected.
  it('ships the rig retarget corrections', () => {
    const retargets = { model1: { anim1: [{ sourceName: 'mixamorig:Hips', targetName: 'pelvis' }] } };
    const { manifest } = unpackGameBin(packGameBin(game({ retargets })).buffer);
    expect(manifest.retargets).toEqual(retargets);
  });

  it('adds neither field when the build has none', () => {
    const { manifest } = unpackGameBin(packGameBin(game()).buffer);
    expect('modules' in manifest).toBe(false);
    expect('retargets' in manifest).toBe(false);
  });
});

describe("the Sequencer's working copies in a serialized scene", () => {
  let unregister: (() => void) | null = null;
  afterEach(() => { unregister?.(); unregister = null; });

  it('replaces the timeline of every Sequence node that links an open tab, at any depth', () => {
    const copy = { name: 'Intro (edited)', duration: 9, fps: 30, tracks: [] } as any;
    unregister = registerSequenceWorkingCopies(() => new Map([['seq-a', copy]]));
    const scene = {
      name: 'root', children: [
        { type: 'sequence', name: 'Intro', sequenceId: 'seq-a', sequence: { name: 'Intro', duration: 4 }, children: [] },
        { type: 'node', name: 'Group', children: [
          { type: 'sequence', name: 'Intro again', sequenceId: 'seq-a', sequence: { name: 'Intro', duration: 4 }, children: [] },
          { type: 'sequence', name: 'Outro', sequenceId: 'seq-b', sequence: { name: 'Outro', duration: 2 }, children: [] },
        ] },
      ],
    };
    expect(applySequenceWorkingCopiesToJson(scene)).toBe(2);
    expect(scene.children[0].sequence).toEqual(copy);
    expect(scene.children[1].children![0].sequence).toEqual(copy);
    // A copy, never the tab's own object: the game must not alias the editor's working state.
    expect(scene.children[0].sequence).not.toBe(copy);
    // Not linked to an open tab: the saved timeline stays.
    expect(scene.children[1].children![1].sequence).toEqual({ name: 'Outro', duration: 2 });
  });

  it('does nothing with no Sequencer tab open', () => {
    const scene = { name: 'root', children: [{ type: 'sequence', sequenceId: 'seq-a', sequence: { duration: 4 }, children: [] }] };
    expect(applySequenceWorkingCopiesToJson(scene)).toBe(0);
    expect(scene.children[0].sequence).toEqual({ duration: 4 });
  });
});

describe('the play-session store', () => {
  it('drops sessions older than the cut-off, and any without a usable date', () => {
    const now = 1_000_000_000;
    const stale = staleSessionIds([
      { id: 'fresh', createdAt: now - 1000 },
      { id: 'edge', createdAt: now - STALE_SESSION_MS },
      { id: 'old', createdAt: now - STALE_SESSION_MS - 1 },
      { id: 'undated', createdAt: NaN },
    ], now);
    expect(stale.sort()).toEqual(['old', 'undated']);
  });
});

describe('the play channel', () => {
  it('only accepts messages of this session, for this side', () => {
    const msg = { to: 'editor', session: 'abc123', type: 'hello', state: { phase: 'waiting' } };
    expect(isMessageFor(msg, 'editor', 'abc123')).toBe(true);
    expect(isMessageFor(msg, 'game', 'abc123')).toBe(false);
    expect(isMessageFor(msg, 'editor', 'other')).toBe(false);
    expect(isMessageFor({ to: 'editor', session: 'abc123' }, 'editor', 'abc123')).toBe(false);
    expect(isMessageFor(null, 'editor', 'abc123')).toBe(false);
    expect(isMessageFor('hello', 'editor', 'abc123')).toBe(false);
  });

  it('session ids are hex and unique', () => {
    const ids = new Set(Array.from({ length: 50 }, newSessionId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('flattens a log row into what structured clone carries and the console shows', () => {
    class Goblin { name = 'Goblin 3'; hp = 4; }
    const circular: any = { a: 1 }; circular.self = circular;
    const error = new TypeError('cannot read hp');
    const row = encodeLogEntry({
      id: '7', method: 'warn', scope: 'Script', timestamp: 42, flushKey: 'fps',
      data: ['text', 3, true, null, undefined, new Goblin(), circular, new Float32Array(1000), [1, 2, 3], () => 1, error],
    });
    expect(row).toMatchObject({ id: '7', method: 'warn', scope: 'Script', timestamp: 42, flushKey: 'fps' });
    expect(row.data.slice(0, 5)).toEqual(['text', 3, true, null, 'undefined']);
    expect(row.data[5]).toBe('Goblin name hp');
    expect(row.data[6]).toBe('Object a self');
    expect(row.data[7]).toBe('Float32Array(1000)');
    expect(row.data[8]).toBe('Array(3)');
    expect(String(row.data[9])).toMatch(/^ƒ /);
    expect(String(row.data[10])).toContain('cannot read hp');
    // Everything left is cloneable.
    expect(() => structuredClone(row)).not.toThrow();
  });

  it('keeps an Error readable even when its stack does not carry the message', () => {
    const e = new Error('boom');
    e.stack = 'at somewhere';
    expect(encodeLogValue(e)).toBe('Error: boom\nat somewhere');
  });
});

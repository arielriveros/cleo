import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

/**
 * What a published game keeps of a texture or a sound once the engine has it (TextureManager.setRetention,
 * addTextureFromBlob, ensureImage; Sound's `retainSource`). A published game reads each from game.bin and
 * should keep neither its encoded bytes nor, for a texture nothing reads afterwards, its decoded image —
 * while the editor, which sets no retention, keeps everything it always kept (it saves, publishes and
 * previews from it). Both directions fail quietly: a leak is just memory, and an image released that a
 * UI image or LUT still reads draws blank.
 */

// howler, faked: a Howl that "decodes" on the next tick, as the real one does once it has fetched its URL.
const howls: any[] = [];
vi.mock('howler', () => {
  class Howl {
    opts: any; handlers: Record<string, Function[]> = {}; loaded = false;
    constructor(opts: any) {
      this.opts = opts;
      howls.push(this);
      if (opts.preload !== false) this.load();
    }
    load() { setTimeout(() => { this.loaded = true; this.opts.onload?.(); for (const f of this.handlers.load ?? []) f(); }, 0); }
    on(ev: string, f: Function) { (this.handlers[ev] ??= []).push(f); }
    once(ev: string, f: Function) { this.on(ev, f); }
    off() {}
    unload() {}
    duration() { return 1; }
  }
  return { Howl, Howler: { ctx: undefined } };
});

import { setGLContext } from '../src/graphics/rhi/webgl2/glContext';
import { WebGL2Device } from '../src/graphics/rhi/webgl2/webgl2Device';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { TextureManager } from '../src/graphics/systems/textureManager';
import { Sound } from '../src/audio/sound';
import { DEFAULT_SOUND_SETTINGS } from '../src/audio/soundSettings';

/** Blob URLs alive right now, and the image size each fake encoded image decodes to. */
const live = new Set<string>();
const sizes = new WeakMap<Blob, { w: number; h: number } | 'bad'>();
const urlBlobs = new Map<string, Blob>();
let urlCount = 0;

class FakeImage {
  width = 0; height = 0; naturalWidth = 0; naturalHeight = 0; complete = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = '';
  get src() { return this._src; }
  set src(url: string) {
    this._src = url;
    const blob = urlBlobs.get(url);
    const size = blob ? sizes.get(blob) : undefined;
    setTimeout(() => {
      if (!size || size === 'bad' || !live.has(url)) { this.onerror?.(); return; }
      this.width = this.naturalWidth = size.w;
      this.height = this.naturalHeight = size.h;
      this.complete = true;
      this.onload?.();
    }, 0);
  }
}

/** An "encoded image" of the given size (or one that fails to decode). */
const image = (w: number, h: number) => { const b = new Blob(['img']); sizes.set(b, { w, h }); return b; };
const broken = () => { const b = new Blob(['?']); sizes.set(b, 'bad'); return b; };

let ids = 0;
const nextId = () => `tex-${++ids}`;

beforeAll(() => {
  let n = 0;
  const gl = new Proxy({}, {
    get: (_t, key: string) => (key === 'createTexture' || key === 'createFramebuffer' ? () => ({ id: ++n })
      : key === 'getParameter' ? () => 4096 : key === 'getExtension' ? () => null : key === 'getError' ? () => 0
      : key === 'NO_ERROR' ? 0 : () => undefined),
  });
  setGLContext(gl as any);
  setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('HTMLImageElement', FakeImage);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: any) => {
    const url = `blob:test/${++urlCount}`;
    live.add(url);
    urlBlobs.set(url, blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => { live.delete(url); });
});
afterEach(() => TextureManager.Instance.setRetention(null));
afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const tm = () => TextureManager.Instance;

describe('textures read from game.bin', () => {
  it('keep their image and its URL with no retention (the editor), and never their encoded bytes', async () => {
    const { id, loaded } = tm().addTextureFromBlob(image(8, 8), undefined, nextId());
    expect(tm().getTexture(id)).toBeDefined(); // usable at once
    expect(await loaded).toBe(true);
    const t = tm().getTexture(id)!;
    expect(t.data).toBeInstanceOf(FakeImage);
    expect(t.released).toBe(false);
    expect(live.has((t.data as any).src)).toBe(true);
    expect(t.source).toBeNull();
  });

  it('let the decoded image and its URL go after upload, unless the retention keeps them', async () => {
    const kept = nextId();
    tm().setRetention({ keep: id => id === kept, reload: async () => null });
    const before = live.size;
    const dropped = tm().addTextureFromBlob(image(16, 4), undefined, nextId());
    const keptOne = tm().addTextureFromBlob(image(16, 4), undefined, kept);
    expect(await dropped.loaded).toBe(true);
    expect(await keptOne.loaded).toBe(true);

    const d = tm().getTexture(dropped.id)!;
    expect(d.released).toBe(true);
    expect(d.data).toBeNull();
    expect([d.width, d.height]).toEqual([16, 4]);
    const k = tm().getTexture(kept)!;
    expect(k.released).toBe(false);
    expect(k.data).not.toBeNull();
    expect(live.size).toBe(before + 1); // only the kept one's URL
  });

  it('decode a released image again on ensureImage, once for every asker, and say so through imageRevision', async () => {
    let reloads = 0;
    tm().setRetention({ keep: () => false, reload: async () => { reloads++; return image(4, 4); } });
    const { id, loaded } = tm().addTextureFromBlob(image(4, 4), undefined, nextId());
    await loaded;
    expect(tm().getTexture(id)!.released).toBe(true);
    const rev = tm().imageRevision;
    const [a, b] = await Promise.all([tm().ensureImage(id), tm().ensureImage(id)]);
    expect([a, b]).toEqual([true, true]);
    expect(reloads).toBe(1);
    const t = tm().getTexture(id)!;
    expect(t.released).toBe(false);
    expect(t.data).toBeInstanceOf(FakeImage);
    expect(tm().imageRevision).toBeGreaterThan(rev);
    // Already there: nothing to read.
    expect(await tm().ensureImage(id)).toBe(true);
    expect(reloads).toBe(1);
    expect(await tm().ensureImage('no-such-texture')).toBe(false);
  });

  it('drop a texture whose image does not decode, and one whose read failed, without leaking its URL', async () => {
    const before = live.size;
    const bad = tm().addTextureFromBlob(broken(), undefined, nextId());
    const failed = tm().addTextureFromBlob(Promise.reject(new Error('network')), undefined, nextId());
    expect(await bad.loaded).toBe(false);
    expect(await failed.loaded).toBe(false);
    expect(tm().getTexture(bad.id)).toBeUndefined();
    expect(tm().getTexture(failed.id)).toBeUndefined();
    expect(live.size).toBe(before);
    expect(tm().pendingLoads).toBe(0);
  });

  it('let go of an image that arrives after its texture was removed', async () => {
    const before = live.size;
    let give!: (b: Blob) => void;
    const { id, loaded } = tm().addTextureFromBlob(new Promise<Blob>(r => { give = r; }), undefined, nextId());
    tm().removeTexture(id);
    give(image(2, 2));
    expect(await loaded).toBe(false);
    expect(live.size).toBe(before);
  });
});

describe('sounds read from game.bin', () => {
  it('keep no bytes and let the blob URL go once howler has decoded it', async () => {
    const sound = new Sound('s1', new Blob(['ogg']), 'audio/ogg', { ...DEFAULT_SOUND_SETTINGS, preload: true }, null, { retainSource: false });
    expect(sound.source).toBeNull();
    const url = sound.objectUrl!;
    expect(live.has(url)).toBe(true);
    await new Promise<void>(r => sound.onLoad(() => setTimeout(r, 0)));
    expect(live.has(url)).toBe(false);
    expect(sound.objectUrl).toBeNull();
    sound.delete();
  });

  it('hold the URL until the first play loads a sample that does not preload', async () => {
    const sound = new Sound('s2', new Blob(['ogg']), 'audio/ogg', { ...DEFAULT_SOUND_SETTINGS, preload: false }, null, { retainSource: false });
    await new Promise(r => setTimeout(r, 5));
    const url = sound.objectUrl!;
    expect(live.has(url)).toBe(true);
    howls.at(-1).load(); // what play() does on a sample not loaded yet
    await new Promise(r => setTimeout(r, 5));
    expect(live.has(url)).toBe(false);
    sound.delete();
  });

  it('keep their bytes and their URL by default (the editor saves and publishes them)', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sound = new Sound('s3', bytes, 'audio/ogg', { ...DEFAULT_SOUND_SETTINGS, preload: true });
    await new Promise(r => setTimeout(r, 5));
    expect(sound.source?.bytes).toBe(bytes);
    expect(live.has(sound.objectUrl!)).toBe(true);
    sound.delete();
    expect(sound.objectUrl).toBeNull();
  });
});

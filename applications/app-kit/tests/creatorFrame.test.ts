import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import {
  creatorChannel, getCreatorAsset, getCreatorFiles, listCreatorAssets, memoryBackend, putCreatorAsset, renameCreatorAsset,
  resetCreatorChannel, setCreatorBackend, setCreatorChannel, type CreatorBackend, type CreatorMessage,
} from '../src/creatorLibrary';
import { acceptsConnect, servePort, wirePort, type ChannelLike, type PortLike } from '../src/creatorLibrary/frame';

/**
 * Cleo Creator on its own site reaches the editor's library through a frame of the editor's origin
 * (creatorLibrary/frame.ts). Here the frame's side and the Creator's side talk over a real MessageChannel, with a
 * Map as the editor's library and a pair of fake BroadcastChannels as the editor's tabs. What has to hold: every
 * library call round-trips (files included), a write the Creator makes reaches the editor's tabs exactly once, an
 * editor tab's message reaches the Creator, and only the Creator's own origin may connect.
 */

const file = (name: string, text: string) => ({ name, mime: 'text/plain', blob: new Blob([text]) });
const input = (over: Partial<Parameters<typeof putCreatorAsset>[0]> = {}) => ({
  id: 'foliage_a', kind: 'foliage' as const, name: 'Pine', doc: { seed: 1 }, sidecar: { output: {} },
  files: [file('pine_LOD0.glb', 'a'), file('pine.foliage.json', '{}')], contentHash: 'h1', ...over,
});

/** Two ends of a BroadcastChannel: what the frame posts, the editor's tab hears, and the other way round. */
function broadcastPair() {
  const frameEnd: ChannelLike & { closed: boolean } = {
    onmessage: null, closed: false,
    postMessage(m) { editorHeard.push(m as CreatorMessage); },
    close() { this.closed = true; },
  };
  const editorHeard: CreatorMessage[] = [];
  const editorPosts = (m: CreatorMessage) => frameEnd.onmessage?.({ data: m });
  return { frameEnd, editorHeard, editorPosts };
}

/** Node's MessagePort speaks EventEmitter; give it the browser's onmessage/postMessage shape. */
function browserPort(port: import('node:worker_threads').MessagePort): PortLike {
  let handler: PortLike['onmessage'] = null;
  port.on('message', (data) => handler?.({ data }));
  return {
    postMessage: (m) => port.postMessage(m),
    get onmessage() { return handler; },
    set onmessage(fn) { handler = fn; },
    close: () => port.close(),
  };
}

const tick = () => new Promise(r => setTimeout(r, 20));

describe('the Creator library through the storage frame', () => {
  let editorLibrary: CreatorBackend;
  let pair: ReturnType<typeof broadcastPair>;
  let stop: () => void;
  let creatorHeard: CreatorMessage[];
  let ports: import('node:worker_threads').MessagePort[];

  beforeEach(async () => {
    editorLibrary = memoryBackend();
    pair = broadcastPair();
    const mc = new MessageChannel();
    ports = [mc.port1, mc.port2];
    const frameSide = browserPort(mc.port2);
    const creatorSide = browserPort(mc.port1);
    // The Creator waits for `ready` before wiring, as connectCreatorFrame does.
    const ready = new Promise<any>(resolve => { creatorSide.onmessage = (e) => resolve(e.data); });
    stop = servePort(frameSide, editorLibrary, pair.frameEnd, true);
    expect(await ready).toEqual({ kind: 'ready', storageAccess: true });
    const { backend, channel } = wirePort(creatorSide);
    setCreatorBackend(backend);
    setCreatorChannel(channel);
    creatorHeard = [];
    creatorChannel().subscribe(m => creatorHeard.push(m));
  });

  afterEach(() => {
    stop();
    for (const p of ports) p.close();
    resetCreatorChannel();
    setCreatorBackend(null);
  });

  it("writes into the editor's library, files and all", async () => {
    const meta = await putCreatorAsset(input());
    expect(meta!.revision).toBe(1);
    expect((await editorLibrary.get('foliage_a'))!.name).toBe('Pine');
    const files = await getCreatorFiles('foliage_a', ['pine_LOD0.glb']);
    expect(await files[0].blob.text()).toBe('a');
    expect((await listCreatorAssets()).map(m => m.id)).toEqual(['foliage_a']);
  });

  it("announces each write to the editor's tabs once, and to the Creator's own listeners once", async () => {
    await putCreatorAsset(input());
    await renameCreatorAsset('foliage_a', 'Fir');
    await tick();
    const expected = [{ type: 'upsert', id: 'foliage_a', revision: 1 }, { type: 'upsert', id: 'foliage_a', revision: 2 }];
    expect(pair.editorHeard).toEqual(expected);
    expect(creatorHeard).toEqual(expected);
  });

  it("hands the Creator what an editor tab posts", async () => {
    pair.editorPosts({ type: 'delete', id: 'foliage_b', revision: 4 });
    await tick();
    expect(creatorHeard).toEqual([{ type: 'delete', id: 'foliage_b', revision: 4 }]);
  });

  it("passes the library's errors back as rejections", async () => {
    editorLibrary.get = async () => { throw new Error('disk full'); };
    await expect(getCreatorAsset('foliage_a')).rejects.toThrow('disk full');
  });

  it('closes its broadcast channel when torn down', () => {
    stop();
    expect(pair.frameEnd.closed).toBe(true);
    stop = () => {};
  });
});

describe("the storage frame's door", () => {
  const parent = {};
  const port = {};
  const connect = { type: 'cleo-creator-frame:connect' };
  const allowed = ['https://creator.cleoengine.com'];

  it("takes a connect from its parent, at the Creator's origin, with a port", () => {
    expect(acceptsConnect({ data: connect, origin: 'https://creator.cleoengine.com', source: parent, ports: [port] }, parent, allowed)).toBe(true);
  });

  it('refuses any other origin, any other window, and a connect without a port', () => {
    expect(acceptsConnect({ data: connect, origin: 'https://evil.example', source: parent, ports: [port] }, parent, allowed)).toBe(false);
    expect(acceptsConnect({ data: connect, origin: 'https://creator.cleoengine.com', source: {}, ports: [port] }, parent, allowed)).toBe(false);
    expect(acceptsConnect({ data: connect, origin: 'https://creator.cleoengine.com', source: parent, ports: [] }, parent, allowed)).toBe(false);
    expect(acceptsConnect({ data: { type: 'other' }, origin: 'https://creator.cleoengine.com', source: parent, ports: [port] }, parent, allowed)).toBe(false);
  });

  it('serves nobody with an empty allow-list', () => {
    expect(acceptsConnect({ data: connect, origin: 'https://creator.cleoengine.com', source: parent, ports: [port] }, parent, [])).toBe(false);
  });
});

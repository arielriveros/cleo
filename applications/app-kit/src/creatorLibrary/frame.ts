// The Creator library across two origins: Cleo Creator on its own site (creator.cleoengine.com) reaching the
// library of the editor's (editor.cleoengine.com).
//
// The library is an IndexedDB database plus a BroadcastChannel (store.ts, channel.ts), and the browser keeps both
// per origin: on a site of its own, the Creator's writes would land in a database no editor reads. So the Creator
// embeds a hidden page of the editor's origin -- the STORAGE FRAME, applications/editor/creator-library.html -- and
// does its reads, writes and channel posts through it. A browser splits an embedded frame's storage by the site of
// the page around it; the two subdomains are one site (cleoengine.com), so the frame sees the editor's own database
// and channel, and the editor keeps reading them directly, unchanged. (Two *.web.app sites are NOT one site:
// web.app is a public suffix. The frame only reaches the editor's library on the custom domain.)
//
//   Creator page                          storage frame (editor origin)          editor tabs
//   frameBackend ── call {op,args} ──►    indexedDbBackend[op](...args)
//                ◄── reply {value} ──
//   frameChannel ── post {msg} ─────►    BroadcastChannel('cleo-creator') ──►    CreatorSync
//                ◄── event {msg} ────    ◄────────────────────────────────────
//
// The handshake: the frame says `hello` to its parent; the parent answers `connect` with a MessagePort, to the
// frame's origin only; the frame checks the parent's origin against its allow-list and says `ready` on the port.
// Everything after that is on the port. Same-origin hosts (the desktop app at app://editor/creator/, dev through
// the editor's /creator proxy) never use any of this: they open the database themselves.

import { indexedDbBackend, setCreatorBackend, type CreatorBackend } from './store';
import { CREATOR_CHANNEL_NAME, setCreatorChannel, type CreatorChannel } from './channel';
import type { CreatorMessage } from './types';

const HELLO = 'cleo-creator-frame:hello';
const CONNECT = 'cleo-creator-frame:connect';

type Op = keyof CreatorBackend;
const OPS: readonly Op[] = ['all', 'get', 'files', 'write', 'addFile'];

/** Creator -> frame, on the port. */
type ToFrame =
  | { kind: 'call'; id: number; op: Op; args: unknown[] }
  | { kind: 'post'; msg: CreatorMessage };
/** Frame -> Creator, on the port. */
type FromFrame =
  | { kind: 'ready'; storageAccess: boolean | null }
  | { kind: 'reply'; id: number; ok: true; value: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string }
  | { kind: 'event'; msg: CreatorMessage };

/** The little of a MessagePort this module uses (Node's and the browser's both fit). */
export interface PortLike {
  postMessage(message: unknown): void;
  onmessage: ((e: { data: any }) => void) | null;
  close?(): void;
}

/** The little of a BroadcastChannel the frame uses. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((e: { data: any }) => void) | null;
  close(): void;
}

// --- The frame's side -------------------------------------------------------------------------------------

/**
 * Serve one connected Creator on `port`: its calls from `backend`, its posts onto `channel`, and every message
 * another window posts on `channel` back to it. A BroadcastChannel never hands a window its own posts, so the
 * Creator does not hear its writes twice (frameChannel tells its own listeners itself). Returns the teardown.
 */
export function servePort(port: PortLike, backend: CreatorBackend, channel: ChannelLike, storageAccess: boolean | null = null): () => void {
  channel.onmessage = (e) => port.postMessage({ kind: 'event', msg: e.data } satisfies FromFrame);
  port.onmessage = async (e) => {
    const m = e.data as ToFrame;
    if (m?.kind === 'post') { channel.postMessage(m.msg); return; }
    if (m?.kind !== 'call') return;
    if (!OPS.includes(m.op)) {
      port.postMessage({ kind: 'reply', id: m.id, ok: false, error: `no such operation: ${String(m.op)}` } satisfies FromFrame);
      return;
    }
    try {
      const value = await (backend[m.op] as (...a: unknown[]) => Promise<unknown>)(...m.args);
      port.postMessage({ kind: 'reply', id: m.id, ok: true, value } satisfies FromFrame);
    } catch (err: any) {
      port.postMessage({ kind: 'reply', id: m.id, ok: false, error: String(err?.message ?? err) } satisfies FromFrame);
    }
  };
  port.postMessage({ kind: 'ready', storageAccess } satisfies FromFrame);
  return () => { channel.onmessage = null; channel.close(); port.onmessage = null; port.close?.(); };
}

/** Whether a message is a `connect` the frame should take: from its own parent, at an allowed origin, with a port. */
export function acceptsConnect(
  e: { data: any; origin: string; source: unknown; ports?: readonly unknown[] },
  parent: unknown,
  allowedOrigins: readonly string[],
): boolean {
  return e.source === parent && e.data?.type === CONNECT && !!e.ports?.[0] && allowedOrigins.includes(e.origin);
}

/**
 * Run on the storage frame's page (creator-library.html). Each `connect` from the embedding Creator, if its origin
 * is allowed, gets a port served from this origin's own library. Returns the teardown.
 */
export function serveCreatorFrame(allowedOrigins: readonly string[], win: Window = window): () => void {
  const served: (() => void)[] = [];
  const onMessage = async (e: MessageEvent) => {
    if (!acceptsConnect(e, win.parent, allowedOrigins)) return;
    // Whether this frame has its first-party storage: false would mean the browser partitioned it, and the
    // Creator would be writing into a library no editor reads. Reported, not acted on: a browser that answers
    // wrongly for a same-site frame must not switch the sync off.
    let storageAccess: boolean | null = null;
    try { storageAccess = (await (win.document as any).hasStorageAccess?.()) ?? null; } catch { /* not supported */ }
    const channel = new BroadcastChannel(CREATOR_CHANNEL_NAME) as unknown as ChannelLike;
    served.push(servePort(e.ports[0] as unknown as PortLike, indexedDbBackend, channel, storageAccess));
  };
  win.addEventListener('message', onMessage);
  // Tell the parent this page is listening. No data: the target origin can be anything.
  if (win.parent !== win) win.parent.postMessage({ type: HELLO }, '*');
  return () => { win.removeEventListener('message', onMessage); for (const stop of served) stop(); };
}

// --- The Creator's side -----------------------------------------------------------------------------------

/** The library's backend, answered by the frame on `port`. */
export function frameBackend(port: PortLike): CreatorBackend & { dispatch(m: FromFrame): boolean } {
  let next = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const call = (op: Op, ...args: unknown[]) => new Promise<any>((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    port.postMessage({ kind: 'call', id, op, args } satisfies ToFrame);
  });
  return {
    all: () => call('all'),
    get: (id) => call('get', id),
    files: (id, names) => call('files', id, names),
    write: (meta, put, drop) => call('write', meta, put, drop),
    addFile: (id, file, isPrivate) => call('addFile', id, file, isPrivate),
    /** Settle the call a reply answers; false when `m` is not a reply. */
    dispatch(m) {
      if (m.kind !== 'reply') return false;
      const p = pending.get(m.id);
      if (!p) return true;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
      return true;
    },
  };
}

/** The library's change feed, carried by the frame on `port`. */
export function frameChannel(port: PortLike): CreatorChannel & { dispatch(m: FromFrame): boolean } {
  const listeners = new Set<(msg: CreatorMessage) => void>();
  return {
    post(msg) {
      port.postMessage({ kind: 'post', msg } satisfies ToFrame);
      for (const fn of listeners) fn(msg);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    dispatch(m) {
      if (m.kind !== 'event') return false;
      for (const fn of listeners) fn(m.msg);
      return true;
    },
  };
}

/** Route the frame's messages on `port` to a backend and a channel. */
export function wirePort(port: PortLike) {
  const backend = frameBackend(port);
  const channel = frameChannel(port);
  port.onmessage = (e) => { const m = e.data as FromFrame; if (!backend.dispatch(m)) channel.dispatch(m); };
  return { backend, channel };
}

export interface FrameConnection {
  connected: boolean;
  /** Why not, when not: the frame did not answer in time, or could not be loaded. */
  reason?: string;
  /** What the frame said about its storage (Document.hasStorageAccess), when it answered. */
  storageAccess?: boolean | null;
}

/**
 * Embed the storage frame at `frameUrl` and, once it answers, make it this window's library: every read, write
 * and channel post from here on goes through it. Resolves `{ connected: false }` (and changes nothing) when it does
 * not answer within `timeoutMs`: the Creator then keeps a library of its own, unsynced.
 */
export function connectCreatorFrame(frameUrl: string, { timeoutMs = 8000, doc = document }: { timeoutMs?: number; doc?: Document } = {}): Promise<FrameConnection> {
  const origin = new URL(frameUrl, doc.baseURI).origin;
  return new Promise<FrameConnection>((resolve) => {
    const iframe = doc.createElement('iframe');
    iframe.src = frameUrl;
    iframe.title = 'Cleo Creator library';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    const win = doc.defaultView!;
    let port: MessagePort | null = null;
    let settled = false;

    const finish = (result: FrameConnection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.removeEventListener('message', onHello);
      if (!result.connected) { port?.close(); iframe.remove(); }
      resolve(result);
    };
    const connect = () => {
      if (port || settled || !iframe.contentWindow) return;
      const mc = new MessageChannel();
      port = mc.port1;
      port.onmessage = (e: MessageEvent<FromFrame>) => {
        if (e.data?.kind !== 'ready') return;
        const { backend, channel } = wirePort(port as unknown as PortLike);
        setCreatorBackend(backend);
        setCreatorChannel(channel);
        if (e.data.storageAccess === false) console.warn('[Creator library] the storage frame reports partitioned storage: the editor may not see these assets');
        finish({ connected: true, storageAccess: e.data.storageAccess });
      };
      iframe.contentWindow.postMessage({ type: CONNECT }, origin, [mc.port2]);
    };
    // The frame's hello, or its load event: whichever comes first (a module script may run after `load`'s
    // listeners are added, or before).
    const onHello = (e: MessageEvent) => { if (e.source === iframe.contentWindow && e.origin === origin && e.data?.type === HELLO) connect(); };
    win.addEventListener('message', onHello);
    iframe.addEventListener('load', connect);
    iframe.addEventListener('error', () => finish({ connected: false, reason: 'the storage frame did not load' }));
    const timer = setTimeout(() => finish({ connected: false, reason: `the storage frame at ${origin} did not answer` }), timeoutMs);
    doc.body.appendChild(iframe);
  });
}

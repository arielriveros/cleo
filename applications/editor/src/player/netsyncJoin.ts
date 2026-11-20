import type { PlayerNetSync } from './boot';

// Where a published game finds its NetSync host, from the page's address:
//
//   ?join=<JSON>        a join ticket, URL-encoded: { endpoint, token?, name? } — what the allocator hands out
//                       (docs/design/netsync.md §7.2), and what Play › Multiplayer opens peers with
//   ?wt=<https://host:port/path>&hash=<base64 cert hash>&ws=<wss://…>&name=<player name>
//                       the same, spelled out (a host started by hand: cleo-host prints these)
//   &transport=websocket | webtransport      force one link (the fallback, played on purpose)
//   &lag=<ms>&jitter=<ms>&loss=<percent>     a worse network, simulated on this side (Play › Multiplayer)
//
// No parameters: a game published for online play (Project ▸ NetSync, `config.netsync.allocator`) asks its
// allocator for a host (POST /join, the mode from `?mode=` or the project's); any other game is played alone.

export function netsyncFromUrl(search: string = location.search): PlayerNetSync | null {
  const q = new URLSearchParams(search);
  let net: PlayerNetSync | null = null;
  const join = q.get('join');
  if (join) {
    const ticket = JSON.parse(join);
    if (!ticket?.endpoint) throw new Error('The join ticket in this address has no endpoint.');
    net = { endpoint: ticket.endpoint, token: ticket.token, name: ticket.name };
  } else if (q.get('wt') || q.get('ws')) {
    const wt = q.get('wt'), hash = q.get('hash'), ws = q.get('ws');
    net = {
      endpoint: {
        ...(wt ? { webTransport: { url: wt, ...(hash ? { certHashes: [hash] } : {}) } } : {}),
        ...(ws ? { webSocket: { url: ws } } : {}),
      },
    };
  }
  if (!net) return null;
  const name = q.get('name');
  if (name) net.name = name;
  const transport = q.get('transport');
  if (transport === 'websocket' || transport === 'webtransport') net.connectOptions = { only: transport };
  const conditions = conditionsFrom(q);
  if (conditions) net.conditions = conditions;
  return net;
}

/** `lag` (one-way ms), `jitter` (ms) and `loss` (percent) from an address, each clamped; null with none of them. */
export function conditionsFrom(q: URLSearchParams): PlayerNetSync['conditions'] | null {
  const read = (k: string, max: number) => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0;
  };
  const latencyMs = read('lag', 1000), jitterMs = read('jitter', 500), loss = read('loss', 50) / 100;
  return latencyMs || jitterMs || loss ? { latencyMs, jitterMs, loss } : null;
}

/** A join ticket from the game's allocator, for a game published for online play; null for any other game. */
export async function netsyncFromAllocator(config: any, search: string = location.search,
                                           fetchImpl: typeof fetch = fetch): Promise<PlayerNetSync | null> {
  const allocator: unknown = config?.netsync?.allocator;
  if (typeof allocator !== 'string' || !allocator) return null;
  const q = new URLSearchParams(search);
  const mode = q.get('mode') ?? config.netsync.mode ?? undefined;
  const name = q.get('name') ?? undefined;
  const res = await fetchImpl(new URL('join', allocator.endsWith('/') ? allocator : `${allocator}/`).toString(), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(mode ? { mode } : {}), ...(name ? { name } : {}), ...(q.get('session') ? { session: q.get('session') } : {}) }),
  }).catch((e) => { throw new Error(`Could not reach the game's server (${(e as Error)?.message ?? e}).`); });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`The game's server could not find a game to join: ${body?.error ?? `HTTP ${res.status}`}.`);
  const net: PlayerNetSync = { endpoint: body.endpoint, token: body.token, name: body.name };
  const transport = q.get('transport');
  if (transport === 'websocket' || transport === 'webtransport') net.connectOptions = { only: transport };
  return net;
}

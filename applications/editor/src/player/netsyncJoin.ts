import type { PlayerNetSync } from './boot';

// Where a published game finds its NetSync host, from the page's address:
//
//   ?join=<JSON>        a join ticket, URL-encoded: { endpoint, token?, name? } — what the allocator hands out
//                       (docs/design/netsync.md §7.2), and what Play › Multiplayer opens peers with
//   ?wt=<https://host:port/path>&hash=<base64 cert hash>&ws=<wss://…>&name=<player name>
//                       the same, spelled out (a host started by hand: cleo-host prints these)
//   &transport=websocket | webtransport      force one link (the fallback, played on purpose)
//
// No parameters: the game is played alone, as before.

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
  return net;
}

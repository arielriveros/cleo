#!/usr/bin/env node
// Runs the browser probe from Node against an in-process host, over each link the page can pick:
// WebTransport, forced WebSocket, and WebTransport "blocked" (wrong port → fallback). Exits 1 on any failure.
//
//   node selftest.mjs
import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import { startHost } from './host.mjs';
import { runProbe } from './public/probe.js';

await quicheLoaded;
const { info, stop } = await startHost({ wtPort: 0, httpPort: 0, httpsPort: 0, quiet: true });
const base = `http://127.0.0.1:${info.httpPort}`;

const cases = [
    { label: 'webtransport', opts: {}, expect: 'webtransport' },
    { label: 'force-ws', opts: { force: 'ws' }, expect: 'websocket' },
    { label: 'udp-blocked', opts: { wtPort: 9, wtTimeoutMs: 1500 }, expect: 'websocket' },
];

let failed = 0;
for (const c of cases) {
    let r;
    try {
        r = await runProbe({ base, WebTransportImpl: WebTransport, ...c.opts });
    } catch (e) {
        console.log(`✗ ${c.label}: ${e?.stack ?? e}`);
        failed++;
        continue;
    }
    const ok = r.link.kind === c.expect && r.errors.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${c.label}: link=${r.link.kind}${r.link.fallbackReason ? ` (${r.link.fallbackReason})` : ''} writer=${r.link.datagramWriter}`);
    for (const [k, v] of Object.entries(r.tests)) console.log(`    ${k}: ${JSON.stringify(v)}`);
    for (const e of r.errors) console.log(`    ERROR ${e}`);
}
await stop();
console.log(failed ? `${failed} case(s) failed` : 'all cases passed');
process.exit(failed ? 1 : 0);

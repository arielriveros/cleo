// NetSync phase-0 spike: the measurements a peer runs over a link (docs/design/netsync.md §4.5). Same code in
// the browser page and the Node self-test. Returns one plain JSON report.
import { CTRL, DGRAM, echoMsg, jsonMsg, readJson, readSeq, seqDatagram, sizeDatagram } from './protocol.js';
import { connect } from './link.js';

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const r = (v) => Math.round(v * 100) / 100;
    return { n: s.length, min: r(s[0]), p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1]) };
}

/**
 * Connect, run every test, close. `log` gets one line per step (the page shows them as they come).
 * @param {object} o   connect() options, plus `log`
 */
export async function runProbe(o) {
    const log = o.log ?? (() => {});
    const report = {
        when: new Date().toISOString(),
        userAgent: globalThis.navigator?.userAgent ?? `node ${globalThis.process?.version}`,
        features: {
            webTransport: typeof (o.WebTransportImpl ?? globalThis.WebTransport) === 'function',
            secureContext: globalThis.isSecureContext ?? null,
        },
        options: { force: o.force ?? null, wtPort: o.wtPort ?? null },
        link: null,
        tests: {},
        errors: [],
    };

    log('connecting…');
    const link = await connect(o);
    report.link = {
        kind: link.kind, fallbackReason: link.fallbackReason, connectMs: Math.round(link.connectMs),
        maxDatagramSize: link.maxDatagramSize, datagramWriter: link.writerKind,
    };
    log(`connected over ${link.kind} in ${Math.round(link.connectMs)} ms${link.fallbackReason ? ` (fallback: ${link.fallbackReason})` : ''}`);

    // Route control replies to whoever is waiting for that type.
    const waiters = new Map();
    const waitFor = (type, ms = 5000) => new Promise((resolve, reject) => {
        const t = setTimeout(() => { waiters.delete(type); reject(new Error(`no reply ${type} in ${ms} ms`)); }, ms);
        waiters.set(type, (m) => { clearTimeout(t); waiters.delete(type); resolve(m); });
    });
    const echoes = new Map();
    link.onControl = (m) => {
        if (m[0] === CTRL.echo) { const { seq } = readSeq(m); echoes.get(seq)?.(); return; }
        waiters.get(m[0])?.(m);
    };
    let onDgram = null;
    link.onDatagram = (m) => onDgram?.(m);
    let onBulk = null;
    link.onBulk = (b) => onBulk?.(b);

    const step = async (name, fn) => {
        log(`${name}…`);
        try { report.tests[name] = await fn(); log(`${name}: ${JSON.stringify(report.tests[name])}`); }
        catch (e) { report.errors.push(`${name}: ${e?.message ?? e}`); log(`${name} FAILED: ${e?.message ?? e}`); }
    };

    try {
        await step('handshake', async () => {
            const reply = waitFor(CTRL.welcome);
            const t0 = now();
            link.sendControl(jsonMsg(CTRL.hello, { ua: report.userAgent, linkKind: link.kind }));
            const w = readJson(await reply);
            return { ms: Math.round(now() - t0), peerId: w.peerId, hostLinkKind: w.linkKind };
        });

        let echoId = 0;
        const echo = () => new Promise((resolve, reject) => {
            const id = ++echoId;
            const t0 = now();
            const t = setTimeout(() => { echoes.delete(id); reject(new Error('echo lost')); }, 5000);
            echoes.set(id, () => { clearTimeout(t); echoes.delete(id); resolve(now() - t0); });
            link.sendControl(echoMsg(id, t0));
        });

        await step('controlRtt', async () => {
            const rtts = [];
            for (let i = 0; i < 20; i++) rtts.push(await echo());
            return stats(rtts);
        });

        await step('datagramPing', async () => {
            const sent = new Map();
            const rtts = [];
            onDgram = (m) => {
                if (m[0] !== DGRAM.pong) return;
                const { seq } = readSeq(m);
                const t0 = sent.get(seq);
                if (t0 !== undefined) { rtts.push(now() - t0); sent.delete(seq); }
            };
            const N = 100;
            let accepted = 0;
            const start = now();
            for (let i = 0; i < N; i++) {
                const t0 = now();
                sent.set(i, t0);
                if (link.sendDatagram(seqDatagram(DGRAM.ping, i, t0))) accepted++;
                await sleep(Math.max(0, start + (i + 1) * (1000 / 30) - now()));
            }
            await sleep(1000);
            onDgram = null;
            return { sent: N, accepted, received: rtts.length, lossPct: Math.round((1 - rtts.length / N) * 1000) / 10, rtt: stats(rtts) };
        });

        await step('hostPulses', async () => {
            const size = Math.min(1000, link.maxDatagramSize ?? 1000);
            const count = 150;
            const seen = new Set();
            let outOfOrder = 0, last = -1, lastAt = null;
            const gaps = [];
            onDgram = (m) => {
                if (m[0] !== DGRAM.pulse) return;
                const { seq } = readSeq(m);
                if (seq < last) outOfOrder++;
                last = Math.max(last, seq);
                seen.add(seq);
                const t = now();
                if (lastAt !== null) gaps.push(t - lastAt);
                lastAt = t;
            };
            const done = waitFor(CTRL.pulsesDone, 15000);
            link.sendControl(jsonMsg(CTRL.pulses, { hz: 30, size, count }));
            const d = readJson(await done);
            await sleep(500);
            onDgram = null;
            return {
                size, requested: count, hostSent: d.sent, hostSkipped: d.skipped, received: seen.size,
                lossPct: Math.round((1 - seen.size / count) * 1000) / 10, outOfOrder, interArrivalMs: stats(gaps),
            };
        });

        await step('datagramSizes', async () => {
            const sizes = [200, 500, 800, 1000, 1100, 1150, 1200, 1250, 1300, 1400, 1500, 2000];
            link.sendControl(jsonMsg(CTRL.sizeBegin));
            await sleep(100);
            const accepted = {};
            for (const s of sizes) for (let k = 0; k < 3; k++) {
                let ok = false;
                try { ok = link.sendDatagram(sizeDatagram(s)); } catch { ok = false; }
                accepted[s] = (accepted[s] ?? 0) + (ok ? 1 : 0);
                await sleep(10);
            }
            await sleep(500);
            const reply = waitFor(CTRL.sizeResult);
            link.sendControl(jsonMsg(CTRL.sizeEnd));
            const { received } = readJson(await reply);
            const largestDelivered = Math.max(0, ...Object.keys(received).map(Number));
            return { sentEach: 3, received, largestDelivered };
        });

        await step('bulkWithControl', async () => {
            const bytes = 2 * 1024 * 1024;
            let got = 0;
            const t0 = now();
            const finished = new Promise((resolve) => {
                onBulk = (b) => { got += b.length; if (got >= bytes) resolve(now() - t0); };
            });
            link.sendControl(jsonMsg(CTRL.bulk, { bytes }));
            // Keep the control lane busy during the transfer: on WebTransport its latency should not move.
            const during = [];
            let transferring = true;
            const pinger = (async () => { while (transferring) { during.push(await echo()); await sleep(50); } })();
            const ms = await Promise.race([finished, sleep(30000).then(() => null)]);
            transferring = false;
            await pinger.catch(() => {});
            onBulk = null;
            if (ms === null) throw new Error(`bulk incomplete: ${got} of ${bytes} bytes in 30 s`);
            return { bytes, ms: Math.round(ms), mbps: Math.round((bytes * 8) / (ms * 1000) * 10) / 10, controlRttDuring: stats(during) };
        });
    } finally {
        link.close();
    }
    log('done');
    return report;
}

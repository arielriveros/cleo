// NetSync phase-0 spike: the wire format both ends share. Plain ES module with no dependencies, so the browser
// page, the Node host and the Node self-test all import this same file.
//
// Lanes (docs/design/netsync.md §4.2):
//   control — reliable, ordered. WebTransport: one bidirectional stream, messages framed `u32 length | payload`.
//   bulk    — reliable, one-off transfers. WebTransport: one unidirectional stream per transfer.
//   pulse   — unreliable datagrams. Every datagram is self-contained.
// Over a WebSocket all three ride one connection; each WebSocket message is `u8 lane | payload`.

export const LANE = { control: 0, bulk: 1, pulse: 2 };

/** Control message types: the first byte of a control payload. */
export const CTRL = {
    hello: 1,        // peer → host  json { ua, linkKind }
    welcome: 2,      // host → peer  json { peerId, linkKind, hostTime }
    echo: 3,         // both ways    u32 id | f64 sentAt  (the host returns it unchanged)
    pulses: 4,       // peer → host  json { hz, size, count }: send that many pulse datagrams
    pulsesDone: 5,   // host → peer  json { sent, skipped }
    sizeBegin: 6,    // peer → host  forget earlier size-probe datagrams
    sizeEnd: 7,      // peer → host  report which size-probe datagrams arrived
    sizeResult: 8,   // host → peer  json { received: { [size]: count } }
    bulk: 9,         // peer → host  json { bytes }: send that many bytes on the bulk lane
};

/** Datagram kinds: the first byte of a pulse-lane payload. */
export const DGRAM = {
    ping: 1,   // peer → host  u32 seq | f64 sentAt
    pong: 2,   // host → peer  the ping, returned
    pulse: 3,  // host → peer  u32 seq | f64 hostTime | padding
    size: 4,   // peer → host  u16 size | padding (size probe)
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export function jsonMsg(type, value) {
    const body = enc.encode(JSON.stringify(value ?? {}));
    const out = new Uint8Array(1 + body.length);
    out[0] = type;
    out.set(body, 1);
    return out;
}

export function readJson(msg) {
    return JSON.parse(dec.decode(msg.subarray(1)));
}

export function echoMsg(id, sentAt) {
    const out = new Uint8Array(13);
    const dv = new DataView(out.buffer);
    out[0] = CTRL.echo;
    dv.setUint32(1, id);
    dv.setFloat64(5, sentAt);
    return out;
}

/** `kind | u32 seq | f64 time`, padded with zeros to `size` bytes. */
export function seqDatagram(kind, seq, time, size = 13) {
    const out = new Uint8Array(Math.max(13, size));
    const dv = new DataView(out.buffer);
    out[0] = kind;
    dv.setUint32(1, seq);
    dv.setFloat64(5, time);
    return out;
}

export function readSeq(msg) {
    const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    return { seq: dv.getUint32(1), time: dv.getFloat64(5) };
}

export function sizeDatagram(size) {
    const out = new Uint8Array(size);
    out[0] = DGRAM.size;
    new DataView(out.buffer).setUint16(1, size);
    return out;
}

/** `u32 length | payload` — control-stream framing on WebTransport. */
export function frame(payload) {
    const out = new Uint8Array(4 + payload.length);
    new DataView(out.buffer).setUint32(0, payload.length);
    out.set(payload, 4);
    return out;
}

/** Feed it stream chunks; it calls `onMessage` once per whole framed message. */
export function frameReader(onMessage) {
    let buf = new Uint8Array(0);
    return (chunk) => {
        const next = new Uint8Array(buf.length + chunk.length);
        next.set(buf, 0);
        next.set(chunk, buf.length);
        buf = next;
        while (buf.length >= 4) {
            const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
            if (buf.length < 4 + len) break;
            onMessage(buf.slice(4, 4 + len));
            buf = buf.slice(4 + len);
        }
    };
}

export function withLane(lane, payload) {
    const out = new Uint8Array(1 + payload.length);
    out[0] = lane;
    out.set(payload, 1);
    return out;
}

export function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

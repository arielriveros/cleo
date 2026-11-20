// How a synced node's state is written on the wire (docs/design/netsync.md §6.4). Quantized, so two states that
// look the same to a player compare equal — which is what lets the host skip a node that has not visibly moved.
//
//   position  3 × int32, 1/1024 m (≈1 mm) — ±2 000 km, more than any scene
//   rotation  "smallest three": the largest component is dropped (2 bits say which), the other three are
//             10 bits each over ±1/√2 — 32 bits, under 0.25° of error (measured: 0.23° worst of 2000)
//   velocity  3 × int16, 1/64 m/s — ±512 m/s; only for extrapolating a body when pulses are late

import { ByteReader, ByteWriter } from '../bytes';

export const POSITION_SCALE = 1024;
export const VELOCITY_SCALE = 64;
const ROT_BITS = 10;
const ROT_MAX = (1 << ROT_BITS) - 1;
const ROT_RANGE = Math.SQRT1_2;

/** One node's state, quantized. Integers throughout, so `sameState` is exact. */
export interface QState {
    px: number; py: number; pz: number;
    /** Smallest-three packed quaternion (unsigned 32-bit). */
    rot: number;
    /** Velocity, or absent when the node has no body. */
    vx?: number; vy?: number; vz?: number;
    sleeping: boolean;
}

const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));

export function quantizePosition(p: ArrayLike<number>): [number, number, number] {
    const c = (v: number) => clampInt(v * POSITION_SCALE, -0x7fffffff, 0x7fffffff);
    return [c(p[0]), c(p[1]), c(p[2])];
}

export function quantizeVelocity(v: ArrayLike<number>): [number, number, number] {
    const c = (x: number) => clampInt(x * VELOCITY_SCALE, -0x7fff, 0x7fff);
    return [c(v[0]), c(v[1]), c(v[2])];
}

/** Pack a unit quaternion [x, y, z, w] into 32 bits (smallest three). */
export function packQuaternion(q: ArrayLike<number>): number {
    let largest = 0;
    for (let i = 1; i < 4; i++) if (Math.abs(q[i]) > Math.abs(q[largest])) largest = i;
    // q and -q are the same rotation: flip so the dropped component is positive and can be rebuilt as +√(…).
    const sign = q[largest] < 0 ? -1 : 1;
    let packed = largest;
    for (let i = 0; i < 4; i++) {
        if (i === largest) continue;
        const v = (q[i] * sign + ROT_RANGE) / (2 * ROT_RANGE);
        packed = packed * (ROT_MAX + 1) + clampInt(v * ROT_MAX, 0, ROT_MAX);
    }
    return packed >>> 0;
}

/** Unpack {@link packQuaternion}'s 32 bits into `out` (normalized). */
export function unpackQuaternion(packed: number, out: number[] | Float32Array = [0, 0, 0, 1]): number[] | Float32Array {
    const values: number[] = [];
    let rest = packed >>> 0;
    for (let k = 0; k < 3; k++) {
        values.unshift(((rest % (ROT_MAX + 1)) / ROT_MAX) * 2 * ROT_RANGE - ROT_RANGE);
        rest = Math.floor(rest / (ROT_MAX + 1));
    }
    const largest = rest & 3;
    let sum = 0;
    for (const v of values) sum += v * v;
    let j = 0;
    for (let i = 0; i < 4; i++) out[i] = i === largest ? Math.sqrt(Math.max(0, 1 - sum)) : values[j++];
    const len = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
    for (let i = 0; i < 4; i++) out[i] /= len;
    return out;
}

/** Quantize a node's local position and rotation, and a body's velocity when given. */
export function quantizeState(position: ArrayLike<number>, quaternion: ArrayLike<number>, velocity: ArrayLike<number> | null, sleeping: boolean): QState {
    const [px, py, pz] = quantizePosition(position);
    const s: QState = { px, py, pz, rot: packQuaternion(quaternion), sleeping };
    if (velocity) {
        const [vx, vy, vz] = quantizeVelocity(velocity);
        s.vx = vx; s.vy = vy; s.vz = vz;
    }
    return s;
}

/** Whether a peer holding `a` would see nothing different in `b`. */
export function sameState(a: QState | undefined, b: QState): boolean {
    return !!a && a.px === b.px && a.py === b.py && a.pz === b.pz && a.rot === b.rot
        && a.vx === b.vx && a.vy === b.vy && a.vz === b.vz && a.sleeping === b.sleeping;
}

// Row flags.
const HAS_VELOCITY = 1;
const SLEEPING = 2;

/** Bytes one row takes: netId + flags + position + rotation (+ velocity). */
export function rowSize(netId: number, s: QState): number {
    let idBytes = 1;
    for (let v = netId; v >= 0x80; v = Math.floor(v / 0x80)) idBytes++;
    return idBytes + 1 + 12 + 4 + (s.vx !== undefined ? 6 : 0);
}

export function writeRow(w: ByteWriter, netId: number, s: QState): void {
    w.varUint(netId);
    w.u8((s.vx !== undefined ? HAS_VELOCITY : 0) | (s.sleeping ? SLEEPING : 0));
    w.u32(s.px >>> 0).u32(s.py >>> 0).u32(s.pz >>> 0);
    w.u32(s.rot);
    if (s.vx !== undefined) w.u16(s.vx & 0xffff).u16(s.vy! & 0xffff).u16(s.vz! & 0xffff);
}

export function readRow(r: ByteReader): { netId: number; state: QState } {
    const netId = r.varUint();
    const flags = r.u8();
    const i32 = (v: number) => v | 0;
    const i16 = (v: number) => (v << 16) >> 16;
    const state: QState = { px: i32(r.u32()), py: i32(r.u32()), pz: i32(r.u32()), rot: r.u32(), sleeping: (flags & SLEEPING) !== 0 };
    if (flags & HAS_VELOCITY) { state.vx = i16(r.u16()); state.vy = i16(r.u16()); state.vz = i16(r.u16()); }
    return { netId, state };
}

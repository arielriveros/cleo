// The sync layer's messages (docs/design/netsync.md §6). Types start at FIRST_APP_TYPE: below it is the session's.
//
// Control lane (reliable, ordered) — what a peer must not miss:
//   table    the scene's synced nodes, NetId ↔ node id, and which scene (an `epoch` that changes with it)
//   spawn    a template instantiated at runtime: its NetId, its root's parent, the ids its subtree's nodes got
//            on the host (so the peer's copy has the very same ids), and its synced descendants' NetIds
//   despawn  nodes removed from the scene: spawned copies' roots (by id) and synced nodes (by NetId)
// Pulse lane (unreliable) — the state that changes every tick:
//   pulse    host → peer: epoch, tick, a per-peer datagram sequence number, rows of quantized node state
//            (sync/quantize.ts). A tick's rows can span several datagrams, so acknowledgement is per datagram.
//   ack      peer → host: the newest pulse sequence number received and which of the 32 before it arrived

import { ByteReader, ByteWriter } from '../bytes';
import { FIRST_APP_TYPE } from '../session/messages';

export const SyncControl = {
    table: FIRST_APP_TYPE,
    spawn: FIRST_APP_TYPE + 1,
    despawn: FIRST_APP_TYPE + 2,
} as const;

export const SyncPulse = {
    pulse: FIRST_APP_TYPE,
    ack: FIRST_APP_TYPE + 1,
} as const;

/** Header bytes of a pulse before its rows: type, epoch, tick, sequence, row count (≤ 2 bytes each varint). */
export const PULSE_HEADER_BYTES = 1 + 2 + 4 + 4 + 2;

export interface SyncTable {
    /** Bumped when the host starts another scene: messages from an older epoch are ignored. */
    epoch: number;
    sceneId: string;
    entries: { netId: number; nodeId: string }[];
}

export interface SyncSpawn {
    epoch: number;
    /** NetId of the spawned root when it is synced itself, else 0. */
    netId: number;
    template: string;
    /** Id of the node the copy was added under; empty for the scene root. */
    parentId: string;
    /** Every node id in the copy, depth first, root first — as the host's copy has them. */
    ids: string[];
    /** Synced nodes inside the copy: index into `ids` → NetId. */
    synced: { index: number; netId: number }[];
}

export interface SyncDespawn {
    epoch: number;
    /** Nodes to remove (with their subtrees): the roots of spawned copies, and removed authored nodes. */
    nodeIds: string[];
    /** NetIds no longer in use. */
    netIds: number[];
}

export function encodeTable(t: SyncTable): Uint8Array {
    const w = new ByteWriter(64 + t.entries.length * 40).u8(SyncControl.table).varUint(t.epoch).string(t.sceneId).varUint(t.entries.length);
    for (const e of t.entries) w.varUint(e.netId).string(e.nodeId);
    return w.finish();
}

export function decodeTable(r: ByteReader): SyncTable {
    const epoch = r.varUint();
    const sceneId = r.string();
    const n = r.varUint();
    const entries: SyncTable['entries'] = [];
    for (let i = 0; i < n; i++) entries.push({ netId: r.varUint(), nodeId: r.string() });
    return { epoch, sceneId, entries };
}

export function encodeSpawn(s: SyncSpawn): Uint8Array {
    const w = new ByteWriter(64 + s.ids.length * 40).u8(SyncControl.spawn).varUint(s.epoch).varUint(s.netId)
        .string(s.template).string(s.parentId).varUint(s.ids.length);
    for (const id of s.ids) w.string(id);
    w.varUint(s.synced.length);
    for (const e of s.synced) w.varUint(e.index).varUint(e.netId);
    return w.finish();
}

export function decodeSpawn(r: ByteReader): SyncSpawn {
    const epoch = r.varUint();
    const netId = r.varUint();
    const template = r.string();
    const parentId = r.string();
    const ids: string[] = [];
    for (let i = r.varUint(); i > 0; i--) ids.push(r.string());
    const synced: SyncSpawn['synced'] = [];
    for (let i = r.varUint(); i > 0; i--) synced.push({ index: r.varUint(), netId: r.varUint() });
    return { epoch, netId, template, parentId, ids, synced };
}

export function encodeDespawn(d: SyncDespawn): Uint8Array {
    const w = new ByteWriter(8 + d.nodeIds.length * 40 + d.netIds.length * 3).u8(SyncControl.despawn).varUint(d.epoch);
    w.varUint(d.nodeIds.length);
    for (const id of d.nodeIds) w.string(id);
    w.varUint(d.netIds.length);
    for (const id of d.netIds) w.varUint(id);
    return w.finish();
}

export function decodeDespawn(r: ByteReader): SyncDespawn {
    const epoch = r.varUint();
    const nodeIds: string[] = [];
    for (let i = r.varUint(); i > 0; i--) nodeIds.push(r.string());
    const netIds: number[] = [];
    for (let i = r.varUint(); i > 0; i--) netIds.push(r.varUint());
    return { epoch, nodeIds, netIds };
}

export function encodeAck(latestSeq: number, received: number): Uint8Array {
    return new ByteWriter(9).u8(SyncPulse.ack).u32(latestSeq).u32(received >>> 0).finish();
}

export function decodeAck(r: ByteReader): { latestSeq: number; received: number } {
    return { latestSeq: r.u32(), received: r.u32() };
}

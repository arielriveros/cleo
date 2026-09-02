// Storage for the graph's virtual resources. The one file here that touches the GPU.
//
// It owns `Framebuffer`s and nothing cleverer: the aliasing decision was already made in `compile`,
// and this only has to hand back the same object for the same slot and reallocate when the shape it
// is asked for changes. Allocation follows the idiom the renderer already uses in `_ensureTaaTargets`
// and `_createBloomMips` — allocate if absent, recreate if the dimensions moved, otherwise leave it be.

import { Framebuffer } from '../framebuffer';
import { slotKey } from './resources';
import type { SlotDesc } from './resources';
import type { ResourcePool } from './graph';

/** A framebuffer plus the shape it was built for, so a change of shape can be noticed. */
interface Held {
    readonly buffer: Framebuffer;
    readonly key: string;
}

export class FramebufferPool implements ResourcePool<Framebuffer> {
    private readonly _transient = new Map<number, Held>();
    private readonly _persistent = new Map<string, Held>();

    /**
     * Storage for an aliased slot. The SAME slot backs different resources at different points in the
     * frame, which is the whole saving; what it must not do is back two resources that are live at
     * once, and that is `compile`'s guarantee rather than this one's.
     */
    public transient(slot: number, desc: SlotDesc): Framebuffer {
        return this._resolve(this._transient, slot, desc);
    }

    /**
     * Storage for a resource that outlives the frame — a temporal history. Keyed by NAME, never by
     * slot index: indices move when the chain is reordered, and a history that moved with them would
     * come back holding another pass's pixels rather than last frame's own.
     */
    public persistent(name: string, desc: SlotDesc): Framebuffer {
        return this._resolve(this._persistent, name, desc);
    }

    /** Physical framebuffers alive right now — transient slots plus histories. */
    public get count(): number { return this._transient.size + this._persistent.size; }

    /** Bytes the pool is holding, for the renderer's GPU-memory estimate. */
    public get byteSize(): number {
        let bytes = 0;
        for (const held of [...this._transient.values(), ...this._persistent.values()]) {
            for (const color of held.buffer.colors) bytes += color.byteSize;
            if (held.buffer.depth) bytes += held.buffer.depth.byteSize;
        }
        return bytes;
    }

    /**
     * Release every transient slot at or above `slotCount`. Called after a compile whose graph got
     * smaller — switching an effect off frees its buffers rather than leaving them resident, which is
     * the difference between this and the eagerly-allocated fields it replaces.
     */
    public trim(slotCount: number): void {
        for (const [slot, held] of this._transient) {
            if (slot < slotCount) continue;
            held.buffer.destroy();
            this._transient.delete(slot);
        }
    }

    /** Release everything. The renderer calls this when the device goes away. */
    public destroy(): void {
        for (const held of this._transient.values()) held.buffer.destroy();
        for (const held of this._persistent.values()) held.buffer.destroy();
        this._transient.clear();
        this._persistent.clear();
    }

    private _resolve<K>(store: Map<K, Held>, key: K, desc: SlotDesc): Framebuffer {
        const wanted = slotKey(desc);
        const held = store.get(key);
        if (held && held.key === wanted) return held.buffer;

        // A shape change is a reallocation, not a resize: the format or the attachment count can
        // differ too, and `Framebuffer.resize` only moves the dimensions. Destroying first also
        // evicts the device's cached render target, which is keyed on the attachment set.
        held?.buffer.destroy();

        const buffer = new Framebuffer({
            // Zero colour attachments means depth and nothing else — the shape `usage: 'depth'` takes.
            usage: desc.colorAttachments > 0 ? 'color' : 'depth',
            colorAttachments: Math.max(1, desc.colorAttachments),
            // `format` bypasses the precision/channels inference and is still subject to the float
            // fallback in rhi/textureFormat.ts, so a device without renderable floats degrades here
            // exactly as every hand-allocated target already does.
            colorTextureOptions: { mipMap: false, format: desc.format },
            depth: desc.depth,
        });
        buffer.create(desc.extent.width, desc.extent.height);
        store.set(key, { buffer, key: wanted });
        return buffer;
    }
}

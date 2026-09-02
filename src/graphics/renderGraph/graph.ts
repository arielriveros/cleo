// The scheduler: it validates an ORDER it is given, works out how long each resource is live, and
// hands out storage. It does not derive the order — for a post chain the order is the user's, and a
// graph that re-derived it would be overruling them. What it can do is refuse an order that cannot
// run, which is the half currently written in comments.
//
// Generic over the physical resource type `P`, so this file imports no device and no framebuffer. The
// renderer instantiates it with `Framebuffer`; a test instantiates it with a string.

import { resolveExtent, slotKey } from './resources';
import type { Extent, ResourceDesc, SlotDesc } from './resources';

declare const RESOURCE_BRAND: unique symbol;
/** An index into the graph's resource table. Branded so a raw number cannot be passed by accident. */
export type ResourceId = number & { readonly [RESOURCE_BRAND]: true };

/**
 * How a pass reaches its buffers — and the reason the graph exists. Every accessor checks that the
 * pass DECLARED the access, so "this pass reads the scene depth" stops being a comment and becomes
 * something that throws the first time it is untrue.
 */
export interface PassContext<P> {
    /** Storage for a resource this pass declared in `writes` or `readWrites`. */
    target(id: ResourceId): P;
    /** Storage for a resource this pass declared in `reads` or `readWrites`. */
    read(id: ResourceId): P;
    /** The resolved size of a resource this pass touches, for the texel-size uniforms. */
    extent(id: ResourceId): Extent;
    /** The frame's render size. Not the canvas size — the present pass upscales. */
    readonly width: number;
    readonly height: number;
}

export interface PassDesc<P> {
    /** Stable identity, for errors and for the profiler row: `bloom`, `chromatic`, `material:<id>`. */
    readonly id: string;
    /**
     * The profiler scope this pass reports under — a `RenderPass` from `gpuProfiler`. Kept as a plain
     * string here so this module imports nothing: the renderer supplies a value from that union, and
     * `tests/gpuProfilerLabels` is what checks the two agree.
     */
    readonly scope: string;
    readonly reads?: readonly ResourceId[];
    readonly writes?: readonly ResourceId[];
    /**
     * Read AND written in place. Its own list rather than membership of both, because the pair means
     * something a graph must not "optimize": god rays composite additively INTO the buffer they read,
     * so that resource cannot be aliased onto anything live at the same moment.
     */
    readonly readWrites?: readonly ResourceId[];
    readonly execute: (ctx: PassContext<P>) => void;
}

/** Where a pass's storage comes from. `persistent` is keyed by NAME — see the note in `_storage`. */
export interface ResourcePool<P> {
    transient(slot: number, desc: SlotDesc): P;
    persistent(name: string, desc: SlotDesc): P;
}

interface Entry {
    readonly desc: ResourceDesc;
    /** Supplied at import time. Undefined for anything the graph allocates. */
    readonly imported?: unknown;
    /** Pass index that first wrote it, and last read it. -1 until `compile` fills them in. */
    firstWrite: number;
    lastRead: number;
    /** Transient slot index, or -1 for an imported or persistent resource. */
    slot: number;
}

export class RenderGraphError extends Error {}

export class RenderGraphBuilder<P> {
    private readonly _entries: Entry[] = [];
    private readonly _passes: PassDesc<P>[] = [];
    private readonly _names = new Set<string>();

    /** A resource the graph allocates. `transient` may be aliased; `persistent` never is. */
    public declare(desc: ResourceDesc): ResourceId {
        if (desc.lifetime === 'imported')
            throw new RenderGraphError(`'${desc.name}' is imported; use importResource`);
        return this._add(desc, undefined);
    }

    /** A resource the graph only ORDERS: storage, size and lifetime all belong to the caller. */
    public importResource(desc: ResourceDesc, physical: P): ResourceId {
        if (desc.lifetime !== 'imported')
            throw new RenderGraphError(`'${desc.name}' is not imported; use declare`);
        return this._add(desc, physical);
    }

    public addPass(pass: PassDesc<P>): void {
        const seen = new Set<number>();
        for (const id of [...(pass.reads ?? []), ...(pass.writes ?? []), ...(pass.readWrites ?? [])]) {
            if (id < 0 || id >= this._entries.length)
                throw new RenderGraphError(`pass '${pass.id}' names resource ${id}, which does not exist`);
            // A resource in two of the three lists is ambiguous: `readWrites` already MEANS both, and
            // listing it as a read and a write besides leaves the aliasing question unanswerable.
            if (seen.has(id))
                throw new RenderGraphError(
                    `pass '${pass.id}' names '${this._entries[id].desc.name}' more than once`);
            seen.add(id);
        }
        this._passes.push(pass);
    }

    /**
     * Check that the order runs, compute lifetimes, assign slots.
     *
     * Passes keep the order they were added in. The only ordering ERROR possible in a linear list is
     * reading something nothing has produced yet — and that is exactly what a reordered chain
     * produces, which is why it is checked here rather than trusted.
     */
    public compile(renderWidth: number, renderHeight: number): CompiledGraph<P> {
        const written = new Set<number>();
        for (let index = 0; index < this._passes.length; index++) {
            const pass = this._passes[index];
            for (const id of [...(pass.reads ?? []), ...(pass.readWrites ?? [])]) {
                const entry = this._entries[id];
                // An import arrives already filled by whatever ran before the graph.
                if (entry.desc.lifetime !== 'imported' && !written.has(id))
                    throw new RenderGraphError(
                        `pass '${pass.id}' reads '${entry.desc.name}' before any pass writes it`);
                entry.lastRead = index;
            }
            for (const id of [...(pass.writes ?? []), ...(pass.readWrites ?? [])]) {
                const entry = this._entries[id];
                if (entry.firstWrite < 0) entry.firstWrite = index;
                // A resource written but never read still needs storage for the pass that writes it.
                if (entry.lastRead < index) entry.lastRead = index;
                written.add(id);
            }
        }

        const slots: SlotDesc[] = [];
        // Free lists per aliasing bucket: a slot index, and the pass after which it comes free.
        const buckets = new Map<string, { slot: number; freeAfter: number }[]>();

        // By first write, so a slot is only ever offered to a resource that starts after it ends.
        const transients = this._entries
            .map((entry, id) => ({ entry, id }))
            .filter(({ entry }) => entry.desc.lifetime === 'transient' && entry.firstWrite >= 0)
            .sort((a, b) => a.entry.firstWrite - b.entry.firstWrite || a.id - b.id);

        for (const { entry } of transients) {
            const desc = this._slotDesc(entry.desc, renderWidth, renderHeight);
            const key = slotKey(desc);
            const free = buckets.get(key) ?? [];
            // STRICTLY before: a slot whose last read is this resource's first write is still being
            // read by that very pass, and handing it over is a read/write feedback on one texture.
            const reuse = free.find(candidate => candidate.freeAfter < entry.firstWrite);
            if (reuse) {
                entry.slot = reuse.slot;
                reuse.freeAfter = entry.lastRead;
            } else {
                entry.slot = slots.length;
                slots.push(desc);
                free.push({ slot: entry.slot, freeAfter: entry.lastRead });
                buckets.set(key, free);
            }
        }

        return new CompiledGraph<P>(this._entries, this._passes, slots, renderWidth, renderHeight);
    }

    private _add(desc: ResourceDesc, imported: unknown): ResourceId {
        // The name is the pool's key for a persistent and the reader's only handle in an error, so a
        // duplicate would silently make one of the two unreachable.
        if (this._names.has(desc.name))
            throw new RenderGraphError(`duplicate resource name '${desc.name}'`);
        this._names.add(desc.name);
        this._entries.push({ desc, imported, firstWrite: -1, lastRead: -1, slot: -1 });
        return (this._entries.length - 1) as ResourceId;
    }

    private _slotDesc(desc: ResourceDesc, width: number, height: number): SlotDesc {
        return {
            format: desc.format,
            colorAttachments: desc.colorAttachments,
            depth: desc.depth,
            extent: resolveExtent(desc.size, width, height),
        };
    }
}

export class CompiledGraph<P> {
    constructor(
        private readonly _entries: readonly Entry[],
        private readonly _passes: readonly PassDesc<P>[],
        /** One descriptor per aliased transient slot. Its length is what the pool has to allocate. */
        public readonly slots: readonly SlotDesc[],
        private readonly _width: number,
        private readonly _height: number,
    ) {}

    /** Pass ids in execution order. For the profiler, and for tests that assert an order survived. */
    public get order(): string[] { return this._passes.map(pass => pass.id); }

    /** The transient slot backing a resource, or -1 when it is imported or persistent. */
    public slotOf(id: ResourceId): number { return this._entries[id].slot; }

    /** The pass range a resource is live over, for tests and for a memory report. */
    public lifetimeOf(id: ResourceId): { firstWrite: number; lastRead: number } {
        const entry = this._entries[id];
        return { firstWrite: entry.firstWrite, lastRead: entry.lastRead };
    }

    /**
     * Run every pass in order.
     *
     * `onPass` is the profiler's kill switch and its scope in one call, exactly as `Renderer._beginPass`
     * does it: a pass that is switched off must not also be timed. Returning false skips the pass.
     *
     * No encoder flush between passes, deliberately. The renderer keeps ONE encoder per frame and
     * `_exposurePass` defers its readback to the end of it — a `readPixels` between two passes
     * redirects everything after it, and on WebGL2 it cost the context outright.
     */
    public execute(pool: ResourcePool<P>, onPass?: (scope: string) => boolean): void {
        for (const pass of this._passes) {
            if (onPass && !onPass(pass.scope)) continue;
            pass.execute(this._contextFor(pass, pool));
        }
    }

    private _contextFor(pass: PassDesc<P>, pool: ResourcePool<P>): PassContext<P> {
        const readable = new Set<ResourceId>([...(pass.reads ?? []), ...(pass.readWrites ?? [])]);
        const writable = new Set<ResourceId>([...(pass.writes ?? []), ...(pass.readWrites ?? [])]);
        const resolve = (id: ResourceId, allowed: Set<ResourceId>, verb: string): P => {
            if (!allowed.has(id)) {
                const name = this._entries[id]?.desc.name ?? String(id);
                throw new RenderGraphError(`pass '${pass.id}' ${verb} '${name}' without declaring it`);
            }
            return this._storage(id, pool);
        };
        return {
            target: id => resolve(id, writable, 'writes'),
            read: id => resolve(id, readable, 'reads'),
            extent: id => resolveExtent(this._entries[id].desc.size, this._width, this._height),
            width: this._width,
            height: this._height,
        };
    }

    private _storage(id: ResourceId, pool: ResourcePool<P>): P {
        const entry = this._entries[id];
        if (entry.desc.lifetime === 'imported') return entry.imported as P;
        const desc: SlotDesc = {
            format: entry.desc.format,
            colorAttachments: entry.desc.colorAttachments,
            depth: entry.desc.depth,
            extent: resolveExtent(entry.desc.size, this._width, this._height),
        };
        // Persistent storage is keyed by NAME rather than by slot index on purpose: slot indices shift
        // whenever the chain is reordered, and a temporal history that moved with them would come back
        // pointing at another pass's pixels the first time somebody dragged a row in the inspector.
        if (entry.desc.lifetime === 'persistent') return pool.persistent(entry.desc.name, desc);
        return pool.transient(entry.slot, desc);
    }
}

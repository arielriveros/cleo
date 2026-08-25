/**
 * Writing uniforms by NAME into a uniform buffer, from a build-time layout.
 *
 * `UniformBlockSet` does this on WebGL2 using offsets the driver reports. WebGPU reports nothing — a
 * uniform buffer is bytes and the shader reads whatever sits where its struct says — so the offsets
 * come from `tools/wgslLayout.mjs` instead, shipped on every `.wgsl` import and checked member for
 * member against a real driver by `tools/harness/uniformLayoutCheck.js`.
 *
 * The point of the exercise is that `setUniform('u_exposure', 2.0)` keeps working. ~380 call sites in
 * `renderer.ts` pass values by name and must not learn which backend they are talking to, so the
 * name-to-offset step is the backend's problem, and this is where it is solved for WebGPU.
 *
 * **A block is an ARENA of slots, not a single struct.** `queue.writeBuffer` is ordered against the
 * SUBMIT, not against the commands already recorded — so a pass that draws twenty objects, writing
 * `u_model` before each one, would have every one of those draws read the LAST value written, and the
 * pass would render twenty copies of the last object. So a write that follows a draw lands in a FRESH
 * slot, and the bind group for that draw names the slot's byte offset. See {@link UniformSet}.
 */

import type { Device } from './device';
import type { Buffer } from './resources';
import { BufferUsage } from './types';

/** One writable leaf, as the `.wgsl` loader reflects it. */
export interface UniformMember {
    readonly name: string;
    readonly type: string;
    readonly offset: number;
    readonly size: number;
    readonly arrayStride?: number;
    readonly matrixStride?: number;
}

export interface UniformBlockLayout {
    readonly name: string;
    readonly group: number;
    readonly binding: number;
    readonly size: number;
    readonly flat: readonly UniformMember[];
}

/**
 * How to write one member: N elements of M components, each element `stride` bytes apart.
 *
 * Collapsing every type onto this shape is what keeps the writer branch-free at call time. A matrix is
 * "4 elements of 4 components, 16 bytes apart" because its columns are padded to their alignment; an
 * `array<vec4<f32>, 8>` is "8 elements of 4 components, 16 bytes apart" for the same reason. Only the
 * derivation differs, and it happens once, here.
 */
interface WriteShape {
    readonly offset: number;
    readonly elements: number;
    readonly components: number;
    /** Bytes between elements. Equal to `components * 4` when the packing is tight. */
    readonly stride: number;
    readonly integer: boolean;
}

const VECTOR = /^vec([234])<\s*([a-z0-9]+)\s*>$/;
const MATRIX = /^mat([234])x([234])<\s*([a-z0-9]+)\s*>$/;
const ARRAY = /^array<\s*([\s\S]+)\s*>$/;

/**
 * The offset alignment WebGPU requires of a uniform binding, when the caller supplies none.
 *
 * The real value comes off `GPUSupportedLimits.minUniformBufferOffsetAlignment`. 256 is the spec's
 * DEFAULT — the largest an adapter may report — so it is safe everywhere and merely wasteful on one
 * that would have accepted less.
 */
export const DEFAULT_UNIFORM_OFFSET_ALIGNMENT = 256;

/** Bytes a fresh arena aims at. A big block gets fewer slots for it, and grows if it needs more. */
const ARENA_BUDGET_BYTES = 16384;
/** Slots a fresh arena starts with, whatever the budget works out to. */
const MIN_ARENA_SLOTS = 8;
/** Slots a fresh arena starts with at most. Past this it grows on demand instead of guessing. */
const MAX_INITIAL_ARENA_SLOTS = 64;

function alignUp(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

function isInteger(scalar: string): boolean { return scalar === 'i32' || scalar === 'u32'; }

/** Element type and count of an `array<T, N>`, splitting at the LAST top-level comma. */
function splitArray(inner: string): { of: string; count: number } {
    let depth = 0, split = -1;
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '<') depth++;
        else if (ch === '>') depth--;
        else if (ch === ',' && depth === 0) split = i;
    }
    if (split < 0) return { of: inner.trim(), count: 0 };
    return { of: inner.slice(0, split).trim(), count: Number(inner.slice(split + 1).trim()) };
}

function shapeOf(member: UniformMember): WriteShape {
    const type = member.type.trim();

    const array = ARRAY.exec(type);
    if (array) {
        const { of, count } = splitArray(array[1]);
        const stride = member.arrayStride ?? 16;
        const matrix = MATRIX.exec(of);
        if (matrix) {
            // An array of matrices, written as `count` contiguous runs. Safe only while the columns
            // themselves are tight — true for mat4x4, which is every such array in this engine.
            const columns = Number(matrix[1]), rows = Number(matrix[2]);
            return { offset: member.offset, elements: count, components: columns * rows, stride,
                     integer: isInteger(matrix[3]) };
        }
        const vector = VECTOR.exec(of);
        const components = vector ? Number(vector[1]) : 1;
        const scalar = vector ? vector[2] : of;
        return { offset: member.offset, elements: count, components, stride, integer: isInteger(scalar) };
    }

    const matrix = MATRIX.exec(type);
    if (matrix) {
        // Columns, each padded to the column vector's alignment: a mat3x3 is 48 bytes, not 36.
        return { offset: member.offset, elements: Number(matrix[1]), components: Number(matrix[2]),
                 stride: member.matrixStride ?? 16, integer: isInteger(matrix[3]) };
    }

    const vector = VECTOR.exec(type);
    if (vector) {
        const components = Number(vector[1]);
        return { offset: member.offset, elements: 1, components, stride: components * 4,
                 integer: isInteger(vector[2]) };
    }

    return { offset: member.offset, elements: 1, components: 1, stride: 4, integer: isInteger(type) };
}

/**
 * A CPU-side uniform block, and the GPU ARENA its successive values are written into.
 *
 * One per uniform block. The CPU half is a plain `ArrayBuffer` written by name; the GPU half is a
 * buffer holding `slots` copies of the block, and {@link flush} moves to a fresh slot whenever the
 * contents changed since the last draw read them.
 *
 * **Why a slot rather than one struct.** `queue.writeBuffer` is ordered on the QUEUE timeline — against
 * the submit, not against the commands already recorded in the encoder. Overwriting one struct per draw
 * therefore does not give each draw its own value; it gives every draw in the submission the last one.
 * Slots are what make "set `u_model`, draw, set `u_model`, draw" mean what it says, and they are why
 * the ~380 `setUniform` call sites above this could stay exactly as they were.
 *
 * The cursor is reset by the backend after each `queue.submit` — at that point every command that could
 * read a slot has been enqueued, so the slots are free again. See `WebGPUCommandEncoder.finish`.
 */
export class UniformSet {
    private readonly _cpu: ArrayBuffer;
    private readonly _floats: Float32Array;
    private readonly _ints: Int32Array;
    private readonly _shapes = new Map<string, WriteShape>();
    private readonly _label: string;
    private _dirty = true;

    /** Bytes per slot: the block rounded up to the adapter's uniform-offset alignment. */
    public readonly slotSize: number;
    private _buffer: Buffer;
    private _slots: number;
    /** Slot holding this block's current value, or -1 when nothing has been written since the reset. */
    private _cursor = -1;
    /** Bumped whenever {@link buffer} becomes a different object, so bind groups over it get rebuilt. */
    private _generation = 0;

    constructor(public readonly layout: UniformBlockLayout, device: Device,
                alignment: number = DEFAULT_UNIFORM_OFFSET_ALIGNMENT, label = 'program') {
        this._cpu = new ArrayBuffer(layout.size);
        this._floats = new Float32Array(this._cpu);
        this._ints = new Int32Array(this._cpu);

        this.slotSize = alignUp(layout.size, alignment);
        this._slots = Math.max(MIN_ARENA_SLOTS,
                               Math.min(MAX_INITIAL_ARENA_SLOTS,
                                        Math.floor(ARENA_BUDGET_BYTES / this.slotSize)));
        this._label = `${label}:${layout.name}`;
        this._buffer = this._allocate(device);

        for (const member of layout.flat) {
            const shape = shapeOf(member);
            this._shapes.set(member.name, shape);
            // Suffix aliases, so the renderer's shorter names resolve: `u_present.u_exposure` is also
            // reachable as `u_exposure`. Same rule `UniformBlockSet` applies to GL's reflected names,
            // and for the same reason — the call sites predate both layouts.
            for (const alias of suffixesOf(member.name))
                if (!this._shapes.has(alias)) this._shapes.set(alias, shape);
        }
    }

    private _allocate(device: Device): Buffer {
        return device.createBuffer({
            label: `${this._label}[${this._slots}]`,
            size: this._slots * this.slotSize,
            usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
        });
    }

    public has(name: string): boolean { return this._shapes.has(name); }

    /** The arena. A bind group over it names {@link byteOffset} and the block's own `layout.size`. */
    public get buffer(): Buffer { return this._buffer; }
    /** Byte offset of the slot the next draw should read. */
    public get byteOffset(): number { return Math.max(0, this._cursor) * this.slotSize; }
    /** Slot index — half of a bind-group cache key. */
    public get slot(): number { return this._cursor; }
    /** See {@link _generation} — the other half of that key. */
    public get generation(): number { return this._generation; }

    /**
     * Write a value by name. Returns false when this block declares no such member, so a caller can
     * try the next block rather than failing.
     *
     * A value shorter than the member is written in full and the tail left alone — which is what the
     * SSAO kernel relies on, uploading only the samples in use rather than all 64.
     */
    public set(name: string, value: unknown): boolean {
        const shape = this._shapes.get(name);
        if (!shape) return false;

        const target = shape.integer ? this._ints : this._floats;
        const source = toNumbers(value);
        let written = 0;

        for (let element = 0; element < shape.elements && written < source.length; element++) {
            // Byte offset -> typed-array index. Both views are 4 bytes per entry, and every WGSL
            // uniform offset is a multiple of 4, so this division is always exact.
            const base = (shape.offset + element * shape.stride) >> 2;
            for (let c = 0; c < shape.components && written < source.length; c++)
                target[base + c] = source[written++];
        }
        this._dirty = true;
        return true;
    }

    /**
     * Move to a fresh slot and upload, if anything changed since the last draw read this block.
     *
     * An unchanged block keeps its slot, which is what stops a per-PASS block — the lights, the camera,
     * the cascade matrices — from consuming one slot per draw. A changed one advances, because the draw
     * already recorded against the previous slot must keep reading the value it was given.
     */
    public flush(device: Device): void {
        if (!this._dirty && this._cursor >= 0) return;
        this._dirty = false;
        if (this._cursor + 1 >= this._slots) this._grow(device);
        else this._cursor++;
        device.writeBuffer(this._buffer, this._cursor * this.slotSize, new Uint8Array(this._cpu));
    }

    /**
     * Double the arena and start again at its first slot.
     *
     * The OLD buffer is deliberately not destroyed: draws already recorded in this submission hold bind
     * groups over it and must keep reading it until the queue drains. Dropping the reference is enough
     * — those bind groups keep it alive, and it is collected once they are not. Growth doubles, so it
     * happens a handful of times per arena for the life of the process.
     */
    private _grow(device: Device): void {
        this._slots *= 2;
        this._buffer = this._allocate(device);
        this._generation++;
        this._cursor = 0;
    }

    /**
     * Release every slot.
     *
     * Called after `queue.submit`, where it is safe by construction: `writeBuffer` is ordered on the
     * queue timeline, so anything written after a submit lands after every command that submit
     * contained. Before it, reusing a slot would rewrite a value a recorded draw has not read yet —
     * which is the entire bug this class exists to fix.
     */
    public resetCursor(): void {
        this._cursor = -1;
        this._dirty = true;
    }

    public destroy(): void { this._buffer.destroy(); }
}

/**
 * Every uniform block one PROGRAM declares, written by name and bound by group.
 *
 * This is the piece that makes `setUniform('u_exposure', 2.0)` work on WebGPU. A `UniformSet` knows one
 * block; a program has several — `outline` has its transforms in group 1 and its colour in group 2, the
 * lit families spread four across groups 1, 2, 4 and 5 — and the ~330 call sites in the renderer name
 * a member without knowing or caring which. Routing by name is therefore not a convenience here, it is
 * the entire compatibility story.
 *
 * **A name is written to EVERY block that declares it**, in declaration order. One program really can
 * declare the same member twice, in two blocks with two jobs: `modelVertex.wgsl` puts `u_view` in the
 * transform block because the vertex stage needs it, and `pbrForward.wgsl` puts it in the lighting
 * block because cascade selection needs the view-space depth. GLSL has one global per name and both
 * uses read it; splitting them into blocks turned that into two destinations, and writing only the
 * first left the other holding zeros forever.
 *
 * Which is not a subtle wrongness. A custom forward material's blocks come out in the order
 * `[engine, shadow, user, transform]` — the transform is appended last, since it is the one block the
 * FRAGMENT does not declare — so `u_view` landed in the prelude's engine block and never reached the
 * vertex stage. `projection * 0 * model * p` is the origin with w = 0, every triangle is clipped, and
 * the draw records normally and rasterises nothing: right draw count, empty frame. The built-in
 * programs escaped only because their transform block happens to come first.
 *
 * Blocks of the same PROGRAM, to be clear. `u_material.emissive` exists in both the forward and the
 * deferred Blinn-Phong structs at different offsets, and those are different programs — which is why
 * `uniformLayoutCheck` matches per MODULE rather than across all of them.
 */
export class ProgramUniforms {
    private readonly _sets: UniformSet[] = [];
    /**
     * Resolved name -> every set that declares it, memoised. A miss is cached as null so a stray name
     * costs one search; almost every hit is a one-element array.
     */
    private readonly _route = new Map<string, UniformSet[] | null>();

    constructor(device: Device, blocks: readonly UniformBlockLayout[], label = 'program',
                alignment: number = DEFAULT_UNIFORM_OFFSET_ALIGNMENT) {
        for (const block of blocks) this._sets.push(new UniformSet(block, device, alignment, label));
    }

    /** The blocks, in declaration order. */
    public get blocks(): readonly UniformSet[] { return this._sets; }

    /** The block bound at `group`, or undefined when the program declares none there. */
    public forGroup(group: number): UniformSet | undefined {
        return this._sets.find(s => s.layout.group === group);
    }

    /**
     * Write a value by name into EVERY block that declares it.
     *
     * Returns false when none does — which is NOT an error: the renderer sets uniforms that only some
     * programs have (`u_uvScale` on the unlit family, the shadow members on the lit one), and every
     * call site relies on the miss being silent. A throw here would turn one shader gaining a member
     * into a crash in an unrelated pass.
     */
    public set(name: string, value: unknown): boolean {
        const cached = this._route.get(name);
        if (cached !== undefined) return cached !== null && this._writeAll(cached, name, value);
        const matches = this._sets.filter(set => set.has(name));
        this._route.set(name, matches.length ? matches : null);
        return matches.length > 0 && this._writeAll(matches, name, value);
    }

    private _writeAll(sets: readonly UniformSet[], name: string, value: unknown): boolean {
        let written = false;
        for (const set of sets) written = set.set(name, value) || written;
        return written;
    }

    /** Upload every block that changed, each into a fresh slot. One call, immediately before a draw. */
    public flush(device: Device): void {
        for (const set of this._sets) set.flush(device);
    }

    /** Release every block's slots. See {@link UniformSet.resetCursor}. */
    public resetCursors(): void {
        for (const set of this._sets) set.resetCursor();
    }

    /**
     * Which slot of which arena every block is currently reading from.
     *
     * The cache key for a bind group built over these blocks: two draws with the same signature share
     * one, and a draw that advanced any block gets its own. The generation rides along because a grown
     * arena is a different `GPUBuffer`, and a bind group names the buffer, not the block.
     */
    public bindingSignature(): string {
        let key = '';
        for (const set of this._sets) key += set.slot + ':' + set.generation + ',';
        return key;
    }

    public destroy(): void {
        for (const set of this._sets) set.destroy();
        this._sets.length = 0;
        this._route.clear();
    }
}

/** `a.b.c` -> `b.c`, `c`. Array indices ride along: `u_lights[2].position` -> `position`. */
function suffixesOf(name: string): string[] {
    const parts = name.split('.');
    const out: string[] = [];
    for (let i = 1; i < parts.length; i++) out.push(parts.slice(i).join('.'));
    return out;
}

/**
 * Coerce whatever the renderer passed into a flat run of numbers.
 *
 * Booleans become 0/1 because WGSL forbids `bool` in a uniform buffer — every flag in the engine's
 * shaders is an `i32` and every call site still passes a boolean.
 */
function toNumbers(value: unknown): ArrayLike<number> {
    if (typeof value === 'number') return [value];
    if (typeof value === 'boolean') return [value ? 1 : 0];
    if (ArrayBuffer.isView(value)) return value as unknown as ArrayLike<number>;
    if (Array.isArray(value)) return value.map(v => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
    return [];
}

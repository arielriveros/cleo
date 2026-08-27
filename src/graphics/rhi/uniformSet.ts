// Writing uniforms by NAME into a WebGPU uniform buffer, from the layout each `.wgsl` import ships.
// A block is an ARENA of slots, not one struct — a write following a draw must land in a fresh slot.

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

// How to write one member: N elements of M components, each `stride` bytes apart. Every type collapses
// onto this shape once, here, so the writer stays branch-free at call time.
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
 * Fallback uniform-binding offset alignment. 256 is the largest an adapter may report, so it is safe
 * everywhere; the real value comes off `minUniformBufferOffsetAlignment`.
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
            // An array of matrices, as `count` contiguous runs. Valid only while the columns are tight.
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
 * A CPU-side uniform block and the GPU arena its successive values are written into. Slots are what
 * make "set, draw, set, draw" mean what it says; the backend resets the cursor after `queue.submit`.
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
            // Suffix aliases, so `u_present.u_exposure` is also reachable as `u_exposure`.
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
     * Write a value by name; false when this block declares no such member. A value shorter than the
     * member is written in full and the tail left alone.
     */
    public set(name: string, value: unknown): boolean {
        const shape = this._shapes.get(name);
        if (!shape) return false;

        const target = shape.integer ? this._ints : this._floats;
        const source = toNumbers(value);
        let written = 0;

        for (let element = 0; element < shape.elements && written < source.length; element++) {
            // Byte offset -> typed-array index; exact, since every WGSL uniform offset is a multiple of 4.
            const base = (shape.offset + element * shape.stride) >> 2;
            for (let c = 0; c < shape.components && written < source.length; c++)
                target[base + c] = source[written++];
        }
        this._dirty = true;
        return true;
    }

    /**
     * Move to a fresh slot and upload, if anything changed since the last draw read this block. An
     * unchanged block keeps its slot, so a per-pass block does not consume one per draw.
     */
    public flush(device: Device): void {
        if (!this._dirty && this._cursor >= 0) return;
        this._dirty = false;
        if (this._cursor + 1 >= this._slots) this._grow(device);
        else this._cursor++;
        device.writeBuffer(this._buffer, this._cursor * this.slotSize, new Uint8Array(this._cpu));
    }

    // Double the arena and start again at its first slot. The OLD buffer must NOT be destroyed: draws
    // already recorded hold bind groups over it. Dropping the reference is enough.
    private _grow(device: Device): void {
        this._slots *= 2;
        this._buffer = this._allocate(device);
        this._generation++;
        this._cursor = 0;
    }

    /**
     * Release every slot. Only safe AFTER `queue.submit` — before it, reusing a slot rewrites a value
     * a recorded draw has not read yet.
     */
    public resetCursor(): void {
        this._cursor = -1;
        this._dirty = true;
    }

    public destroy(): void { this._buffer.destroy(); }
}

/**
 * Every uniform block one PROGRAM declares, written by name and bound by group. A name goes to EVERY
 * block declaring it — `u_view` lives in two, and writing only the first leaves the other zeroed.
 */
export class ProgramUniforms {
    private readonly _sets: UniformSet[] = [];
    // Resolved name -> every set that declares it, memoised. A miss caches null.
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
     * Write a value by name into EVERY block that declares it. False when none does, which is not an
     * error — the renderer sets uniforms only some programs have, and every call site relies on that.
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
     * Which slot of which arena every block is reading from — the cache key for a bind group built over
     * them. The arena generation rides along, since a grown arena is a different `GPUBuffer`.
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

// Coerce whatever the renderer passed into a flat run of numbers. Booleans become 0/1: WGSL forbids
// `bool` in a uniform buffer, so every shader flag is an `i32`.
function toNumbers(value: unknown): ArrayLike<number> {
    if (typeof value === 'number') return [value];
    if (typeof value === 'boolean') return [value ? 1 : 0];
    if (ArrayBuffer.isView(value)) return value as unknown as ArrayLike<number>;
    if (Array.isArray(value)) return value.map(v => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
    return [];
}

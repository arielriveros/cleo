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
 */

import type { Device } from './device';
import type { Buffer } from './resources';

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
 * A CPU-side uniform buffer written by name and uploaded when dirty.
 *
 * One per uniform block. Uploads happen in {@link flush}, immediately before the draw that reads them,
 * rather than on every `set` — a pass that writes a dozen members costs one upload, not a dozen.
 */
export class UniformSet {
    private readonly _cpu: ArrayBuffer;
    private readonly _floats: Float32Array;
    private readonly _ints: Int32Array;
    private readonly _shapes = new Map<string, WriteShape>();
    private _dirty = true;

    constructor(public readonly layout: UniformBlockLayout, public readonly buffer: Buffer) {
        this._cpu = new ArrayBuffer(layout.size);
        this._floats = new Float32Array(this._cpu);
        this._ints = new Int32Array(this._cpu);

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

    public has(name: string): boolean { return this._shapes.has(name); }

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

    /** Upload if anything changed since the last call. */
    public flush(device: Device): void {
        if (!this._dirty) return;
        this._dirty = false;
        device.writeBuffer(this.buffer, 0, new Uint8Array(this._cpu));
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

import { gl } from '../glContext';
import { Logger } from '../../core/logger';
import { glDevice } from '../rhi/webgl2/webgl2Device';
import type { WebGL2Buffer } from '../rhi/webgl2/webgl2Device';
import { BufferUsage } from '../rhi/types';

// std140 uniform blocks, for programs generated from WGSL: naga puts every non-sampler uniform into a
// block, and `getUniformLocation` returns null for a block member. A CPU buffer per block, written at
// the offsets GL reports and uploaded once per frame, so `setUniform(name, value)` still works.
//
// Layout is READ BACK from the driver, never computed from the std140 rules: where the two disagree
// the driver is right, and a hand-rolled packer fails on one vendor only.

interface BlockMember {
    /** The name GL reflected, before any suffix aliasing. Kept for layout verification. */
    name: string;
    /** Byte offset of this member within its block. */
    offset: number;
    /** GL type enum (FLOAT, FLOAT_VEC3, FLOAT_MAT4, …). */
    type: number;
    /** Elements, for an array member. 1 otherwise. */
    size: number;
    /** Bytes between consecutive array elements. 0 for a non-array. */
    arrayStride: number;
    /** Bytes between consecutive matrix columns. 0 for a non-matrix. */
    matrixStride: number;
}

interface Block {
    name: string;
    index: number;
    /** The indexed binding point this block is bound to while its program is current. */
    bindingPoint: number;
    buffer: WebGL2Buffer;
    cpu: ArrayBuffer;
    floats: Float32Array;
    ints: Int32Array;
    dirty: boolean;
}

export class UniformBlockSet {
    private readonly _blocks: Block[] = [];
    // Name -> every block member it refers to. A LIST: naga emits one block per stage, so a name can
    // legitimately land in two, and a write must reach both.
    private readonly _members = new Map<string, { block: Block; member: BlockMember }[]>();

    private constructor() {}

    /** Reflect a linked program's uniform blocks, or null when it has none. */
    public static reflect(program: WebGLProgram): UniformBlockSet | null {
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORM_BLOCKS) as number;
        if (!count) return null;

        const set = new UniformBlockSet();
        for (let index = 0; index < count; index++) set._reflectBlock(program, index);
        return set;
    }

    private _reflectBlock(program: WebGLProgram, index: number): void {
        const name = gl.getActiveUniformBlockName(program, index) ?? `block${index}`;
        const dataSize = gl.getActiveUniformBlockParameter(program, index, gl.UNIFORM_BLOCK_DATA_SIZE) as number;

        // One binding point per block, re-bound on every program switch: the indexed UNIFORM_BUFFER
        // points are a small shared array that allocating globally would exhaust.
        const bindingPoint = index;
        gl.uniformBlockBinding(program, index, bindingPoint);

        const buffer = glDevice().createBuffer({
            label: `ubo.${name}`,
            size: dataSize,
            usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
        });

        const cpu = new ArrayBuffer(dataSize);
        const block: Block = {
            name, index, bindingPoint, buffer, cpu,
            floats: new Float32Array(cpu),
            ints: new Int32Array(cpu),
            dirty: true,
        };
        this._blocks.push(block);

        const indices = gl.getActiveUniformBlockParameter(
            program, index, gl.UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES) as Uint32Array;
        if (!indices) return;

        const list = Array.from(indices);
        const offsets = gl.getActiveUniforms(program, list, gl.UNIFORM_OFFSET) as number[];
        const arrayStrides = gl.getActiveUniforms(program, list, gl.UNIFORM_ARRAY_STRIDE) as number[];
        const matrixStrides = gl.getActiveUniforms(program, list, gl.UNIFORM_MATRIX_STRIDE) as number[];

        for (let i = 0; i < list.length; i++) {
            const info = gl.getActiveUniform(program, list[i]);
            if (!info) continue;
            const member: BlockMember = {
                name: info.name,
                offset: offsets[i],
                type: info.type,
                size: info.size,
                arrayStride: arrayStrides[i],
                matrixStride: matrixStrides[i],
            };
            this._register(info.name, block, member);
        }
    }

    // Register a member under its full reflected name and EVERY dotted suffix — the renderer names
    // material uniforms compositionally, so `u_material.baseColor` must resolve as well as the ends.
    private _register(reflectedName: string, block: Block, member: BlockMember): void {
        // GL appends "[0]" to the name of an array member.
        const full = reflectedName.replace(/\[0\]$/, '');
        this._add(full, block, member);
        this._registerSuffixes(full, block, member);

        // naga escapes a member name ending in a digit with a trailing underscore, so alias it back or
        // every such uniform silently resolves to nothing.
        const unmangled = full.replace(/(\d)_$/, '$1');
        if (unmangled !== full) {
            this._add(unmangled, block, member);
            this._registerSuffixes(unmangled, block, member);
        }
    }

    /** Register every dotted suffix of `full` that begins at a `u_` segment. */
    private _registerSuffixes(full: string, block: Block, member: BlockMember): void {
        const parts = full.split('.');
        for (let i = 1; i < parts.length; i++) {
            const suffix = parts.slice(i).join('.');

            // Only `u_`-prefixed suffixes: the remaining segments are STRUCT FIELDS, never set by their
            // bare name, and registering them buries the real ambiguity warnings.
            if (!suffix.startsWith('u_')) continue;

            this._add(suffix, block, member);
        }
    }

    /** Append one target for `name`, ignoring an exact repeat of the same member. */
    private _add(name: string, block: Block, member: BlockMember): void {
        const list = this._members.get(name);
        if (!list) { this._members.set(name, [{ block, member }]); return; }
        if (list.some(e => e.block === block && e.member.offset === member.offset)) return;
        list.push({ block, member });
    }

    public has(name: string): boolean { return this._members.has(name); }

    /** How many block members a name writes to. 1 for almost everything; 2 for a cross-stage uniform. */
    public targetCount(name: string): number { return this._members.get(name)?.length ?? 0; }

    /** Write a value into its block's CPU buffer. Returns false when the name is not a block member. */
    public set(name: string, value: any): boolean {
        const targets = this._members.get(name);
        if (!targets) return false;
        for (const entry of targets) {
            writeMember(entry.block, entry.member, value, name);
            entry.block.dirty = true;
        }
        return true;
    }

    /**
     * Bind every block to its indexed binding point. Required on every program switch — the points are
     * shared, so the previous program's buffers are still sitting in them.
     */
    public bind(): void {
        for (const block of this._blocks)
            gl.bindBufferBase(gl.UNIFORM_BUFFER, block.bindingPoint, block.buffer.handle);
    }

    /** Upload whatever changed. Cheap when nothing did, which is the common case between draws. */
    public flush(): void {
        for (const block of this._blocks) {
            if (!block.dirty) continue;
            glDevice().writeBuffer(block.buffer, 0, new Uint8Array(block.cpu));
            block.dirty = false;
        }
    }

    public dispose(): void {
        for (const block of this._blocks) block.buffer.destroy();
        this._blocks.length = 0;
        this._members.clear();
    }
}

/** Number of components a GL type carries, and whether it is integer-flavoured. */
function describe(type: number): { components: number; columns: number; integer: boolean } | null {
    switch (type) {
        case gl.FLOAT: return { components: 1, columns: 1, integer: false };
        case gl.FLOAT_VEC2: return { components: 2, columns: 1, integer: false };
        case gl.FLOAT_VEC3: return { components: 3, columns: 1, integer: false };
        case gl.FLOAT_VEC4: return { components: 4, columns: 1, integer: false };
        case gl.INT: case gl.BOOL: return { components: 1, columns: 1, integer: true };
        case gl.INT_VEC2: case gl.BOOL_VEC2: return { components: 2, columns: 1, integer: true };
        case gl.INT_VEC3: case gl.BOOL_VEC3: return { components: 3, columns: 1, integer: true };
        case gl.INT_VEC4: case gl.BOOL_VEC4: return { components: 4, columns: 1, integer: true };
        case gl.FLOAT_MAT2: return { components: 2, columns: 2, integer: false };
        case gl.FLOAT_MAT3: return { components: 3, columns: 3, integer: false };
        case gl.FLOAT_MAT4: return { components: 4, columns: 4, integer: false };
        default: return null;
    }
}

/** One slot lent to scalar writes, so `writeMember` never allocates. Never held. */
const SCALAR = new Float64Array(1);

// Write one member into its block's CPU buffer, honouring the reported strides. std140 pads every
// matrix column to a vec4, so a contiguous copy would shear a mat3.
function writeMember(block: Block, member: BlockMember, value: any, name: string): void {
    const shape = describe(member.type);
    if (!shape) {
        Logger.warn(`Uniform "${name}" has a type this block writer does not handle (GL enum ${member.type})`, 'Shader');
        return;
    }

    const target = shape.integer ? block.ints : block.floats;
    // ArrayLike, NOT `Array.from`. This runs on every non-scalar uniform write, and every draw writes at
    // least `u_model` — so boxing produced a 16-element JS array per draw, and `bones * 16` per
    // skinned draw per cascade, purely to read `flat[i]` back out of it. A `vec3`, a `mat4` and a plain
    // number[] are all indexable already; a scalar borrows one shared slot.
    let flat: ArrayLike<number>;
    if (typeof value === 'number') { SCALAR[0] = value; flat = SCALAR; }
    else if (typeof value === 'boolean') { SCALAR[0] = value ? 1 : 0; flat = SCALAR; }
    else flat = value as ArrayLike<number>;

    const elements = Math.max(1, member.size);
    const perElement = shape.components * shape.columns;

    for (let element = 0; element < elements; element++) {
        const source = element * perElement;
        if (source >= flat.length) break;
        const elementOffset = member.offset + element * (member.arrayStride || 0);

        for (let column = 0; column < shape.columns; column++) {
            // A non-matrix has matrixStride 0; the single "column" then starts at the member offset.
            const byteOffset = elementOffset + column * (member.matrixStride || 0);
            const base = byteOffset / 4;
            for (let component = 0; component < shape.components; component++)
                target[base + component] = flat[source + column * shape.components + component];
        }
    }
}

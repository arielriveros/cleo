import { gl } from '../glContext';
import { Logger } from '../../core/logger';
import { device } from '../rhi/webgl2/webgl2Device';
import type { WebGL2Buffer } from '../rhi/webgl2/webgl2Device';
import { BufferUsage } from '../rhi/types';

/**
 * std140 uniform blocks, for programs generated from WGSL.
 *
 * Every uniform in this engine has always been a loose default-block uniform set by name through GL
 * reflection. WGSL has no such thing: naga puts every non-sampler uniform into a std140 block, so a
 * WGSL-authored program emits
 *
 *     layout(std140) uniform PresentUniforms_block_0Fragment { PresentUniforms u_present; };
 *
 * and `getUniformLocation` returns null for each member — which is why `Shader.storeUniforms` skipped
 * them and `setUniform('u_exposure', …)` would have silently done nothing. Not thrown: nothing. The
 * frame would simply render with whatever the buffer happened to contain.
 *
 * This is the smallest honest version of the roadmap's `UniformSet`: a CPU-side buffer per block,
 * written at the offsets GL reports, uploaded once per frame when dirty. Values still arrive through
 * `setUniform(name, value)`, so the ~374 existing call sites are untouched.
 *
 * Layout is read back from the driver (`UNIFORM_OFFSET`, `UNIFORM_ARRAY_STRIDE`,
 * `UNIFORM_MATRIX_STRIDE`) rather than computed from the std140 rules. Both would usually agree; when
 * they disagree the driver is right, and a hand-rolled packer would be wrong in a way that shows up as
 * one shader misbehaving on one vendor.
 */

interface BlockMember {
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
    private readonly _members = new Map<string, { block: Block; member: BlockMember }>();

    private constructor() {}

    /**
     * Reflect a linked program's uniform blocks, or return null when it has none — which is every
     * hand-written GLSL program in the engine, so the common path costs one `getProgramParameter`.
     */
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

        // One binding point per block, per program. They are re-bound on every program switch rather
        // than allocated globally: the indexed UNIFORM_BUFFER binding points are a small shared array
        // (24 guaranteed), and 56 programs would exhaust them.
        const bindingPoint = index;
        gl.uniformBlockBinding(program, index, bindingPoint);

        const buffer = device.createBuffer({
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
                offset: offsets[i],
                type: info.type,
                size: info.size,
                arrayStride: arrayStrides[i],
                matrixStride: matrixStrides[i],
            };
            this._register(info.name, block, member);
        }
    }

    /**
     * Register a member under its full reflected name and under every dotted suffix of it.
     *
     * naga wraps a program's uniforms in a struct, so GL reports members as
     * `PresentUniforms_block_0Fragment.u_present.u_exposure` while call sites ask for `u_exposure`.
     *
     * Every suffix is registered, not just the last segment, because the renderer names material
     * uniforms compositionally: `setUniform(\`u_material.${name}\`, …)` over a material's property map.
     * That asks for `u_material.baseColor`, which is neither the full reflected name nor the last
     * segment — so registering only those two would leave every material uniform silently unset, which
     * looks exactly like a material rendering with default values.
     *
     * First registration wins on a collision, and the loser is reported rather than dropped silently:
     * two blocks sharing a suffix would otherwise route one program's writes into the other's buffer.
     */
    private _register(reflectedName: string, block: Block, member: BlockMember): void {
        // GL appends "[0]" to the name of an array member.
        const full = reflectedName.replace(/\[0\]$/, '');
        this._members.set(full, { block, member });

        // Longest suffix first, so the most specific alias is the one that reports a collision.
        const parts = full.split('.');
        for (let i = 1; i < parts.length; i++) {
            const suffix = parts.slice(i).join('.');
            if (this._members.has(suffix)) {
                Logger.warn(
                    `Uniform "${suffix}" is ambiguous — declared in more than one block. Set it by its ` +
                    `full name to disambiguate.`, 'Shader');
                continue;
            }
            this._members.set(suffix, { block, member });
        }
    }

    public has(name: string): boolean { return this._members.has(name); }

    /** Write a value into its block's CPU buffer. Returns false when the name is not a block member. */
    public set(name: string, value: any): boolean {
        const entry = this._members.get(name);
        if (!entry) return false;
        writeMember(entry.block, entry.member, value, name);
        entry.block.dirty = true;
        return true;
    }

    /**
     * Bind every block to its indexed binding point. Called when the owning program becomes current —
     * the binding points are shared across programs, so the previous program's buffers are still there.
     */
    public bind(): void {
        for (const block of this._blocks)
            gl.bindBufferBase(gl.UNIFORM_BUFFER, block.bindingPoint, block.buffer.handle);
    }

    /** Upload whatever changed. Cheap when nothing did, which is the common case between draws. */
    public flush(): void {
        for (const block of this._blocks) {
            if (!block.dirty) continue;
            device.writeBuffer(block.buffer, 0, new Uint8Array(block.cpu));
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

/**
 * Write one member into its block's CPU buffer, honouring the strides the driver reported.
 *
 * Matrices are the reason `matrixStride` exists: std140 pads every column out to a vec4, so a mat3
 * occupies 48 bytes rather than 36 and a naive contiguous copy would shear it.
 */
function writeMember(block: Block, member: BlockMember, value: any, name: string): void {
    const shape = describe(member.type);
    if (!shape) {
        Logger.warn(`Uniform "${name}" has a type this block writer does not handle (GL enum ${member.type})`, 'Shader');
        return;
    }

    const target = shape.integer ? block.ints : block.floats;
    const flat: number[] = typeof value === 'number' ? [value]
        : typeof value === 'boolean' ? [value ? 1 : 0]
        : Array.from(value as ArrayLike<number>);

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

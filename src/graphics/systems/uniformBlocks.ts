import { gl } from '../glContext';
import { Logger } from '../../core/logger';
import { glDevice } from '../rhi/webgl2/webgl2Device';
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
    /**
     * Name -> every block member it refers to. A LIST, not a single entry.
     *
     * A name can legitimately land in more than one block: naga emits one block per shader stage, so
     * a program whose vertex stage needs `u_view` for its MVP and whose fragment stage needs it to
     * pick a shadow cascade has the same matrix in both. The renderer sets `u_view` once and means
     * both — so a write broadcasts. Keeping one entry per name silently left the other block holding
     * whatever it was initialised with, which for a view matrix is zeroes.
     */
    private readonly _members = new Map<string, { block: Block; member: BlockMember }[]>();

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
     * A name landing in more than one block is normal rather than an error — see `_members` — so every
     * match is recorded and a write reaches all of them.
     */
    private _register(reflectedName: string, block: Block, member: BlockMember): void {
        // GL appends "[0]" to the name of an array member.
        const full = reflectedName.replace(/\[0\]$/, '');
        this._add(full, block, member);
        this._registerSuffixes(full, block, member);

        // naga ESCAPES a member name that ends in a digit by appending an underscore, so `u_iblIntensity0`
        // is emitted as `u_iblIntensity0_` and GL reports it that way. (It is a normalisation, not a
        // quirk: a name already ending in `_` has it stripped, so the two forms can never collide.)
        //
        // The engine asks for the name it authored. Without the alias below, every uniform whose name
        // ends in a digit silently resolves to nothing — which is not a compile error and not a warning,
        // it is a value that stays whatever the buffer was allocated with. That is exactly how the light
        // probes stopped contributing: `u_iblIntensity0` read as 0, and because an unbounded probe drives
        // the fallback-ambient weight to zero, the ambient term vanished entirely instead of degrading.
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

            // Only suffixes that begin at a `u_` name are worth registering. Every uniform this engine
            // sets is `u_`-prefixed; the remaining segments are STRUCT FIELDS, which are never set by
            // their bare name — the renderer says `u_dirLight.diffuse`, never `diffuse`.
            //
            // Registering them anyway was not merely useless, it was noisy in a way that hid real
            // problems: `u_pointLights` is 16 elements and `u_spotlights` 8, all with a `position` and a
            // `diffuse`, so every light shader logged a few hundred ambiguity warnings at startup for
            // aliases nothing would ever ask for.
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

    /** @internal Diagnostic: the GL buffer backing each block, with the size GL reports for its store. */
    /**
     * Every reflected member, with the byte layout the DRIVER reports.
     *
     * Exists to be checked against the layout `tools/wgslLayout.mjs` computes from the WGSL type rules.
     * WebGPU has no reflection, so those computed offsets are what a WebGPU uniform write will use —
     * and the only way to know they are right is to compare them with a real driver's answer for the
     * same struct. See `tools/harness/uniformLayoutCheck.js`.
     */
    public describeLayout(): { block: string; blockSize: number; name: string; offset: number;
                               arrayStride: number; matrixStride: number }[] {
        const seen = new Set<BlockMember>();
        const out: { block: string; blockSize: number; name: string; offset: number;
                     arrayStride: number; matrixStride: number }[] = [];
        for (const entries of this._members.values()) {
            for (const { block, member } of entries) {
                if (seen.has(member)) continue;   // one member is registered under several aliases
                seen.add(member);
                out.push({
                    block: block.name,
                    blockSize: block.cpu.byteLength,
                    name: member.name,
                    offset: member.offset,
                    arrayStride: member.arrayStride,
                    matrixStride: member.matrixStride,
                });
            }
        }
        return out;
    }

    public describeBuffers(): string {
        return this._blocks.map(b => {
            gl.bindBuffer(gl.UNIFORM_BUFFER, b.buffer.handle);
            const store = gl.getBufferParameter(gl.UNIFORM_BUFFER, gl.BUFFER_SIZE);
            const bound = gl.getIndexedParameter(gl.UNIFORM_BUFFER_BINDING, b.bindingPoint);
            return `${b.name}@${b.bindingPoint} cpu${b.cpu.byteLength} store${store} ${bound === b.buffer.handle ? 'MINE' : 'FOREIGN'}`;
        }).join(' | ');
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

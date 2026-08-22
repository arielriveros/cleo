import { describe, it, expect, beforeAll } from 'vitest';
import { setGLContext } from '../src/graphics/glContext';
import { WebGL2Device, setDevice } from '../src/graphics/rhi/webgl2/webgl2Device';
import { UniformBlockSet } from '../src/graphics/systems/uniformBlocks';

/**
 * std140 packing, against a driver-reported layout.
 *
 * This is worth pinning because every way it can be wrong is silent. `UniformBlockSet` writes into a
 * CPU buffer at the offsets and strides GL reports; get a stride wrong and no error is raised anywhere —
 * the matrix simply arrives sheared, or an array reads back as three-quarters zeroes, and the symptom is
 * a shader that looks subtly wrong on one vendor. The old loose-uniform path had `gl.uniformMatrix4fv`
 * doing this arithmetic; now the engine does, so the engine has to prove it.
 *
 * The layout below is the one std140 actually mandates, which is not the one a contiguous memcpy would
 * produce in three separate places:
 *
 *   - `u_kernel`, a `float[4]`, has each element padded out to a full vec4 — stride 16, not 4.
 *   - `u_normalMat`, a mat3, has each COLUMN padded to a vec4 — 48 bytes for 36 bytes of data.
 *   - `u_matrix`, a mat4, is contiguous, so it is the control that shows the stride logic does not
 *     over-correct.
 */

const GL = {
    FLOAT: 0x1406, FLOAT_VEC2: 0x8b50, FLOAT_VEC3: 0x8b51, FLOAT_VEC4: 0x8b52,
    INT: 0x1404, BOOL: 0x8b56,
    FLOAT_MAT2: 0x8b5a, FLOAT_MAT3: 0x8b5b, FLOAT_MAT4: 0x8b5c,
    ACTIVE_UNIFORM_BLOCKS: 0x8a36,
    UNIFORM_BLOCK_DATA_SIZE: 0x8a40,
    UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES: 0x8a43,
    UNIFORM_OFFSET: 0x8a3b, UNIFORM_ARRAY_STRIDE: 0x8a3c, UNIFORM_MATRIX_STRIDE: 0x8a3d,
    UNIFORM_BUFFER: 0x8a11, ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
};

interface FakeMember { name: string; type: number; size: number; offset: number; arrayStride: number; matrixStride: number; }
interface FakeBlock { name: string; dataSize: number; members: FakeMember[]; }

/** A member declaration, defaulting the two strides that only matter for arrays and matrices. */
const m = (name: string, type: number, offset: number,
           extra: Partial<FakeMember> = {}): FakeMember =>
    ({ name, type, size: 1, offset, arrayStride: 0, matrixStride: 0, ...extra });

const BLOCK: FakeBlock = {
    name: 'U_block_0Fragment',
    dataSize: 208,
    members: [
        m('U_block_0Fragment.u_data.u_exposure', GL.FLOAT, 0),
        m('U_block_0Fragment.u_data.u_flags', GL.INT, 4),
        m('U_block_0Fragment.u_data.u_tint', GL.FLOAT_VEC3, 16),
        m('U_block_0Fragment.u_data.u_matrix', GL.FLOAT_MAT4, 32, { matrixStride: 16 }),
        // GL reports an array member's name with a trailing "[0]", which the registrar has to strip.
        m('U_block_0Fragment.u_data.u_kernel[0]', GL.FLOAT, 96, { size: 4, arrayStride: 16 }),
        m('U_block_0Fragment.u_data.u_normalMat', GL.FLOAT_MAT3, 160, { matrixStride: 16 }),
    ],
};

/** Bytes handed to the GPU by the last flush, viewed as floats and as ints. */
let uploads: { floats: Float32Array; ints: Int32Array; byteLength: number }[] = [];
let bindings: { point: number; buffer: unknown }[] = [];

function install(blocks: FakeBlock[]): WebGLProgram {
    uploads = [];
    bindings = [];
    let n = 0;

    const api: Record<string, unknown> = {
        ...GL,
        createBuffer: () => ({ id: ++n }),
        createVertexArray: () => ({ id: ++n }),
        createTexture: () => ({ id: ++n }),
        getProgramParameter: (_p: unknown, name: number) =>
            name === GL.ACTIVE_UNIFORM_BLOCKS ? blocks.length : 0,
        getActiveUniformBlockName: (_p: unknown, i: number) => blocks[i].name,
        getActiveUniformBlockParameter: (_p: unknown, i: number, name: number) => {
            if (name === GL.UNIFORM_BLOCK_DATA_SIZE) return blocks[i].dataSize;
            // Indices are global across the program, so later blocks continue the numbering.
            const base = blocks.slice(0, i).reduce((sum, b) => sum + b.members.length, 0);
            return new Uint32Array(blocks[i].members.map((_, k) => base + k));
        },
        getActiveUniforms: (_p: unknown, list: number[], name: number) => {
            const all = blocks.flatMap(b => b.members);
            const key = name === GL.UNIFORM_OFFSET ? 'offset'
                : name === GL.UNIFORM_ARRAY_STRIDE ? 'arrayStride' : 'matrixStride';
            return list.map(i => all[i][key as keyof FakeMember]);
        },
        getActiveUniform: (_p: unknown, i: number) => blocks.flatMap(b => b.members)[i],
        uniformBlockBinding: () => undefined,
        bindBufferBase: (_target: number, point: number, buffer: unknown) => bindings.push({ point, buffer }),
        bufferSubData: (_target: number, _offset: number, data: ArrayBufferView) => uploads.push({
            floats: new Float32Array(data.buffer.slice(0)),
            ints: new Int32Array(data.buffer.slice(0)),
            byteLength: data.byteLength,
        }),
    };

    const gl = new Proxy(api, { get: (t, key: string) => (key in t ? t[key] : () => undefined) });
    setGLContext(gl as unknown as WebGL2RenderingContext);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
    return {} as WebGLProgram;
}

/** Reflect, set every member, flush, and hand back what reached the GPU. */
function written(values: Record<string, unknown>) {
    const program = install([BLOCK]);
    const set = UniformBlockSet.reflect(program)!;
    for (const [name, value] of Object.entries(values)) set.set(name, value);
    set.flush();
    return { set, upload: uploads[uploads.length - 1] };
}

beforeAll(() => install([BLOCK]));

describe('UniformBlockSet — reflection', () => {
    it('returns null for a program with no blocks, which is every hand-written GLSL shader', () => {
        expect(UniformBlockSet.reflect(install([]))).toBeNull();
    });

    it('registers members under the short name the engine actually uses', () => {
        const set = UniformBlockSet.reflect(install([BLOCK]))!;
        // naga wraps uniforms in a struct inside a block, so GL reports a three-segment name while
        // every call site in the renderer says `setUniform('u_exposure', …)`.
        expect(set.has('u_exposure')).toBe(true);
        expect(set.has('U_block_0Fragment.u_data.u_exposure')).toBe(true);
    });

    it('strips the "[0]" GL appends to an array member', () => {
        const set = UniformBlockSet.reflect(install([BLOCK]))!;
        expect(set.has('u_kernel')).toBe(true);
        expect(set.has('u_kernel[0]')).toBe(false);
    });

    it('reports an unknown name rather than silently swallowing the write', () => {
        const set = UniformBlockSet.reflect(install([BLOCK]))!;
        expect(set.set('u_notAThing', 1)).toBe(false);
        expect(set.set('u_exposure', 1)).toBe(true);
    });

    it('binds each block to an indexed binding point', () => {
        const set = UniformBlockSet.reflect(install([BLOCK]))!;
        set.bind();
        expect(bindings).toHaveLength(1);
        expect(bindings[0].point).toBe(0);
    });

    it('keeps the first claimant when two blocks share a short name', () => {
        // Ambiguity has to not clobber: the second block silently taking over `u_exposure` would send
        // one program's exposure into the other's buffer.
        const other: FakeBlock = {
            name: 'V_block_0Fragment', dataSize: 16,
            members: [m('V_block_0Fragment.u_other.u_exposure', GL.FLOAT, 0)],
        };
        const set = UniformBlockSet.reflect(install([BLOCK, other]))!;
        set.set('u_exposure', 7);
        set.flush();
        // Two blocks, but only the first one's buffer carries the value.
        expect(uploads).toHaveLength(2);
        expect(uploads[0].floats[0]).toBe(7);
        expect(uploads[1].floats[0]).toBe(0);
        // The full name remains available as an unambiguous handle.
        expect(set.has('V_block_0Fragment.u_other.u_exposure')).toBe(true);
    });
});

describe('UniformBlockSet — std140 writes', () => {
    it('places a scalar and a vec3 at their reported offsets', () => {
        const { upload } = written({ u_exposure: 2.5, u_tint: [0.25, 0.5, 0.75] });
        expect(upload.byteLength).toBe(208);
        expect(upload.floats[0]).toBe(2.5);
        expect([...upload.floats.slice(4, 7)]).toEqual([0.25, 0.5, 0.75]);
    });

    it('routes an integer member through the Int32 view, not the Float32 one', () => {
        // Writing 3 as a float would put 0x40400000 in the buffer and the shader would read 1077936128.
        const { upload } = written({ u_flags: 3 });
        expect(upload.ints[1]).toBe(3);
    });

    it('accepts a boolean for a bool-typed member', () => {
        const { upload } = written({ u_flags: true });
        expect(upload.ints[1]).toBe(1);
    });

    it('writes a mat4 contiguously, since its column stride is already 16', () => {
        const matrix = Array.from({ length: 16 }, (_, i) => i + 1);
        const { upload } = written({ u_matrix: matrix });
        expect([...upload.floats.slice(8, 24)]).toEqual(matrix);
    });

    it('pads each mat3 column out to a vec4 instead of shearing it', () => {
        const matrix = Array.from({ length: 9 }, (_, i) => i + 1);
        const { upload } = written({ u_normalMat: matrix });
        // 160 bytes in = float 40. Columns land 4 floats apart, 3 floats used, 4th left as padding.
        expect([...upload.floats.slice(40, 43)]).toEqual([1, 2, 3]);
        expect([...upload.floats.slice(44, 47)]).toEqual([4, 5, 6]);
        expect([...upload.floats.slice(48, 51)]).toEqual([7, 8, 9]);
        expect(upload.floats[43]).toBe(0);
        expect(upload.floats[47]).toBe(0);
    });

    it('spaces array elements by the reported array stride', () => {
        const { upload } = written({ u_kernel: [10, 20, 30, 40] });
        // A float[4] occupies 64 bytes in std140, not 16 — one vec4 slot per element.
        expect(upload.floats[24]).toBe(10);
        expect(upload.floats[28]).toBe(20);
        expect(upload.floats[32]).toBe(30);
        expect(upload.floats[36]).toBe(40);
        expect(upload.floats[25]).toBe(0);
    });

    it('accepts a typed array as readily as a plain one', () => {
        const { upload } = written({ u_tint: new Float32Array([1, 2, 3]) });
        expect([...upload.floats.slice(4, 7)]).toEqual([1, 2, 3]);
    });

    it('stops at the end of a short value rather than writing past it', () => {
        const { upload } = written({ u_kernel: [10, 20] });
        expect(upload.floats[24]).toBe(10);
        expect(upload.floats[28]).toBe(20);
        expect(upload.floats[32]).toBe(0);
    });
});

describe('UniformBlockSet — upload scheduling', () => {
    it('uploads once for many writes and not at all when nothing changed', () => {
        const set = UniformBlockSet.reflect(install([BLOCK]))!;
        set.set('u_exposure', 1);
        set.set('u_tint', [1, 1, 1]);
        set.flush();
        expect(uploads).toHaveLength(1);

        // Between draws nothing changes, and the common case has to stay free.
        set.flush();
        set.flush();
        expect(uploads).toHaveLength(1);

        set.set('u_exposure', 2);
        set.flush();
        expect(uploads).toHaveLength(2);
        expect(uploads[1].floats[0]).toBe(2);
    });

    it('uploads on first flush even before anything is set, so the block is never undefined memory', () => {
        const set = UniformBlockSet.reflect(install([BLOCK]))!;
        set.flush();
        expect(uploads).toHaveLength(1);
    });

    it('does not upload after dispose', () => {
        const set = UniformBlockSet.reflect(install([BLOCK]))!;
        set.dispose();
        set.flush();
        expect(uploads).toHaveLength(0);
        expect(set.has('u_exposure')).toBe(false);
    });
});

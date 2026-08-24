import { describe, it, expect } from 'vitest';
import { UniformSet, ProgramUniforms } from '../src/graphics/rhi/uniformSet';
import type { UniformBlockLayout } from '../src/graphics/rhi/uniformSet';
import type { Buffer } from '../src/graphics/rhi/resources';

/**
 * Writing uniforms by name into a WebGPU-shaped buffer.
 *
 * The offsets themselves are verified against a real driver by `tools/harness/uniformLayoutCheck.js`;
 * what these tests pin is the WRITER — that a mat4 lands as four columns, that a `vec3` does not spill
 * into its own padding, and that a short value leaves the tail alone.
 */

/** A stand-in that records what would have been uploaded. */
function fakeDevice() {
    const uploads: Uint8Array[] = [];
    return {
        uploads,
        device: { writeBuffer: (_b: Buffer, _o: number, data: ArrayBufferView) =>
            uploads.push(new Uint8Array(data.buffer.slice(0))) } as any,
    };
}

const BUFFER = { label: 'test', size: 256, usage: 0, destroy() {} } as Buffer;

function layout(flat: UniformBlockLayout['flat'], size = 256): UniformBlockLayout {
    return { name: 'u_test', group: 1, binding: 0, size, flat };
}

/** Read the floats a set would upload. */
function floatsOf(set: UniformSet): Float32Array {
    const { device, uploads } = fakeDevice();
    set.flush(device);
    return new Float32Array(uploads[0].buffer);
}

function intsOf(set: UniformSet): Int32Array {
    const { device, uploads } = fakeDevice();
    set.flush(device);
    return new Int32Array(uploads[0].buffer);
}

describe('scalars and vectors', () => {
    it('writes a scalar at its offset', () => {
        const set = new UniformSet(layout([
            { name: 'u_test.u_exposure', type: 'f32', offset: 0, size: 4 },
            { name: 'u_test.u_alpha', type: 'f32', offset: 4, size: 4 },
        ]), BUFFER);
        expect(set.set('u_test.u_exposure', 2.5)).toBe(true);
        set.set('u_test.u_alpha', 1);
        const floats = floatsOf(set);
        expect(floats[0]).toBe(2.5);
        expect(floats[1]).toBe(1);
    });

    it('writes a vec3 without touching its padding', () => {
        // vec3 aligns to 16 and occupies 12: the fourth float belongs to whatever comes next, and
        // writing it would silently corrupt that member.
        const set = new UniformSet(layout([
            { name: 'u_test.u_color', type: 'vec3<f32>', offset: 0, size: 12 },
            { name: 'u_test.u_scale', type: 'f32', offset: 12, size: 4 },
        ]), BUFFER);
        set.set('u_test.u_scale', 9);
        set.set('u_test.u_color', [1, 2, 3]);
        const floats = floatsOf(set);
        expect([...floats.slice(0, 4)]).toEqual([1, 2, 3, 9]);
    });

    it('writes integer members through the integer view', () => {
        // A flag stored as i32 must be written as bits, not converted — 1.0 as a float is 0x3f800000.
        const set = new UniformSet(layout([
            { name: 'u_test.u_enabled', type: 'i32', offset: 0, size: 4 },
        ]), BUFFER);
        set.set('u_test.u_enabled', true);
        expect(intsOf(set)[0]).toBe(1);
    });
});

describe('matrices', () => {
    it('writes a mat4x4 as sixteen contiguous floats', () => {
        const set = new UniformSet(layout([
            { name: 'u_test.u_model', type: 'mat4x4<f32>', offset: 0, size: 64, matrixStride: 16 },
        ]), BUFFER);
        const m = new Float32Array(16).map((_, i) => i + 1);
        set.set('u_test.u_model', m);
        expect([...floatsOf(set).slice(0, 16)]).toEqual([...m]);
    });

    it('pads mat3x3 columns to 16 bytes', () => {
        // Three columns of vec3, each 16-byte aligned: floats 0-2, 4-6, 8-10, with 3/7/11 untouched.
        const set = new UniformSet(layout([
            { name: 'u_test.u_normal', type: 'mat3x3<f32>', offset: 0, size: 48, matrixStride: 16 },
        ]), BUFFER);
        set.set('u_test.u_normal', [1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const f = floatsOf(set);
        expect([...f.slice(0, 12)]).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0]);
    });
});

describe('arrays', () => {
    it('spaces elements by the array stride', () => {
        const set = new UniformSet(layout([
            { name: 'u_test.u_splits', type: 'array<vec4<f32>, 3>', offset: 0, size: 48, arrayStride: 16 },
        ]), BUFFER);
        set.set('u_test.u_splits', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        expect([...floatsOf(set).slice(0, 12)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('pads a scalar array to its 16-byte stride', () => {
        // `array<f32, N>` costs 16 bytes PER ELEMENT in the uniform address space. Writing it tightly
        // would put every value where the shader is not looking.
        const set = new UniformSet(layout([
            { name: 'u_test.u_values', type: 'array<f32, 3>', offset: 0, size: 48, arrayStride: 16 },
        ]), BUFFER);
        set.set('u_test.u_values', [7, 8, 9]);
        const f = floatsOf(set);
        expect([f[0], f[4], f[8]]).toEqual([7, 8, 9]);
    });

    it('leaves the tail alone when the value is shorter than the member', () => {
        // The SSAO kernel depends on this: it uploads only the samples in use, not all 64.
        const set = new UniformSet(layout([
            { name: 'u_test.u_samples', type: 'array<vec4<f32>, 4>', offset: 0, size: 64, arrayStride: 16 },
        ]), BUFFER);
        set.set('u_test.u_samples', [1, 1, 1, 1, 2, 2, 2, 2]);
        const f = floatsOf(set);
        expect([...f.slice(0, 8)]).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
        expect([...f.slice(8, 16)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });
});

describe('name resolution', () => {
    it('accepts the renderer’s shorter alias for a nested member', () => {
        // Call sites say `setUniform('u_exposure', …)` while the layout knows it as
        // `u_present.u_exposure`. The same suffix aliasing UniformBlockSet applies on WebGL2.
        const set = new UniformSet(layout([
            { name: 'u_present.u_exposure', type: 'f32', offset: 0, size: 4 },
        ]), BUFFER);
        expect(set.has('u_exposure')).toBe(true);
        expect(set.set('u_exposure', 3)).toBe(true);
        expect(floatsOf(set)[0]).toBe(3);
    });

    it('reports a miss rather than throwing, so a caller can try another block', () => {
        const set = new UniformSet(layout([
            { name: 'u_test.u_a', type: 'f32', offset: 0, size: 4 },
        ]), BUFFER);
        expect(set.set('u_nothing', 1)).toBe(false);
    });

    it('resolves an array-of-struct member by its leaf name', () => {
        const set = new UniformSet(layout([
            { name: 'u_l.u_pointLights[1].position', type: 'vec3<f32>', offset: 32, size: 12 },
        ]), BUFFER);
        expect(set.has('u_pointLights[1].position')).toBe(true);
        set.set('u_pointLights[1].position', [4, 5, 6]);
        expect([...floatsOf(set).slice(8, 11)]).toEqual([4, 5, 6]);
    });
});

describe('uploads', () => {
    it('uploads once per flush and only when dirty', () => {
        const set = new UniformSet(layout([
            { name: 'u_test.u_a', type: 'f32', offset: 0, size: 4 },
        ]), BUFFER);
        const { device, uploads } = fakeDevice();
        set.set('u_test.u_a', 1);
        set.set('u_test.u_a', 2);
        set.flush(device);
        set.flush(device);
        expect(uploads).toHaveLength(1);   // two writes, one upload; the second flush is a no-op
    });
});

/**
 * Routing a name to the right BLOCK.
 *
 * A program has several uniform blocks and the renderer's call sites name a member without knowing
 * which one holds it — `outline` keeps its matrices in group 1 and its colour in group 2, the lit
 * families spread four across groups 1, 2, 4 and 5. These pin the routing rules rather than the
 * offsets, which `harness:uniforms` checks against a real driver.
 */
describe('ProgramUniforms', () => {
    const TRANSFORM: UniformBlockLayout = {
        name: 'u_transform', group: 1, binding: 0, size: 64,
        flat: [
            { name: 'u_transform.u_scale', type: 'f32', offset: 0, size: 4 },
            { name: 'u_transform.u_shared', type: 'f32', offset: 4, size: 4 },
        ],
    };
    const MATERIAL: UniformBlockLayout = {
        name: 'u_material', group: 2, binding: 0, size: 32,
        flat: [
            { name: 'u_material.u_color', type: 'vec3<f32>', offset: 0, size: 12 },
            { name: 'u_material.u_shared', type: 'f32', offset: 16, size: 4 },
        ],
    };

    /** A device that hands out distinguishable buffers and records uploads per buffer. */
    function twoBlockProgram() {
        const uploads = new Map<string, Uint8Array>();
        const device = {
            createBuffer: (d: any) => ({ label: d.label, size: d.size, usage: d.usage, destroy() {} }),
            writeBuffer: (b: any, _o: number, data: ArrayBufferView) =>
                uploads.set(b.label, new Uint8Array(data.buffer.slice(0))),
        } as any;
        return { device, uploads, program: new ProgramUniforms(device, [TRANSFORM, MATERIAL], 'outline') };
    }

    it('allocates one buffer per block, sized to the block', () => {
        const { program } = twoBlockProgram();
        expect(program.blocks.map(b => b.buffer.size)).toEqual([64, 32]);
        expect(program.blocks.map(b => b.buffer.label)).toEqual(['outline:u_transform', 'outline:u_material']);
    });

    it('finds a block by the group it is bound at', () => {
        const { program } = twoBlockProgram();
        expect(program.forGroup(1)?.layout.name).toBe('u_transform');
        expect(program.forGroup(2)?.layout.name).toBe('u_material');
        expect(program.forGroup(3)).toBeUndefined();
    });

    it('routes a bare name to the block that declares it', () => {
        const { program, device, uploads } = twoBlockProgram();
        expect(program.set('u_color', [0.25, 0.5, 0.75])).toBe(true);
        program.flush(device);
        const material = new Float32Array(uploads.get('outline:u_material')!.buffer);
        expect([material[0], material[1], material[2]]).toEqual([0.25, 0.5, 0.75]);
    });

    it('reports a name no block declares, without throwing', () => {
        // Load-bearing: the renderer sets uniforms only some programs have, and every call site relies
        // on the miss being silent.
        const { program } = twoBlockProgram();
        expect(program.set('u_notAThing', 1)).toBe(false);
    });

    it('gives an ambiguous name to the FIRST block in declaration order', () => {
        const { program, device, uploads } = twoBlockProgram();
        program.set('u_shared', 9);
        program.flush(device);
        const transform = new Float32Array(uploads.get('outline:u_transform')!.buffer);
        const material = new Float32Array(uploads.get('outline:u_material')!.buffer);
        expect(transform[1]).toBe(9);      // u_transform.u_shared, offset 4
        expect(material[4]).toBe(0);       // u_material.u_shared, offset 16 — untouched
    });

    it('keeps routing to the same block once resolved', () => {
        // The route is memoised; a second write must not re-search and land elsewhere.
        const { program, device, uploads } = twoBlockProgram();
        program.set('u_shared', 1);
        program.set('u_shared', 2);
        program.flush(device);
        const transform = new Float32Array(uploads.get('outline:u_transform')!.buffer);
        expect(transform[1]).toBe(2);
    });

    it('uploads only the blocks that changed', () => {
        const { program, device, uploads } = twoBlockProgram();
        program.flush(device);            // both dirty on construction
        uploads.clear();
        program.set('u_color', [1, 1, 1]);
        program.flush(device);
        expect([...uploads.keys()]).toEqual(['outline:u_material']);
    });
});

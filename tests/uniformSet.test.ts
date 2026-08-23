import { describe, it, expect } from 'vitest';
import { UniformSet } from '../src/graphics/rhi/uniformSet';
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

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

/**
 * A device that hands out plain buffer records. `UniformSet` allocates its own arena now, so a caller
 * supplies a device rather than a buffer.
 */
const ALLOCATOR = {
    createBuffer: (d: any) => ({ label: d.label, size: d.size, usage: d.usage, destroy() {} } as Buffer),
    writeBuffer: () => { /* construction never uploads */ },
} as any;

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
        ]), ALLOCATOR);
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
        ]), ALLOCATOR);
        set.set('u_test.u_scale', 9);
        set.set('u_test.u_color', [1, 2, 3]);
        const floats = floatsOf(set);
        expect([...floats.slice(0, 4)]).toEqual([1, 2, 3, 9]);
    });

    it('writes integer members through the integer view', () => {
        // A flag stored as i32 must be written as bits, not converted — 1.0 as a float is 0x3f800000.
        const set = new UniformSet(layout([
            { name: 'u_test.u_enabled', type: 'i32', offset: 0, size: 4 },
        ]), ALLOCATOR);
        set.set('u_test.u_enabled', true);
        expect(intsOf(set)[0]).toBe(1);
    });
});

describe('matrices', () => {
    it('writes a mat4x4 as sixteen contiguous floats', () => {
        const set = new UniformSet(layout([
            { name: 'u_test.u_model', type: 'mat4x4<f32>', offset: 0, size: 64, matrixStride: 16 },
        ]), ALLOCATOR);
        const m = new Float32Array(16).map((_, i) => i + 1);
        set.set('u_test.u_model', m);
        expect([...floatsOf(set).slice(0, 16)]).toEqual([...m]);
    });

    it('pads mat3x3 columns to 16 bytes', () => {
        // Three columns of vec3, each 16-byte aligned: floats 0-2, 4-6, 8-10, with 3/7/11 untouched.
        const set = new UniformSet(layout([
            { name: 'u_test.u_normal', type: 'mat3x3<f32>', offset: 0, size: 48, matrixStride: 16 },
        ]), ALLOCATOR);
        set.set('u_test.u_normal', [1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const f = floatsOf(set);
        expect([...f.slice(0, 12)]).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0]);
    });
});

describe('arrays', () => {
    it('spaces elements by the array stride', () => {
        const set = new UniformSet(layout([
            { name: 'u_test.u_splits', type: 'array<vec4<f32>, 3>', offset: 0, size: 48, arrayStride: 16 },
        ]), ALLOCATOR);
        set.set('u_test.u_splits', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        expect([...floatsOf(set).slice(0, 12)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('pads a scalar array to its 16-byte stride', () => {
        // `array<f32, N>` costs 16 bytes PER ELEMENT in the uniform address space. Writing it tightly
        // would put every value where the shader is not looking.
        const set = new UniformSet(layout([
            { name: 'u_test.u_values', type: 'array<f32, 3>', offset: 0, size: 48, arrayStride: 16 },
        ]), ALLOCATOR);
        set.set('u_test.u_values', [7, 8, 9]);
        const f = floatsOf(set);
        expect([f[0], f[4], f[8]]).toEqual([7, 8, 9]);
    });

    it('leaves the tail alone when the value is shorter than the member', () => {
        // The SSAO kernel depends on this: it uploads only the samples in use, not all 64.
        const set = new UniformSet(layout([
            { name: 'u_test.u_samples', type: 'array<vec4<f32>, 4>', offset: 0, size: 64, arrayStride: 16 },
        ]), ALLOCATOR);
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
        ]), ALLOCATOR);
        expect(set.has('u_exposure')).toBe(true);
        expect(set.set('u_exposure', 3)).toBe(true);
        expect(floatsOf(set)[0]).toBe(3);
    });

    it('reports a miss rather than throwing, so a caller can try another block', () => {
        const set = new UniformSet(layout([
            { name: 'u_test.u_a', type: 'f32', offset: 0, size: 4 },
        ]), ALLOCATOR);
        expect(set.set('u_nothing', 1)).toBe(false);
    });

    it('resolves an array-of-struct member by its leaf name', () => {
        const set = new UniformSet(layout([
            { name: 'u_l.u_pointLights[1].position', type: 'vec3<f32>', offset: 32, size: 12 },
        ]), ALLOCATOR);
        expect(set.has('u_pointLights[1].position')).toBe(true);
        set.set('u_pointLights[1].position', [4, 5, 6]);
        expect([...floatsOf(set).slice(8, 11)]).toEqual([4, 5, 6]);
    });
});

describe('uploads', () => {
    it('uploads once per flush and only when dirty', () => {
        const set = new UniformSet(layout([
            { name: 'u_test.u_a', type: 'f32', offset: 0, size: 4 },
        ]), ALLOCATOR);
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
            // Keyed by the BLOCK, not the buffer label: an arena's label carries its slot count
            // (`outline:u_transform[64]`), which is an allocation detail these tests do not pin.
            writeBuffer: (b: any, _o: number, data: ArrayBufferView) =>
                uploads.set(String(b.label).replace(/\[\d+\]$/, ''), new Uint8Array(data.buffer.slice(0))),
        } as any;
        return { device, uploads, program: new ProgramUniforms(device, [TRANSFORM, MATERIAL], 'outline') };
    }

    it('allocates one ARENA per block, a whole number of aligned slots', () => {
        const { program } = twoBlockProgram();
        // 64 and 32 bytes both round up to one 256-byte slot, and a small block gets the initial
        // 64-slot arena. The size is slots x slotSize, not the block size: successive values of the
        // same block have to land at different offsets or a multi-draw pass reads only the last one.
        expect(program.blocks.map(b => b.slotSize)).toEqual([256, 256]);
        expect(program.blocks.map(b => b.buffer.size)).toEqual([64 * 256, 64 * 256]);
        expect(program.blocks.map(b => b.buffer.label))
            .toEqual(['outline:u_transform[64]', 'outline:u_material[64]']);
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

    it('writes an ambiguous name to EVERY block that declares it', () => {
        // One program really does declare a member twice, in two blocks with two jobs: the transform
        // block carries `u_view` for the vertex stage and the forward lighting block carries it for
        // cascade selection. GLSL had one global per name and both uses read it; blocks turned that
        // into two destinations. Writing only the first left the other holding zeros — which for a
        // custom forward material was the TRANSFORM block, so every vertex landed at the origin with
        // w = 0, every triangle clipped, and the mesh recorded its draw and rasterised nothing.
        const { program, device, uploads } = twoBlockProgram();
        program.set('u_shared', 9);
        program.flush(device);
        const transform = new Float32Array(uploads.get('outline:u_transform')!.buffer);
        const material = new Float32Array(uploads.get('outline:u_material')!.buffer);
        expect(transform[1]).toBe(9);      // u_transform.u_shared, offset 4
        expect(material[4]).toBe(9);       // u_material.u_shared, offset 16 — at its OWN offset
    });

    it('keeps writing every declaring block once the route is memoised', () => {
        // The route is memoised as a LIST; a second write must not collapse to the first block.
        const { program, device, uploads } = twoBlockProgram();
        program.set('u_shared', 1);
        program.set('u_shared', 2);
        program.flush(device);
        const transform = new Float32Array(uploads.get('outline:u_transform')!.buffer);
        const material = new Float32Array(uploads.get('outline:u_material')!.buffer);
        expect(transform[1]).toBe(2);
        expect(material[4]).toBe(2);
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

/**
 * The arena.
 *
 * `queue.writeBuffer` is ordered against the SUBMIT, not against the commands already recorded, so a
 * pass that writes `u_model` before each of twenty draws would give all twenty the LAST value — the
 * defect that made a complete WebGPU frame render a scene with most of its objects missing. Each write
 * that follows a draw therefore lands in a fresh slot, and the bind group for that draw names it.
 */
describe('slots', () => {
    /** A device that hands out buffer records and remembers every (buffer, offset) written. */
    function arenaDevice() {
        const writes: { label: string; offset: number }[] = [];
        const device = {
            createBuffer: (d: any) => ({ label: d.label, size: d.size, usage: d.usage, destroy() {} }),
            writeBuffer: (b: any, offset: number) => writes.push({ label: b.label, offset }),
        } as any;
        return { device, writes };
    }

    const BLOCK: UniformBlockLayout = layout([
        { name: 'u_test.u_value', type: 'f32', offset: 0, size: 4 },
    ], 64);

    it('advances a slot for every value that changed', () => {
        const { device, writes } = arenaDevice();
        const set = new UniformSet(BLOCK, device, 256, 'p');
        for (const v of [1, 2, 3]) { set.set('u_value', v); set.flush(device); }
        expect(writes.map(w => w.offset)).toEqual([0, 256, 512]);
    });

    it('keeps its slot while nothing changes', () => {
        // A per-PASS block — the lights, the camera — must not consume one slot per draw.
        const { device, writes } = arenaDevice();
        const set = new UniformSet(BLOCK, device, 256, 'p');
        set.set('u_value', 1);
        set.flush(device);
        set.flush(device);
        set.flush(device);
        expect(writes.map(w => w.offset)).toEqual([0]);
        expect(set.byteOffset).toBe(0);
    });

    it('spaces slots by the ALIGNMENT the adapter reports, not by the block size', () => {
        const { device, writes } = arenaDevice();
        const set = new UniformSet(BLOCK, device, 32, 'p');
        expect(set.slotSize).toBe(64);        // 64-byte block, 32-byte alignment — already aligned
        set.set('u_value', 1); set.flush(device);
        set.set('u_value', 2); set.flush(device);
        expect(writes.map(w => w.offset)).toEqual([0, 64]);
    });

    it('releases every slot on reset, and only then reuses offset 0', () => {
        const { device, writes } = arenaDevice();
        const set = new UniformSet(BLOCK, device, 256, 'p');
        set.set('u_value', 1); set.flush(device);
        set.set('u_value', 2); set.flush(device);
        set.resetCursor();
        set.flush(device);
        expect(writes.map(w => w.offset)).toEqual([0, 256, 0]);
    });

    it('grows into a NEW buffer rather than wrapping onto a slot still in use', () => {
        const { device } = arenaDevice();
        // 16 KB budget over 256-byte slots caps at the 64-slot initial size.
        const set = new UniformSet(BLOCK, device, 256, 'p');
        const first = set.buffer;
        expect(set.generation).toBe(0);
        for (let i = 0; i < 64; i++) { set.set('u_value', i); set.flush(device); }
        expect(set.buffer).toBe(first);        // exactly full, nothing wasted
        set.set('u_value', 64); set.flush(device);
        expect(set.buffer).not.toBe(first);
        expect(set.generation).toBe(1);
        expect(set.buffer.size).toBe(128 * 256);
        // Back to the first slot — of the NEW buffer. The old one stays alive for the bind groups
        // already recorded against it, which is why it is never destroyed here.
        expect(set.byteOffset).toBe(0);
    });

    it('signs a program by the slot and generation of every block', () => {
        const { device } = arenaDevice();
        const program = new ProgramUniforms(device, [BLOCK], 'p');
        program.flush(device);
        const first = program.bindingSignature();
        program.flush(device);
        expect(program.bindingSignature()).toBe(first);   // nothing changed, same bind group
        program.set('u_value', 7);
        program.flush(device);
        expect(program.bindingSignature()).not.toBe(first);
    });
});

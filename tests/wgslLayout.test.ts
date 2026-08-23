import { describe, it, expect } from 'vitest';
import {
    splitStructMembers, findStructs, parseType, layoutOf, layoutStruct, flattenLayout,
} from '../tools/wgslLayout.mjs';

/**
 * The WGSL uniform address space layout rules.
 *
 * These offsets are what a WebGPU uniform write will use, and getting one wrong does not throw — it
 * writes a value where the shader is not looking and the frame renders with whatever was already
 * there. `tools/harness/uniformLayoutCheck.js` checks the whole shader tree against a real driver;
 * these tests pin the individual rules so a failure says WHICH rule broke.
 */

const NO_STRUCTS = new Map();

describe('splitStructMembers', () => {
    it('does not split a generic type on its comma', () => {
        // The original regex stopped at the first comma, truncating every array member's type to
        // `array<mat4x4<f32>`. The member COUNT stayed right, which is why it went unnoticed.
        const members = splitStructMembers('u_model: mat4x4<f32>, u_bones: array<mat4x4<f32>, 100>,');
        expect(members.map(m => m.name)).toEqual(['u_model', 'u_bones']);
        expect(members[1].type).toBe('array<mat4x4<f32>, 100>');
    });

    it('accepts both comma and semicolon separators', () => {
        expect(splitStructMembers('a: f32; b: f32;').map(m => m.name)).toEqual(['a', 'b']);
    });

    it('is not confused by a block comment inside the struct', () => {
        // A doc comment contains commas, and the splitter divides on commas — so an unstripped `/** */`
        // became several phantom members named after the prose, and the first one to reach `layoutOf`
        // failed with "unknown struct which of u_src0..3 to read". Line comments alone were stripped
        // until a struct was written with doc comments on its fields.
        const structs = findStructs(`
struct Packed {
    /** Per destination channel (x=r, y=g, z=b, w=a): which source to read, or -1 for a constant. */
    u_srcIndex: vec4<i32>,
    // A line comment, with a comma, for good measure.
    u_const: vec4<f32>,
};`);
        expect(structs.get('Packed')!.map(m => m.name)).toEqual(['u_srcIndex', 'u_const']);
    });

    it('records layout attributes rather than silently ignoring them', () => {
        const [member] = splitStructMembers('@align(32) @size(64) padded: vec3<f32>,');
        expect(member.name).toBe('padded');
        expect(member.type).toBe('vec3<f32>');
        expect(member.attributes).toEqual([
            { kind: 'align', value: 32 }, { kind: 'size', value: 64 },
        ]);
    });
});

describe('parseType', () => {
    it('reads vectors, matrices and scalars', () => {
        expect(parseType('f32')).toEqual({ kind: 'scalar', scalar: 'f32' });
        expect(parseType('vec3<f32>')).toEqual({ kind: 'vector', components: 3, scalar: 'f32' });
        expect(parseType('mat4x4<f32>')).toEqual({ kind: 'matrix', columns: 4, rows: 4, scalar: 'f32' });
    });

    it('splits an array at its LAST top-level comma, so the element may be generic', () => {
        expect(parseType('array<mat4x4<f32>, 100>')).toEqual({
            kind: 'array', of: 'mat4x4<f32>', count: 100,
        });
        expect(parseType('array<vec4<f32>, 1>')).toEqual({ kind: 'array', of: 'vec4<f32>', count: 1 });
    });

    it('treats an unrecognised name as a struct rather than guessing', () => {
        expect(parseType('PointLight')).toEqual({ kind: 'struct', name: 'PointLight' });
    });
});

describe('layoutOf', () => {
    it('gives vec3 an alignment of 16 and a size of 12', () => {
        // The single most common hand-packing bug: the two numbers differ, so a packer that sums sizes
        // drifts from the shader's view of the buffer after the first vec3.
        expect(layoutOf('vec3<f32>', NO_STRUCTS)).toMatchObject({ align: 16, size: 12 });
        expect(layoutOf('vec2<f32>', NO_STRUCTS)).toMatchObject({ align: 8, size: 8 });
        expect(layoutOf('vec4<f32>', NO_STRUCTS)).toMatchObject({ align: 16, size: 16 });
        expect(layoutOf('f32', NO_STRUCTS)).toMatchObject({ align: 4, size: 4 });
    });

    it('pads matrix columns to the column vector’s alignment', () => {
        // mat3x3 occupies 48 bytes, not 36: each of the three columns is a vec3 padded to 16.
        expect(layoutOf('mat3x3<f32>', NO_STRUCTS)).toMatchObject({ align: 16, size: 48, matrixStride: 16 });
        expect(layoutOf('mat4x4<f32>', NO_STRUCTS)).toMatchObject({ align: 16, size: 64, matrixStride: 16 });
        expect(layoutOf('mat2x2<f32>', NO_STRUCTS)).toMatchObject({ align: 8, size: 16, matrixStride: 8 });
    });

    it('rounds array stride up to 16 in the uniform address space', () => {
        // Why the engine packs per-cascade scalars as array<vec4<f32>, N> rather than array<f32, 4N>:
        // the latter would occupy 16 bytes PER ELEMENT here, which is not what anyone writing it means.
        expect(layoutOf('array<f32, 4>', NO_STRUCTS)).toMatchObject({ arrayStride: 16, size: 64 });
        expect(layoutOf('array<vec4<f32>, 1>', NO_STRUCTS)).toMatchObject({ arrayStride: 16, size: 16 });
        expect(layoutOf('array<mat4x4<f32>, 100>', NO_STRUCTS)).toMatchObject({ arrayStride: 64, size: 6400 });
    });
});

describe('layoutStruct', () => {
    it('aligns each member and rounds the struct up to 16', () => {
        const members = splitStructMembers('a: f32, b: vec3<f32>, c: f32,');
        const laid = layoutStruct(members, NO_STRUCTS);
        expect(laid.members.map(m => m.offset)).toEqual([0, 16, 28]);
        // 32 bytes used, rounded to the struct's 16-byte alignment.
        expect(laid.size).toBe(32);
        expect(laid.align).toBe(16);
    });

    it('honours an explicit @align over the natural one', () => {
        const members = splitStructMembers('a: f32, @align(32) b: f32,');
        expect(layoutStruct(members, NO_STRUCTS).members.map(m => m.offset)).toEqual([0, 32]);
    });

    it('measures a nested struct rather than assuming its size', () => {
        const structs = findStructs('struct Inner { a: vec3<f32>, b: f32, };');
        const laid = layoutStruct(splitStructMembers('x: f32, inner: Inner,'), structs);
        // Inner is 16 bytes and 16-aligned, so it cannot start at offset 4.
        expect(laid.members.map(m => m.offset)).toEqual([0, 16]);
        expect(laid.size).toBe(32);
    });
});

describe('flattenLayout', () => {
    const structs = findStructs(`
        struct PointLight { position: vec3<f32>, diffuse: vec3<f32>, };
        struct Lighting {
            u_viewPos: vec3<f32>,
            u_pointLights: array<PointLight, 4>,
            u_count: i32,
        };
    `);

    it('expands a struct array element by element, with block-absolute offsets', () => {
        const flat = flattenLayout('Lighting', structs, 'u_lighting');
        const byName = new Map(flat.map(m => [m.name, m.offset]));
        expect(byName.get('u_lighting.u_viewPos')).toBe(0);
        // Each PointLight is two 16-aligned vec3s = 32 bytes, starting at 16.
        expect(byName.get('u_lighting.u_pointLights[0].position')).toBe(16);
        expect(byName.get('u_lighting.u_pointLights[0].diffuse')).toBe(32);
        expect(byName.get('u_lighting.u_pointLights[1].position')).toBe(48);
        expect(byName.get('u_lighting.u_pointLights[3].diffuse')).toBe(placedAt(3) + 16);
    });

    function placedAt(index: number): number { return 16 + index * 32; }

    it('does NOT expand an array of scalars or vectors', () => {
        // GL reports such an array as one active uniform with a stride, and the renderer writes it as
        // one typed array. Expanding it would produce names nothing ever sets.
        const flat = flattenLayout('Cascades', findStructs(
            'struct Cascades { u_splits: array<vec4<f32>, 4>, };'), 'u_shadow');
        expect(flat.map(m => m.name)).toEqual(['u_shadow.u_splits']);
        expect(flat[0]).toMatchObject({ offset: 0, arrayStride: 16, size: 64 });
    });

    it('roots every path at the var name, matching what GL reflects', () => {
        // `u_material.opacity`, not `opacity` — the short aliases the renderer also uses are resolved
        // by suffix registration at runtime, the same way UniformBlockSet already does it.
        const flat = flattenLayout('Inner', findStructs('struct Inner { opacity: f32, };'), 'u_material');
        expect(flat[0].name).toBe('u_material.opacity');
    });
});

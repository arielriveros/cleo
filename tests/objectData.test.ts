import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { resolveIncludes } from '../tools/shaderIncludes.mjs';
import { translateWgsl } from '../tools/wgslTranslate.mjs';
import {
    OBJECT_TABLE_WIDTH, OBJECT_TABLE_WIDTH_SHIFT, OBJECT_RECORD_TEXELS, OBJECT_RECORD_SHIFT, OBJECT_RECORD_FLOATS,
    PALETTE_RECORDS, dissolveOf, packObjectRecord, uploadRects,
} from '../src/graphics/objectData';
import { ObjectTable, type ObjectTableBackend } from '../src/graphics/objectTable';

/**
 * The per-object table: one rgba32float texture holding each drawn object's matrix and per-object values,
 * read in the vertex stage through `instance_index`. These pin the layout (shared by TypeScript and WGSL),
 * the upload rectangles, and the rule WebGPU's queue ordering imposes: within one submission a texel is
 * never written twice, so every draw recorded reads the value it was recorded against.
 */
const CHUNK = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl', 'chunks', 'objectData.wgsl');

describe('object record layout', () => {
    it('matches the WGSL constants', () => {
        const wgsl = readFileSync(CHUNK, 'utf-8');
        const constant = (name: string) => Number(new RegExp(`const ${name}: u32 = (\\d+)u`).exec(wgsl)![1]);
        expect(1 << OBJECT_TABLE_WIDTH_SHIFT).toBe(OBJECT_TABLE_WIDTH);
        expect(constant('OBJECT_TABLE_SHIFT')).toBe(OBJECT_TABLE_WIDTH_SHIFT);
        expect(constant('OBJECT_TABLE_MASK')).toBe(OBJECT_TABLE_WIDTH - 1);
        expect(1 << OBJECT_RECORD_SHIFT).toBe(OBJECT_RECORD_TEXELS);
        expect(constant('OBJECT_RECORD_SHIFT')).toBe(OBJECT_RECORD_SHIFT);
        expect(Number.isInteger(PALETTE_RECORDS)).toBe(true);
    });

    it('computes the dissolve exactly as setDissolve does', () => {
        for (const fade of [-1, 0, 0.25, 0.3333333, 0.999, 1, 2]) {
            const uniform = new Float32Array([fade >= 1 ? 0 : 1 - Math.max(0, fade)]);
            expect(new Float32Array([dissolveOf(fade)])[0]).toBe(uniform[0]);
        }
    });

    it('packs the matrix by column, then the parameters and the UV transform', () => {
        const out = new Float32Array(OBJECT_RECORD_FLOATS + 4).fill(9);
        const m = Array.from({ length: 16 }, (_, i) => i + 0.5);
        packObjectRecord(out, 4, m, 0.25, true, 800, 2, 3, 0.5, 0.75);
        expect(Array.from(out.subarray(4, 20))).toEqual(m);
        expect(Array.from(out.subarray(20, 24))).toEqual([0.25, 1, 800, 0]);
        expect(Array.from(out.subarray(24, 28))).toEqual([2, 3, 0.5, 0.75]);
        expect(Array.from(out.subarray(28, 36))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
        packObjectRecord(out, 0, m, 0, false, 0);
        expect(Array.from(out.subarray(16, 24))).toEqual([0, 0, 0, 0, 1, 1, 0, 0]);
    });
});

describe('uploadRects', () => {
    const W = OBJECT_TABLE_WIDTH;
    it('covers a range with at most three contiguous rectangles', () => {
        expect(uploadRects(8, 8)).toEqual([]);
        expect(uploadRects(16, 40)).toEqual([{ x: 16, y: 0, width: 24, height: 1, offset: 64 }]);
        expect(uploadRects(W - 8, W + 16)).toEqual([
            { x: W - 8, y: 0, width: 8, height: 1, offset: (W - 8) * 4 },
            { x: 0, y: 1, width: 16, height: 1, offset: W * 4 },
        ]);
        expect(uploadRects(0, 3 * W)).toEqual([{ x: 0, y: 0, width: W, height: 3, offset: 0 }]);
        const r = uploadRects(W - 8, 4 * W + 8);
        expect(r.map(x => [x.x, x.y, x.width, x.height])).toEqual([[W - 8, 0, 8, 1], [0, 1, W, 3], [0, 4, 8, 1]]);
        // Every texel exactly once, in order.
        let covered = 0;
        for (const x of r) { expect(x.offset).toBe(((x.y << OBJECT_TABLE_WIDTH_SHIFT) + x.x) * 4); covered += x.width * x.height; }
        expect(covered).toBe(3 * W + 16);
    });
});

/** A fake device recording every texel's value per epoch; fails if one is written twice differently. */
function fakeBackend() {
    let epoch = 0;
    let written = new Map<string, string>();
    const textures: { id: number; deleted: boolean; rows: number }[] = [];
    const backend: ObjectTableBackend = {
        get submissionEpoch() { return epoch; },
        writeTexture: (tex, data, w, h, _m, _l, x = 0, y = 0) => {
            const t = tex as unknown as { id: number };
            const f = data as Float32Array;
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
                const key = `${t.id}:${x + i},${y + j}`;
                const value = Array.from(f.subarray(((j * w) + i) * 4, ((j * w) + i) * 4 + 4)).join(',');
                const before = written.get(key);
                if (before !== undefined && before !== value) throw new Error(`texel ${key} rewritten in one epoch`);
                written.set(key, value);
            }
        },
    };
    const allocate = (rows: number) => {
        const t = { id: textures.length + 1, deleted: false, rows };
        textures.push(t);
        return { rhiTexture: t, delete: () => { t.deleted = true; } } as never;
    };
    return {
        table: new ObjectTable(allocate, () => backend),
        submit: () => { epoch++; written = new Map(); },
        textures,
    };
}

const matrix = (tx: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, 0, 0, 1];

describe('ObjectTable', () => {
    it('gives each owner one record per epoch, reused while its data is unchanged', () => {
        const { table } = fakeBackend();
        const a = {}, b = {};
        expect(table.ensure(a, matrix(1), 0, false)).toBe(0);
        expect(table.ensure(b, matrix(2), 0, false)).toBe(1);
        expect(table.ensure(a, matrix(1), 0, false)).toBe(0);
        expect(table.count).toBe(2);
    });

    it('appends a new record when an owner changes mid-epoch, and never rewrites one', () => {
        const { table } = fakeBackend();
        const a = {};
        table.rowFor(a, matrix(1), 0, false);
        expect(table.rowFor(a, matrix(5), 0, false)).toBe(1);
        expect(table.rowFor(a, matrix(5), 0.5, false)).toBe(2);
        expect(table.rowFor(a, matrix(5), 0.5, true)).toBe(3);
    });

    it('lets consecutive identical records share one (a landscape\'s chunks)', () => {
        const { table } = fakeBackend();
        const chunks = Array.from({ length: 50 }, () => ({}));
        for (const c of chunks) expect(table.ensure(c, matrix(3), 0, false)).toBe(0);
        expect(table.count).toBe(1);
    });

    it('starts again at record 0 after a submission', () => {
        const { table, submit } = fakeBackend();
        const a = {}, b = {};
        table.rowFor(a, matrix(1), 0, false);
        table.rowFor(b, matrix(2), 0, false);
        submit();
        expect(table.rowFor(b, matrix(2), 0, false)).toBe(0);
        expect(table.rowFor(a, matrix(1), 0, false)).toBe(1);
    });

    it('uploads only what is pending, in at most a few rectangles', () => {
        const { table } = fakeBackend();
        const spy: number[] = [];
        const owners = Array.from({ length: 300 }, () => ({}));
        owners.forEach((o, i) => table.ensure(o, matrix(i), 0, false));
        const flush = table.flush.bind(table);
        table.flush = () => { spy.push(table.count); flush(); };
        table.flush();
        table.flush();
        expect(spy).toEqual([300, 300]);
    });

    it('grows into a new texture, re-uploads every record there, and frees the old one only after the epoch', () => {
        const { table, submit, textures } = fakeBackend();
        const owners = Array.from({ length: 2048 + 10 }, () => ({}));
        const generation = table.generation;
        owners.forEach((o, i) => table.rowFor(o, matrix(i), 0, false));
        expect(textures.length).toBe(2);
        expect(table.generation).toBeGreaterThan(generation);
        expect(textures[1].rows).toBe(32);
        expect(textures[0].deleted).toBe(false);   // recorded draws may still read it
        submit();
        table.rowFor({}, matrix(0), 0, false);
        expect(textures[0].deleted).toBe(true);
    });
});

describe('ObjectTable bone palettes', () => {
    const pose = (k: number) => { const b = new Float32Array(1600); for (let i = 0; i < 1600; i++) b[i] = (i % 17) + k; return b; };

    it('appends a palette once per owner per epoch, on a record boundary, and reuses an unchanged pose', () => {
        const { table, submit } = fakeBackend();
        const knight = {};
        table.ensure({}, matrix(1), 0, false);
        const texel = table.palette(knight, pose(0));
        expect(texel % OBJECT_RECORD_TEXELS).toBe(0);
        expect(texel).toBe(OBJECT_RECORD_TEXELS);           // after the one record
        expect(table.palette(knight, pose(0))).toBe(texel);
        expect(table.count).toBe(1 + PALETTE_RECORDS);
        expect(table.palette(knight, pose(1))).toBe((1 + PALETTE_RECORDS) * OBJECT_RECORD_TEXELS);
        submit();
        expect(table.palette(knight, pose(1))).toBe(0);
    });

    it('never lets an object record share the palette written before it', () => {
        const { table } = fakeBackend();
        // A palette whose last record happens to hold exactly what the next object record holds.
        const bones = new Float32Array(1600);
        const tail = new Float32Array(32);
        packObjectRecord(tail, 0, matrix(7), 0, false, 0);
        bones.set(tail, 1600 - 32);
        table.palette({}, bones);
        expect(table.ensure({}, matrix(7), 0, false)).toBe(PALETTE_RECORDS);
    });
});

describe('the table in translated GLSL', () => {
    let translated: { vertex: string; fragment: string; resources: { group: number; binding: number; kind: string; glslName: string }[] };
    beforeAll(async () => {
        const source = `#include "./chunks/objectData.wgsl"
struct T { u_view: mat4x4<f32> };
@group(1) @binding(0) var<uniform> u_t: T;
struct VO { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_main(@location(0) position: vec3<f32>, @builtin(instance_index) objectIndex: u32) -> VO {
    var out: VO;
    out.position = u_t.u_view * objectModel(objectIndex) * vec4<f32>(position, 1.0);
    out.uv = objectUvTransform(objectIndex).xy;
    return out;
}
@fragment fn fs_main(in: VO) -> @location(0) vec4<f32> { return vec4<f32>(in.uv, 0.0, 1.0); }`;
        const dir = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
        const wgsl = resolveIncludes(source, dir, {
            read: (p: string) => readFileSync(p, 'utf-8'),
            resolve: (d: string, rel: string) => resolve(d, rel),
        });
        translated = await translateWgsl(wgsl, 'objectDataProbe.wgsl') as never;
    }, 60_000);

    it('reads the table with texelFetch in the vertex stage, through the first-instance uniform', () => {
        expect(translated.vertex).toContain('uniform uint naga_vs_first_instance;');
        expect(translated.vertex).toMatch(/uniform highp sampler2D u_objectData;/);
        expect(translated.vertex).toContain('texelFetch(u_objectData');
        expect(translated.vertex).toContain('gl_InstanceID');
        expect(translated.fragment).not.toContain('u_objectData');
    });

    it('reflects the table as group 2, binding 0', () => {
        expect(translated.resources).toContainEqual(expect.objectContaining(
            { group: 2, binding: 0, kind: 'texture', glslName: 'u_objectData' }));
    });
});

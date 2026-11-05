import { describe, it, expect } from 'vitest';
import { PassEncoder } from '../src/graphics/render/passEncoder';

/**
 * Instanced draws go through `PassEncoder.recordInstancedDraw` — mesh in slot 0, per-instance data in
 * slot 1 — on every path. A mesh WITHOUT an index buffer used to fall back to an immediate-mode
 * `mesh.drawInstanced`, a raw GL call that threw on WebGPU; it now records an instanced ARRAY draw.
 */
function fakePass() {
    const calls: { name: string; args: unknown[] }[] = [];
    const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };
    return {
        calls,
        pass: {
            setVertexBuffer: record('setVertexBuffer'), setIndexBuffer: record('setIndexBuffer'),
            draw: record('draw'), drawIndexed: record('drawIndexed'),
        } as never,
    };
}

const encoder = new PassEncoder({} as never);
const vb = { vb: 1 }, ib = { ib: 1 }, instances = { inst: 1 };

describe('PassEncoder.recordInstancedDraw', () => {
    it('draws an indexed mesh through its active index level', () => {
        const { pass, calls } = fakePass();
        const mesh = { vertexBuffer: vb, activeIndexBuffer: ib, activeIndexFormat: 'uint32', activeIndexCount: 36, vertexCount: 24 };
        encoder.recordInstancedDraw(pass, mesh as never, instances as never, 7);
        expect(calls).toEqual([
            { name: 'setVertexBuffer', args: [0, vb] },
            { name: 'setVertexBuffer', args: [1, instances, 0] },
            { name: 'setIndexBuffer', args: [ib, 'uint32'] },
            { name: 'drawIndexed', args: [36, 7] },
        ]);
    });

    it('draws a mesh with no index buffer as an instanced array draw, not a fallback', () => {
        const { pass, calls } = fakePass();
        const mesh = { vertexBuffer: vb, activeIndexBuffer: null, activeIndexFormat: 'uint16', activeIndexCount: 0, vertexCount: 24 };
        encoder.recordInstancedDraw(pass, mesh as never, instances as never, 3, 64);
        expect(calls).toEqual([
            { name: 'setVertexBuffer', args: [0, vb] },
            { name: 'setVertexBuffer', args: [1, instances, 64] },
            { name: 'draw', args: [24, 3] },
        ]);
    });

    it('records nothing for zero instances', () => {
        const { pass, calls } = fakePass();
        encoder.recordInstancedDraw(pass, { vertexBuffer: vb } as never, instances as never, 0);
        expect(calls).toEqual([]);
    });
});

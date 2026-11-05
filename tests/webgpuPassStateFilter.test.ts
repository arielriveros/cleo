import { describe, it, expect, beforeEach } from 'vitest';
import { WebGPURenderPassEncoder } from '../src/graphics/rhi/webgpu/webgpuDevice';
import { frameStats, resetFrameStats } from '../src/graphics/renderStats';

/**
 * The WebGPU pass encoder skips a state call that would set what is already bound: a measured Valley frame
 * repeated 42% of its setPipeline/setBindGroup/setVertexBuffer/setIndexBuffer calls. A pass gets a fresh
 * encoder (WebGPU resets pass state at beginRenderPass), so the tracking lives and dies with it. What must
 * hold: the native calls that remain set exactly the state the full sequence would have left.
 */
function fakePass() {
    const calls: string[] = [];
    const id = new Map<object, number>();
    const name = (o: object) => { if (!id.has(o)) id.set(o, id.size + 1); return `#${id.get(o)}`; };
    const pass = {
        setPipeline: (p: object) => calls.push(`pipeline ${name(p)}`),
        setBindGroup: (i: number, g: object, offsets?: number[]) =>
            calls.push(`group ${i} ${name(g)}${offsets ? ' [' + offsets.join(',') + ']' : ''}`),
        setVertexBuffer: (s: number, b: object, o: number) => calls.push(`vb ${s} ${name(b)} ${o}`),
        setIndexBuffer: (b: object, f: string, o: number) => calls.push(`ib ${name(b)} ${f} ${o}`),
        drawIndexed: () => calls.push('draw'),
        draw: () => calls.push('draw'),
        end: () => calls.push('end'),
    };
    return { pass, calls };
}

function pipeline(empties: number[] = []) {
    const handle = {};
    const groups = empties.map(group => ({ group, handle: {} }));
    return { handle, program: '__none__', primitive: { topology: 'triangle-list' }, emptyBindGroups: () => groups };
}
const group = () => ({ handle: {} });
const buffer = () => ({ handle: {} });

describe('WebGPURenderPassEncoder state filter', () => {
    beforeEach(() => resetFrameStats());

    it('skips a pipeline, group or buffer that is already bound', () => {
        const { pass, calls } = fakePass();
        const enc = new WebGPURenderPassEncoder(pass as never, {} as never);
        const p = pipeline([2]), g0 = group(), vb = buffer(), ib = buffer();
        for (let i = 0; i < 3; i++) {
            enc.setPipeline(p as never);
            enc.setBindGroup(0, g0 as never);
            enc.setVertexBuffer(0, vb as never);
            enc.setIndexBuffer(ib as never, 'uint32');
            enc.drawIndexed(3);
        }
        expect(calls).toEqual([
            'pipeline #1', 'group 2 #2', 'group 0 #3', 'vb 0 #4 0', 'ib #5 uint32 0', 'draw', 'draw', 'draw',
        ]);
        expect(frameStats.rhiStateCalls).toBe(5);
        expect(frameStats.rhiStateCallsSaved).toBe(8);
    });

    it('re-binds the empty groups after another pipeline was set', () => {
        const { pass, calls } = fakePass();
        const enc = new WebGPURenderPassEncoder(pass as never, {} as never);
        const a = pipeline([2]), b = pipeline(), gb = group();
        enc.setPipeline(a as never);
        enc.setPipeline(b as never);
        enc.setBindGroup(2, gb as never);
        enc.setPipeline(a as never);
        expect(calls).toEqual(['pipeline #1', 'group 2 #2', 'pipeline #3', 'group 2 #4', 'pipeline #1', 'group 2 #2']);
    });

    it('always issues a group with dynamic offsets, and forgets what that slot holds', () => {
        const { pass, calls } = fakePass();
        const enc = new WebGPURenderPassEncoder(pass as never, {} as never);
        const g = group();
        enc.setBindGroup(1, g as never, [256]);
        enc.setBindGroup(1, g as never, [256]);
        enc.setBindGroup(1, g as never);
        expect(calls).toEqual(['group 1 #1 [256]', 'group 1 #1 [256]', 'group 1 #1']);
    });

    it('keys a vertex buffer on its offset and an index buffer on its format and offset', () => {
        const { pass, calls } = fakePass();
        const enc = new WebGPURenderPassEncoder(pass as never, {} as never);
        const vb = buffer(), ib = buffer();
        enc.setVertexBuffer(1, vb as never, 0);
        enc.setVertexBuffer(1, vb as never, 64);
        enc.setVertexBuffer(1, vb as never, 64);
        enc.setVertexBuffer(0, vb as never, 64);
        enc.setIndexBuffer(ib as never, 'uint16');
        enc.setIndexBuffer(ib as never, 'uint32');
        enc.setIndexBuffer(ib as never, 'uint32', 12);
        enc.setIndexBuffer(ib as never, 'uint32', 12);
        expect(calls).toEqual(['vb 1 #1 0', 'vb 1 #1 64', 'vb 0 #1 64', 'ib #2 uint16 0', 'ib #2 uint32 0', 'ib #2 uint32 12']);
    });

    it('starts every pass with nothing bound', () => {
        const a = fakePass(), b = fakePass();
        const p = pipeline(), g = group();
        const first = new WebGPURenderPassEncoder(a.pass as never, {} as never);
        first.setPipeline(p as never); first.setBindGroup(0, g as never); first.end();
        const second = new WebGPURenderPassEncoder(b.pass as never, {} as never);
        second.setPipeline(p as never); second.setBindGroup(0, g as never);
        expect(b.calls).toEqual(['pipeline #1', 'group 0 #2']);
    });
});

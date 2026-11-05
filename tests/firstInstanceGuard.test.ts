import { describe, it, expect } from 'vitest';
import { WebGL2RenderPassEncoder } from '../src/graphics/rhi/webgl2/webgl2Commands';
import { WebGPURenderPassEncoder } from '../src/graphics/rhi/webgpu/webgpuDevice';

/**
 * `firstInstance` selects a draw's per-object record. WebGPU also offsets instance-rate attribute fetch by
 * it, and WebGL2 (which has no base instance and reaches the shader through naga's
 * `naga_vs_first_instance`) cannot — so a pipeline with an instance-rate buffer must draw from 0, and both
 * encoders refuse otherwise rather than let the backends disagree.
 */
const instanced = {
    label: 'foliage', vertexLayouts: [{ stepMode: 'vertex' }, { stepMode: 'instance' }],
    primitive: { topology: 'triangle-list' }, apply: () => {}, emptyBindGroups: () => [], program: '__none__',
    handle: {}, module: { shader: { setFirstInstance: () => {} } },
};

describe('firstInstance with instance-rate vertex buffers', () => {
    it('is refused on WebGL2', () => {
        const enc = new WebGL2RenderPassEncoder();
        enc.setPipeline(instanced as never);
        expect(() => enc.drawIndexed(3, 1, 0, 0, 5)).toThrow(/instance-rate/);
    });

    it('is refused on WebGPU', () => {
        const pass = { setPipeline: () => {}, setBindGroup: () => {}, drawIndexed: () => {} };
        const enc = new WebGPURenderPassEncoder(pass as never, {} as never);
        enc.setPipeline(instanced as never);
        expect(() => enc.drawIndexed(3, 1, 0, 0, 5)).toThrow(/instance-rate/);
    });
});

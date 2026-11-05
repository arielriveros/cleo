import { describe, it, expect } from 'vitest';
import { FullscreenPasses } from '../src/graphics/render/fullscreenPasses';
import type { PipelineCache } from '../src/graphics/render/pipelineCache';
import type { BindGroupCache } from '../src/graphics/render/bindGroups';
import type { RenderPassEncoder } from '../src/graphics/rhi/device';
import type { Texture } from '../src/graphics/texture';

/**
 * FullscreenPasses.bind is the common body of ~37 fullscreen passes: the program's fullscreen pipeline
 * (fetched after the pass opened, so it sees the pass's target), set on the pass, then the textures as
 * group 0 of that same pipeline. Setting the pipeline is what binds the program, so it must come first.
 */
describe('FullscreenPasses.bind', () => {
    it('sets the fullscreen pipeline, then binds the textures as its group 0', () => {
        const calls: string[] = [];
        const pipeline = { label: 'fxaa' };
        const group = { label: 'fxaa:group0' };
        const pipelines = {
            fullscreen: (program: string, _reflection: unknown, blend?: unknown) => {
                calls.push(`fullscreen ${program} ${blend ? 'blend' : 'opaque'}`);
                return pipeline;
            },
        } as unknown as PipelineCache;
        const bindGroups = {
            textureGroup: (p: unknown, index: number, textures: Texture[]) => {
                calls.push(`textureGroup ${p === pipeline} ${index} ${textures.length}`);
                return group;
            },
        } as unknown as BindGroupCache;
        const pass = {
            setPipeline: (p: unknown) => calls.push(`setPipeline ${p === pipeline}`),
            setBindGroup: (index: number, g: unknown) => calls.push(`setBindGroup ${index} ${g === group}`),
        } as unknown as RenderPassEncoder;

        const fullscreen = new FullscreenPasses(pipelines, bindGroups);
        const blend = {} as never;
        const returned = fullscreen.bind(pass, 'fxaa', { resources: [] }, [{} as Texture, {} as Texture], blend);

        expect(returned).toBe(pipeline);
        expect(calls).toEqual([
            'fullscreen fxaa blend',
            'setPipeline true',
            'textureGroup true 0 2',
            'setBindGroup 0 true',
        ]);
    });
});

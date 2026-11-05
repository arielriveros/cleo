import type { RenderPassEncoder } from '../rhi/device';
import type { RenderPipeline } from '../rhi/resources';
import type { BlendState } from '../rhi/types';
import type { Texture } from '../texture';
import type { PipelineCache, PipelineReflection } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';

/**
 * The common body of a fullscreen pass: a program's fullscreen pipeline set on an open pass, with its
 * textures in group 0. Called between `PassEncoder.beginFullscreenPass` — which keeps every pass label a
 * literal at its call site, where the profiler-label test finds it — and
 * `PassEncoder.drawFullscreenAndEnd`. Uniforms set in between reach the program: setting the pipeline is
 * what binds it, on both backends.
 */
export class FullscreenPasses {
    constructor(private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache) {}

    /**
     * Set `program`'s fullscreen pipeline on `pass` and bind `textures` as group 0, in binding order.
     * The pipeline is fetched here, after the pass opened, because its colour formats come from the
     * pass's target. Returned for a pass that binds more than group 0.
     */
    public bind(pass: RenderPassEncoder, program: string, reflection: PipelineReflection,
                textures: Texture[], blend?: BlendState): RenderPipeline {
        const pipeline = this._pipelines.fullscreen(program, reflection, blend);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, textures));
        return pipeline;
    }
}

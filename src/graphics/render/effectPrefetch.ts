// Building the pipelines of effects a script can switch on in play (screen-space reflections and indirect light, TAA,
// volumetric fog, clouds, auto exposure, the other shadow filter) while a scene's shaders are prepared
// (Renderer.prepareShaders), without running them. Such an effect keeps history buffers it makes the first time it
// runs and never gives back, so a loading step that ran it to build its shaders would leave tens of megabytes behind
// for the session. Asked for by key instead (PipelineCache.prefetch: off the main thread on WebGPU, recorded as
// recipes), each exactly as its pass asks `get` for it, the first frame it runs finds them built.

import { Framebuffer } from '../framebuffer';
import type { PipelineCache, PipelineOptions, PipelineReflection } from './pipelineCache';
import type { BlendState } from '../rhi/types';
import type { RenderTarget } from '../rhi/resources';

/** What a Framebuffer is made with. */
export type FrameBufferOptions = NonNullable<ConstructorParameters<typeof Framebuffer>[0]>;

/**
 * The target a pass draws into: one that exists, or the options of one the effect has not made yet (a history it
 * allocates when it first runs). A pipeline's key reads its target's attachment formats, never its size, so a 1x1
 * framebuffer made with the same options stands in for it.
 */
export type PrefetchTarget = RenderTarget | FrameBufferOptions;

/** The options most history and effect buffers are made with: one half-float colour attachment, no depth. */
export const HALF_FLOAT_COLOR: FrameBufferOptions = { colorTextureOptions: { mipMap: false, precision: 'high' }, depth: false };

export class EffectPrefetch {
    /** The stand-in targets, by their options. Tiny; kept while the prefetch lives. */
    private readonly _shapes = new Map<string, Framebuffer>();

    constructor(private readonly _pipelines: PipelineCache) {}

    /** What `FullscreenPasses.bind` (PipelineCache.fullscreen) asks for, drawing into `target` with `blend`. */
    public fullscreen(program: string, reflection: PipelineReflection, target: PrefetchTarget, blend?: BlendState): void {
        this._pipelines.prefetch(program, reflection, { blend, vertex: 'model', builtFor: program, target: this.target(target) });
    }

    /** Any other pipeline, with `options` exactly as its pass gives `get`. */
    public pipeline(program: string, reflection: PipelineReflection, options: PipelineOptions, target: PrefetchTarget): void {
        this._pipelines.prefetch(program, reflection, { ...options, target: this.target(target) });
    }

    /** `target` itself, or a 1x1 framebuffer made with those options. */
    public target(target: PrefetchTarget): RenderTarget {
        if ('colorViews' in target) return target;
        const key = JSON.stringify(target);
        let fb = this._shapes.get(key);
        if (!fb) {
            fb = new Framebuffer(target).create(1, 1);
            this._shapes.set(key, fb);
        }
        return fb.renderTarget;
    }

    /** Free the stand-in targets. The pipelines built against them stay: they are keyed by formats alone. */
    public dispose(): void {
        for (const fb of this._shapes.values()) fb.destroy();
        this._shapes.clear();
    }
}

import { vec3 } from 'gl-matrix';
import { Logger } from '../../core/logger';
import { Scene } from '../../core/scene/scene';
import { BUILTIN_LENS_DIRT_MIME, BUILTIN_LENS_DIRT_BASE64 } from '../builtinLensDirt';
import { ColorGradingLut } from '../colorGrading';
import { focusDistanceToTarget, focalLengthFromFov, SENSOR_HEIGHT } from '../dofMath';
import { Framebuffer } from '../framebuffer';
import { RenderPass } from '../gpuProfiler';
import { CustomMaterial } from '../material';
import { ADDITIVE_BLEND } from '../rhi/types';
import { customShaderModules, screenShaderResources, screenUserSamplerNames } from '../systems/customShaders';
import { GLState } from '../rhi/webgl2/glState';
import { TextureManager } from '../systems/textureManager';
import { Texture } from '../texture';
import { PresentProgram, OutlinePostProgram, BloomProgram, BloomDownsampleProgram, BloomUpsampleProgram, ComposerProgram, DofCocProgram, DofGatherProgram, DofCompositeProgram, LensFlareProgram, LensFlareCompositeProgram, FxaaProgram, VignetteProgram, FilmGrainProgram, ChromaticAberrationProgram } from './programs';
import { FXAA_SEARCH_STEPS } from './settingsTypes';
import type { FxaaQuality, ToneMapper } from './settingsTypes';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { PipelineCache } from './pipelineCache';
import type { BindGroupCache } from './bindGroups';
import type { MaterialBinder } from './materialBinder';
import type { TemporalPasses } from './temporal';
import { ShaderManager } from '../systems/shaderManager';
import type { FullscreenPasses } from './fullscreenPasses';
import type { RenderSubsystems } from './subsystems';

/** What PostEffects reads from the renderer that owns it: its own state, not another subsystem's. */
export interface PostEffectsHost {
    readonly passEnabled: Record<RenderPass, boolean>;
    readonly renderHeight: number;
    readonly renderWidth: number;
}

/**
 * The post chain's effect passes and their settings: bloom, depth of field, lens flare and dirt,
 * chromatic aberration, vignette, film grain, FXAA, the selection outline, screen materials, and the
 * present pass with its tonemapper, saturation and colour-grading LUT. The render graph that orders
 * them stays in Renderer (`_buildPostGraph`). Split out of Renderer.
 */
export class PostEffects {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: PostEffectsHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _pipelines: PipelineCache,
                private readonly _bindGroups: BindGroupCache,
                private readonly _materials: MaterialBinder,
                private readonly _temporal: TemporalPasses,
                private readonly _fullscreen: FullscreenPasses,
                private readonly _sys: RenderSubsystems) {}

    /**
     * HDR bloom: luminance where bloom starts, soft-knee width around it, and additive strength.
     *
     * The threshold is EXPOSED luminance (see bloom.wgsl), and 2.0 rather than the 1.0 it sat at for as
     * long as bloom has existed. 1.0 was chosen while the bright pass was reading an unwritten mip of
     * the compose buffer and contributing almost nothing, so it was never really tested; with the
     * sampling fixed it selects 16% of an ordinary frame and lays a haze over everything.
     *
     * 2.0 is where the tonemapper gives out rather than an arbitrary knob: ACES does not reach white
     * until an exposed luminance around 2, so "bloom what would clip on screen" IS this number. Measured
     * on the harness base scene, it selects 1.3% of the frame — the blown specular highlights and
     * nothing else — against 16% at 1.0 and 71% at 0.8.
     */
    public bloomThreshold: number = 2.0;
    public bloomKnee: number = 0.5;

    /**
     * Additive strength of the bloom pyramid, 0.35.
     *
     * It was 0.6, set while the bright pass was reading an unwritten mip and adding almost nothing.
     * Against a working bloom that is too much: measured on the `full` scene it lifts the frame mean by
     * 3.8%, and what that looks like is a checkerboard floor losing its contrast and a bright sphere
     * turning into a ball of haze. 0.35 lifts it by 2.8%, keeps the floor readable, and still glows
     * clearly on the blown highlights.
     *
     * For reference, Unreal ships 0.675 — but over a DIFFERENT model, with no threshold at all and five
     * weighted passes summing to roughly 0.7 tint, which is a wide thin veiling glare rather than this
     * pyramid's thresholded glow. The number does not transfer; the restraint does.
     */
    public bloomIntensity: number = 0.35;

    // The intensity the USER asked for, remembered across quality changes — a tier that disables bloom
    // zeroes `bloomIntensity`, and this is what it restores from. Must track the default above, or a
    // quality switch silently reinstates the old value.
    public bloomIntensityUser: number = 0.35;

    // Restrict bloom to surfaces that set the scene buffer's alpha mask. Off by default: only
    // deferred-lit geometry, a baked sky and clouds can set it, so sprites and transparents never bloom.
    public bloomMaskEnabled: boolean = false;
    public chromaticAberrationStrength: number = 0.0;

    // Every effect added after the render graph landed ships OFF, so that adding them to the default
    // chain changed no existing project's image. See DEFAULT_POST_CHAIN in renderGraph/chain.ts.
    public dofEnabled: boolean = false;
    public dofFocusDistance: number = 10.0;
    public dofFocusRange: number = 0.0;
    public dofAperture: number = 2.8;
    public dofMaxBlur: number = 24.0;

    /**
     * The last focus distance actually used, so a focus target that despawns HOLDS the focal plane
     * rather than snapping it to the camera. A rack focus to zero is far more visible than a stale one.
     */
    private _dofLastFocusDistance: number = 10.0;
    private _warnedDanglingFocus: boolean = false;
    public lensFlareIntensity: number = 0.0;
    public lensFlareThreshold: number = 1.0;
    public lensFlareGhosts: number = 4;
    public lensFlareHaloWidth: number = 0.45;
    public lensDirtTexture: string | null = null;
    public lensDirtIntensity: number = 0.0;
    public vignetteStrength: number = 0.0;
    public vignetteRoundness: number = 0.0;
    public vignetteSmoothness: number = 0.4;
    public filmGrainIntensity: number = 0.0;
    public filmGrainSize: number = 2.0;
    public filmGrainColored: boolean = false;

    // Selection outline: a silhouette mask FBO plus a screen-space edge pass. `outlineActive` is set
    // per frame when something was drawn into the mask, so the pass is skipped with no selection.
    public outlineMaskFBO!: Framebuffer;
    public outlineActive: boolean = false;
    public outlineColor: [number, number, number] = [1.0, 0.55, 0.1];
    public outlineWidth: number = 5.0;

    /**
     * The built-in lens-dirt overlay, decoded once on first use.
     *
     * Held HERE rather than registered in `TextureManager`, and that is what makes it work in a
     * published game: the editor registers its 'Null' fallback into the manager at boot and the
     * standalone player does not, so a built-in registered the same way would work in the editor and
     * silently vanish everywhere else. Staying out of the manager also keeps it invisible to the
     * publish walk and the orphan collector, so it needs no plumbing in either.
     */
    private _builtinLensDirt: Texture | null = null;
    private _builtinLensDirtRequested: boolean = false;

    /**
     * The colour-grading LUT as a GPU volume. Owns its own cache and an identity fallback, so the
     * three display resolves below can bind `volumeFor(...)` unconditionally — WebGPU rejects a bind
     * group with an unsatisfied binding, and there is no 3D equivalent of the 'Null' texture.
     */
    public readonly colorLut: ColorGradingLut = new ColorGradingLut();

    // Post processing
    // Bloom downsample/upsample pyramid: level 0 is half the render size and each halves again, so the
    // whole chain costs about a third of one full-res pass. Allocation stops at 1px.
    public bloomMips: Framebuffer[] = [];
    public static readonly BLOOM_MIP_COUNT = 6;

    /** Ghost spacing along the centre line, as a fraction of the distance to it. */
    private static readonly LENS_FLARE_DISPERSAL = 0.32;

    /** Channel separation of a ghost, in uv. Small: past ~0.01 it stops reading as glass. */
    private static readonly LENS_FLARE_CHROMATIC = 0.006;

    // Upsample tent radius, in source-mip texels. ~2 gives a wide, soft falloff without ringing.
    private static readonly BLOOM_FILTER_RADIUS = 2.0;
    public fxaaEnabled: boolean = false;
    public fxaaQuality: FxaaQuality = 'medium';
    public fxaaSubpixel: number = 0.75;
    public fxaaEdgeThreshold: number = 0.125;

    /** Saturation removed at full cloud. Small: most of the wash should come from the lighting. */
    private static readonly CLOUD_DESATURATE = 0.28;

    /** Artist trim on final saturation. 1 = untouched; the cloud grade multiplies on top of it. */
    public saturation: number = 1.0;

    /** The display transform. See {@link ToneMapper} for why AgX rather than the ACES fit. */
    public toneMapper: ToneMapper = 'agx';

    /** Colour-grading LUT: a texture id resolved to a 3D volume by `colorLut`. */
    public colorGradingLut: string | null = null;
    public colorGradingIntensity: number = 1.0;

    /**
     * The operator id the shaders switch on. Must match the TONE_* constants in
     * `shaders/wgsl/chunks/grade.wgsl` — two tables, and nothing but this comment ties them.
     */
    public toneMapperId(): number {
        switch (this.toneMapper) {
            case 'aces': return 1;
            case 'neutral': return 2;
            case 'none': return 3;
            default: return 0;   // agx
        }
    }

    /**
     * LUT blend for the present pass. Zero with no LUT assigned — while one is still DECODING the
     * identity volume is bound instead, and blending toward an identity is already a no-op, so that
     * case needs no special handling and gets none.
     */
    private _lutIntensity(): number {
        return this.colorGradingLut ? this.colorGradingIntensity : 0;
    }

    /**
     * Saturation for the present pass: the artist trim, times what the clouds take out. The cloud
     * share is deliberately the small half — most of the overcast wash comes from the lighting.
     */
    private _effectiveSaturation(): number {
        const scene = this._view.scene;
        if (!scene) return this.saturation;
        const skyLight = scene.skyLight;
        const c = this._sys.lighting.cloudiness(scene) * (skyLight ? skyLight.cloudResponse : 0);
        return this.saturation * (1 - PostEffects.CLOUD_DESATURATE * c);
    }

    /**
     * (Re)size the bloom pyramid for a `width`x`height` render target. Level i is the render size
     * halved i+1 times, floored at 1px so a small window cannot ask for a 0-sized texture.
     */
    public createBloomMips(width: number, height: number): void {
        let w = Math.max(1, Math.floor(width / 2));
        let h = Math.max(1, Math.floor(height / 2));
        for (const mip of this.bloomMips) {
            if (mip.width !== w || mip.height !== h) mip.create(w, h);
            w = Math.max(1, Math.floor(w / 2));
            h = Math.max(1, Math.floor(h / 2));
        }
    }

    /**
     * The single display resolve: exposure -> tone curve -> LUT -> sRGB on the linear-HDR composite.
     * Uniform VALUES still travel by name through ShaderManager; the backend decides how a named
     * uniform reaches the GPU.
     */
    public presentPass(source: Framebuffer): void {
        const pass = this._passes.beginFullscreenPass(this._passes.screenTarget(), 'present', true);
        const lut = this.colorLut.volumeFor(this.colorGradingLut);
        this._fullscreen.bind(pass, 'present', PresentProgram, [
            source.colors[0], this._targets.scene.depth, lut,
        ]);
        this._shaderManager.setUniform('u_exposure', this._view.exposure);
        this._shaderManager.setUniform('u_saturation', this._effectiveSaturation());
        this._shaderManager.setUniform('u_toneMapper', this.toneMapperId());
        this._shaderManager.setUniform('u_lutSize', this.colorLut.size);
        this._shaderManager.setUniform('u_lutIntensity', this._lutIntensity());
        // Opaque. The flag is reset rather than assumed because uniforms persist across binds, and a
        // preceding thumbnail capture would otherwise leave it on and punch the page background
        // through the viewport.
        this._shaderManager.setUniform('u_alphaFromDepth', 0.0);
        // Every texture is bound even where it is not read (the coverage depth at alphaFromDepth 0,
        // the identity LUT at intensity 0) — WebGPU requires every declared binding to be satisfied.
        this._passes.drawFullscreenAndEnd(pass);
    }

    /**
     * Run ONE of the active camera's screen-space custom materials as a fullscreen pass, from one chain
     * stage into the next. Where it sits in the chain — and whether it runs at all — is decided in
     * `_buildPostGraph`, which is also where a material whose program failed to build is left out
     * rather than skipped mid-loop. Runs in linear HDR; the resolve happens afterwards in 'present'.
     *
     * These programs compile at RUNTIME from user GLSL, so there is no build-time reflection:
     * `customShaderResources` derives group 0 from the same interface description the prelude is
     * generated from.
     */
    public screenMaterialPass(scene: Scene, mat: CustomMaterial,
                                source: Framebuffer, target: Framebuffer): void {
        const sun = this._sys.sky.sunScreenInfo(scene);
        const pass = this._passes.beginFullscreenPass(target.renderTarget, 'screenMaterial',
                                               false, undefined, false);
        // The WGSL, when there is any. On WebGL2 there is none and none is needed — the program
        // is already linked and `_pipelines.get` reaches it by name. `entryPoints.fragment` is
        // `main` because that is what naga calls the entry it generates, not `fs_main`.
        const wgsl = customShaderModules(mat);
        const pipeline = this._pipelines.get(mat.type, {
            resources: screenShaderResources(mat.uniforms),
            ...(wgsl ? { wgsl: wgsl.fragment, entryPoints: { fragment: 'main' },
                         vertexWgsl: { wgsl: wgsl.vertex, entryPoint: wgsl.vertexEntry } } : {}),
        }, { vertex: 'model', builtFor: mat.type });
        pass.setPipeline(pipeline);
        this._shaderManager.bind(mat.type);
        // Group 0 is the two engine samplers followed by the user's, in declaration order — the
        // order `screenShaderResources` and the prelude both use. A user sampler with no texture
        // assigned gets the shared fallback, because a bind group cannot leave a binding empty.
        const fallback = TextureManager.Instance.getTexture('Null') ?? this._bindGroups.fallbackTexture;
        const userTextures = screenUserSamplerNames(mat.uniforms).map((name: string) => {
            const id = mat.textures.get(name.replace(/^u_/, ''));
            return (id ? TextureManager.Instance.getTexture(id) : null) ?? fallback;
        });
        pass.setBindGroup(0, this._bindGroups.textureGroup(pipeline, 0, [
            source.colors[0], this._targets.sceneDepth.depth, ...userTextures,
        ]));
        this._shaderManager.setUniform('u_resolution', [this._host.renderWidth, this._host.renderHeight]);
        this._shaderManager.setUniform('u_invViewProj', this._view.invViewProj);
        this._shaderManager.setUniform('u_sunDir', sun.dir);
        this._shaderManager.setUniform('u_sunUV', sun.uv);
        this._shaderManager.setUniform('u_sunVisible', sun.visible);
        this._shaderManager.setUniform('u_exposure', this._view.exposure); // lets a pass invert the final present resolve
        this._materials.applyCustom(mat, true);   // u_time, u_viewPos + user VALUE uniforms only
        this._passes.drawFullscreenAndEnd(pass);
    }

    // Screen-space selection outline: draws a border just outside the silhouette mask over the
    // final composited image. Renders to whatever framebuffer is currently bound (the screen).
    public outlinePass(source: Framebuffer): void {
        // The clear moves in here with the pass: the caller used to unbind the scene FBO and clear the
        // screen by hand, which is the same thing said twice and only one of them portable.
        const pass = this._passes.beginFullscreenPass(this._passes.screenTarget(), 'outline', true);
        const lut = this.colorLut.volumeFor(this.colorGradingLut);
        this._fullscreen.bind(pass, 'outlinePost', OutlinePostProgram, [
            source.colors[0], this.outlineMaskFBO.colors[0], lut,
        ]);
        // This pass does the final resolve, so it carries the WHOLE grade and not just the exposure.
        // It used to set only that, which meant selecting an object dropped the saturation trim and
        // the frame changed colour under the artist.
        this._shaderManager.setUniform('u_exposure', this._view.exposure);
        this._shaderManager.setUniform('u_saturation', this._effectiveSaturation());
        this._shaderManager.setUniform('u_toneMapper', this.toneMapperId());
        this._shaderManager.setUniform('u_lutSize', this.colorLut.size);
        this._shaderManager.setUniform('u_lutIntensity', this._lutIntensity());
        this._shaderManager.setUniform('u_texelSize', [1 / this._host.renderWidth, 1 / this._host.renderHeight]);
        this._shaderManager.setUniform('u_outlineColor', this.outlineColor);
        this._shaderManager.setUniform('u_outlineWidth', this.outlineWidth);
        this._passes.drawFullscreenAndEnd(pass);
    }

    /**
     * HDR bloom via a downsample/upsample mip pyramid (Jimenez, "Next Generation Post Processing in
     * Call of Duty: Advanced Warfare", SIGGRAPH 2014). Chain: bright-pass into mip 0, downsample to
     * the smallest mip, upsample back with additive blending, composite mip 0 over the scene.
     *
     * Build the bloom pyramid from `source`: bright pass, downsample chain, additive upsample chain.
     * Writes only its own mips — the composite that puts the result back over the image is
     * {@link bloomComposite}, a separate pass because it is separately switchable and because only it
     * consumes a stage of the chain.
     */
    public bloomGenerate(source: Framebuffer): void {
        // 1. Bright pass into the largest mip (half res). Also writes the scene passthrough into
        const mip0 = this.bloomMips[0];
        const brightPass = this._passes.beginFullscreenPass(mip0.renderTarget, 'bloom.bright', true,
                                                     undefined, false);
        this._fullscreen.bind(brightPass, 'bloom', BloomProgram, [
            source.colors[0], this._targets.scene.colors[0],
        ]);
        // The bright pass reads pre-exposure linear radiance, so it needs the exposure to decide what
        // counts as bright — without it the threshold is compared against radiance ~3x darker than what
        // reaches the screen, and at the default 1.0 nothing in an ordinary scene ever clears it.
        this._shaderManager.setUniform('u_bloomThreshold', this.bloomThreshold);
        this._shaderManager.setUniform('u_bloomKnee', this.bloomKnee);
        this._shaderManager.setUniform('u_exposure', this._view.exposure);
        this._shaderManager.setUniform('u_bloomMaskEnabled', this.bloomMaskEnabled);
        // The bright pass halves the resolution, so it needs both grids to box-filter rather than
        // point-sample (see sourceBlockUV in bloom.fs).
        this._shaderManager.setUniform('u_srcTexelSize', [1 / this._host.renderWidth, 1 / this._host.renderHeight]);
        this._shaderManager.setUniform('u_dstResolution', [mip0.width, mip0.height]);
        // Bloom-eligibility mask lives in the raw scene buffer's alpha (motion blur discards alpha, so
        // read it from the scene FBO directly, not the post-processed copy the first entry names).
        this._passes.drawFullscreenAndEnd(brightPass);

        if (this._host.passEnabled['bloom.blur']) {
            // 2. Downsample: each level reads the one above it at twice the resolution.
            this._passes.scope('bloom.blur');
            for (let i = 1; i < this.bloomMips.length; i++) {
                const from = this.bloomMips[i - 1];
                // `loadOp: 'load'` — each level is fully overwritten by the draw, so clearing first
                // would be a wasted write. That is what the bare `bind()` used to express implicitly.
                const pass = this._passes.beginFullscreenPass(this.bloomMips[i].renderTarget, 'bloom.blur',
                                                       false, undefined, false);
                // Built INSIDE the pass, never hoisted above the loop: `_pipelines.get` reads its colour
                // format off `_passes.target`, which only exists between begin and end. Not a
                // per-iteration cost — pipelines are cached and the format is part of the key.
                this._fullscreen.bind(pass, 'bloomDownsample', BloomDownsampleProgram, [from.colors[0]]);
                this._shaderManager.setUniform('u_srcTexelSize', [1 / from.width, 1 / from.height]);
                // Both grids: the mips halve with floor(), so an odd level is not exactly 2x the next
                // and the kernel has to be snapped to the source grid rather than assuming the ratio.
                this._shaderManager.setUniform('u_dstResolution', [this.bloomMips[i].width, this.bloomMips[i].height]);
                // Karis average on the first step only — it tames fireflies but is not energy
                // conserving, so applying it all the way down would visibly dim the bloom.
                this._shaderManager.setUniform('u_karisAverage', i === 1);
                this._passes.drawFullscreenAndEnd(pass);
            }

            // 3. Upsample: additively blend each level onto the next larger one, accumulating in the
            //    blender. ADDITIVE_BLEND (rhi/types.ts) spells out the ALPHA half as well as the
            //    colour half; a blend that forgets alpha makes bloom emit nothing.
            for (let i = this.bloomMips.length - 1; i > 0; i--) {
                const from = this.bloomMips[i];
                const to = this.bloomMips[i - 1];
                // Accumulating INTO the destination, so it must be loaded, never cleared.
                const pass = this._passes.beginFullscreenPass(to.renderTarget, 'bloom.blur', false,
                                                       undefined, false);
                // Inside the pass, for the format reason spelled out on the downsample loop above.
                this._fullscreen.bind(pass, 'bloomUpsample', BloomUpsampleProgram, [from.colors[0]], ADDITIVE_BLEND);
                // Radius in the SOURCE mip's texels, so the spread is resolution-independent. Per axis:
                // one value off the width alone is short by the aspect ratio vertically.
                this._shaderManager.setUniform('u_filterRadius',
                    [PostEffects.BLOOM_FILTER_RADIUS / from.width, PostEffects.BLOOM_FILTER_RADIUS / from.height]);
                this._passes.drawFullscreenAndEnd(pass);
            }
            // Still restored by hand: the passes that follow are on the legacy path and enable BLEND
            // without setting the function, so they inherit whatever was left. Drop this once they are
            // migrated and their own pipelines say what they need.
            GLState.blend(false);
            this._passes.restoreDefaultBlend();
        }
    }

    /** Composite the accumulated bloom back over the image, from one chain stage into the next. */
    public bloomComposite(source: Framebuffer, target: Framebuffer): void {
        const pass = this._passes.beginFullscreenPass(target.renderTarget, 'bloom.composite', true);
        // Dirt rides on the bloom composite because it is only visible where there is glare to catch —
        // see the header of composer.wgsl. Bound even at intensity 0, because WebGPU requires every
        // declared binding to be satisfied whether or not the shader reads it.
        const dirt = this._lensDirtSource();
        this._fullscreen.bind(pass, 'composer', ComposerProgram, [
            source.colors[0], this.bloomMips[0].colors[0], dirt ?? this._bindGroups.fallbackTexture,
        ]);
        this._shaderManager.setUniform('u_bloomIntensity', this.bloomIntensity);
        this._shaderManager.setUniform('u_dirtIntensity', this._lensDirtStrength(dirt));
        // The unit numbers are gone: the bind group assigns them and sets u_buffer1/u_buffer2 from the
        // shader's own reflection, so the order here is the order the shader declares.
        this._passes.drawFullscreenAndEnd(pass);
    }

    /**
     * The lens-dirt overlay to sample this frame: the project's texture, or the built-in one.
     *
     * Resolved lazily, per frame, INSIDE the pass — never at `applyRenderSettings` time. That is not a
     * style choice: the standalone player applies render settings before it registers any texture, so
     * anything that resolved an id up front would come back empty in every published game. The same
     * reason `ColorGradingLut.volumeFor` works this way.
     *
     * Returns null while the built-in is still decoding, which {@link _lensDirtStrength} turns into an
     * intensity of 0 — so a frame composites against no dirt rather than against a white fallback,
     * which would flash the bloom to double brightness for the frame or two before the decode lands.
     */
    private _lensDirtSource(): Texture | null {
        if (this.lensDirtTexture) return TextureManager.Instance.getTexture(this.lensDirtTexture) ?? null;
        if (this._builtinLensDirt) return this._builtinLensDirt;
        this._decodeBuiltinLensDirt();
        return null;
    }

    /** Kick off the one-time decode of the built-in mask. Idempotent; a failure is not retried. */
    private _decodeBuiltinLensDirt(): void {
        if (this._builtinLensDirtRequested || typeof Image === 'undefined') return;
        this._builtinLensDirtRequested = true;
        // Clamped, not repeated: it is a single overlay stretched across the frame, and a repeat wrap
        // would seam down the middle of the image the moment a sample landed outside [0,1].
        const texture = new Texture({ mipMap: false, wrapping: 'clamp' });
        const image = new Image();
        image.onload = () => {
            if (image.width > 0 && image.height > 0) {
                texture.create(image, image.width, image.height);
                this._builtinLensDirt = texture;
            } else Logger.warn('Built-in lens dirt decoded to zero size', 'Renderer');
        };
        image.onerror = () => Logger.warn('Failed to decode the built-in lens dirt', 'Renderer');
        image.src = `data:${BUILTIN_LENS_DIRT_MIME};base64,${BUILTIN_LENS_DIRT_BASE64}`;
    }

    /** The dirt intensity actually in force: zero unless there is a decoded mask to multiply by. */
    private _lensDirtStrength(dirt: Texture | null): number {
        return dirt ? this.lensDirtIntensity : 0;
    }

    /**
     * The distance the lens is focused at this frame, in metres.
     *
     * A camera that names a focus target measures the distance to it ALONG THE VIEW AXIS — a target
     * off to one side is further away than the plane it stands on, and focusing on its euclidean
     * distance would push the plane past it and leave the target itself soft.
     *
     * A target that has been removed HOLDS the last distance rather than falling back to the authored
     * one. Both are defensible; holding is much less alarming to watch, because the alternative racks
     * focus across the whole frame on the exact frame something despawned.
     */
    private _resolveFocusDistance(scene: Scene): number {
        const node = scene.activeCamera;
        const targetId = node?.focusTargetId ?? null;
        if (!targetId) {
            this._dofLastFocusDistance = this.dofFocusDistance;
            this._warnedDanglingFocus = false;
            return this.dofFocusDistance;
        }
        const target = node!.focusTarget;
        if (!target) {
            if (!this._warnedDanglingFocus) {
                Logger.warn(`Focus target ${targetId} is not in the scene; holding the last focus distance`,
                            'Renderer');
                this._warnedDanglingFocus = true;
            }
            return this._dofLastFocusDistance;
        }
        this._warnedDanglingFocus = false;
        const view = this._view.camera.viewMatrix;
        // The camera's forward axis, read off the view matrix's third row — the same place
        // `_captureTemporalCameraState` takes it from, rather than recomputing it from the node.
        const forward = vec3.fromValues(-view[2], -view[6], -view[10]);
        const distance = focusDistanceToTarget(this._view.camera.position, forward, target.worldPosition);
        // Behind the camera is not a focus distance. Hold rather than invert the image.
        if (distance > 0.01) this._dofLastFocusDistance = distance;
        return this._dofLastFocusDistance;
    }

    /** Everything in the CoC that is constant across the frame. See `dofMath.circleOfConfusion`. */
    private _dofUniforms(scene: Scene): { focus: number; halfRange: number; focal: number; scale: number } {
        const focal = focalLengthFromFov(this._view.camera.fov);
        return {
            focus: this._resolveFocusDistance(scene),
            halfRange: this.dofFocusRange * 0.5,
            focal,
            // f*f / N / sensorHeight * screenHeight — the leading term of the thin-lens CoC, in pixels.
            // The thin lens gives the blur circle's DIAMETER and the gather uses it as a RADIUS, so every
            // f-stop blurs twice as much as a real lens would. Kept on purpose: the camera's default 60
            // degree FOV is a ~21 mm lens, which barely defocuses anything at true scale.
            scale: (focal * focal / Math.max(1e-3, this.dofAperture) / SENSOR_HEIGHT) * this._host.renderHeight,
        };
    }

    /**
     * Depth of field: CoC prefilter, bokeh gather, composite. Three passes over two half-resolution
     * buffers the graph owns, so none of it is resident when the effect is off.
     */
    public dofPass(scene: Scene, coc: Framebuffer, bokeh: Framebuffer,
                     source: Framebuffer, target: Framebuffer): void {
        const u = this._dofUniforms(scene);
        const depth = this._temporal.depthSource();

        // 1. Half-res colour, and the signed CoC in alpha. The scope is already open — this node
        //    reports under `dof.coc`, and the two below are opened as it moves through them.
        const cocPass = this._passes.beginFullscreenPass(coc.renderTarget, 'dof.coc', true, undefined, false);
        this._fullscreen.bind(cocPass, 'dofCoc', DofCocProgram, [source.colors[0], depth]);
        this._shaderManager.setUniform('u_near', this._view.camera.near);
        this._shaderManager.setUniform('u_far', this._view.camera.far);
        this._shaderManager.setUniform('u_focusDistance', u.focus);
        this._shaderManager.setUniform('u_focusHalfRange', u.halfRange);
        this._shaderManager.setUniform('u_focalLength', u.focal);
        this._shaderManager.setUniform('u_cocScale', u.scale);
        this._shaderManager.setUniform('u_maxCocPx', this.dofMaxBlur);
        this._shaderManager.setUniform('u_srcTexelSize', [1 / this._host.renderWidth, 1 / this._host.renderHeight]);
        this._passes.drawFullscreenAndEnd(cocPass);

        // 2. The bokeh itself.
        this._passes.scope('dof.gather');
        const gatherPass = this._passes.beginFullscreenPass(bokeh.renderTarget, 'dof.gather', true,
                                                     undefined, false);
        this._fullscreen.bind(gatherPass, 'dofGather', DofGatherProgram, [coc.colors[0]]);
        // The clamp expressed in the grid this pass works in, which is half the render resolution.
        this._shaderManager.setUniform('u_maxCocHalfPx', this.dofMaxBlur * 0.5);
        this._shaderManager.setUniform('u_texelSize', [1 / coc.width, 1 / coc.height]);
        this._passes.drawFullscreenAndEnd(gatherPass);

        // 3. Back over the sharp image, with the CoC recomputed at full resolution so the boundary
        //    between sharp and blurred does not land on the half-res grid.
        this._passes.scope('dof.composite');
        const outPass = this._passes.beginFullscreenPass(target.renderTarget, 'dof.composite', true);
        this._fullscreen.bind(outPass, 'dofComposite', DofCompositeProgram, [
            source.colors[0], bokeh.colors[0], depth,
        ]);
        this._shaderManager.setUniform('u_near', this._view.camera.near);
        this._shaderManager.setUniform('u_far', this._view.camera.far);
        this._shaderManager.setUniform('u_focusDistance', u.focus);
        this._shaderManager.setUniform('u_focusHalfRange', u.halfRange);
        this._shaderManager.setUniform('u_focalLength', u.focal);
        this._shaderManager.setUniform('u_cocScale', u.scale);
        this._shaderManager.setUniform('u_maxCocPx', this.dofMaxBlur);
        this._passes.drawFullscreenAndEnd(outPass);
    }

    /**
     * Ghosts and halo, raised at half resolution into `scratch` and composited additively back into
     * `target`. In place, like god rays, so it neither consumes nor produces a stage of the chain.
     */
    public lensFlarePass(scratch: Framebuffer, target: Framebuffer): void {
        // 1. Trace the ghosts. Reads the chain image itself, so anything occluded throws no flare.
        const genPass = this._passes.beginFullscreenPass(scratch.renderTarget, 'lensFlare', true,
                                                  undefined, false);
        this._fullscreen.bind(genPass, 'lensFlare', LensFlareProgram, [target.colors[0]]);
        // The threshold is on the EXPOSED image, as bloom's is, so it means the same brightness on screen in
        // a sunlit field and in a cave; the buffer is pre-exposure, so it is uploaded divided back out.
        this._shaderManager.setUniform('u_flareThreshold', this.lensFlareThreshold / Math.max(1e-8, this._view.exposure));
        this._shaderManager.setUniform('u_flareGhosts', this.lensFlareGhosts);
        // Not a setting: the spacing that puts the ghosts across the frame rather than piled at the
        // centre. Exposing it alongside the ghost count would mostly be a way to hide them all.
        this._shaderManager.setUniform('u_flareDispersal', PostEffects.LENS_FLARE_DISPERSAL);
        this._shaderManager.setUniform('u_flareHaloWidth', this.lensFlareHaloWidth);
        this._shaderManager.setUniform('u_flareChromatic', PostEffects.LENS_FLARE_CHROMATIC);
        this._passes.drawFullscreenAndEnd(genPass);

        // 2. Add it back, modulated by the dirt overlay. Additive, so the pass returns a contribution
        // and never reads its own destination — which is what makes the in-place declaration honest.
        const dirt = this._lensDirtSource();
        const upPass = this._passes.beginFullscreenPass(target.renderTarget, 'lensFlareComposite', false,
                                                 undefined, false);
        this._fullscreen.bind(upPass, 'lensFlareComposite', LensFlareCompositeProgram, [
            scratch.colors[0], dirt ?? this._bindGroups.fallbackTexture,
        ], ADDITIVE_BLEND);
        this._shaderManager.setUniform('u_flareIntensity', this.lensFlareIntensity);
        this._shaderManager.setUniform('u_dirtIntensity', this._lensDirtStrength(dirt));
        this._passes.drawFullscreenAndEnd(upPass);

        // Restored by hand, as god rays does: the passes that follow are still on the legacy path and
        // enable BLEND without setting the function, so they inherit whatever was left here.
        GLState.blend(false);
        this._passes.restoreDefaultBlend();
    }

    public fxaaPass(source: Framebuffer, target: Framebuffer): void {
        const pass = this._passes.beginFullscreenPass(target.renderTarget, 'fxaa', true);
        this._fullscreen.bind(pass, 'fxaa', FxaaProgram, [source.colors[0]]);
        this._shaderManager.setUniform('u_texelSize', [1 / Math.max(1, this._host.renderWidth), 1 / Math.max(1, this._host.renderHeight)]);
        this._shaderManager.setUniform('u_exposure', this._view.exposure);
        this._shaderManager.setUniform('u_edgeThreshold', this.fxaaEdgeThreshold);
        this._shaderManager.setUniform('u_subpixel', this.fxaaSubpixel);
        this._shaderManager.setUniform('u_searchSteps', FXAA_SEARCH_STEPS[this.fxaaQuality]);
        this._passes.drawFullscreenAndEnd(pass);
    }

    /** Lens fall-off toward the corners, multiplicative on the linear-HDR chain. */
    public vignettePass(source: Framebuffer, target: Framebuffer): void {
        const pass = this._passes.beginFullscreenPass(target.renderTarget, 'vignette', true);
        this._fullscreen.bind(pass, 'vignette', VignetteProgram, [source.colors[0]]);
        this._shaderManager.setUniform('u_vignetteStrength', this.vignetteStrength);
        this._shaderManager.setUniform('u_vignetteRoundness', this.vignetteRoundness);
        this._shaderManager.setUniform('u_vignetteSmoothness', this.vignetteSmoothness);
        // The RENDER aspect, not the canvas: internal buffers follow `renderScale` and the present
        // pass upscales, so a canvas-derived ratio would skew the ellipse at any scale but 1.
        this._shaderManager.setUniform('u_aspect', this._host.renderWidth / Math.max(1, this._host.renderHeight));
        this._passes.drawFullscreenAndEnd(pass);
    }

    /** Film grain, animated and midtone-weighted. The last thing in the lens; see filmGrain.wgsl. */
    public filmGrainPass(source: Framebuffer, target: Framebuffer): void {
        const pass = this._passes.beginFullscreenPass(target.renderTarget, 'filmGrain', true);
        this._fullscreen.bind(pass, 'filmGrain', FilmGrainProgram, [source.colors[0]]);
        this._shaderManager.setUniform('u_grainIntensity', this.filmGrainIntensity);
        this._shaderManager.setUniform('u_grainSize', this.filmGrainSize);
        this._shaderManager.setUniform('u_grainColored', this.filmGrainColored ? 1 : 0);
        // Wall-clock, as the other animated passes take it. A frame counter would tie the grain's
        // speed to the frame rate, so it would crawl on a slow machine and shimmer on a fast one.
        this._shaderManager.setUniform('u_time', performance.now() * 0.001);
        this._shaderManager.setUniform('u_resolution', [this._host.renderWidth, this._host.renderHeight]);
        this._shaderManager.setUniform('u_exposure', this._view.exposure);
        this._passes.drawFullscreenAndEnd(pass);
    }

    public chromaticAberrationPass(source: Framebuffer, target: Framebuffer): void {
        const pass = this._passes.beginFullscreenPass(target.renderTarget, 'chromatic', true);
        this._fullscreen.bind(pass, 'chromaticAberration', ChromaticAberrationProgram, [source.colors[0]]);
        this._shaderManager.setUniform('u_strength', this.chromaticAberrationStrength);
        this._shaderManager.setUniform('u_aspect', this._host.renderWidth / Math.max(1, this._host.renderHeight));
        this._passes.drawFullscreenAndEnd(pass);
    }
}

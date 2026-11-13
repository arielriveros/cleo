import type { RenderSettings } from '../../graphics/render/settingsTypes';

/**
 * The render settings a movie draws with, from the project's own (renderer.getRenderSettings()).
 *
 * Cinematic quality raises what only costs time — resolution scales to 1, sample and step counts, shadow
 * and shelter map sizes, GI rays per frame, the Ultra tier's clouds — and turns off what trades the picture
 * for frame time (staggered shadow cascades, asynchronous occlusion verdicts). It never touches the LOOK:
 * exposure, tone curve, grading, bloom, fog, draw distances, which effects are on at all, and the shadows'
 * filter. Those are the project's, and the movie must look like the game.
 *
 * Anti-aliasing and motion blur follow the samples. With two or more per frame the movie's own average does
 * both (render/movieCapture.ts), so TAA, FXAA and the post motion blur are off — they would filter an image
 * that is already filtered, and TAA's history would smear across samples. With one sample the frame is
 * what Play shows: the project's TAA, and its motion blur set to the shutter (a 180° shutter blurs half a
 * frame's movement, as a camera does).
 */

export interface MovieQuality {
    samples: number;
    /** The shutter as a fraction of the frame (180° = 0.5). */
    shutter: number;
    /** Raise every cost-only quality setting (on by default in the dialog). */
    cinematic: boolean;
}

/** Ultra-tier floors and the movie's own ceilings for the counts it raises. */
const CINEMATIC = {
    ssaoSamples: 64,
    ssrSteps: 64,
    giRaysPerFrame: 1 << 20,
    giFillDrawsPerFrame: 512,
    volumetricFogTileSize: 12,
    volumetricFogSlices: 96,
    weatherShelterResolution: 2048,
    shadowMapResolution: 4096,
    shadowCascades: 4,
    particleLodDistanceScale: 1.5,
} as const;

const atLeast = (value: number | undefined, floor: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(value, floor) : floor;

export function movieRenderSettings(project: RenderSettings, quality: MovieQuality): Partial<RenderSettings> {
    const out: Partial<RenderSettings> = { ...project };
    if (quality.cinematic) {
        // The Ultra tier first (it is also what pushes Ultra's cloud march to the scene's clouds), then every
        // project key on top of it, then the raised ones: the tier's enable flags never win over the project's.
        Object.assign(out, {
            quality: 'ultra',
            renderScale: 1,
            ssaoResolutionScale: 1,
            ssaoSamples: atLeast(project.ssaoSamples, CINEMATIC.ssaoSamples),
            ssrResolutionScale: 1,
            ssrSteps: atLeast(project.ssrSteps, CINEMATIC.ssrSteps),
            giResolutionScale: 1,
            giRaysPerFrame: atLeast(project.giRaysPerFrame, CINEMATIC.giRaysPerFrame),
            giFillDrawsPerFrame: atLeast(project.giFillDrawsPerFrame, CINEMATIC.giFillDrawsPerFrame),
            volumetricFogTileSize: Math.min(project.volumetricFogTileSize ?? CINEMATIC.volumetricFogTileSize, CINEMATIC.volumetricFogTileSize),
            volumetricFogSlices: atLeast(project.volumetricFogSlices, CINEMATIC.volumetricFogSlices),
            weatherShelterResolution: atLeast(project.weatherShelterResolution, CINEMATIC.weatherShelterResolution),
            shadowMapResolution: atLeast(project.shadowMapResolution, CINEMATIC.shadowMapResolution),
            shadowCascades: atLeast(project.shadowCascades, CINEMATIC.shadowCascades),
            particleLodDistanceScale: atLeast(project.particleLodDistanceScale, CINEMATIC.particleLodDistanceScale),
            shadowStagger: false,
            occlusionQueries: false,
        } satisfies Partial<RenderSettings>);
    }
    if (Math.floor(quality.samples) >= 2) {
        out.taaEnabled = false;
        out.fxaaEnabled = false;
        out.motionBlurEnabled = false;
    } else if (project.motionBlurEnabled) {
        out.motionBlurIntensity = Math.min(1, Math.max(0, quality.shutter));
    }
    return out;
}

import { mat4, vec3 } from 'gl-matrix';
import { MAX_FORCE_FIELDS } from '../../core/scene/nodes/forceFieldNode';
import { packFrameFields } from '../../particles/particleFields';
import { LightNode } from '../../core/scene/nodes/lightNode';
import type { ParticleSystemNode } from '../../core/scene/nodes/particleSystemNode';
import { Scene } from '../../core/scene/scene';
import { AreaLight, DirectionalLight, PointLight, Spotlight } from '../lighting';
import { skyAmbient } from '../particles/particleLighting';
import type { ParticleLocalLight } from '../particles/particleLighting';
import { ParticleRenderer } from '../particles/particleRenderer';
import type { ParticleSimFrame, ParticleDrawFrame } from '../particles/particleRenderer';
import type { RenderPassEncoder } from '../rhi/device';
import type { RenderTarget } from '../rhi/resources';
import { keyLight } from '../skyNight';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { ViewProjection } from './viewProjection';
import type { TemporalPasses } from './temporal';
import type { RenderSubsystems } from './subsystems';
import type { ParticleWeather } from './weather';

/** What ParticlePasses reads from the renderer that owns it: its own state, not another subsystem's. */
export interface ParticlePassesHost {
    readonly renderHeight: number;
    readonly renderWidth: number;
    readonly thumbnailMode: boolean;
}

/**
 * The renderer's side of the GPU particle system: running the queued simulation steps with this
 * frame's force fields and collision depth, sorting, and drawing with the camera, depth snapshot and
 * scene light a lit particle needs. The simulation itself is ParticleRenderer's. Split out of Renderer.
 */
export class ParticlePasses {
    constructor(private readonly _host: ParticlePassesHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _passes: PassEncoder,
                private readonly _projection: ViewProjection,
                private readonly _temporal: TemporalPasses,
                private readonly _sys: RenderSubsystems) {}

    /** The GPU particle system: state textures, simulation steps, billboard draws. */
    public readonly particles = new ParticleRenderer();

    /**
     * The camera that produced the opaque depth the particle simulation collides against — LAST frame's,
     * since the simulation runs before this frame draws anything. Its own copy rather than
     * `_view.prevViewProj`, because a thumbnail capture must not overwrite it.
     */
    public readonly particleCollideViewProj: mat4 = mat4.create();
    public readonly particleCollideCamPos: vec3 = vec3.create();
    public particleCollideOrtho = false;
    public particleCollideValid = false;
    private readonly _forceFieldScratch = new Float32Array(MAX_FORCE_FIELDS * 16);

    /** See RenderSettings.particleLodDistanceScale. */
    public particleLodDistanceScale: number = 1;
    /** See RenderSettings.precipitationDensity. Handed to each scene's precipitation as it simulates. */
    public precipitationDensity: number = 1;
    private readonly _systemList: ParticleSystemNode[] = [];

    // Keep every material's derived texture slots in step with its authored sources. Per frame rather
    // than on assignment: sources decode asynchronously, and an unresolved pack simply retries.
    /**
     * Run the particle systems' queued simulation steps. See {@link ParticleRenderer.simulate}. `weather`:
     * the frame's weather volumes and shelter map (WeatherPasses.particleWeather), null in a preview.
     */
    public simulateParticles(scene: Scene, weather: ParticleWeather | null = null): void {
        scene.precipitation.density = this.precipitationDensity;
        const frame = this._particleSimFrame(scene);
        frame.weather = weather;
        const systems = this.frameSystems(scene);
        if (systems.length === 0) { this.particles.simulate(scene, frame, systems); return; }
        this._passes.scope('particles.sim');
        this.particles.simulate(scene, frame, systems);
        this._passes.endScope();
    }

    /**
     * The particle systems this frame runs and draws: the scene's own, and the rain and snow falling from
     * its weather (Scene.precipitation) — except in a thumbnail or a capture (a probe must not bake rain
     * into its reflection), and in a flat 2D scene. The same list for the simulation and the draws.
     */
    public frameSystems(scene: Scene): readonly ParticleSystemNode[] {
        const out = this._systemList;
        out.length = 0;
        for (const node of scene.particleSystems) out.push(node);
        const precipitation = scene.precipitation.systems;
        if (precipitation.length > 0 && !this._host.thumbnailMode && !this._view.capturing && !this.isFlatParticleScene(scene))
            for (const node of precipitation) out.push(node);
        return out;
    }

    private _particleSimFrame(scene: Scene): ParticleSimFrame {
        // Force fields, packed once for every emitter this frame: the ones that move the air first, the
        // wind sources the foliage sees too (particleFields.ts).
        const fieldCount = packFrameFields(scene.forceFields, this._forceFieldScratch, MAX_FORCE_FIELDS);
        const live = this.particleCollideValid && !this._host.thumbnailMode && !this._view.capturing;
        return {
            encoder: this._passes.acquireEncoder('particles.sim'),
            gravity: scene.physics?.gravity ?? [0, -9.81, 0],
            depth: live ? this._temporal.depthSource() : null,
            viewProj: live ? this.particleCollideViewProj : null,
            cameraPosition: this.particleCollideCamPos,
            orthographic: this.particleCollideOrtho,
            fields: this._forceFieldScratch,
            fieldCount,
            // The scene's wind field this frame (FoliagePasses.prepareWindField), for Scene-wind emitters.
            windBase: this._sys.foliage.windField.params.subarray(0, 4),
            windMotion: this._sys.foliage.windField.params.subarray(4, 8),
        };
    }

    /** Draw every particle system of a 3D scene into the scene buffer. 2D scenes draw theirs in the 2D pass. */
    /**
     * The scene's particles, in two calls around the sprite pass: `'nonAdditive'` first (alpha and cut-out
     * emitters, sorted with the transparents' depth), then `'additive'` after the sprites, so a lit smoke
     * sprite never covers the embers and sparks in front of it. Additive light is order-independent, so
     * drawing it last costs nothing in correctness.
     */
    public renderParticles(scene: Scene, emitters: 'all' | 'nonAdditive' | 'additive' = 'all'): void {
        if (this.isFlatParticleScene(scene)) return;
        const systems = this.frameSystems(scene);
        if (systems.length === 0) return;
        this._drawParticleNodes(scene, systems, this._targets.scene.renderTarget, emitters);
    }

    /**
     * A 2D scene: one authored as 2D (`Scene.dimension`), or an orthographic camera over tilemaps. Its
     * particles join the sorted 2D pass (render/sprites2d.ts) instead of drawing here.
     */
    public isFlatParticleScene(scene: Scene): boolean {
        return scene.dimension === '2D' || (this._view.camera.type === 'orthographic' && scene.tilemaps.size > 0);
    }

    private _drawParticleNodes(scene: Scene, nodes: Iterable<ParticleSystemNode>, target: RenderTarget,
                               emitters: 'all' | 'nonAdditive' | 'additive' = 'all'): void {
        // The sort runs passes of its own, so it goes before the particle pass opens — once a frame.
        if (emitters !== 'additive')
            this.particles.sort(nodes, this._passes.acquireEncoder('particles.sort'), this._view.camera.position);
        const pass = this._passes.beginFullscreenPass(target, 'particles', false, undefined, false);
        const frame = this.particleDrawFrame(scene, pass, target);
        frame.emitters = emitters;
        this.particles.draw(nodes, frame);
        this._passes.endFullscreenPass(pass);
    }

    /**
     * What a particle draw needs from this frame: camera, depth snapshot, and the scene's light for lit
     * particles — the same ambient and sky light the deferred pass gives surfaces, the key light (the sun,
     * or the moon at night), and the punctual lights, which the particle renderer gathers per effect.
     *
     * `exposure` is the one the PREVIOUS frame's post chain settled on (the post chain runs after the scene
     * draw), the same one-frame lag TAA has; it only matters for an `exposureWeight` below 1.
     */
    public particleDrawFrame(scene: Scene, pass: RenderPassEncoder, target: RenderTarget): ParticleDrawFrame {
        const camera = this._view.camera;
        const { ambient, sunDirection, sunColor, localLights } = this.frameLight(scene);

        return {
            pass, target,
            viewProj: mat4.multiply(this._particleViewProj, this._projection.rasterProjection(camera.projectionMatrix),
                                    camera.viewMatrix),
            view: camera.viewMatrix,
            cameraPosition: camera.position,
            near: camera.near, far: camera.far,
            orthographic: camera.type === 'orthographic',
            // No snapshot in a thumbnail or a flat 2D frame (which takes none): no soft fade against it.
            depth: this._host.thumbnailMode || this._view.flat2D ? null : this._temporal.depthSource(),
            width: this._host.renderWidth, height: this._host.renderHeight,
            ambient, sunDirection, sunColor, localLights,
            // The light probes' fill at an effect, as surfaces there get it (render/probeLighting.ts).
            ambientAt: position => this._sys.lighting.probeAmbientAt(scene, position as vec3, ambient, this._probeAmbient),
            visible: this._sys.visibility.frustumCulling ? (min, max) => this._sys.visibility.frustum.intersectsAABB(min, max) : undefined,
            hidden: this._hiddenByVolume,
            lodDistanceScale: this.particleLodDistanceScale,
            // A preview pane draws what the editing view measured (render/viewLayout.ts).
            measure: !this._view.preview,
            exposure: this._view.exposure,
            preExposure: this._view.preExposure,
            // As the forward path picks a mesh's reflection: the probe containing it, else the sky. Never
            // during a probe capture, which would reflect the probe being captured.
            environment: this._view.capturing ? undefined : position => {
                const probe = scene.probeForPoint(position, true);
                const probeCube = probe ? probe.envMap : null;
                const cube = probeCube ?? scene.environmentMap;
                return cube ? { cube, linear: !!probeCube } : null;
            },
        };
    }

    /**
     * The frame's light as lit particles and lit sprites (Sprite.lit) take it: the key directional light
     * (the sun, or the moon at night) as a unit direction TOWARD it and its colour times its intensity, the
     * ambient and sky fill surfaces get, and the punctual lights for `gatherParticleLocalLight` to pick a
     * key from at each effect. Worked out once per scene and frame; the result is shared, not a copy.
     */
    public frameLight(scene: Scene): FrameLight {
        const cached = this._frameLight;
        if (cached && this._frameLightScene === scene && this._frameLightFrame === this._view.frameIndex) return cached;
        let sun: LightNode | null = null;
        for (const light of scene.lights) if (light.type === 'directional') { sun = light; break; }
        const sunColor = [0, 0, 0];
        const sunDirection = [0, 1, 0];
        if (sun) {
            const light = sun.light as DirectionalLight;
            const key = sun === this._sys.lighting.keyLightNode ? this._sys.lighting.keyLight : null;
            const k = key ? key.intensity : light.internalIntensity;
            const c = key ? key.color : light.color;
            sunColor[0] = c[0] * k; sunColor[1] = c[1] * k; sunColor[2] = c[2] * k;
            const f = this._sys.lighting.dirOf(sun);
            sunDirection[0] = -f[0]; sunDirection[1] = -f[1]; sunDirection[2] = -f[2];
        }
        // The fallback indirect term surfaces get (deferredLighting `indirect.diffuse`): the scene ambient,
        // as the sky light scales it, plus the sky light's mean irradiance. No invented floor: a scene with
        // neither is dark, for particles as for everything else.
        const ambient = this._sys.lighting.internalAmbient(scene);
        const skyNode = scene.skyLight;
        if (skyNode && this._sys.sky.skySHValid) {
            const grade = this._sys.lighting.cloudGrade(scene);
            const sky = skyAmbient(this._sys.sky.skySH, skyNode.intensity * grade.sky);
            ambient[0] += sky[0]; ambient[1] += sky[1]; ambient[2] += sky[2];
        }

        // The punctual lights as the light grid has them, less those whose whole reach was hidden this frame
        // and those inside an occlusion volume the camera cannot see.
        const localLights = this._particleLights;
        localLights.length = 0;
        for (const node of scene.lights) {
            if (node.type === 'directional' || node.index < 0) continue;
            if (this._sys.visibility.lightOccludedMemo.get(node) === true || this._sys.visibility.volumeCulled(node)) continue;
            const light = node.light as PointLight | Spotlight;
            const record: ParticleLocalLight = {
                // Flickering with the light, as the light grid does, so torch smoke pulses with its torch.
                position: node.worldPosition, intensity: light.internalIntensity * node.flickerFactor, color: light.color,
                range: light.range, sourceRadius: light.sourceRadius,
            };
            if (node.type === 'spotlight') {
                record.direction = node.worldForward;
                record.cone = (light as Spotlight).coneScaleOffset;
            } else if (node.type === 'area' && !(node.light as AreaLight).twoSided) {
                // As its light record has it (render/lighting.ts): a one-sided panel lights its half-space.
                record.direction = node.worldForward;
                record.cone = [1, 0];
            }
            localLights.push(record);
        }

        const light: FrameLight = { ambient, sunDirection, sunColor, localLights };
        this._frameLight = light;
        this._frameLightScene = scene;
        this._frameLightFrame = this._view.frameIndex;
        return light;
    }

    private readonly _hiddenByVolume = (node: ParticleSystemNode) => this._sys.visibility.volumeCulled(node);
    private readonly _particleViewProj: mat4 = mat4.create();
    private readonly _particleLights: ParticleLocalLight[] = [];
    /** Scratch for `ambientAt`: read by the particle renderer before its next call. */
    private readonly _probeAmbient: number[] = [0, 0, 0];
    private _frameLight: FrameLight | null = null;
    private _frameLightScene: Scene | null = null;
    private _frameLightFrame = -1;
}

/** See {@link ParticlePasses.frameLight}. */
export interface FrameLight {
    readonly ambient: number[];
    readonly sunDirection: number[];
    readonly sunColor: number[];
    readonly localLights: readonly ParticleLocalLight[];
}

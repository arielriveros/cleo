import { mat4, vec3 } from 'gl-matrix';
import { MAX_FORCE_FIELDS } from '../../core/scene/nodes/forceFieldNode';
import { LightNode } from '../../core/scene/nodes/lightNode';
import type { ParticleSystemNode } from '../../core/scene/nodes/particleSystemNode';
import { Scene } from '../../core/scene/scene';
import { DirectionalLight, PointLight, Spotlight } from '../lighting';
import { skyAmbient } from '../particles/particleLighting';
import type { ParticleLocalLight } from '../particles/particleLighting';
import { ParticleRenderer } from '../particles/particleRenderer';
import type { ParticleSimFrame, ParticleDrawFrame } from '../particles/particleRenderer';
import type { RenderPassEncoder } from '../rhi/device';
import type { RenderTarget } from '../rhi/resources';
import { keyLight } from '../skyNight';
import { GLState } from '../systems/glState';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { PassEncoder } from './passEncoder';
import type { ViewProjection } from './viewProjection';
import type { TemporalPasses } from './temporal';
import type { RenderSubsystems } from './subsystems';

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

    // Keep every material's derived texture slots in step with its authored sources. Per frame rather
    // than on assignment: sources decode asynchronously, and an unresolved pack simply retries.
    /** Run the particle systems' queued simulation steps. See {@link ParticleRenderer.simulate}. */
    public simulateParticles(scene: Scene): void {
        const frame = this._particleSimFrame(scene);
        if (scene.particleSystems.size === 0) { this.particles.simulate(scene, frame); return; }
        this._passes.scope('particles.sim');
        this.particles.simulate(scene, frame);
        this._passes.endScope();
        // The WebGL2 ping-pong went through pipelines that leave blend and depth off; put back what the
        // legacy draws that follow expect, as the cloud pass does.
        this._passes.restoreDefaultBlend();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
    }

    private _particleSimFrame(scene: Scene): ParticleSimFrame {
        // Force fields, packed once for every emitter this frame.
        let fieldCount = 0;
        for (const field of scene.forceFields) {
            if (!field.enabled || !field.visible || fieldCount >= MAX_FORCE_FIELDS) continue;
            field.packInto(this._forceFieldScratch, fieldCount * 16);
            fieldCount++;
        }
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
        };
    }

    /** Draw every particle system of a 3D scene into the scene buffer. 2D scenes draw theirs in the 2D pass. */
    public renderParticles(scene: Scene): void {
        if (scene.particleSystems.size === 0 || this._isFlatParticleScene(scene)) return;
        this._drawParticleNodes(scene, scene.particleSystems, this._targets.scene.renderTarget);
    }

    /** A 2D scene: an orthographic camera over tilemaps. Its particles join the Y-sorted 2D pass. */
    private _isFlatParticleScene(scene: Scene): boolean {
        return this._view.camera.type === 'orthographic' && scene.tilemaps.size > 0;
    }

    private _drawParticleNodes(scene: Scene, nodes: Iterable<ParticleSystemNode>, target: RenderTarget): void {
        // The sort runs passes of its own, so it goes before the particle pass opens.
        this.particles.sort(nodes, this._passes.acquireEncoder('particles.sort'), this._view.camera.position);
        const pass = this._passes.beginFullscreenPass(target, 'particles', false, undefined, false);
        this.particles.draw(nodes, this.particleDrawFrame(scene, pass, target));
        this._passes.endFullscreenPass(pass);
        this._passes.restoreDefaultBlend();
        GLState.blend(false);
        GLState.depthTest(true);
        GLState.depthMask(true);
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

        // The punctual lights as the light grid has them, less those whose whole reach was hidden this frame.
        const localLights = this._particleLights;
        localLights.length = 0;
        for (const node of scene.lights) {
            if (node.type === 'directional' || node.index < 0) continue;
            if (this._sys.visibility.lightOccludedMemo.get(node) === true) continue;
            const light = node.light as PointLight | Spotlight;
            const record: ParticleLocalLight = {
                position: node.worldPosition, intensity: light.internalIntensity, color: light.color,
                range: light.range, sourceRadius: light.sourceRadius,
            };
            if (node.type === 'spotlight') {
                record.direction = node.worldForward;
                record.cone = (light as Spotlight).coneScaleOffset;
            }
            localLights.push(record);
        }

        return {
            pass, target,
            viewProj: mat4.multiply(this._particleViewProj, this._projection.rasterProjection(camera.projectionMatrix),
                                    camera.viewMatrix),
            view: camera.viewMatrix,
            cameraPosition: camera.position,
            near: camera.near, far: camera.far,
            orthographic: camera.type === 'orthographic',
            depth: this._host.thumbnailMode ? null : this._temporal.depthSource(),
            width: this._host.renderWidth, height: this._host.renderHeight,
            ambient, sunDirection, sunColor, localLights,
            visible: this._sys.visibility.frustumCulling ? (min, max) => this._sys.visibility.frustum.intersectsAABB(min, max) : undefined,
            lodDistanceScale: this.particleLodDistanceScale,
            exposure: this._view.exposure,
            // As the forward path picks a mesh's reflection: the probe containing it, else the sky. Never
            // during a probe capture, which would reflect the probe being captured.
            environment: this._view.capturing ? undefined : position => {
                const probe = scene.probeForPoint(position, true);
                const probeCube = probe ? (probe.envMap ?? probe.prefiltered) : null;
                const cube = probeCube ?? scene.environmentMap;
                return cube ? { cube, linear: !!probeCube } : null;
            },
        };
    }

    private readonly _particleViewProj: mat4 = mat4.create();
    private readonly _particleLights: ParticleLocalLight[] = [];
}

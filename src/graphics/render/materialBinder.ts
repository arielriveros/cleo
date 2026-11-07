import { mat4 } from 'gl-matrix';
import { ShaderManager } from '../systems/shaderManager';
import { MaterialSync, MATERIAL_VIEW_SIZE } from '../shaderOptimizer';
import type { Material, CustomMaterial } from '../material';
import type { Scene } from '../../core/scene/scene';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { BindGroupCache } from './bindGroups';
import { device } from '../rhi/deviceHandle';
import { ViewProjection } from './viewProjection';

/** What MaterialBinder reads from the renderer that owns it. */
export interface MaterialBinderHost {
    /** The roughness filter (specular anti-aliasing) setting. */
    specularAa(): boolean;
    /** The internal render size, in pixels. */
    renderWidth(): number;
    renderHeight(): number;
    /** True while the transparent queue runs after this frame's depth and colour snapshots. */
    sceneBuffersLive(): boolean;
    /** True while an offscreen thumbnail is being captured. */
    thumbnailMode(): boolean;
    /**
     * The screen-space reflection settings a forward material's `cleoScreenReflection` marches with:
     * [steps, thickness, max distance, 1 = on].
     */
    ssrForward(): readonly number[];
}

/**
 * Writes what a draw's program needs beyond its pipeline and bind groups: a material's uniforms (through
 * MaterialSync, so an unchanged material on the same program sends nothing), the legacy by-unit texture
 * binding, a custom material's user uniforms, the despawn dissolve and the camera see-through hole.
 * Split out of Renderer.
 */
export class MaterialBinder {
    private readonly _shaderManager = ShaderManager.Instance;

    constructor(private readonly _host: MaterialBinderHost,
                private readonly _view: FrameView,
                private readonly _targets: FrameTargets,
                private readonly _bindGroups: BindGroupCache) {}

    // ---- The shader optimizer (shaderOptimizer/) ----
    /** Which material each program's material block already holds; see MaterialSync. */
    public readonly sync = new MaterialSync();
    private readonly _ssrProjection: mat4 = mat4.create();

    /** The per-view values riding in the material block, gathered for MaterialSync's comparison. */
    private readonly _materialView = new Float64Array(MATERIAL_VIEW_SIZE);

    private static readonly _UV_IDENTITY = [1, 1, 0, 0];

    private readonly _materialViewProj: mat4 = mat4.create();

    /**
     * Every scalar the material block wants: the material's own properties, and the per-frame camera
     * and sun that parallax occlusion mapping marches against.
     *
     * The last two are why this is a method rather than a two-line loop at each call site. They are NOT
     * material constants — they change every frame — but the deferred geometry stage has no other
     * group-1 block to read them from, so they ride in `PBRMaterial` (see chunks/pbrGBuffer.wgsl).
     * They used to be written ONLY in `apply`, which the RHI migration quietly demoted to the
     * legacy no-reflection fallback: every real PBR draw took an inline `mat.properties` loop instead
     * and wrote neither. `UniformBlockSet.set` returns false for a name it does not know and
     * `setUniform` swallows that, so nothing reported it and both members simply stayed ZERO.
     *
     * A zero `viewPos` does not switch parallax off — it moves the eye to the world ORIGIN. `toEye`
     * becomes `normalize(-fragPos)`, which still varies per fragment and still produces a plausible
     * offset, so the relief looked real. It just could not respond to the camera: the effect was welded
     * to the object and sat still while you orbited it. A zero `sunDirection` did switch the
     * height-field self-shadow off outright.
     *
     * Called for every material on every pipeline. `setUniform` no-ops where a name is not declared,
     * which is what makes it safe on the forward and sprite paths that read the camera from their own
     * lighting block instead.
     */
    public applyProperties(material: Material): void {
        // The per-view values below, gathered first: if the bound program's block already holds this
        // material under this exact view, this frame, there is nothing to send (shaderOptimizer/materialSync).
        if (!this.sync.needsWrite(this._shaderManager.bound, material, this._viewValues())) return;

        for (const [name, value] of material.properties)
            this._shaderManager.setUniform(this.sync.uniformName(name), value);
        // An emissive that takes less than the whole exposure (Material emissiveExposureWeight) is divided
        // by the rest of it here, as a sprite's overdrive is; the tonemapper multiplies by all of it. Safe
        // against the per-frame memo above: the exposure does not change within a frame.
        const emissiveWeight = material.properties.get('emissiveExposureWeight');
        if (emissiveWeight !== undefined && emissiveWeight < 1 && this._view.exposure > 0) {
            const k = Math.pow(this._view.exposure, Math.max(0, emissiveWeight) - 1);
            if (material.properties.has('emissiveIntensity'))
                this._shaderManager.setUniform('u_material.emissiveIntensity', Number(material.properties.get('emissiveIntensity')) * k);
            else {
                const e = material.properties.get('emissive');
                if (e) this._shaderManager.setUniform('u_material.emissive', [e[0] * k, e[1] * k, e[2] * k]);
            }
        }
        // Uniforms stick to the program, so a Basic material built without `intensity` (Material.Basic sets
        // it) would inherit the last sprite's overdrive. Pin it to 1 instead.
        if (material.type === 'basic' && !material.properties.has('intensity'))
            this._shaderManager.setUniform('u_material.intensity', 1);
        // The same for a sprite's soft fade: a Basic material without one must not inherit it.
        if (material.type === 'basic' && !material.properties.has('softness'))
            this._shaderManager.setUniform('u_material.softness', 0);
        // Pre-exposure for the programs that carry their own (basic, lit sprites): the frame's while the
        // scene draws, 1 while the display-referred editor overlay does. A no-op where undeclared.
        this._shaderManager.setUniform('u_material.preExposure', this._view.drawPreExposure);
        // The same sticky-uniform guard for the texture mapping (chunks/uvProjection.wgsl): a lit material
        // built without the factories would otherwise inherit the last draw's tiling or projection.
        if (!material.properties.has('uvTransform')) {
            this._shaderManager.setUniform('u_material.uvTransform', MaterialBinder._UV_IDENTITY);
            this._shaderManager.setUniform('u_material.uvProjection', 0);
            this._shaderManager.setUniform('u_material.uvSpace', 0);
            this._shaderManager.setUniform('u_material.uvWorldSize', 1);
            this._shaderManager.setUniform('u_material.uvBlend', 4);
        }
        // And for translucency: a PBR material built by hand (not through Material.PBR) would otherwise
        // inherit the last leaf's, and carry it into the G-buffer as a negative metallic.
        if (material.type === 'pbr' && !material.properties.has('translucency'))
            this._shaderManager.setUniform('u_material.translucency', 0);
        // Same for its tint: a leaf's would otherwise recolour the next hand-built material's glow.
        if (material.type === 'pbr' && !material.properties.has('translucencyTint'))
            this._shaderManager.setUniform('u_material.translucencyTint', [1, 1, 1, 0]);
        this._shaderManager.setUniform('u_material.viewPos', this._view.camera.position);
        this._shaderManager.setUniform('u_material.sunDirection', this._view.sunDirection);
        // The parallax hit's pixel depth offset (`parallaxDepth`). Built from the camera being drawn
        // NOW rather than the frame's cached `_view.viewProj`, so a probe or thumbnail capture that swaps the
        // active camera offsets against its own projection. Unjittered and GL-convention on purpose:
        // the shader adds a DELTA to the rasterised depth, which neither the jitter nor WebGPU's 0..1
        // remap changes. (Computed at the top, where the memo needs it.)
        this._shaderManager.setUniform('u_material.viewProj', this._materialViewProj);
        // Renderer state in a material block for the third time, and the same reason as the two above:
        // the deferred geometry stage binds no lighting block. `setUniform` no-ops on the material
        // types that do not declare it (basic, blinn-phong), which is what keeps this one line enough.
        this._shaderManager.setUniform('u_material.specularAA', this._host.specularAa());
    }

    /**
     * Upload a custom material's per-draw values to the currently bound program: time, camera, the
     * forward scene helpers' inputs, and the user's scalar and vector uniforms by bare `u_<name>`. Its
     * samplers belong to the bind group (`BindGroupCache.customGroup`).
     */
    public applyCustom(material: CustomMaterial): void {
        this._shaderManager.setUniform('u_time', performance.now() * 0.001);
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);
        if (material.renderMode === 'forward') {
            // The scene helpers' inputs (customShaders.ts FORWARD_SCENE_BODY). Set per draw: both names
            // are shared with fullscreen passes that leave their own values behind.
            const cam = this._view.camera;
            this._shaderManager.setUniform('u_resolution', [this._host.renderWidth(), this._host.renderHeight()]);
            this._shaderManager.setUniform('u_depthParams', [cam.near, cam.far,
                cam.type === 'orthographic' ? 1 : 0, this._host.sceneBuffersLive() ? 1 : 0]);
            // `cleoScreenReflection` projects onto the same screen uvs `cleoScreenUV` reads: GL's rows on
            // WebGL2, flipped to WebGPU's where they run the other way (`ViewProjection.uvProducing`).
            if (device.capabilities.conventions.originTopLeft)
                mat4.multiply(this._ssrProjection, ViewProjection.FLIP_SCREEN_Y, cam.projectionMatrix);
            else mat4.copy(this._ssrProjection, cam.projectionMatrix);
            this._shaderManager.setUniform('u_ssrProjection', this._ssrProjection);
            this._shaderManager.setUniform('u_ssrParams', this._host.ssrForward());
            // `cleoPreExposure()` (opt-in): a no-op for a material that does not name it.
            this._shaderManager.setUniform('u_preExposure', this._view.preExposure);
        }
        for (const u of material.uniforms) {
            if (u.type === 'sampler2D' || u.type === 'samplerCube') continue;   // the bind group's
            const value = material.properties.has(u.name) ? material.properties.get(u.name) : u.value;
            this._shaderManager.setUniform(`u_${u.name}`, value);
        }
    }

    /**
     * The per-view values a material write depends on ({@link MATERIAL_VIEW_SIZE}): view-projection,
     * camera position, sun direction, specular AA, the draw's pre-exposure. See MaterialSync for why they are compared, not versioned.
     */
    private _viewValues(): Float64Array {
        const cam = this._view.camera;
        mat4.multiply(this._materialViewProj, cam.projectionMatrix, cam.viewMatrix);
        const view = this._materialView, eye = cam.position, sun = this._view.sunDirection;
        for (let i = 0; i < 16; i++) view[i] = this._materialViewProj[i];
        view[16] = eye[0]; view[17] = eye[1]; view[18] = eye[2];
        view[19] = sun[0]; view[20] = sun[1]; view[21] = sun[2];
        view[22] = this._host.specularAa() ? 1 : 0;
        // The overlay draws the same materials at pre-exposure 1, so it must not skip their write.
        view[23] = this._view.drawPreExposure;
        return view;
    }

    /**
     * A landscape material's values into the bound terrain program's block: its properties (the surface
     * arrays — eight vec4 arrays of every surface's colour, rules, blend, shading) and the specular AA
     * switch. Under the same rule as {@link applyProperties}: skipped when this program's last write was
     * this material, this frame, under the same view. A landscape draws as ~100 chunks with one
     * material, so this was the single largest uniform writer in the frame — every chunk re-wrote and
     * re-compared ~600 floats that had not changed. Nothing else writes these names (`TerrainLayerStack`
     * only fills the material's Map), so no foreign write can slip in between.
     */
    public applyTerrainProperties(material: Material): void {
        if (!this.sync.needsWrite(this._shaderManager.bound, material, this._viewValues())) return;
        this._shaderManager.setUniform('u_specularAA', this._host.specularAa());
        for (const [name, value] of material.properties)
            this._shaderManager.setUniform(name, value);
    }

    /**
     * A node's despawn dissolve for the program just bound (`u_dissolve`, see Node.remove). Written on
     * EVERY draw through a model or basic program, never only on fading ones: a uniform keeps its last
     * value, so a solid draw after a dissolving one would otherwise inherit its holes.
     */
    public setDissolve(fade: number, legacy: boolean = true): void {
        const d = this._dissolveVec;
        d[0] = fade >= 1 ? 0 : 1 - Math.max(0, fade);
        // The foliage crossfade's phase, so a despawn resolves under TAA exactly as a LOD change does.
        d[1] = ((this._view.frameIndex * 7) % 16) / 16;
        // `legacy` false: the caller knows the bound program has no per-draw `u_dissolve` (it reads the
        // per-object table), so the write would reach nothing.
        if (legacy) this._shaderManager.setUniform('u_dissolve', d);
        // The phase alone, for a program that reads how far gone from the per-object table.
        this._shaderManager.setUniform('u_ditherPhase', d[1]);
    }

    private readonly _dissolveVec: [number, number] = [0, 0];

    /**
     * This frame's camera see-through hole (chunks/cameraHole.wgsl), from the active camera's
     * `seeThrough` — set by a CameraRig in 'dither' collision mode. `_camHolePivot[3]` is the strength,
     * 0 when no rig asked for one, which switches the test off in every program at once.
     */
    private readonly _camHole: number[] = [0, 0, 0, 1];

    private readonly _camHolePivot: number[] = [0, 0, 0, 0];

    private readonly _camHoleDraw: number[] = [0, 0, 0, 0];

    private readonly _camHolePass: number[] = [0, 0, 0, 0];

    private _camHoleStrength = 0;

    public updateCameraHole(scene: Scene): void {
        const see = scene.activeCamera?.seeThrough;
        // Not in the editor's own views, not in captures and thumbnails: only the game camera has a player.
        if (!see || !see.active || see.strength <= 0 || see.radius <= 0 || this._view.capturing || this._host.thumbnailMode()) {
            this._camHoleStrength = 0;
            return;
        }
        const eye = this._view.camera.position;
        this._camHole[0] = eye[0]; this._camHole[1] = eye[1]; this._camHole[2] = eye[2];
        this._camHole[3] = 1 / see.radius;
        this._camHolePivot[0] = see.pivot[0]; this._camHolePivot[1] = see.pivot[1]; this._camHolePivot[2] = see.pivot[2];
        this._camHoleStrength = Math.min(1, see.strength);
    }

    /** Whether a draw that opted in (`cameraDither`) gets the hole this frame. */
    public cameraHoleOn(optedIn: boolean): boolean {
        return optedIn && this._camHoleStrength > 0 && !this._view.capturing && !this._view.cubeFace;
    }

    /**
     * The hole block of the program just bound. Written on EVERY draw through a model or instanced
     * program, like `setDissolve`: a uniform keeps its last value.
     */
    public setCameraHole(optedIn: boolean, legacy: boolean = true): void {
        this._shaderManager.setUniform('u_camHole', this._camHole);
        // `legacy` false: the bound program reads the opt-in from the per-object table and has no
        // per-draw `u_camHolePivot` (see setDissolve).
        if (legacy) {
            const p = this._camHoleDraw;
            p[0] = this._camHolePivot[0]; p[1] = this._camHolePivot[1]; p[2] = this._camHolePivot[2];
            p[3] = this.cameraHoleOn(optedIn) ? this._camHoleStrength : 0;
            this._shaderManager.setUniform('u_camHolePivot', p);
        }
        // For a program reading the opt-in from the per-object table: this pass's strength, which the
        // shader multiplies by the record's 0/1 — exactly `p[3]` for an object that opted in, 0 otherwise.
        const q = this._camHolePass;
        q[0] = this._camHolePivot[0]; q[1] = this._camHolePivot[1]; q[2] = this._camHolePivot[2];
        q[3] = this.cameraHoleOn(true) ? this._camHoleStrength : 0;
        this._shaderManager.setUniform('u_camHolePass', q);
    }
}

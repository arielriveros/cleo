import { mat4 } from 'gl-matrix';
import { GLState } from '../systems/glState';
import { ShaderManager } from '../systems/shaderManager';
import { TextureManager } from '../systems/textureManager';
import { MaterialSync, MATERIAL_VIEW_SIZE } from '../shaderOptimizer';
import type { Material, CustomMaterial } from '../material';
import type { Scene } from '../../core/scene/scene';
import type { FrameView } from './frameView';
import type { FrameTargets } from './frameTargets';
import type { BindGroupCache } from './bindGroups';

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

    /** The per-view values riding in the material block, gathered for MaterialSync's comparison. */
    private readonly _materialView = new Float64Array(MATERIAL_VIEW_SIZE);

    private _textureSlot(name: string): number {
        switch (name) {
            case 'texture': case 'baseTexture': case 'baseColorTexture': return 0;
            case 'ormTexture': case 'specularReflectivityMap': return 1;
            case 'emissiveMap': return 2;
            case 'normalMap': return 3;
            case 'maskMap': return 4;
            // Unit 5 was freed when metallic/roughness/occlusion were packed into one ORM map. The
            // parallax height field spends it; see the note in chunks/pbrGBuffer.wgsl for why this
            // gets its own unit rather than riding in the normal map's alpha the way terrain does.
            case 'displacementMap': return 5;
            // The cel ramp rides unit 1, which is free on a cel material and only on a cel
            // material: unit 1 belongs to the packed ORM / specular-reflectivity map, and those are
            // written only by `systems/texturePacker.ts`, whose switch on the material type has no
            // cel case. Adding one would collide here.
            case 'rampMap': return 1;
            default: return 0;
        }
    }

    /**
     * Slots a material carries as authoring inputs but never binds: `systems/texturePacker.ts` combines
     * them into a derived slot (`ormTexture`, `specularReflectivityMap`) and the shader samples that.
     * They MUST be skipped — `_textureSlot` falls through to unit 0, so a source slot left in the loop
     * binds over the base-colour texture.
     */
    private static readonly _SOURCE_SLOTS = new Set([
        'metallicMap', 'roughnessMap', 'occlusionMap', 'metallicRoughnessTexture',
        'specularMap', 'reflectivityMap'
    ]);

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
        const cam = this._view.camera;
        mat4.multiply(this._materialViewProj, cam.projectionMatrix, cam.viewMatrix);
        const view = this._materialView, eye = cam.position, sun = this._view.sunDirection;
        for (let i = 0; i < 16; i++) view[i] = this._materialViewProj[i];
        view[16] = eye[0]; view[17] = eye[1]; view[18] = eye[2];
        view[19] = sun[0]; view[20] = sun[1]; view[21] = sun[2];
        view[22] = this._host.specularAa() ? 1 : 0;
        if (!this.sync.needsWrite(this._shaderManager.bound, material, view)) return;

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

    public apply(material: Material): void {
        this.applyProperties(material);
        for (const [name, tex] of material.textures) {
            if (MaterialBinder._SOURCE_SLOTS.has(name)) continue;
            const slot = this._textureSlot(name);
            // Samplers are `u_material_<field>` with an UNDERSCORE while the scalars above stay dotted:
            // WGSL forbids an opaque type inside a uniform struct, so the samplers are hoisted out.
            this._shaderManager.setUniform(`u_material_${name}`, slot);
            const texture = TextureManager.Instance.getTexture(tex);
            if (texture) texture.bind(slot);
        }
    }

    /**
     * Upload a custom material's user uniforms to the currently bound program. Scalars and vectors go by
     * bare `u_<name>`; user samplers bind from texture unit 9 upward — 0-5 std material, 6 shadow
     * cascades, 7 env, 8 skybox and 15 spot shadow atlas are reserved.
     */
    public applyCustom(material: CustomMaterial, samplersViaBindGroup: boolean = false): void {
        this._shaderManager.setUniform('u_time', performance.now() * 0.001);
        this._shaderManager.setUniform('u_viewPos', this._view.camera.position);
        if (material.renderMode === 'forward') {
            // The scene helpers' inputs (customShaders.ts FORWARD_SCENE_BODY). Set per draw: both names
            // are shared with fullscreen passes that leave their own values behind.
            const cam = this._view.camera;
            this._shaderManager.setUniform('u_resolution', [this._host.renderWidth(), this._host.renderHeight()]);
            this._shaderManager.setUniform('u_depthParams', [cam.near, cam.far,
                cam.type === 'orthographic' ? 1 : 0, this._host.sceneBuffersLive() ? 1 : 0]);
        }
        const fallback = TextureManager.Instance.getTexture('Null');
        let unit = 9;
        for (const u of material.uniforms) {
            if (u.type === 'sampler2D' || u.type === 'samplerCube') {
                // A bind group already assigned this sampler its unit AND set the uniform; doing it
                // again here would bind the texture to a second unit the allocator can reuse.
                if (samplersViaBindGroup) continue;
                // No unit ceiling: units are the backend's to assign.
                const texId = material.textures.get(u.name);
                const tex = (texId && TextureManager.Instance.getTexture(texId)) || fallback;
                this._shaderManager.setUniform(`u_${u.name}`, unit);
                if (tex) tex.bind(unit);
                unit++;
            } else {
                const value = material.properties.has(u.name) ? material.properties.get(u.name) : u.value;
                this._shaderManager.setUniform(`u_${u.name}`, value);
            }
        }
        // The legacy (non-bind-group) path binds the forward scene samplers by unit too.
        if (!samplersViaBindGroup && material.renderMode === 'forward') {
            this._targets.sceneDepth.depth.bind(unit);
            this._shaderManager.setUniform('u_sceneDepth', unit++);
            const color = this._targets.refraction?.colors[0] ?? fallback;
            if (color) color.bind(unit);
            this._shaderManager.setUniform('u_sceneColor', unit++);
        }
    }

    public applyTerrain(material: Material): void {
        // Fixed slot layout, 4 units: the paint masks and the three surface arrays (see
        // chunks/terrainStack.wgsl). Every binding is a 2D ARRAY, so a missing one takes the one-layer
        // array fallback — a 2D texture on a sampler2DArray unit is a draw error. The scalar and array
        // uniforms already match by name.
        const fallback = this._bindGroups.fallbackFor('texture_2d_array<f32>');
        const bindAt = (name: string, slot: number) => {
            const texId = material.textures.get(name);
            const tex = (texId && TextureManager.Instance.getTexture(texId)) || fallback;
            tex.bind(slot);
            this._shaderManager.setUniform(name, slot);
        };
        bindAt('u_masks', 0);
        bindAt('u_surfAlbedo', 1);
        bindAt('u_surfNormal', 2);
        bindAt('u_surfOrm', 3);
        for (const [name, value] of material.properties)
            this._shaderManager.setUniform(name, value);
    }

    public applyCull(side: 'front' | 'back' | 'double' | undefined): void {
        switch (side) {
            case 'back':
                GLState.cull(true); GLState.cullFace('front'); break;
            case 'double':
                GLState.cull(false); break;
            case 'front':
            default:
                GLState.cull(true); GLState.cullFace('back'); break;
        }
    }

    /**
     * A node's despawn dissolve for the program just bound (`u_dissolve`, see Node.remove). Written on
     * EVERY draw through a model or basic program, never only on fading ones: a uniform keeps its last
     * value, so a solid draw after a dissolving one would otherwise inherit its holes.
     */
    public setDissolve(fade: number): void {
        const d = this._dissolveVec;
        d[0] = fade >= 1 ? 0 : 1 - Math.max(0, fade);
        // The foliage crossfade's phase, so a despawn resolves under TAA exactly as a LOD change does.
        d[1] = ((this._view.frameIndex * 7) % 16) / 16;
        this._shaderManager.setUniform('u_dissolve', d);
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
    public setCameraHole(optedIn: boolean): void {
        const p = this._camHoleDraw;
        p[0] = this._camHolePivot[0]; p[1] = this._camHolePivot[1]; p[2] = this._camHolePivot[2];
        p[3] = this.cameraHoleOn(optedIn) ? this._camHoleStrength : 0;
        this._shaderManager.setUniform('u_camHole', this._camHole);
        this._shaderManager.setUniform('u_camHolePivot', p);
        // For a program reading the opt-in from the per-object table: this pass's strength, which the
        // shader multiplies by the record's 0/1 — exactly `p[3]` for an object that opted in, 0 otherwise.
        const q = this._camHolePass;
        q[0] = p[0]; q[1] = p[1]; q[2] = p[2];
        q[3] = this.cameraHoleOn(true) ? this._camHoleStrength : 0;
        this._shaderManager.setUniform('u_camHolePass', q);
    }
}

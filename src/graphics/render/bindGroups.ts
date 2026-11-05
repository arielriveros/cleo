import { device } from '../rhi/deviceHandle';
import type { BindGroup, RenderPipeline } from '../rhi/resources';
import { Texture } from '../texture';
import { TextureManager } from '../systems/textureManager';
import { DILATED_BASE_SLOT } from '../systems/texturePacker';
import type { Material, CustomMaterial } from '../material';
import type { FrameTargets } from './frameTargets';

/** The opaque scene depth's slot name in a material's group 0 (a soft sprite's fade). */
export const SCENE_DEPTH_FIELD = 'u_sceneDepth';

/** The frame's lighting textures, owned by the shadow and light-grid code still in the renderer. */
export interface BindGroupHost {
    shadowCascades(): Texture;
    spotShadows(): Texture;
    pointShadows(): Texture;
    lightGrid(): Texture;
}

/**
 * Bind groups over textures, materials and the frame's lighting, cached by what they bind: on WebGPU a
 * `GPUBindGroup` is a real driver object and a frame needs over a hundred of them. Also the 1x1
 * fallbacks bound wherever a declared slot has nothing to hold. Split out of Renderer.
 */
export class BindGroupCache {
    constructor(private readonly _host: BindGroupHost, private readonly _targets: FrameTargets) {}

    /** 1x1 cube bound to unfilled IBL slots so no cube sampler is ever left unbound. */
    public fallbackCube!: Texture;

    /** 1x1 white 2D texture, bound wherever a material declares a map it does not have. */
    public fallbackTexture!: Texture;

    /**
     * The same, as a one-layer 2D ARRAY: a `texture_2d_array` binding cannot take the plain fallback —
     * WebGPU rejects the view dimension outright, and on WebGL2 a sampler2DArray reading a TEXTURE_2D
     * unit is a draw error. Built on first need; the landscape's layer stack is its only user.
     */
    public fallbackArray: Texture | null = null;

    private readonly _materialFields = new WeakMap<RenderPipeline, (string | null)[]>();

    private readonly _materialTextureScratch: Texture[] = [];

    private readonly _textureGroups = new WeakMap<RenderPipeline, Map<string, BindGroup>>();

    private static readonly BIND_GROUP_CACHE_LIMIT = 512;

    private readonly _textureIds = new WeakMap<Texture, number>();

    private _nextTextureId = 0;

    /**
     * A bind group over this pass's textures, in binding order. Cached — on WebGPU a `GPUBindGroup` is
     * a real driver object and a frame needs ~120 of them.
     *
     * Keyed on texture identity plus `generation`, the pair `Texture._cachedView` also uses: a
     * recreated `GPUTexture` must invalidate the group naming it. WebGL2's `generation` is constant,
     * so a resize correctly does not invalidate there.
     */
    public textureGroup(pipeline: RenderPipeline, group: number, textures: Texture[],
                              bindings?: readonly number[]): BindGroup {
        const layout = pipeline.layoutForGroup(group);
        if (!layout) throw new Error(`${pipeline.label}: no bind group layout for group ${group}`);

        const at = (i: number) => bindings ? bindings[i] : i * 2;
        const signature = this._textureGroupKey(group, textures, bindings);
        let byKey = this._textureGroups.get(pipeline);
        if (!byKey) { byKey = new Map(); this._textureGroups.set(pipeline, byKey); }
        const cached = byKey.get(signature);
        if (cached) return cached;

        const made = device.createBindGroup({
            label: `${pipeline.label}:group${group}`,
            layout,
            // Bindings are (texture, sampler) pairs, so the Nth texture is at binding 2N unless the
            // caller numbered them itself — see `frameLightingGroup`, whose group is shared by two
            // chunks and so has holes in it. The sampler half is deliberately not listed: this engine
            // keeps filter and wrap state on the texture.
            entries: textures.map((texture, i) => ({ binding: at(i), textureView: texture.sampledView })),
        });
        // A cached bind group holds its textures alive and a `Framebuffer` resize can produce NEW
        // `Texture` objects, so the cap bounds what would otherwise leak; the next frame refills.
        if (byKey.size >= BindGroupCache.BIND_GROUP_CACHE_LIMIT) byKey.clear();
        byKey.set(signature, made);
        return made;
    }

    /**
     * A stable key for "these textures, in this order, at these storage generations". `Texture` has no
     * id of its own, so one is handed out lazily and remembered weakly.
     */
    private _textureGroupKey(group: number, textures: Texture[], bindings?: readonly number[]): string {
        let key = bindings ? group + '@' + bindings.join(',') : String(group);
        for (const texture of textures) {
            let id = this._textureIds.get(texture);
            if (id === undefined) { id = ++this._nextTextureId; this._textureIds.set(texture, id); }
            key += '|' + id + ':' + texture.rhiTexture.generation;
        }
        return key;
    }

    /**
     * A bind group over a material's textures, one entry per texture the SHADER declares. EVERY
     * declared binding is filled — a bind group cannot leave one out — so a missing map takes a 1x1
     * white fallback and the shader gates on its `has*` flags.
     */
    public materialGroup(pipeline: RenderPipeline, material: Material,
                               envCube?: Texture | null): BindGroup {
        // A scratch list, not a new array per draw: _textureBindGroup only reads it.
        const textures = this._materialTextureScratch;
        textures.length = 0;
        for (const field of this._materialTextureFields(pipeline)) {
            // The environment cube rides in group 0 alongside the material maps but must NOT be looked
            // up as one: the miss falls back to a 2D texture, a sampler-type mismatch at draw time.
            if (field === null) { textures.push(envCube ?? this.fallbackCube); continue; }
            // The opaque depth snapshot (a soft sprite's fade, chunks/basicForward.wgsl) is the frame's.
            if (field === SCENE_DEPTH_FIELD) { textures.push(this._targets.sceneDepth.depth); continue; }
            // A cutout's edge-padded base colour stands in for the authored one (TexturePacker
            // `_syncDilation`); until it is baked, or once it is swept, the authored map draws.
            const dilated = field === 'baseColorTexture' ? material.textures.get(DILATED_BASE_SLOT) : undefined;
            const dilatedTexture = dilated ? TextureManager.Instance.getTexture(dilated) : null;
            const id = material.textures.get(field);
            const texture = dilatedTexture ?? (id ? TextureManager.Instance.getTexture(id) : null);
            textures.push(texture ?? this.fallbackTexture);
        }
        return this.textureGroup(pipeline, 0, textures);
    }

    /**
     * A pipeline's group-0 material texture slots, as the MATERIAL names them, in binding order.
     * `null` marks the environment cube, which has no material slot behind it.
     *
     * Derived once per pipeline rather than per draw: the names come from the shader's reflection and
     * cannot change, but stripping the `u_material_` prefix off each one used to run a regex per texture
     * per draw — six throwaway strings on every PBR mesh in the scene, every frame.
     */
    private _materialTextureFields(pipeline: RenderPipeline): readonly (string | null)[] {
        let fields = this._materialFields.get(pipeline);
        if (fields) return fields;
        fields = [];
        for (const resource of pipeline.resources) {
            if (resource.group !== 0 || resource.kind !== 'texture') continue;
            fields.push(resource.glslName === 'u_envMap'
                ? null
                : resource.glslName.replace(/^u_material_/, ''));
        }
        this._materialFields.set(pipeline, fields);
        return fields;
    }

    /**
     * A custom material's group 0: the mode's engine samplers, then the user's, in declaration order.
     * The ORDER is the PRELUDE's — `customShaderResources` and `declareSamplers` walk the same lists —
     * so this only fills each declared slot, falling back to a 1x1 texture where none is assigned.
     */
    public customGroup(pipeline: RenderPipeline, material: CustomMaterial,
                             envCube?: Texture | null): BindGroup {
        const textures: Texture[] = [];
        // Each at the binding its resource declares: a resource the shader never uses is filtered out of
        // a translated pipeline (see `usedResources`), so counting slots off by twos would shift the rest.
        const bindings: number[] = [];
        for (const resource of pipeline.resources) {
            if (resource.group !== 0 || resource.kind !== 'texture') continue;
            bindings.push(resource.binding);
            if (resource.glslName === 'u_envMap') { textures.push(envCube ?? this.fallbackCube); continue; }
            if (resource.glslName === 'u_sceneDepth') { textures.push(this._targets.sceneDepth.depth); continue; }
            if (resource.glslName === 'u_sceneColor') {
                textures.push(this._targets.refraction?.colors[0] ?? this.fallbackTexture);
                continue;
            }
            const id = material.textures.get(resource.glslName.replace(/^u_/, ''));
            const texture = id ? TextureManager.Instance.getTexture(id) : null;
            textures.push(texture ?? this.fallbackTexture);
        }
        return this.textureGroup(pipeline, 0, textures, bindings);
    }

    /**
     * A terrain material's nine layer samplers as a bind group. Separate from
     * {@link materialGroup} because terrain names its textures bare. EVERY slot is filled,
     * unassigned layers included — an empty binding leaves whatever the previous draw put there.
     */
    public terrainGroup(pipeline: RenderPipeline, material: Material): BindGroup {
        const textures: Texture[] = [];
        for (const resource of pipeline.resources) {
            if (resource.group !== 0 || resource.kind !== 'texture') continue;
            const id = material.textures.get(resource.glslName);
            const texture = id ? TextureManager.Instance.getTexture(id) : null;
            textures.push(texture ?? this.fallbackFor(resource.type));
        }
        return this.textureGroup(pipeline, 0, textures);
    }

    /**
     * The fallback that matches a binding's WGSL TYPE. The dimension has to agree with the declaration
     * on both backends, so a missing array layer stack binds a one-layer white array, never the 2D white.
     */
    public fallbackFor(wgslType: string): Texture {
        if (!wgslType.includes('2d_array')) return this.fallbackTexture;
        if (!this.fallbackArray) {
            const array = new Texture({ target: 'texture2DArray', mipMap: false });
            array.createColorArray(1, 1, 1, false);
            array.writeLayer(0, 0, 0, 1, 1, new Uint8Array([255, 255, 255, 255]));
            this.fallbackArray = array;
        }
        return this.fallbackArray;
    }

    /**
     * Does this program sample the shadow maps? Asked of the RESOURCE, never the group number —
     * group 3 holds the light grid as well, and `terrainForward` takes that half and no shadows.
     */
    public declaresShadowGroup(pipeline: RenderPipeline): boolean {
        return pipeline.resources.some(r => r.group === 3 && r.glslName === 'u_shadowCascades');
    }

    /**
     * Does this program read the clustered light grid? Asked of the RESOURCE, like
     * {@link declaresShadowGroup} — the unlit Basic family reads neither half of group 3, and binding
     * a group a program never declared is an error rather than an empty bind.
     */
    public declaresLightGrid(pipeline: RenderPipeline): boolean {
        return pipeline.resources.some(r => r.group === 3 && r.glslName === 'u_lightData');
    }

    /** Does this program declare group 3 at all, in either half? */
    public declaresFrameLighting(pipeline: RenderPipeline): boolean {
        return this.declaresShadowGroup(pipeline) || this.declaresLightGrid(pipeline);
    }

    /**
     * Group 3, the per-frame lighting group: the shadow maps, and the clustered light-data texture.
     *
     * TWO CHUNKS SHARE THE GROUP because there is no fifth group to give either of them — WebGPU's
     * `maxBindGroups` is 4, a CEILING rather than a default (see chunks/clusteredLights.wgsl). A
     * program takes either half, both, or neither, so the entries carry their BINDING NUMBERS from
     * chunks/shadows.wgsl (0/2/4) and chunks/clusteredLights.wgsl (6) instead of being counted off:
     * terrain reads the light grid with no shadow maps at all, which counting would land at binding 0.
     *
     * The punctual atlases are the caller's to STATE — a program declaring them but never calling them
     * has the binding dead-code eliminated, and an entry the layout does not have invalidates the whole
     * command buffer.
     */
    public frameLightingGroup(pipeline: RenderPipeline, withPunctual: boolean = true): BindGroup {
        const textures: Texture[] = [];
        const bindings: number[] = [];
        // Only the bindings this program's layout really has. A CUSTOM material's WGSL comes out of naga,
        // which drops every resource the shader never reaches: a lit custom surface (the Valley's water)
        // that samples the sun's cascades but never a spot or point shadow has no binding 2 or 4, and
        // naming them anyway made the whole group -- and every frame's command buffer -- invalid.
        const declared = new Set(pipeline.resources.filter(r => r.group === 3).map(r => r.binding));
        const add = (texture: Texture, binding: number) => {
            if (!declared.has(binding)) return;
            textures.push(texture); bindings.push(binding);
        };
        if (this.declaresShadowGroup(pipeline)) {
            add(this._host.shadowCascades(), 0);
            if (withPunctual) {
                add(this._host.spotShadows(), 2);
                add(this._host.pointShadows(), 4);
            }
        }
        // One texture and no sampler beside it — the light data is only ever `textureLoad`ed.
        if (this.declaresLightGrid(pipeline)) add(this._host.lightGrid(), 6);
        return this.textureGroup(pipeline, 3, textures, bindings);
    }
}

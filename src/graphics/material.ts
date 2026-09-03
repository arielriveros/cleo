interface MaterialConfig {
    side?: 'front' | 'back' | 'double';
    transparent?: boolean;
    castShadow?: boolean;
    probeable?: boolean;
    wireframe?: boolean;
}

interface BasicProperties extends HeightConfig {
    color?: number[];
    texture?: string;
    opacity?: number;
    /**
     * Alpha-cutout threshold. Below it the fragment is DISCARDED — no blending, no sorting; the surface
     * stays ordinary opaque geometry. **0 disables it**, which is the "off" encoding, so 0 is not a
     * valid threshold.
     *
     * The value tested is the `mask` texture's RED channel when one is assigned. (PBR additionally
     * falls back to the base-colour texture's alpha when there is no mask, which is what glTF's
     * `alphaMode: MASK` uses.)
     */
    alphaCutoff?: number;
    /**
     * Opacity/cutout mask, read from RED. Assign a grayscale map; `alphaCutoff` decides where it cuts.
     *
     * This is where an FBX/OBJ opacity map (aiTextureType_OPACITY) lands on import.
     */
    mask?: string;
    /**
     * Height field, read from RED. Present on EVERY material type, not just PBR, because a terrain paint
     * layer can be based on any of them and terrain reads its height from this one slot.
     *
     * Inert on a standard Basic or Blinn-Phong material: only chunks/pbrGBuffer.wgsl and
     * chunks/pbrForward.wgsl carry the parallax march. What it always does is feed a terrain layer's
     * height-aware blend, which is base-type agnostic.
     */
    displacementMap?: string;
}

interface DefaultProperties extends HeightConfig {
    diffuse?: number[];
    specular?: number[];
    ambient?: number[];
    emissive?: number[];
    shininess?: number;
    opacity?: number;
    reflectivity?: number;
    /**
     * Alpha-cutout threshold. Below it the fragment is DISCARDED — no blending, no sorting; the surface
     * stays ordinary opaque geometry. **0 disables it**, which is the "off" encoding, so 0 is not a
     * valid threshold.
     *
     * The value tested is the `mask` texture's RED channel when one is assigned. (PBR additionally
     * falls back to the base-colour texture's alpha when there is no mask, which is what glTF's
     * `alphaMode: MASK` uses.)
     */
    alphaCutoff?: number;

    textures?: {
        base?: string;
        specular?: string;
        emissive?: string;
        normal?: string;
        mask?: string;
        reflectivity?: string;
        /**
         * Height field, read from RED. Present on EVERY material type, not just PBR, because a terrain paint
         * layer can be based on any of them and terrain reads its height from this one slot.
         *
         * Inert on a standard Basic or Blinn-Phong material: only chunks/pbrGBuffer.wgsl and
         * chunks/pbrForward.wgsl carry the parallax march. What it always does is feed a terrain layer's
         * height-aware blend, which is base-type agnostic.
         */
        displacementMap?: string;
    }
}

/**
 * The Cel (toon) model. Not a physical response at all: the Lambert term is quantized into flat bands,
 * the specular lobe is thresholded into a hard shape, and the rim is an artistic term no light in the
 * scene contributes to. See chunks/celForward.wgsl.
 *
 * Deliberately narrower than `DefaultProperties`: there is no `reflectivity` and no specular MAP,
 * because cel has no environment reflection to author and never packs a texture (which is what leaves
 * texture unit 1 free for the ramp — see `Renderer._textureSlot`).
 */
interface CelProperties extends HeightConfig {
    diffuse?: number[];
    ambient?: number[];
    /** Tint of the hard highlight. Not a reflectance — nothing in this model conserves energy. */
    specular?: number[];
    emissive?: number[];
    emissiveIntensity?: number;
    /** Width of the Blinn lobe that `specularThreshold` then cuts. */
    shininess?: number;
    opacity?: number;
    /** See `DefaultProperties.alphaCutoff`; the rule is identical across every shading model. */
    alphaCutoff?: number;

    /** Step count for the quantizer. Ignored entirely when a ramp texture is assigned. */
    bands?: number;
    /**
     * Edge width as a FRACTION OF ONE BAND, so the same number means the same thing at three bands and
     * at eight. Shared by the band edges, the specular cut and the rim cut, so one control softens the
     * whole material consistently.
     */
    bandSoftness?: number;
    /** The lobe value the hard highlight cuts at. Higher is a smaller highlight. */
    specularThreshold?: number;

    rimColor?: number[];
    /** Fresnel exponent. Higher is a tighter rim. */
    rimPower?: number;
    rimStrength?: number;

    textures?: {
        base?: string;
        /**
         * The light response as a 1-D gradient, sampled at `v = 0.5`. When assigned it REPLACES the
         * numeric bands wholesale — which is the only way to express a hue shift into shadow, something
         * no step count can do.
         *
         * Must be clamp-wrapped or its darkest band bleeds onto its brightest at `u = 1`. That is the
         * engine default (see `Texture`), so it costs the author nothing.
         */
        ramp?: string;
        emissive?: string;
        normal?: string;
        mask?: string;
        /** See `DefaultProperties.textures.displacementMap`. Inert here, kept for slot parity. */
        displacementMap?: string;
    }
}

interface PBRProperties {
    baseColor?: number[];
    metallic?: number;
    roughness?: number;
    /**
     * Dielectric specular level, 0..1. Default 0.5.
     *
     * Every non-metal in this engine used to reflect exactly 4% at normal incidence, because `F0` was
     * the literal `0.04` in four shaders. Real dielectrics are not all the same: water is near 0.02,
     * skin about 0.028, most gemstones 0.05 to 0.08. Filament's remapping is `F0 = 0.16 * r^2`, which
     * puts 0.5 at exactly the old constant — so every material that does not set this is bit-identical
     * to what it was — and spans 0 to 0.16 across the slider.
     *
     * Ignored where `metallic` is 1: a conductor's F0 is its base colour, not a scalar.
     */
    reflectance?: number;
    opacity?: number;
    /**
     * glTF `alphaMode: MASK`. Below this base-colour alpha the fragment is discarded; the surface
     * stays opaque G-buffer geometry, with no blending or sorting. 0 disables it.
     */
    alphaCutoff?: number;
    emissiveFactor?: number[];
    /**
     * HDR headroom for {@link emissiveFactor}, default 1.
     *
     * The colour is authored through a hex picker and so cannot exceed 1 on any channel, which put a
     * ceiling on emissive brightness BELOW the point where anything happens: bloom thresholds in
     * display-referred terms, and at the default exposure a mid-tone emissive lands at exposed luma
     * 1.0 — exactly the default threshold — and contributes nothing at all. Pure white only doubles
     * it. There was no combination of bloom settings at which an authored emissive material glowed.
     *
     * Keep the colour for hue and this for how hot, which is what glTF's
     * `KHR_materials_emissive_strength` means by the same split.
     */
    emissiveIntensity?: number;
    /**
     * Height relief depth. UV units on an ordinary material, where the parallax march offsets texture
     * coordinates; WORLD METRES on a terrain layer, where it moves the terrain's own vertices.
     *
     * The two are different quantities because they do different things, and pretending otherwise is
     * what made terrain relief unauthorable: a shared unit meant the terrain number changed meaning with
     * the terrain's size.
     */
    displacementScale?: number;
    /**
     * The `displacementMap` is a DEPTH map (white = deep), not the height map the engine authors.
     *
     * There is nothing to detect here. The two conventions are the same bytes, and a wrong guess does
     * not degrade — it turns the relief inside out, so brick reads as mortar. The engine's own maps and
     * every terrain layer are height maps, so this defaults off; a downloaded `*_disp.png` usually
     * needs it on.
     */
    invertHeight?: boolean;
    /**
     * Discard where the parallax ray walks off the edge of the face, so the SILHOUETTE follows the
     * height field instead of staying a straight polygon edge.
     *
     * Off by default, and it has to be: the test is against the 0..1 uv rectangle, which is a real
     * border only on a surface mapped 0..1 (a cube face, a quad). A tiled surface has no border there
     * and would come out punched with a grid of holes.
     */
    clipSilhouette?: boolean;
    /** Unit for `displacementScale`. See {@link HeightConfig.depthSpace} — this is the same flag. */
    depthSpace?: 'world' | 'uv';
    /** Whether the parallax march runs. See {@link HeightConfig.parallax} — the same flag. */
    parallax?: boolean;
    /** Compute-tessellation level. See {@link HeightConfig.displaceLevel}. */
    displaceLevel?: number;
    textures?: {
        baseColorTexture?: string;
        /**
         * Authored source maps, never bound directly: `systems/texturePacker.ts` combines them into the
         * derived `ormTexture` slot. One texture in several of these slots means it is already packed.
         */
        metallicMap?: string;
        roughnessMap?: string;
        occlusionMap?: string;
        normalMap?: string;
        emissiveMap?: string;
        /**
         * Opacity/cutout mask, read from RED. Assign a grayscale map; `alphaCutoff` decides where it cuts.
         *
         * This is where an FBX/OBJ opacity map (aiTextureType_OPACITY) lands on import.
         */
        mask?: string;
        /**
         * Height field for parallax occlusion mapping, read from RED (0 = floor, 1 = surface — set
         * `invertHeight` for a depth map, which runs the other way). Unlike the ORM sources above, this
         * is bound directly on its own texture unit.
         */
        displacementMap?: string;
        /** Legacy/glTF input only: a pre-packed map, fanned out to metallicMap + roughnessMap. Never written back. */
        metallicRoughnessTexture?: string;
    }
}

/**
 * Assign the cutout mask and its threshold, for any material type.
 *
 * The default is CONDITIONAL, and that is the whole point of centralising it. Blinn-Phong's mask used
 * to discard at a literal 0.5 with no property behind it, so defaulting `alphaCutoff` to the usual 0
 * ("off") would have silently switched masking off on every material authored before this existed.
 * A mask with no stated threshold therefore means 0.5 — the constant it replaced — and no mask means
 * 0, which leaves a material that never had a cutout exactly as it was.
 *
 * `Material.parse` applies the same rule, so a project saved before the property existed reloads
 * rendering identically.
 */
export function applyMask(material: Material, mask: string | undefined | null,
                          alphaCutoff: number | undefined): void {
    material.properties.set('hasMaskMap', mask ? true : false);
    if (mask) material.textures.set('maskMap', mask);
    material.properties.set('alphaCutoff', alphaCutoff ?? (mask ? 0.5 : 0));
}

/**
 * What a height field does, and where.
 *
 * On an ORDINARY material it is parallax occlusion mapping: the fragment stage offsets texture
 * coordinates and never moves a vertex, so a silhouette stays a straight polygon edge and the relief
 * flattens under a grazing view. Cheap and resolution-independent.
 *
 * On a TERRAIN paint layer it raises the terrain's own vertices — always, with no mode to choose. Real
 * geometry, so it silhouettes and self-occludes. Only terrain can do this, because only terrain rebuilds
 * its vertices from a field it owns; a mesh's vertices are what `Model.serialize()` writes, so
 * displacing them would be saved over the authored asset. See `Terrain._displacementAt`.
 *
 * `displacementScale` is read in each mode's natural unit: tiled uv for the march (which offsets texture
 * coordinates and has no world scale of its own), world metres for terrain (which moves vertices, and
 * where an artist is asking for "three centimetres of gravel"). Terrains authored before the terrain unit
 * changed are migrated on load by `Terrain.deserialize`.
 */

/** Everything on the height slot except the texture itself. */
export interface HeightConfig {
    displacementScale?: number;
    invertHeight?: boolean;
    clipSilhouette?: boolean;
    /**
     * `'world'` (the default for anything created from here on) reads `displacementScale` as a depth in
     * WORLD units; `'uv'` is the original meaning, a fraction of one texture repeat.
     *
     * A uv depth only means something once you know what a uv unit is worth. On a tiling material one
     * repeat is a few centimetres and 0.05 is a sensible few millimetres of relief; on an atlas-mapped
     * scan one repeat is the WHOLE OBJECT and the same number is metres. Measured on a scanned branch,
     * one uv unit was 47.97 world units — so the default asked for 2.4 units of relief on a branch 12.7
     * units thick, the march reached across the atlas, and the surface swam as the camera moved.
     *
     * A FLAG, not a silent reinterpretation, and there is no numeric migration: converting a stored
     * number needs the chart's world scale, and that belongs to the MESH, not the material — one
     * material can sit on a cube and on a scan. So `parse` defaults it to `'uv'` when the marker is
     * absent (every existing asset is bit-identical) while new materials get `'world'`.
     *
     * NOT called `depthUnit`: that key is terrain's, from its retired metres migration, and
     * `tests/terrainDepthMigration.test.ts` asserts nothing stamps it any more — a stale
     * `depthUnit: 'metres'` in a saved terrain is the double-migration hazard that marker guards.
     */
    depthSpace?: 'world' | 'uv';
    /**
     * Subdivision level for compute tessellation, or 0 for none.
     *
     * On the MATERIAL, beside the height map it displaces by, rather than on the model — the surface
     * decides how it wants to be represented, and a material carried onto another mesh brings its relief
     * with it. Each level multiplies the triangle count by four, so this is a small number; see
     * `MAX_TESS_LEVEL`.
     *
     * WebGPU only. WebGL2 has no compute stage, so it is inert there and the mesh draws as authored —
     * the intended fallback, not an error.
     */
    displaceLevel?: number;
    /**
     * Whether the PARALLAX MARCH runs. OFF EVERYWHERE, including for an asset that predates the flag.
     *
     * That last part is a deliberate REMOVAL, not the usual legacy-preservation rule every other marker
     * in this file follows. The behaviour was withdrawn rather than re-defaulted: the editor no longer
     * offers a control for it, so a material that kept marching would have no way to stop. Displacement
     * replaced it for the case it was being used for — POM cannot move a silhouette and it flattens at
     * steep angles, and on the photogrammetry scan that drove this (25.6 degrees of median dihedral,
     * 80.4 at p90) it never looked like anything but a smear.
     *
     * The march itself survives in `chunks/pbrGBuffer.wgsl` and `chunks/pbrForward.wgsl` and still
     * honours this flag, so an asset that explicitly stores `true` re-enables it.
     */
    parallax?: boolean;
}

/**
 * Assign the height field and its settings, for any material type.
 *
 * Centralised for the same reason applyMask is: the slot lives on all three material types, and
 * `hasDisplacementMap` — which the PBR shaders branch on — has to be written in lock step with the
 * texture, or the march reads a sampler nothing bound. Basic and Blinn-Phong set the flag too and
 * simply never read it; cheaper than three near-identical pairs of lines that can drift apart.
 */
export function applyHeight(material: Material, height: string | undefined | null,
                            cfg: HeightConfig = {}): void {
    // Always written, so a material that gains a height map later already has a usable depth.
    material.properties.set('dispScale', cfg.displacementScale ?? 0.05);
    // Defaults to WORLD, so anything authored from now on carries a unit the shader can scale. Only
    // `parse` passes 'uv', for assets written before the unit existed — see HeightConfig.
    material.properties.set('depthInWorld', (cfg.depthSpace ?? 'world') === 'world');
    // Off unless asked for. Only `parse` passes true, for assets written before the flag existed.
    material.properties.set('parallax', cfg.parallax === true);
    material.properties.set('displaceLevel', Math.max(0, Math.floor(cfg.displaceLevel ?? 0)));
    material.properties.set('invertHeight', cfg.invertHeight ? true : false);
    material.properties.set('clipSilhouette', cfg.clipSilhouette ? true : false);
    material.properties.set('hasDisplacementMap', height ? true : false);
    if (height) material.textures.set('displacementMap', height);
}

enum MaterialType {
    Basic = 'basic',
    Default = 'blinn_phong',
    BasicSkinned = 'basicSkinned',
    DefaultSkinned = 'blinn_phongSkinned',
    PBR = 'pbr',
    // Forward-only, like Blinn-Phong: `Renderer._inGBuffer` excludes both, and the forward overlay draws
    // them. A cel material CANNOT go through the deferred pass — the G-buffer carries no shading-model
    // id and the lighting pass is Cook-Torrance, so the bands and the rim would simply be lost.
    Cel = 'cel',
    CelSkinned = 'celSkinned',
    Terrain = 'terrain'
}

export class Material {
    public type: MaterialType = MaterialType.Basic;
    public properties: Map<string, any>;
    public textures: Map<string, string>;
    public config: MaterialConfig;

    constructor(config?: MaterialConfig) {
        this.properties = new Map<string, any>();
        this.textures = new Map<string, string>();
        this.config = {
            side: config?.side || 'front',
            transparent: config?.transparent || false,
            castShadow: config?.castShadow === undefined ? true : config.castShadow,
            probeable: config?.probeable === undefined ? true : config.probeable,
            wireframe: config?.wireframe || false
        };
    }

    public static Basic( properties: BasicProperties, config?: MaterialConfig ): Material {
        const material = new Material(config);
        material.type = MaterialType.Basic;
        material.properties.set('color', properties.color || [1.0, 1.0, 1.0] );
        material.properties.set('opacity', properties.opacity || 1.0);

        material.properties.set('hasTexture', properties.texture ? true : false);

        if (properties.texture) {
            const tex = properties.texture;
            material.textures.set('texture', tex);
        }

        applyMask(material, properties.mask, properties.alphaCutoff);
        applyHeight(material, properties.displacementMap, properties);

        return material;
    }

    public static Default(properties: DefaultProperties, config?: MaterialConfig): Material {
        const material = new Material(config);
        material.type = MaterialType.Default;
        material.properties.set('diffuse', properties.diffuse || [1.0, 1.0, 1.0]);
        material.properties.set('specular', properties.specular || [1.0, 1.0, 1.0]);
        material.properties.set('ambient', properties.ambient || properties.diffuse || [1.0, 1.0, 1.0]);
        material.properties.set('emissive', properties.emissive || [0.0, 0.0, 0.0]);
        material.properties.set('shininess', properties.shininess || 32.0);
        material.properties.set('opacity', properties.opacity || 1.0);
        material.properties.set('reflectivity', properties.reflectivity || 0.0);

        material.properties.set('hasBaseTexture', properties.textures?.base ? true : false);

        if (properties.textures?.base) {
            const tex = properties.textures.base;
            material.textures.set('baseTexture', tex);
        }

        material.properties.set('hasSpecularMap', properties.textures?.specular ? true : false);

        if (properties.textures?.specular) {
            const tex = properties.textures.specular;
            material.textures.set('specularMap', tex);
        }

        material.properties.set('hasEmissiveMap', properties.textures?.emissive ? true : false);

        if (properties.textures?.emissive) {
            const tex = properties.textures.emissive;
            material.textures.set('emissiveMap', tex);
        }

        material.properties.set('hasNormalMap', properties.textures?.normal ? true : false);

        if (properties.textures?.normal) {
            const tex = properties.textures.normal;
            material.textures.set('normalMap', tex);
        }

        applyMask(material, properties.textures?.mask, properties.alphaCutoff);
        applyHeight(material, properties.textures?.displacementMap, properties);

        material.properties.set('hasReflectivityMap', properties.textures?.reflectivity ? true : false);

        if (properties.textures?.reflectivity) {
            const tex = properties.textures.reflectivity;
            material.textures.set('reflectivityMap', tex);
        }

        return material;
    }

    /**
     * A Cel (toon) material.
     *
     * The defaults are chosen so a material created with no arguments already READS as cel shading —
     * three bands, a compact highlight and a visible rim. A cel material with one band, no highlight and
     * no rim is indistinguishable from a broken shader, which is why `rimStrength` does not default to 0
     * the way an additive term normally would.
     */
    public static Cel(properties: CelProperties = {}, config?: MaterialConfig): Material {
        const material = new Material(config);
        material.type = MaterialType.Cel;
        material.properties.set('diffuse', properties.diffuse || [1.0, 1.0, 1.0]);
        // Falls back to the diffuse tint rather than to grey: the darkest band should read as a dark
        // version of the surface, not as an unrelated colour.
        material.properties.set('ambient', properties.ambient || properties.diffuse || [1.0, 1.0, 1.0]);
        material.properties.set('specular', properties.specular || [1.0, 1.0, 1.0]);
        material.properties.set('emissive', properties.emissive || [0.0, 0.0, 0.0]);
        material.properties.set('emissiveIntensity',
                                properties.emissiveIntensity === undefined ? 1.0 : properties.emissiveIntensity);
        material.properties.set('shininess', properties.shininess || 32.0);
        material.properties.set('opacity', properties.opacity === undefined ? 1.0 : properties.opacity);

        // 3 is the canonical toon count — shadow, mid, lit. 2 reads as a cutout and 4+ starts to look
        // like a gradient again.
        material.properties.set('bands', properties.bands === undefined ? 3 : properties.bands);
        // 2% of a band: visually a hard edge, but wide enough to antialias the terminator at 1080p.
        material.properties.set('bandSoftness',
                                properties.bandSoftness === undefined ? 0.02 : properties.bandSoftness);
        // With shininess 32 this puts a compact highlight on a sphere rather than a hemisphere-wide wash.
        material.properties.set('specularThreshold',
                                properties.specularThreshold === undefined ? 0.5 : properties.specularThreshold);

        material.properties.set('rimColor', properties.rimColor || [1.0, 1.0, 1.0]);
        material.properties.set('rimPower', properties.rimPower === undefined ? 4.0 : properties.rimPower);
        material.properties.set('rimStrength',
                                properties.rimStrength === undefined ? 0.35 : properties.rimStrength);

        material.properties.set('hasBaseTexture', properties.textures?.base ? true : false);
        if (properties.textures?.base) material.textures.set('baseTexture', properties.textures.base);

        material.properties.set('hasRampMap', properties.textures?.ramp ? true : false);
        if (properties.textures?.ramp) material.textures.set('rampMap', properties.textures.ramp);

        material.properties.set('hasEmissiveMap', properties.textures?.emissive ? true : false);
        if (properties.textures?.emissive) material.textures.set('emissiveMap', properties.textures.emissive);

        material.properties.set('hasNormalMap', properties.textures?.normal ? true : false);
        if (properties.textures?.normal) material.textures.set('normalMap', properties.textures.normal);

        applyMask(material, properties.textures?.mask, properties.alphaCutoff);
        applyHeight(material, properties.textures?.displacementMap, properties);

        return material;
    }

    public static PBR(properties: PBRProperties = {}, config?: MaterialConfig): Material {
        const material = new Material(config);
        material.type = MaterialType.PBR;
        material.properties.set('baseColor', properties.baseColor || [1.0, 1.0, 1.0]);
        material.properties.set('metallic', properties.metallic === undefined ? 0.0 : properties.metallic);
        material.properties.set('roughness', properties.roughness === undefined ? 1.0 : properties.roughness);
        // 0.5 -> F0 0.04, which is what every dielectric was hardcoded to before this existed. That
        // default is what makes the whole change a no-op on content authored before it.
        material.properties.set('reflectance', properties.reflectance === undefined ? 0.5 : properties.reflectance);
        material.properties.set('opacity', properties.opacity === undefined ? 1.0 : properties.opacity);
        material.properties.set('emissiveFactor', properties.emissiveFactor || [0.0, 0.0, 0.0]);
        material.properties.set('emissiveIntensity',
                                properties.emissiveIntensity === undefined ? 1.0 : properties.emissiveIntensity);

        // Textures flags
        const tex = properties.textures || {};
        material.properties.set('hasBaseColorTexture', tex.baseColorTexture ? true : false);
        if (tex.baseColorTexture) material.textures.set('baseColorTexture', tex.baseColorTexture);

        // A pre-packed map fans out to both source slots, which is what tells the packer to take the
        // identity path and hand the same texture straight back.
        const metallicId = tex.metallicMap ?? tex.metallicRoughnessTexture;
        const roughnessId = tex.roughnessMap ?? tex.metallicRoughnessTexture;

        material.properties.set('hasMetallicMap', metallicId ? true : false);
        if (metallicId) material.textures.set('metallicMap', metallicId);

        material.properties.set('hasRoughnessMap', roughnessId ? true : false);
        if (roughnessId) material.textures.set('roughnessMap', roughnessId);

        material.properties.set('hasNormalMap', tex.normalMap ? true : false);
        if (tex.normalMap) material.textures.set('normalMap', tex.normalMap);

        material.properties.set('hasOcclusionMap', tex.occlusionMap ? true : false);
        if (tex.occlusionMap) material.textures.set('occlusionMap', tex.occlusionMap);

        material.properties.set('hasEmissiveMap', tex.emissiveMap ? true : false);
        if (tex.emissiveMap) material.textures.set('emissiveMap', tex.emissiveMap);

        // `alphaCutoff` is set HERE and nowhere else on this path. It has to receive the raw authoring
        // value rather than an already-defaulted one: a glTF `alphaMode` other than MASK leaves it
        // undefined, and only an undefined can pick up the "mask present => 0.5" default. Pre-setting
        // it to 0 first would hand applyMask a concrete 0 and leave every hand-assigned mask inert.
        applyMask(material, tex.mask, properties.alphaCutoff);

        applyHeight(material, tex.displacementMap, properties);

        return material;
    }

    /**
     * Terrain splat material: up to 4 tiled layers blended by an RGBA splat map, with optional per-layer
     * height/slope masking. Seeds defaults only — `Terrain` owns the splat and layer textures.
     */
    public static Terrain(properties: { baseColor?: number[] } = {}, config?: MaterialConfig): Material {
        const material = new Material(config);
        material.type = MaterialType.Terrain;
        material.properties.set('u_baseColor', properties.baseColor || [0.38, 0.5, 0.28]);
        material.properties.set('u_layerCount', 0);
        material.properties.set('u_useAuto', 0);
        for (let i = 0; i < 4; i++) {
            material.properties.set(`u_tiling${i}`, 20);
            material.properties.set(`u_auto${i}`, 0);
            material.properties.set(`u_hRange${i}`, [0, 100]);
            material.properties.set(`u_sRange${i}`, [0, 1]);
            // Per-layer PBR-blend surface factors (Terrain.setLayer overwrites these from the layer material).
            material.properties.set(`u_color${i}`, [1, 1, 1]);
            material.properties.set(`u_metallic${i}`, 0);
            material.properties.set(`u_roughness${i}`, 1);
            material.properties.set(`u_hasAlbedo${i}`, 0);
            material.properties.set(`u_hasNormal${i}`, 0);
            material.properties.set(`u_hasHeight${i}`, 0);
            material.properties.set(`u_invertHeight${i}`, 0);
            material.properties.set(`u_dispScale${i}`, 0.05);
            material.properties.set(`u_heightBlend${i}`, 0);
        }
        return material;
    }

    /**
     * Flatten this material to plain JSON keyed by shader type. Skinned types normalize to their base
     * type; terrain and anything unrecognized fall through to the Blinn-Phong shape.
     */
    public serialize(): any {
        const cfg = {
            side: this.config.side,
            wireframe: this.config.wireframe,
            transparent: this.config.transparent,
            castShadow: this.config.castShadow,
            probeable: this.config.probeable,
        };
        const normalizeType = (t: string) => t === 'basicSkinned' ? 'basic'
            : t === 'blinn_phongSkinned' ? 'blinn_phong'
            : t === 'celSkinned' ? 'cel' : t;
        const type = normalizeType(this.type as any);

        if (type === 'basic') {
            return {
                type,
                color: this.properties.get('color'),
                opacity: this.properties.get('opacity'),
                alphaCutoff: this.properties.get('alphaCutoff'),
                displacementScale: this.properties.get('dispScale'),
                invertHeight: this.properties.get('invertHeight'),
                clipSilhouette: this.properties.get('clipSilhouette'),
                textures: {
                    texture: this.textures.get('texture'),
                    mask: this.textures.get('maskMap'),
                    displacementMap: this.textures.get('displacementMap')
                },
                config: cfg
            };
        } else if (type === 'pbr') {
            return {
                type,
                baseColor: this.properties.get('baseColor'),
                metallic: this.properties.get('metallic'),
                roughness: this.properties.get('roughness'),
                reflectance: this.properties.get('reflectance'),
                opacity: this.properties.get('opacity'),
                alphaCutoff: this.properties.get('alphaCutoff'),
                emissiveFactor: this.properties.get('emissiveFactor'),
                emissiveIntensity: this.properties.get('emissiveIntensity'),
                displacementScale: this.properties.get('dispScale'),
                // The unit `displacementScale` is in. Its ABSENCE means 'uv', which is what every asset
                // written before this existed implies — so the read in `parse` must stay forever. PBR
                // only: it is the one branch whose shaders actually march.
                depthSpace: this.properties.get('depthInWorld') === false ? 'uv' : 'world',
                parallax: this.properties.get('parallax') === true,
                displaceLevel: this.properties.get('displaceLevel') ?? 0,
                invertHeight: this.properties.get('invertHeight'),
                clipSilhouette: this.properties.get('clipSilhouette'),
                // Fixed keys, not a dump of the map: that keeps the derived `ormTexture` out of assets.
                textures: {
                    baseColorTexture: this.textures.get('baseColorTexture'),
                    metallicMap: this.textures.get('metallicMap'),
                    roughnessMap: this.textures.get('roughnessMap'),
                    normalMap: this.textures.get('normalMap'),
                    occlusionMap: this.textures.get('occlusionMap'),
                    emissiveMap: this.textures.get('emissiveMap'),
                    displacementMap: this.textures.get('displacementMap'),
                    mask: this.textures.get('maskMap')
                },
                config: cfg
            };
        } else if (type === 'cel') {
            return {
                type,
                diffuse: this.properties.get('diffuse'),
                ambient: this.properties.get('ambient'),
                specular: this.properties.get('specular'),
                emissive: this.properties.get('emissive'),
                emissiveIntensity: this.properties.get('emissiveIntensity'),
                shininess: this.properties.get('shininess'),
                opacity: this.properties.get('opacity'),
                alphaCutoff: this.properties.get('alphaCutoff'),
                bands: this.properties.get('bands'),
                bandSoftness: this.properties.get('bandSoftness'),
                specularThreshold: this.properties.get('specularThreshold'),
                rimColor: this.properties.get('rimColor'),
                rimPower: this.properties.get('rimPower'),
                rimStrength: this.properties.get('rimStrength'),
                displacementScale: this.properties.get('dispScale'),
                invertHeight: this.properties.get('invertHeight'),
                clipSilhouette: this.properties.get('clipSilhouette'),
                // The AUTHORING spellings, which differ from the runtime map keys (`base` vs
                // `baseTexture`, `ramp` vs `rampMap`, `mask` vs `maskMap`) exactly as the Basic and
                // Blinn-Phong branches do. Anything walking these generically stays correct;
                // a hand-maintained list would not.
                textures: {
                    base: this.textures.get('baseTexture'),
                    ramp: this.textures.get('rampMap'),
                    normal: this.textures.get('normalMap'),
                    emissive: this.textures.get('emissiveMap'),
                    mask: this.textures.get('maskMap'),
                    displacementMap: this.textures.get('displacementMap')
                },
                config: cfg
            };
        } else { // blinn_phong (and legacy/terrain fall-through)
            return {
                type: 'blinn_phong',
                diffuse: this.properties.get('diffuse'),
                specular: this.properties.get('specular'),
                ambient: this.properties.get('ambient'),
                emissive: this.properties.get('emissive'),
                shininess: this.properties.get('shininess'),
                opacity: this.properties.get('opacity'),
                alphaCutoff: this.properties.get('alphaCutoff'),
                displacementScale: this.properties.get('dispScale'),
                invertHeight: this.properties.get('invertHeight'),
                clipSilhouette: this.properties.get('clipSilhouette'),
                textures: {
                    base: this.textures.get('baseTexture'),
                    specular: this.textures.get('specularMap'),
                    normal: this.textures.get('normalMap'),
                    emissive: this.textures.get('emissiveMap'),
                    mask: this.textures.get('maskMap'),
                    reflectivity: this.textures.get('reflectivityMap'),
                    displacementMap: this.textures.get('displacementMap')
                },
                config: cfg
            };
        }
    }

    /** Rebuild a Material from the JSON produced by serialize(). Missing/legacy 'default' type -> Blinn-Phong. */
    public static parse(m: any): Material {
        m = m || {};
        // A serialized TerrainMaterial carries the extra terrain/foliage fields; delegate to its subclass.
        if (m.terrainMaterial) return TerrainMaterial.parse(m);
        // Route on the discriminator flag OR a `custom:`/`customGeom:` type prefix — a blob without the
        // flag must still reconstruct as a CustomMaterial, not a base Material carrying a custom type.
        if (m.customMaterial ||
            (typeof m.type === 'string' && (m.type.startsWith('custom:') || m.type.startsWith('customGeom:') || m.type.startsWith('customScreen:'))))
            return CustomMaterial.parse(m);
        const config = {
            side: m.config?.side,
            wireframe: m.config?.wireframe,
            transparent: m.config?.transparent,
            castShadow: m.config?.castShadow,
            probeable: m.config?.probeable
        };
        const type: string = m.type || 'blinn_phong';
        if (type === 'basic') {
            return Material.Basic({
                color: m.color || [1, 1, 1],
                opacity: m.opacity ?? 1.0,
                texture: m.textures?.texture,
                // Undefined when absent, never 0: applyMask has to tell "no cutoff stored" from
                // "cutoff explicitly off" so a mask can still pick up its 0.5 default.
                alphaCutoff: m.alphaCutoff,
                mask: m.textures?.mask,
                displacementMap: m.textures?.displacementMap,
                displacementScale: m.displacementScale ?? 0.05,
                invertHeight: !!m.invertHeight,
                clipSilhouette: !!m.clipSilhouette,
            }, config);
        } else if (type === 'pbr') {
            return Material.PBR({
                baseColor: m.baseColor || [1, 1, 1],
                metallic: m.metallic ?? 0.0,
                roughness: m.roughness ?? 1.0,
                // `??`, so a project saved before reflectance existed reloads at the neutral 0.5
                // rather than at 0, which would strip the specular off every dielectric in it.
                reflectance: m.reflectance ?? 0.5,
                opacity: m.opacity ?? 1.0,
                // Left undefined when absent rather than forced to 0: applyMask needs to tell "no
                // cutoff stored" from "cutoff explicitly off", so a mask can still pick up its 0.5
                // default. With no mask, undefined resolves to 0 and an old scene reloads unchanged.
                alphaCutoff: m.alphaCutoff,
                emissiveFactor: m.emissiveFactor || [0, 0, 0],
                // `??`, so a project saved before the multiplier existed reloads at 1 rather than at 0
                // — which would black out every emissive material in it.
                emissiveIntensity: m.emissiveIntensity ?? 1.0,
                displacementScale: m.displacementScale ?? 0.05,
                // NO marker means UV — the only unit that existed when the asset was written. This read
                // must stay forever: asset JSON is not rewritten until the asset is re-saved, so dropping
                // it would silently reinterpret every stored depth as world units. `applyHeight` defaults
                // the other way (world) for anything CREATED rather than parsed.
                depthSpace: m.depthSpace === 'world' ? 'world' : 'uv',
                // `=== true`, NOT `!== false` — and it is the one marker here that does not preserve
                // old behaviour. An old asset's silence reads as OFF because the march was WITHDRAWN,
                // not re-defaulted, and the editor has no control left that could switch it back off.
                // An asset that explicitly stored `true` still marches.
                parallax: m.parallax === true,
                displaceLevel: Number(m.displaceLevel ?? 0),
                invertHeight: !!m.invertHeight,
                clipSilhouette: !!m.clipSilhouette,
                // `metallicRoughnessTexture` is the pre-split key; Material.PBR fans it out to both slots.
                textures: {
                    baseColorTexture: m.textures?.baseColorTexture,
                    metallicMap: m.textures?.metallicMap,
                    roughnessMap: m.textures?.roughnessMap,
                    metallicRoughnessTexture: m.textures?.metallicRoughnessTexture,
                    normalMap: m.textures?.normalMap,
                    occlusionMap: m.textures?.occlusionMap,
                    emissiveMap: m.textures?.emissiveMap,
                    displacementMap: m.textures?.displacementMap,
                    mask: m.textures?.mask
                }
            }, config);
        } else if (type === 'cel') {
            const texData = m.textures || {};
            return Material.Cel({
                diffuse: m.diffuse,
                ambient: m.ambient,
                specular: m.specular,
                emissive: m.emissive,
                emissiveIntensity: m.emissiveIntensity,
                shininess: m.shininess,
                opacity: m.opacity,
                // Passed through UNDEFINED when absent, never `?? 0`: `applyMask` reads the absence as
                // "no threshold stated" and supplies 0.5 whenever a mask is present, which is how a
                // cutout authored before the property existed keeps working. A literal 0 would mean
                // "explicitly off" and switch the cutout off instead.
                alphaCutoff: m.alphaCutoff,
                bands: m.bands,
                bandSoftness: m.bandSoftness,
                specularThreshold: m.specularThreshold,
                rimColor: m.rimColor,
                rimPower: m.rimPower,
                rimStrength: m.rimStrength,
                displacementScale: m.displacementScale ?? 0.05,
                invertHeight: !!m.invertHeight,
                clipSilhouette: !!m.clipSilhouette,
                textures: {
                    base: texData.base,
                    ramp: texData.ramp,
                    normal: texData.normal,
                    emissive: texData.emissive,
                    mask: texData.mask,
                    displacementMap: texData.displacementMap
                }
            }, config);
        } else { // 'blinn_phong' (or legacy 'default')
            const texData = m.textures || {};
            return Material.Default({
                diffuse: m.diffuse,
                specular: m.specular,
                ambient: m.ambient,
                emissive: m.emissive,
                shininess: m.shininess,
                opacity: m.opacity,
                alphaCutoff: m.alphaCutoff,
                displacementScale: m.displacementScale ?? 0.05,
                invertHeight: !!m.invertHeight,
                clipSilhouette: !!m.clipSilhouette,
                textures: {
                    base: texData.base,
                    specular: texData.specular,
                    normal: texData.normal,
                    emissive: texData.emissive,
                    mask: texData.mask,
                    reflectivity: texData.reflectivity,
                    displacementMap: texData.displacementMap
                }
            }, config);
        }
    }
}

/** The base shading model a TerrainMaterial layers its terrain behaviour on top of. */
export type TerrainBaseType = 'basic' | 'blinn_phong' | 'pbr';

/**
 * An optional physics proxy for a foliage prototype: instances near the camera get a static collider.
 * Dimensions are in prototype units, multiplied by the instance's own random scale.
 */
export interface FoliageCollision {
    shape: 'cylinder' | 'box' | 'sphere';
    /** Cylinder/sphere radius. */
    radius?: number;
    /** Cylinder/box height. */
    height?: number;
    /** Box footprint (defaults to `radius * 2` when absent). */
    width?: number;
    depth?: number;
    /** Shape centre above the instance base. Defaults to half the height (or the radius for a sphere). */
    offsetY?: number;
}

/** Marker stamped on a rule whose `density` is expressed in instances per square metre. */
export const FOLIAGE_DENSITY_UNIT = 'm2';

/** Per-m² densities a freshly authored rule starts at. Grass is dense; scattered props are sparse. */
export const DEFAULT_FOLIAGE_DENSITY = { billboard: 2.0, mesh: 0.05 };

/**
 * Bring a serialized foliage rule up to the per-m² density unit, in place. Idempotent — the
 * `densityUnit` marker stops a serialize/parse round trip dividing twice.
 */
export function migrateFoliageRule<T extends { density?: number; densityUnit?: string }>(rule: T): T {
    if (rule.densityUnit === FOLIAGE_DENSITY_UNIT) return rule;
    rule.density = Math.max(0, (rule.density ?? 8) / 100);
    rule.densityUnit = FOLIAGE_DENSITY_UNIT;
    return rule;
}

/**
 * The stable key a runtime foliage layer is filed under.
 *
 * Three tiers, most stable first. `id` is the real answer and every newly written rule carries one.
 * `modelId` covers every library-linked mesh rule authored before ids existed, which is the bulk of
 * real content. `name` is the last resort and the only tier a rename can break — which is exactly the
 * behaviour this replaces, so nothing regresses by falling through to it.
 */
export function foliageRuleKey(rule: TerrainFoliageRule): string {
    return rule.id ?? rule.modelId ?? rule.meshId ?? rule.name;
}

/**
 * A foliage prototype a TerrainMaterial auto-instances, or — named in an exclude list — one to keep
 * off that material. Plain data only, to keep this module free of a cycle with `terrain/foliage.ts`.
 */
/**
 * A foliage rule as it should be PERSISTED: without the baked prototype geometry when that geometry can
 * be rebuilt from the model library. See TerrainMaterial.serialize for why.
 */
function stripDerivedFoliageGeometry(rule: TerrainFoliageRule): TerrainFoliageRule {
    const out: any = { ...rule, densityUnit: FOLIAGE_DENSITY_UNIT };
    if (out.kind === 'mesh' && (out.modelId || out.meshId)) {
        delete out.model;
        delete out.models;
        // The LOD levels' geometry goes with them; their DISTANCES come back from the model asset's own
        // levels, which is where they were authored.
        delete out.lods;
    }
    return out;
}

export interface TerrainFoliageRule {
    kind: 'mesh' | 'billboard';
    /**
     * Stable identity, independent of the display name. Never shown, never referenced by an exclude
     * list — it exists so a runtime foliage layer can follow its rule across a RENAME instead of being
     * orphaned with its scattered instances.
     *
     * Optional because it is migrated in, not required: {@link foliageRuleKey} falls back through
     * `modelId` to `name`, so a rule authored before this existed keeps working and converges on an id
     * the next time the editor writes it.
     */
    id?: string;
    /** Display name. Also what exclude lists reference, so it is NOT an identity — see `id`. */
    name: string;
    /** Billboard albedo (TextureManager id). Unused for 'mesh'. */
    textureId?: string | null;
    /** Legacy single Model.serialize() JSON for 'mesh' (still honored). Superseded by `models`. */
    model?: any;
    /** Editor-side link to the source model library asset (sync key). The engine ignores it. */
    modelId?: string;
    /** Pre-rename spelling of `modelId`, still read so unmigrated terrain materials keep their link. */
    meshId?: string;
    /** LOD0 as a flattened list of Model.serialize() JSON (one entry per sub-mesh, transforms baked). */
    models?: any[];
    /** Additional detail levels, ascending by the camera distance at which each takes over. */
    lods?: { models: any[]; distance: number }[];
    /** Optional impostor: past `distance`, instances draw as textured cross-quads (the farthest LOD). */
    billboard?: { textureId: string; distance: number } | null;
    /** Hide instances beyond this camera distance; 0/absent = the renderer's global foliage cull. */
    cullDistance?: number;
    /** Rasterize these instances into the shadow cascades. Off by default: one instanced draw per cell per cascade. */
    castShadows?: boolean;
    /** Instances per SQUARE METRE — the same unit for the brush disc and whole-terrain generation. */
    density?: number;
    /** Unit marker for `density`. Absent = legacy per-100x100-tile; see {@link migrateFoliageRule}. */
    densityUnit?: string;
    minScale?: number;
    maxScale?: number;
    /** Static physics proxy spawned for nearby instances. Absent/null = never collidable (grass). */
    collision?: FoliageCollision | null;
}

/**
 * A reusable paint-layer material for terrains: a {@link Material} of a base type plus terrain blend
 * fields and foliage rules. Never rendered on its own — `Terrain` reads it into a paint layer.
 */
export class TerrainMaterial extends Material {
    /** UV repeat of this layer across the whole terrain. */
    public tiling: number = 20;
    /** Enable automatic height/slope masking for this layer. */
    public auto: boolean = false;
    /** World-Y band the layer is visible in (auto blend). */
    public hRange: [number, number] = [0, 100];
    /** Slope band (0 flat .. 1 vertical) the layer is visible in (auto blend). */
    public sRange: [number, number] = [0, 1];
    /**
     * Relief depth for this layer's height map, as a fraction of ONE TEXTURE REPEAT.
     *
     * The same unit and the same meaning as a standard material's `displacementScale`, which is what
     * makes a library material read identically on terrain and on a mesh: both surfaces know their own
     * texture repeat and nothing else. `chunks/terrainLayers.wgsl`'s `blendedDepth` divides by the
     * layer's tiling to reach the base uv the ray travels in.
     *
     * This was briefly WORLD METRES, because relief was split between a vertex bake and the march and a
     * bake works in metres. One authored number driving two mechanisms forced a unit that meant nothing
     * to the texture: 6 cm on a 3.2 m brick is 2% of the feature, where the same map on a mesh gets 24%,
     * so terrain read flat next to an identical material. The bake is gone and so is the unit.
     */
    public displacementScale: number = 0.05;
    /**
     * "My source is already a HEIGHT map (white = high)."
     *
     * Reads backwards from its name, and the name is kept because it is the same control a standard
     * material has — and now it means the same thing. The slot is documented as a DEPTH map
     * (`*_disp.png`, white = deep; the two are indistinguishable from the bytes), so with this off a
     * depth map recesses on terrain exactly as it does on a mesh.
     *
     * `Terrain._deriveLayerSurface` used to NEGATE this on the way to the layer, because terrain relief
     * was geometry: geometry only adds, a march only carves, so the two needed opposite reference
     * planes and the same map came out inside-out depending on what it was applied to. Terrain marches
     * now; the negation is gone and there is one meaning.
     */
    public invertHeight: boolean = false;
    /**
     * Height-aware blend sharpness (0 = plain linear splat blend; higher = high spots poke through).
     *
     * The second thing terrain does with a height map, alongside the parallax march above: where two
     * layers overlap, the one standing higher takes the fragment instead of the two averaging into mud.
     */
    public heightBlend: number = 0;
    /** Foliage prototypes this material scatters under the foliage brush. */
    public foliageInclude: TerrainFoliageRule[] = [];
    /** Foliage names kept off this material even when a neighbouring material would place them. */
    public foliageExclude: string[] = [];

    /** Build a terrain paint-layer material whose surface is the given base shading model. */
    public static Create(baseType: TerrainBaseType, properties: any = {}, config?: MaterialConfig): TerrainMaterial {
        const base = baseType === 'basic' ? Material.Basic(properties, config)
            : baseType === 'pbr' ? Material.PBR(properties, config)
            : Material.Default(properties, config);
        const tm = new TerrainMaterial(config);
        tm.type = base.type;
        tm.properties = base.properties;
        tm.textures = base.textures;
        tm.config = base.config;
        return tm;
    }

    public serialize(): any {
        // The height map rides in `textures` like every other slot now. It used to be emitted as a
        // TOP-LEVEL sibling, because `Material.serialize()` writes a FIXED key list per base type and
        // only the pbr branch listed a displacement slot — so a basic- or blinn_phong-based layer had
        // nowhere else to put it. All three branches carry the slot now, which removes the terrain-only
        // shape that `terrainMaterials.ts`, `bundleMerge.ts` and `references.ts` each had to special-case.
        //
        // `parse` still READS the old top-level key, and must forever: asset JSON on disk is never
        // rewritten until that asset is re-saved, and the shipped 3d-example stores its height ids there
        // and nowhere else.
        return {
            ...super.serialize(), // base surface shape, keyed by this.type (basic/pbr/blinn_phong)
            terrainMaterial: true,
            tiling: this.tiling,
            auto: this.auto,
            hRange: [this.hRange[0], this.hRange[1]],
            sRange: [this.sRange[0], this.sRange[1]],
            displacementScale: this.displacementScale,
            invertHeight: this.invertHeight,
            heightBlend: this.heightBlend,
            // Stamping the unit on the way out is what makes the round trip idempotent.
            //
            // A mesh rule's baked prototypes are NOT written when it has a `modelId`: they are a derived
            // cache of that model asset, and persisting them put a full copy of every tree in every
            // terrain material that scattered it — and a second copy in every scene blob, since a scene
            // serializes its layer materials too. The editor rebuilds them on load
            // (resolveFoliageRuleGeometry). A rule with no `modelId` has nothing to rebuild FROM, so it
            // keeps carrying its geometry.
            foliageInclude: this.foliageInclude.map(r => stripDerivedFoliageGeometry(r)),
            foliageExclude: [...this.foliageExclude],
        };
    }

    public static parse(m: any): TerrainMaterial {
        m = m || {};
        // Parse the base surface without re-triggering the terrainMaterial delegation guard.
        const base = Material.parse({ ...m, terrainMaterial: undefined });
        const tm = new TerrainMaterial(base.config);
        tm.type = base.type;
        tm.properties = base.properties;
        tm.textures = base.textures;
        tm.config = base.config;
        tm.tiling = m.tiling ?? 20;
        tm.auto = !!m.auto;
        tm.hRange = m.hRange ? [m.hRange[0], m.hRange[1]] : [0, 100];
        tm.sRange = m.sRange ? [m.sRange[0], m.sRange[1]] : [0, 1];
        // LEGACY READ, and it stays. Terrain used to serialize its height map as a top-level sibling of
        // `textures`; it now rides inside `textures` like every other slot (see serialize above). Every
        // project saved before that — the shipped 3d-example included — has the id ONLY out here, and
        // nothing rewrites an asset until the user re-saves it. Dropping this line loads those terrains
        // with no height at all: `u_hasHeight{i}` goes to 0 and the height-aware blend silently becomes a
        // plain linear splat, with nothing logged.
        //
        if (m.displacementMap) tm.textures.set('displacementMap', m.displacementMap);
        tm.displacementScale = m.displacementScale ?? 0.05;
        // NOT un-migrated here, deliberately. A `depthUnit: 'metres'` stamp means the value was
        // multiplied by `terrainSize / tiling` while terrain relief was geometry, and undoing that needs
        // the terrain size — which this function does not have and the stamp does not carry. It is done
        // where both are in hand: `Terrain.deserialize` for an embedded layer material, and
        // `unmigrateTerrainMaterialDepth` on the editor side for a library asset.
        // CARRIED THROUGH UNCHANGED, deliberately. There was a migration here that flipped this on
        // load for assets written before terrain honoured the depth-map convention, so that nothing
        // already authored would change on screen — and it cancelled the very fix it accompanied.
        // `Terrain._deriveLayerSurface` inverts on the way to the layer, so flipping again here returned
        // `X -> !X -> X` and every saved material rendered exactly as wrongly as before. Preserving the
        // appearance was the mistake: the appearance was the bug. Existing materials flip on load now,
        // which is the point.
        tm.invertHeight = !!m.invertHeight;
        tm.heightBlend = m.heightBlend ?? 0;
        // The only JSON -> live-rule path, so the density migration runs here. Downstream consumers
        // may assume every live foliageInclude entry is already per-m².
        tm.foliageInclude = Array.isArray(m.foliageInclude)
            ? m.foliageInclude.map((r: any) => migrateFoliageRule({ ...r })) : [];
        tm.foliageExclude = Array.isArray(m.foliageExclude) ? [...m.foliageExclude] : [];
        return tm;
    }
}

/** The editor material a custom shader was seeded from (its "extend" base), or null when written from scratch. */
export type CustomBaseType = 'basic' | 'blinn_phong' | 'pbr' | null;

/**
 * Whether a custom material's fragment shader outputs a final lit colour (`forward`), writes G-buffer
 * channels (`deferred`), or is a fullscreen post pass (`screen`). Governs template and render path.
 */
export type CustomRenderMode = 'forward' | 'deferred' | 'screen';

/** GLSL uniform types a user may declare — exactly the set `Shader.storeUniforms` can introspect (minus mat4, which is engine-owned). */
export type CustomUniformType = 'float' | 'vec2' | 'vec3' | 'vec4' | 'int' | 'bool' | 'sampler2D' | 'samplerCube';

/** A user-declared shader uniform (name/type/default) — analogous to a node variable. */
export interface CustomUniform {
    name: string;
    type: CustomUniformType;
    value: any;
}

/** Normalize typed arrays to plain arrays so uniform values survive a JSON round-trip. */
function toPlainValue(v: any): any {
    if (v instanceof Float32Array || v instanceof Int32Array) return Array.from(v as any);
    if (Array.isArray(v)) return v.slice();
    return v;
}

/** cyrb53 — small, stable, non-crypto string hash. Derives dedupable shader and packed-texture keys. */
export function cyrb53(str: string, seed = 0): string {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * A material whose surface is a user-written GLSL fragment shader plus {@link CustomUniform}s, compiled
 * lazily by `systems/customShaders.ts`. Uniform values live in `properties`, samplers in `textures`, both
 * under the bare name; `type` is a content hash, so identical shaders share one program.
 */
export class CustomMaterial extends Material {
    public renderMode: CustomRenderMode = 'forward';
    public baseType: CustomBaseType = null;
    public fragmentSource: string = '';
    public uniforms: CustomUniform[] = [];

    /**
     * The WGSL this material's source last translated to. Written by the editor's Compile button, never
     * at runtime — naga does not ship to players.
     */
    public compiledWgsl: string | null = null;

    /**
     * The `type` hash `compiledWgsl` was produced from. Comparing it against the current `type` is how
     * staleness is detected — `fragmentSource` and `uniforms` are public fields with no setter to hook.
     */
    public compiledWgslType: string | null = null;

    /** Create a bare custom material. Callers (the editor) seed `fragmentSource`/`uniforms` from customShaders' templates, then `refreshType()`. */
    public static Create(baseType: CustomBaseType, renderMode: CustomRenderMode = 'forward', config?: MaterialConfig): CustomMaterial {
        const m = new CustomMaterial(config);
        m.baseType = baseType;
        m.renderMode = renderMode;
        m.refreshType();
        return m;
    }

    /**
     * Recompute the shader-registry key from mode, source and uniform declarations. Must be called after
     * editing any of those; the value is the ShaderManager key and the VAO key.
     */
    public refreshType(): void {
        const sig = this.renderMode + '|' + (this.baseType ?? '') + '|' + this.fragmentSource + '|' +
            this.uniforms.map(u => u.name + ':' + u.type).join(',');
        this.type = ((this.renderMode === 'deferred' ? 'customGeom:' :
            this.renderMode === 'screen' ? 'customScreen:' : 'custom:') + cyrb53(sig)) as any;
    }

    /** True when `compiledWgsl` was translated from exactly the source and uniforms in effect now. */
    public get wgslIsCurrent(): boolean {
        return this.compiledWgsl !== null && this.compiledWgslType === this.type;
    }

    public serialize(): any {
        const properties: { [k: string]: any } = {};
        for (const [k, v] of this.properties) properties[k] = toPlainValue(v);
        return {
            type: this.type,
            customMaterial: true,
            compiledWgsl: this.compiledWgsl,
            compiledWgslType: this.compiledWgslType,
            renderMode: this.renderMode,
            baseType: this.baseType,
            fragmentSource: this.fragmentSource,
            uniforms: this.uniforms.map(u => ({ name: u.name, type: u.type, value: toPlainValue(u.value) })),
            properties,
            textures: Object.fromEntries(this.textures),
            config: {
                side: this.config.side,
                wireframe: this.config.wireframe,
                transparent: this.config.transparent,
                castShadow: this.config.castShadow,
                probeable: this.config.probeable,
            },
        };
    }

    public static parse(m: any): CustomMaterial {
        m = m || {};
        const cm = new CustomMaterial({
            side: m.config?.side,
            wireframe: m.config?.wireframe,
            transparent: m.config?.transparent,
            castShadow: m.config?.castShadow,
            probeable: m.config?.probeable,
        });
        cm.renderMode = m.renderMode === 'deferred' ? 'deferred' : m.renderMode === 'screen' ? 'screen' : 'forward';
        cm.baseType = m.baseType ?? null;
        cm.fragmentSource = m.fragmentSource ?? '';
        cm.uniforms = Array.isArray(m.uniforms)
            ? m.uniforms.map((u: any) => ({ name: u.name, type: u.type, value: toPlainValue(u.value) }))
            : [];
        cm.compiledWgsl = typeof m.compiledWgsl === 'string' ? m.compiledWgsl : null;
        cm.compiledWgslType = typeof m.compiledWgslType === 'string' ? m.compiledWgslType : null;
        for (const [k, v] of Object.entries(m.properties ?? {})) cm.properties.set(k, toPlainValue(v));
        for (const [k, v] of Object.entries(m.textures ?? {})) if (v) cm.textures.set(k, v as string);
        cm.refreshType();
        return cm;
    }
}
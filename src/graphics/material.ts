interface MaterialConfig {
    side?: 'front' | 'back' | 'double';
    transparent?: boolean;
    castShadow?: boolean;
    probeable?: boolean;
    wireframe?: boolean;
}

interface BasicProperties {
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
}

interface DefaultProperties {
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
    }
}

interface PBRProperties {
    baseColor?: number[];
    metallic?: number;
    roughness?: number;
    opacity?: number;
    /**
     * glTF `alphaMode: MASK`. Below this base-colour alpha the fragment is discarded; the surface
     * stays opaque G-buffer geometry, with no blending or sorting. 0 disables it.
     */
    alphaCutoff?: number;
    emissiveFactor?: number[];
    /** Parallax occlusion mapping depth, in UV units. Inert without a `displacementMap`. */
    displacementScale?: number;
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
         * Height field for parallax occlusion mapping, read from RED (0 = floor, 1 = surface). Unlike
         * the ORM sources above, this is bound directly on its own texture unit.
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

enum MaterialType {
    Basic = 'basic',
    Default = 'blinn_phong',
    BasicSkinned = 'basicSkinned',
    DefaultSkinned = 'blinn_phongSkinned',
    PBR = 'pbr',
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

        material.properties.set('hasReflectivityMap', properties.textures?.reflectivity ? true : false);

        if (properties.textures?.reflectivity) {
            const tex = properties.textures.reflectivity;
            material.textures.set('reflectivityMap', tex);
        }

        return material;
    }

    public static PBR(properties: PBRProperties = {}, config?: MaterialConfig): Material {
        const material = new Material(config);
        material.type = MaterialType.PBR;
        material.properties.set('baseColor', properties.baseColor || [1.0, 1.0, 1.0]);
        material.properties.set('metallic', properties.metallic === undefined ? 0.0 : properties.metallic);
        material.properties.set('roughness', properties.roughness === undefined ? 1.0 : properties.roughness);
        material.properties.set('opacity', properties.opacity === undefined ? 1.0 : properties.opacity);
        material.properties.set('emissiveFactor', properties.emissiveFactor || [0.0, 0.0, 0.0]);

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

        // Always written, so a material that gains a height map later already has a usable depth.
        material.properties.set('dispScale', properties.displacementScale ?? 0.05);
        material.properties.set('hasDisplacementMap', tex.displacementMap ? true : false);
        if (tex.displacementMap) material.textures.set('displacementMap', tex.displacementMap);

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
            material.properties.set(`u_hasDisp${i}`, 0);
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
        const normalizeType = (t: string) => t === 'basicSkinned' ? 'basic' : (t === 'blinn_phongSkinned' ? 'blinn_phong' : t);
        const type = normalizeType(this.type as any);

        if (type === 'basic') {
            return {
                type,
                color: this.properties.get('color'),
                opacity: this.properties.get('opacity'),
                alphaCutoff: this.properties.get('alphaCutoff'),
                textures: {
                    texture: this.textures.get('texture'),
                    mask: this.textures.get('maskMap')
                },
                config: cfg
            };
        } else if (type === 'pbr') {
            return {
                type,
                baseColor: this.properties.get('baseColor'),
                metallic: this.properties.get('metallic'),
                roughness: this.properties.get('roughness'),
                opacity: this.properties.get('opacity'),
                alphaCutoff: this.properties.get('alphaCutoff'),
                emissiveFactor: this.properties.get('emissiveFactor'),
                displacementScale: this.properties.get('dispScale'),
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
                textures: {
                    base: this.textures.get('baseTexture'),
                    specular: this.textures.get('specularMap'),
                    normal: this.textures.get('normalMap'),
                    emissive: this.textures.get('emissiveMap'),
                    mask: this.textures.get('maskMap'),
                    reflectivity: this.textures.get('reflectivityMap')
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
                mask: m.textures?.mask
            }, config);
        } else if (type === 'pbr') {
            return Material.PBR({
                baseColor: m.baseColor || [1, 1, 1],
                metallic: m.metallic ?? 0.0,
                roughness: m.roughness ?? 1.0,
                opacity: m.opacity ?? 1.0,
                // Left undefined when absent rather than forced to 0: applyMask needs to tell "no
                // cutoff stored" from "cutoff explicitly off", so a mask can still pick up its 0.5
                // default. With no mask, undefined resolves to 0 and an old scene reloads unchanged.
                alphaCutoff: m.alphaCutoff,
                emissiveFactor: m.emissiveFactor || [0, 0, 0],
                displacementScale: m.displacementScale ?? 0.05,
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
                textures: {
                    base: texData.base,
                    specular: texData.specular,
                    normal: texData.normal,
                    emissive: texData.emissive,
                    mask: texData.mask,
                    reflectivity: texData.reflectivity
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
 * A foliage prototype a TerrainMaterial auto-instances, or — named in an exclude list — one to keep
 * off that material. Plain data only, to keep this module free of a cycle with `terrain/foliage.ts`.
 */
export interface TerrainFoliageRule {
    kind: 'mesh' | 'billboard';
    /** Stable identifier; also what exclude lists reference. */
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
    /** Parallax strength for the layer's displacement (height) map (0 = flat). */
    public displacementScale: number = 0.05;
    /** Height-aware blend sharpness (0 = plain linear splat blend; higher = high spots poke through). */
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
        return {
            ...super.serialize(), // base surface shape, keyed by this.type (basic/pbr/blinn_phong)
            terrainMaterial: true,
            tiling: this.tiling,
            auto: this.auto,
            hRange: [this.hRange[0], this.hRange[1]],
            sRange: [this.sRange[0], this.sRange[1]],
            // super.serialize() emits fixed base-type keys only, so carry displacement explicitly.
            displacementMap: this.textures.get('displacementMap') ?? null,
            displacementScale: this.displacementScale,
            heightBlend: this.heightBlend,
            // Stamping the unit on the way out is what makes the round trip idempotent.
            foliageInclude: this.foliageInclude.map(r => ({ ...r, densityUnit: FOLIAGE_DENSITY_UNIT })),
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
        if (m.displacementMap) tm.textures.set('displacementMap', m.displacementMap);
        tm.displacementScale = m.displacementScale ?? 0.05;
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
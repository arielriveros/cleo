interface MaterialConfig {
    side?: 'front' | 'back' | 'double';
    transparent?: boolean;
    castShadow?: boolean;
    wireframe?: boolean;
}

interface BasicProperties {
    color?: number[];
    texture?: string;
    opacity?: number;
}

interface DefaultProperties {
    diffuse?: number[];
    specular?: number[];
    ambient?: number[];
    emissive?: number[];
    shininess?: number;
    opacity?: number;
    reflectivity?: number;

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
    emissiveFactor?: number[];
    textures?: {
        baseColorTexture?: string;
        metallicRoughnessTexture?: string; // b=metallic, g=roughness
        normalMap?: string;
        occlusionMap?: string;
        emissiveMap?: string;
    }
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

        material.properties.set('hasMaskMap', properties.textures?.mask ? true : false);

        if (properties.textures?.mask) {
            const tex = properties.textures.mask;
            material.textures.set('maskMap', tex);
        }

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

        material.properties.set('hasMetallicRoughnessTexture', tex.metallicRoughnessTexture ? true : false);
        if (tex.metallicRoughnessTexture) material.textures.set('metallicRoughnessTexture', tex.metallicRoughnessTexture);

        material.properties.set('hasNormalMap', tex.normalMap ? true : false);
        if (tex.normalMap) material.textures.set('normalMap', tex.normalMap);

        material.properties.set('hasOcclusionMap', tex.occlusionMap ? true : false);
        if (tex.occlusionMap) material.textures.set('occlusionMap', tex.occlusionMap);

        material.properties.set('hasEmissiveMap', tex.emissiveMap ? true : false);
        if (tex.emissiveMap) material.textures.set('emissiveMap', tex.emissiveMap);

        return material;
    }

    /**
     * Terrain splat material: up to 4 tiled layers blended by an RGBA splat map, with optional
     * per-layer automatic height/slope masking. Uniform names match shaders/deferred/geometryTerrain.fs.
     * The `Terrain` subsystem owns/updates the splat + layer textures and the per-layer properties;
     * this factory just seeds the defaults.
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
     * Flatten this material to a plain JSON object keyed by shader type. Geometry-independent, so it
     * can snapshot a standalone material (e.g. a material asset) as well as back Model.serialize().
     * Skinned types normalize to their base type; terrain and anything unrecognized fall through to
     * the Blinn-Phong shape (matching the historical Model.serialize behavior).
     */
    public serialize(): any {
        const cfg = {
            side: this.config.side,
            wireframe: this.config.wireframe,
            transparent: this.config.transparent,
            castShadow: this.config.castShadow,
        };
        const normalizeType = (t: string) => t === 'basicSkinned' ? 'basic' : (t === 'blinn_phongSkinned' ? 'blinn_phong' : t);
        const type = normalizeType(this.type as any);

        if (type === 'basic') {
            return {
                type,
                color: this.properties.get('color'),
                opacity: this.properties.get('opacity'),
                textures: { texture: this.textures.get('texture') },
                config: cfg
            };
        } else if (type === 'pbr') {
            return {
                type,
                baseColor: this.properties.get('baseColor'),
                metallic: this.properties.get('metallic'),
                roughness: this.properties.get('roughness'),
                opacity: this.properties.get('opacity'),
                emissiveFactor: this.properties.get('emissiveFactor'),
                textures: {
                    baseColorTexture: this.textures.get('baseColorTexture'),
                    metallicRoughnessTexture: this.textures.get('metallicRoughnessTexture'),
                    normalMap: this.textures.get('normalMap'),
                    occlusionMap: this.textures.get('occlusionMap'),
                    emissiveMap: this.textures.get('emissiveMap')
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
        const config = {
            side: m.config?.side,
            wireframe: m.config?.wireframe,
            transparent: m.config?.transparent,
            castShadow: m.config?.castShadow
        };
        const type: string = m.type || 'blinn_phong';
        if (type === 'basic') {
            return Material.Basic({
                color: m.color || [1, 1, 1],
                opacity: m.opacity ?? 1.0,
                texture: m.textures?.texture
            }, config);
        } else if (type === 'pbr') {
            return Material.PBR({
                baseColor: m.baseColor || [1, 1, 1],
                metallic: m.metallic ?? 0.0,
                roughness: m.roughness ?? 1.0,
                opacity: m.opacity ?? 1.0,
                emissiveFactor: m.emissiveFactor || [0, 0, 0],
                textures: {
                    baseColorTexture: m.textures?.baseColorTexture,
                    metallicRoughnessTexture: m.textures?.metallicRoughnessTexture,
                    normalMap: m.textures?.normalMap,
                    occlusionMap: m.textures?.occlusionMap,
                    emissiveMap: m.textures?.emissiveMap
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
 * A foliage prototype a TerrainMaterial auto-instances (or, referenced by name in a material's
 * exclude list, a foliage type to keep off that material). Plain data only — no runtime engine
 * imports — so `material.ts` stays free of a circular dependency with `terrain/foliage.ts`.
 */
export interface TerrainFoliageRule {
    kind: 'mesh' | 'billboard';
    /** Stable identifier; also what exclude lists reference. */
    name: string;
    /** Billboard albedo (TextureManager id). Unused for 'mesh'. */
    textureId?: string | null;
    /** Model.serialize() JSON for 'mesh'. Unused for 'billboard'. */
    model?: any;
    density?: number;
    minScale?: number;
    maxScale?: number;
}

/**
 * An authorable, reusable **paint-layer** material for terrains. It *is* a {@link Material} of a
 * base type (basic / blinn_phong / pbr) — so it inherits all base shading and any future extension —
 * plus terrain-specific blend fields (tiling + automatic height/slope masking) and foliage rules.
 *
 * A TerrainMaterial is never rendered on its own: when assigned to one of a terrain's 4 paint layers,
 * the `Terrain` reads its surface (albedo/normal/metallic-roughness) into the composite terrain
 * material's per-layer uniforms, and its foliage rules drive the material-driven foliage brush.
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
            // Displacement lives in the inherited textures map; super.serialize() only emits fixed base-type
            // keys, so carry the terrain-specific displacement texture + params explicitly.
            displacementMap: this.textures.get('displacementMap') ?? null,
            displacementScale: this.displacementScale,
            heightBlend: this.heightBlend,
            foliageInclude: this.foliageInclude.map(r => ({ ...r })),
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
        tm.foliageInclude = Array.isArray(m.foliageInclude) ? m.foliageInclude.map((r: any) => ({ ...r })) : [];
        tm.foliageExclude = Array.isArray(m.foliageExclude) ? [...m.foliageExclude] : [];
        return tm;
    }
}
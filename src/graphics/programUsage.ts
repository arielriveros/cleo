// Which shader programs a published game needs, worked out from its serialized scenes and settings.
//
// A first launch compiles every program the renderer builds at boot, and on Windows (ANGLE -> D3D) that
// is the black screen a player waits through: ~50 s for all ~80. A game uses far fewer — no cel
// shading, no clouds, no decals, one shadow filter, particles without force fields — so publish writes
// the list this module produces into `config.graphics.programs`, and the player builds only those.
//
// The rule throughout is CONSERVATIVE: when the JSON cannot tell, include. A name missing from the list
// is not a crash — the renderer builds it on first use, with a warning (Renderer._buildOnDemand) — but
// it is a hitch in the middle of play, which is exactly what the list exists to avoid.
//
// Names are PHYSICAL (programVariants.ts): `pbr~pcf`, `particleSim~s9`. Every program-table name is
// classified in PROGRAM_CLASS, and tests/programUsage.test.ts fails when a new program is not, so a
// program added later cannot silently be left out of published games.

import { physicalFor, particleSimProgram, type ShadowFilter } from './programVariants';
import { packEmitter, simStripMask } from '../particles/particlePack';
import { parseParticleSystem } from '../particles/particleSystemAsset';
import { resolveSubEmitters } from '../particles/particleRuntime';
import { QUALITY_TIERS, type RenderSettings, type QualityPreset } from './renderer';

/**
 * How a program-table entry is decided: `core` always ships; `feature` ships when a scene or setting
 * uses it (see {@link programsFor}); `editor` never ships (debug views, gizmos, thumbnails).
 */
export const PROGRAM_CLASS: Readonly<Record<string, 'core' | 'feature' | 'editor'>> = {
    // Boot and every frame: the targets, IBL bakes, the deferred resolve, presentation.
    screen: 'core', present: 'core', composer: 'core', brdf: 'core', irradiance: 'core', prefilter: 'core',
    skybox: 'core', deferredLighting: 'core', shadowMap: 'core', basic: 'core', basicGeometry: 'core',
    // The default attribute layout foliage and other instanced meshes are initialised from.
    blinn_phongGeometry: 'core',
    bloom: 'feature', bloomDownsample: 'feature', bloomUpsample: 'feature', exposureMeter: 'feature',
    basicSkinned: 'feature', basicGeometrySkinned: 'feature',
    blinn_phong: 'feature', blinn_phongSkinned: 'feature', blinn_phongGeometrySkinned: 'feature',
    blinn_phongGeometryInstanced: 'feature',
    pbr: 'feature', pbrSkinned: 'feature', pbrGeometry: 'feature', pbrGeometrySkinned: 'feature',
    pbrGeometryInstanced: 'feature',
    cel: 'feature', celSkinned: 'feature',
    terrain: 'feature', terrainGeometry: 'feature', terrainForward: 'feature', foliageBillboardInstanced: 'feature',
    tilemap: 'feature',
    ssao: 'feature', ssaoBlur: 'feature',
    shadowMapSkinned: 'feature', shadowMapInstanced: 'feature', shadowMapInstancedCutout: 'feature',
    shadowMapCutout: 'feature', shadowMapSkinnedCutout: 'feature', shadowMapBasicCutout: 'feature',
    shadowMapBasicSkinnedCutout: 'feature',
    volumetricClouds: 'feature', cloudNoiseBake: 'feature', cloudTemporalResolve: 'feature', cloudUpsample: 'feature',
    skyAtmosphere: 'feature', skyProject: 'feature', skyFog: 'feature', godRays: 'feature',
    chromaticAberration: 'feature', dofCoc: 'feature', dofGather: 'feature', dofComposite: 'feature',
    lensFlare: 'feature', lensFlareComposite: 'feature', vignette: 'feature', filmGrain: 'feature',
    taaResolve: 'feature',
    motionBlurVelocity: 'feature', motionBlurTileMax: 'feature', motionBlurNeighborMax: 'feature', motionBlur: 'feature',
    objectVelocity: 'feature', objectVelocitySkinned: 'feature', objectVelocityBasicSkinned: 'feature',
    decalSurface: 'feature', decalResolve: 'feature', decalColor: 'feature',
    particleSim: 'feature', particleBillboard: 'feature', particleMesh: 'feature', particleSort: 'feature',
    basicInstanced: 'editor', probePreview: 'editor', overlayComposite: 'editor', debugView: 'editor',
    shadowDebug: 'editor', overdraw: 'editor', grid: 'editor', outline: 'editor', outlinePost: 'editor',
};

/** What a game uses, accumulated over every scene and template. Logical names, plus the filter. */
export interface ProgramUsage {
    /** Logical program names (`pbrPom`, `cel`, `particleSim~s9`...). */
    readonly names: Set<string>;
    /** Shadow filters any of the game's render settings select. */
    readonly filters: Set<ShadowFilter>;
}

export function createProgramUsage(): ProgramUsage {
    return { names: new Set(), filters: new Set() };
}

const FORWARD: Record<string, string> = { basic: 'basic', blinn_phong: 'blinn_phong', pbr: 'pbr', cel: 'cel' };

/** The material JSONs a serialized model carries (single or per-submesh). */
function materialsOf(model: any): any[] {
    const out: any[] = [];
    if (model?.material) out.push(model.material);
    if (Array.isArray(model?.materials)) out.push(...model.materials);
    return out;
}

/** The serialized form of the parallax test in `usesParallax` (programVariants.ts). */
function marches(m: any): boolean {
    return m?.type === 'pbr' && !!m.textures?.displacementMap && m.uvProjection !== 'triplanar';
}

/** Add the programs one serialized model can draw with: forward and G-buffer, static or skinned. */
function addModel(model: any, use: ProgramUsage, shadows: boolean): void {
    const skinned = !!model?.skin;
    const mats = materialsOf(model);
    const pom = mats.some(marches) ? 'Pom' : '';
    const add = (n: string) => use.names.add(n);
    for (const m of mats) {
        const type: string = typeof m?.type === 'string' ? m.type : 'pbr';
        const cutout = (m?.alphaCutoff ?? 0) > 0 || !!m?.textures?.maskMap;
        if (m?.terrainMaterial || type === 'terrain') { add('terrain'); add('terrainGeometry'); continue; }
        if (m?.customMaterial || type.startsWith('custom')) {
            // Compiled at runtime from its own source; the stand-ins it falls back to are the PBR pair.
            add(skinned ? 'pbrSkinned' : 'pbr'); add(skinned ? 'pbrGeometrySkinned' : 'pbrGeometry');
            continue;
        }
        const base = FORWARD[type] ?? 'pbr';
        // Forward (transparent, cel, blinn-phong, the forward path, probe captures) and deferred both:
        // which one a material takes depends on runtime state the JSON does not pin down.
        add(base + (skinned ? 'Skinned' : '') + (base === 'pbr' ? pom : ''));
        if (base === 'pbr' || base === 'blinn_phong' || base === 'basic') {
            add(`${base}Geometry${skinned ? 'Skinned' : ''}${base === 'pbr' ? pom : ''}`);
            if (!skinned && base !== 'basic') add(`${base}GeometryInstanced${base === 'pbr' ? pom : ''}`);
        }
        if (shadows) {
            if (base === 'basic') add(cutout ? (skinned ? 'shadowMapBasicSkinnedCutout' : 'shadowMapBasicCutout') : skinned ? 'shadowMapSkinned' : 'shadowMap');
            else add(cutout ? (skinned ? 'shadowMapSkinnedCutout' : 'shadowMapCutout') : skinned ? 'shadowMapSkinned' : 'shadowMap');
            if (!skinned) add(cutout ? 'shadowMapInstancedCutout' : 'shadowMapInstanced');
        }
        add(skinned ? (base === 'basic' ? 'objectVelocityBasicSkinned' : 'objectVelocitySkinned') : 'objectVelocity');
    }
}

/** Add the simulation and draw programs of one serialized particle system. */
function addParticles(payload: any, use: ProgramUsage): void {
    use.names.add('particleBillboard'); use.names.add('particleMesh'); use.names.add('particleSort');
    let defs;
    try {
        defs = resolveSubEmitters(parseParticleSystem(payload?.system ?? payload ?? {}).emitters);
    } catch {
        use.names.add('particleSim');
        return;
    }
    defs.defs.forEach((def, i) => {
        try {
            const packed = packEmitter(def);
            use.names.add(packed.custom ? 'particleSim' : particleSimProgram(simStripMask(packed.simMask, !!defs.links[i])));
        } catch {
            use.names.add('particleSim');
        }
    });
}

/**
 * Accumulate what one serialized subtree uses — a scene root or a template node. `shadows`: whether any
 * light in the game casts them (a scene's lights decide for its models; pass true when unsure).
 */
export function usageFromSceneJson(node: any, use: ProgramUsage, shadows = true): void {
    if (!node || typeof node !== 'object') return;
    const add = (n: string) => use.names.add(n);
    switch (node.type) {
        case 'model': addModel(node.model, use, shadows); break;
        case 'sprite':
        case 'animatedSprite': {
            const type = node.sprite?.material?.type;
            add(FORWARD[type] ?? 'basic');
            if (type === 'pbr' || type === 'blinn_phong') add(`${type}Geometry`);
            break;
        }
        case 'landscape':
            for (const n of ['terrain', 'terrainGeometry', 'foliageBillboardInstanced', 'blinn_phongGeometryInstanced',
                             'pbrGeometryInstanced', 'shadowMapInstanced', 'shadowMapInstancedCutout']) add(n);
            break;
        case 'tilemap': add('tilemap'); break;
        case 'decal': add('decalSurface'); add('decalResolve'); add('decalColor'); break;
        case 'volumetricClouds':
            for (const n of ['volumetricClouds', 'cloudNoiseBake', 'cloudTemporalResolve', 'cloudUpsample']) add(n);
            break;
        case 'skyAtmosphere': {
            add('skyAtmosphere'); add('skyProject');
            const a = node.atmosphere ?? {};
            if (a.fogEnabled !== false) add('skyFog');
            if (a.godRaysEnabled !== false) add('godRays');
            break;
        }
        // A probe captures the scene through the forward programs, terrain included.
        case 'lightProbe': add('terrainForward'); break;
        case 'particleSystem': addParticles(node.particleSystem, use); break;
    }
    for (const child of Array.isArray(node.children) ? node.children : []) usageFromSceneJson(child, use, shadows);
}

/** Whether any light in the subtree casts shadows. */
export function castsShadows(node: any): boolean {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'light' && node.castShadows) return true;
    return (Array.isArray(node.children) ? node.children : []).some(castsShadows);
}

/**
 * Accumulate what one render-settings object switches on. Applied as the renderer applies it: the
 * quality tier first, explicit keys over it; and anything neither states counts as ON.
 */
export function usageFromRenderSettings(settings: Partial<RenderSettings> | null | undefined, use: ProgramUsage): void {
    const s = settings ?? {};
    const tier = s.quality && s.quality !== 'custom' ? QUALITY_TIERS[s.quality as Exclude<QualityPreset, 'custom'>] : undefined;
    const on = (key: keyof RenderSettings, tierKey?: string): boolean => {
        const v = s[key] ?? (tierKey && tier ? (tier as unknown as Record<string, unknown>)[tierKey] : undefined);
        return v === undefined ? true : !!v;
    };
    const positive = (key: keyof RenderSettings): boolean => {
        const v = s[key];
        return v === undefined || (typeof v === 'number' && v > 0);
    };
    const add = (...names: string[]) => names.forEach(n => use.names.add(n));
    const filter = (s.shadowFilterMode ?? (tier as { shadowFilterMode?: number } | undefined)?.shadowFilterMode ?? 0) === 1 ? 1 : 0;
    use.filters.add(filter);
    if (on('bloomEnabled', 'bloomEnabled')) add('bloom', 'bloomDownsample', 'bloomUpsample');
    if (on('ssaoEnabled', 'ssaoEnabled')) add('ssao', 'ssaoBlur');
    if (on('autoExposureEnabled')) add('exposureMeter');
    if (on('dofEnabled')) add('dofCoc', 'dofGather', 'dofComposite');
    if (positive('lensFlareIntensity')) add('lensFlare', 'lensFlareComposite');
    if (positive('chromaticAberrationStrength')) add('chromaticAberration');
    if (positive('vignetteStrength')) add('vignette');
    if (positive('filmGrainIntensity')) add('filmGrain');
    const taa = on('taaEnabled', 'taaEnabled');
    const blur = on('motionBlurEnabled', 'motionBlurEnabled');
    if (taa) add('taaResolve');
    if (taa || blur) add('motionBlurVelocity');
    if (blur) add('motionBlurTileMax', 'motionBlurNeighborMax', 'motionBlur');
}

/** Logical names the velocity pass needs only when TAA or motion blur runs. */
const VELOCITY = ['objectVelocity', 'objectVelocitySkinned', 'objectVelocityBasicSkinned'];

/**
 * The physical program list for `use`, in no particular order (the renderer builds in table order).
 * Each filter-dependent name contributes the variant of every filter the settings select, so a game
 * whose scenes disagree on the filter still has both ready.
 */
export function programsFor(use: ProgramUsage): string[] {
    const names = new Set(use.names);
    for (const [name, cls] of Object.entries(PROGRAM_CLASS)) if (cls === 'core') names.add(name);
    if (!names.has('motionBlurVelocity')) for (const v of VELOCITY) names.delete(v);
    const filters = use.filters.size ? [...use.filters] : [0 as ShadowFilter];
    const out = new Set<string>();
    for (const name of names) {
        if (PROGRAM_CLASS[name] === 'editor') continue;
        for (const filter of filters) out.add(physicalFor(name, filter));
    }
    return [...out].sort();
}

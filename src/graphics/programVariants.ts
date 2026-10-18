// Program variants: which build-time variant of a program the renderer actually binds.
//
// A program family's WGSL declares variants (`// @variant <tag> NAME=VAL` lines, see
// tools/shaderIncludes.mjs), each the same source with code compiled out: one shadow filter instead of
// a runtime branch over both, the parallax march only where a material uses it, particle modules an
// emitter does not have. The import carries them under `variants[tag]`.
//
// Call sites keep asking for LOGICAL names — 'pbr', 'pbrPom', 'deferredLighting' — and ShaderManager
// registers each logical name as an alias of the PHYSICAL program behind it, so nothing that binds or
// writes uniforms has to know variants exist. A physical name is `<table name>~<tag>`; '~' never
// appears in a program-table name.
//
// Variants are only used where the program set is planned up front (a published game, which knows its
// shadow filter and materials) or when asked for explicitly. The editor builds the base programs, whose
// runtime branches cover every setting it can toggle without a recompile — with ONE exception: the
// parallax march is never compiled into a base program, because the march writes frag_depth and that
// costs early-Z for every draw of the program. So the `Pom` names below mean their `pom` variant
// everywhere, the editor included (see Renderer._physicalOf).

/** The shadow filter a variant compiles in: 0 = 3x3 PCF, 1 = rotated Poisson. */
export type ShadowFilter = 0 | 1;

interface Rule {
    /** The program-table entry whose import declares the variants. */
    readonly base: string;
    readonly tag: (filter: ShadowFilter) => string;
}

const FILTER_TAG = (f: ShadowFilter) => f === 1 ? 'poisson' : 'pcf';
const filtered = (base: string): Rule => ({ base, tag: FILTER_TAG });
const filteredPom = (base: string): Rule => ({ base, tag: f => FILTER_TAG(f) + '.pom' });
const fixed = (base: string, tag: string): Rule => ({ base, tag: () => tag });

/** Every logical name that resolves to a variant, by name. */
const RULES: Readonly<Record<string, Rule>> = {
    pbr: filtered('pbr'),
    pbrPom: filteredPom('pbr'),
    pbrSkinned: filtered('pbrSkinned'),
    pbrSkinnedPom: filteredPom('pbrSkinned'),
    blinn_phong: filtered('blinn_phong'),
    blinn_phongSkinned: filtered('blinn_phongSkinned'),
    cel: filtered('cel'),
    celSkinned: filtered('celSkinned'),
    deferredLighting: filtered('deferredLighting'),
    pbrGeometry: fixed('pbrGeometry', 'flat'),
    pbrGeometryPom: fixed('pbrGeometry', 'pom'),
    pbrGeometrySkinned: fixed('pbrGeometrySkinned', 'flat'),
    pbrGeometrySkinnedPom: fixed('pbrGeometrySkinned', 'pom'),
    pbrGeometryInstanced: fixed('pbrGeometryInstanced', 'flat'),
    pbrGeometryInstancedPom: fixed('pbrGeometryInstanced', 'pom'),
    // Foliage wind (chunks/foliageWind.wgsl): the instanced programs with the displacement compiled in.
    pbrGeometryInstancedWind: fixed('pbrGeometryInstanced', 'wind'),
    blinn_phongGeometryInstancedWind: fixed('blinn_phongGeometryInstanced', 'wind'),
    foliageBillboardInstancedWind: fixed('foliageBillboardInstanced', 'wind'),
    shadowMapInstancedWind: fixed('shadowMapInstanced', 'wind'),
    shadowMapInstancedCutoutWind: fixed('shadowMapInstancedCutout', 'wind'),
};

/**
 * Logical names that are not program-table entries, each mapped to the table entry whose import
 * declares its variant. These always resolve to the `pom` variant (with or without the variant
 * system), never to the base program — the base has the march compiled out.
 */
export const EXTRA_LOGICAL_NAMES: Readonly<Record<string, string>> = {
    pbrPom: 'pbr',
    pbrSkinnedPom: 'pbrSkinned',
    pbrGeometryPom: 'pbrGeometry',
    pbrGeometrySkinnedPom: 'pbrGeometrySkinned',
    pbrGeometryInstancedPom: 'pbrGeometryInstanced',
    // Wind names likewise always mean their `wind` variant: the base programs have it compiled out.
    pbrGeometryInstancedWind: 'pbrGeometryInstanced',
    blinn_phongGeometryInstancedWind: 'blinn_phongGeometryInstanced',
    foliageBillboardInstancedWind: 'foliageBillboardInstanced',
    shadowMapInstancedWind: 'shadowMapInstanced',
    shadowMapInstancedCutoutWind: 'shadowMapInstancedCutout',
};

/** Logical names whose program depends on the shadow filter. */
export const FILTER_DEPENDENT: readonly string[] = Object.keys(RULES).filter(n => RULES[n].tag(0) !== RULES[n].tag(1));

/** The physical program a logical name means under `filter`, or the name itself when it has no variants. */
export function physicalFor(logical: string, filter: ShadowFilter): string {
    const rule = RULES[logical];
    return rule ? `${rule.base}~${rule.tag(filter)}` : logical;
}

/** `[table name, tag]` of a physical name, or null for a plain program-table name. */
export function splitPhysical(name: string): readonly [string, string] | null {
    const at = name.indexOf('~');
    return at < 0 ? null : [name.slice(0, at), name.slice(at + 1)];
}

/** Every logical name that resolves to `physical` under `filter`, the physical name itself first. */
export function logicalNamesFor(physical: string, filter: ShadowFilter): string[] {
    return [physical, ...Object.keys(RULES).filter(n => physicalFor(n, filter) === physical)];
}

/** Every logical name with a variant rule. */
export function variantLogicalNames(): string[] { return Object.keys(RULES); }

/**
 * Whether any of `materials` runs the parallax march — the condition chunks/pbrForward.wgsl and
 * chunks/pbrGBuffer.wgsl test, read off the material's properties: a height map, and not triplanar
 * (uvProjection 2), which has no single surface to march. There is no on/off flag: the map being there
 * IS the request. Such a model draws with the `Pom` variant, which keeps that same test inside, so one
 * marching submesh is enough to choose it.
 */
export function usesParallax(materials: readonly { properties: Map<string, unknown> }[]): boolean {
    return materials.some(m => !!m.properties.get('hasDisplacementMap')
                               && m.properties.get('uvProjection') !== 2);
}

// --- Particle simulation ----------------------------------------------------------------------------

/** Bits of a particle strip mask: modules compiled out of `particleSim~s<mask>`. */
export const SIM_STRIP = { NOISE: 1, FIELDS: 2, COLLIDE: 4, SUB: 8 } as const;

/** The particle-simulation program for a strip mask: the full program at 0. */
export function particleSimProgram(stripMask: number): string {
    return PARTICLE_SIM_NAMES[stripMask] ?? 'particleSim';
}

/** Precomputed: asked for on every simulation step, where a template string would be garbage per step. */
const PARTICLE_SIM_NAMES: readonly string[] =
    Array.from({ length: 16 }, (_unused, mask) => mask > 0 ? `particleSim~s${mask}` : 'particleSim');

// The engine's vertex layouts as data, because a WebGPU pipeline is handed the whole layout up front
// and cannot recover it by reflecting a linked program. Pure functions — no context, no GL enums.

import type { VertexBufferLayout, VertexAttribute, VertexFormat } from './types';
import { vertexFormatSize } from './types';

/** One attribute of the standard interleaved model vertex, in the order `Geometry.getData()` emits. */
interface ModelAttribute {
    /** Canonical name, as the shaders declare it. */
    readonly name: string;
    /** Position in the interleaved buffer. Not a shader location — that is per-program. */
    readonly order: number;
    readonly format: VertexFormat;
    /** Alternative spellings accepted from reflected shader attributes. */
    readonly aliases: readonly string[];
}

/**
 * The canonical interleaved model vertex: position, normal, uv, tangent, bitangent. This ORDER is the
 * source of truth, never the shader's reflected enumeration, which is driver-dependent.
 */
export const MODEL_ATTRIBUTES: readonly ModelAttribute[] = [
    { name: 'a_position',  order: 0, format: 'float32x3', aliases: ['position'] },
    { name: 'a_normal',    order: 1, format: 'float32x3', aliases: ['normal'] },
    { name: 'a_texCoord',  order: 2, format: 'float32x2', aliases: ['texCoord', 'a_uv', 'uv'] },
    { name: 'a_tangent',   order: 3, format: 'float32x3', aliases: ['tangent'] },
    { name: 'a_bitangent', order: 4, format: 'float32x3', aliases: ['bitangent'] },
];

/** Every accepted spelling mapped to its canonical attribute. */
const BY_NAME: ReadonlyMap<string, ModelAttribute> = (() => {
    const map = new Map<string, ModelAttribute>();
    for (const attribute of MODEL_ATTRIBUTES) {
        map.set(attribute.name, attribute);
        for (const alias of attribute.aliases) map.set(alias, attribute);
    }
    return map;
})();

/** Whether `name` is one of the standard model attributes (under any accepted spelling). */
export function isModelAttribute(name: string): boolean { return BY_NAME.has(name); }

/** A shader attribute as `Shader` reflects it back from the linked program. */
export interface ReflectedAttribute {
    name: string;
    location: number;
}

/**
 * The full 14-float, 56-byte model vertex — what `createAnimated` writes. Locations follow canonical
 * order; a program that assigns them differently goes through {@link packedModelLayout}.
 */
export const MODEL_VERTEX_LAYOUT: VertexBufferLayout = buildLayout(
    MODEL_ATTRIBUTES.map((attribute, index) => ({ name: attribute.name, location: index })),
);

/**
 * The packed layout for whichever standard attributes a program declares — the stride is not constant,
 * a position-and-uv program packs to 20 bytes. Unknown names are dropped; survivors keep canonical order.
 */
export function packedModelLayout(attributes: readonly ReflectedAttribute[]): VertexBufferLayout {
    return buildLayout(attributes);
}

function buildLayout(attributes: readonly ReflectedAttribute[]): VertexBufferLayout {
    const known: { attribute: ModelAttribute; location: number }[] = [];
    // Keep the first of two spellings of one attribute, so the stride cannot double.
    const seen = new Set<string>();
    for (const reflected of attributes) {
        const attribute = BY_NAME.get(reflected.name);
        if (!attribute || seen.has(attribute.name)) continue;
        seen.add(attribute.name);
        known.push({ attribute, location: reflected.location });
    }
    known.sort((a, b) => a.attribute.order - b.attribute.order);

    const out: VertexAttribute[] = [];
    let offset = 0;
    for (const { attribute, location } of known) {
        out.push({ name: attribute.name, shaderLocation: location, offset, format: attribute.format });
        offset += vertexFormatSize(attribute.format);
    }
    return { arrayStride: offset, stepMode: 'vertex', attributes: out };
}

/**
 * The shared fullscreen quad: position then uv, 20 bytes. Returns a LIST so it can be empty — a stage
 * declaring no vertex attributes must get no layout, and WebGPU rejects a zero-stride one.
 */
export function screenQuadLayout(attributes: readonly ReflectedAttribute[]): VertexBufferLayout[] {
    const layout = buildLayout(attributes);
    return layout.attributes.length > 0 ? [layout] : [];
}

/**
 * Per-instance model matrix, spread across four consecutive slots — neither API has a mat4 vertex
 * format. `baseLocation` is 5 for every current caller, immediately after the five model attributes.
 */
export function instanceMatrixLayout(baseLocation: number = 5): VertexBufferLayout {
    const attributes: VertexAttribute[] = [];
    for (let row = 0; row < 4; row++) {
        attributes.push({
            name: `a_instanceMatrix${row}`,
            shaderLocation: baseLocation + row,
            offset: row * 16,
            format: 'float32x4',
        });
    }
    return { arrayStride: 64, stepMode: 'instance', attributes };
}

/**
 * Bone indices, in a buffer of their own. Integers, so they bind with `vertexAttribIPointer` rather
 * than the float path.
 */
export const BONE_INDEX_LAYOUT: VertexBufferLayout = {
    arrayStride: 16,
    stepMode: 'vertex',
    attributes: [{ name: 'a_boneIds', shaderLocation: 0, offset: 0, format: 'sint32x4' }],
};

export const BONE_WEIGHT_LAYOUT: VertexBufferLayout = {
    arrayStride: 16,
    stepMode: 'vertex',
    attributes: [{ name: 'a_weights', shaderLocation: 0, offset: 0, format: 'float32x4' }],
};

/**
 * The two bone layouts at the locations a program declares them, or null for a non-skinned program.
 * Locations are NOT fixed: the lit families use 5 and 6, the unlit Basic family 2 and 3.
 */
export function boneLayouts(attributes: readonly ReflectedAttribute[]): [VertexBufferLayout, VertexBufferLayout] | null {
    let indices = -1, weights = -1;
    for (const attribute of attributes) {
        if (attribute.name === 'a_boneIds') indices = attribute.location;
        else if (attribute.name === 'a_weights') weights = attribute.location;
    }
    if (indices < 0 || weights < 0) return null;
    return [
        { ...BONE_INDEX_LAYOUT, attributes: [{ ...BONE_INDEX_LAYOUT.attributes[0], shaderLocation: indices }] },
        { ...BONE_WEIGHT_LAYOUT, attributes: [{ ...BONE_WEIGHT_LAYOUT.attributes[0], shaderLocation: weights }] },
    ];
}

/**
 * The interleaved model vertex, read by a program that may declare only part of it. `builtWith` is the
 * program the BUFFER was packed for and owns the stride; `drawnBy` supplies only the shader locations.
 */
export function modelVertexLayout(drawnBy: readonly ReflectedAttribute[],
                                  builtWith?: readonly ReflectedAttribute[] | null): VertexBufferLayout {
    const base = builtWith ? packedModelLayout(builtWith) : MODEL_VERTEX_LAYOUT;
    // Reflected names vary in spelling (`uv` vs `a_texCoord`); match through the canonical table.
    const declared = new Map<string, number>();
    for (const attribute of drawnBy) {
        const canonical = BY_NAME.get(attribute.name);
        if (canonical) declared.set(canonical.name, attribute.location);
    }
    return {
        ...base,
        attributes: base.attributes
            .filter(a => declared.has(a.name))
            .map(a => ({ ...a, shaderLocation: declared.get(a.name) as number })),
    };
}

/**
 * The tilemap chunk vertex: position.xy | uv.xy | colour.rgba, 32-byte stride. Locations are fixed
 * here rather than reflected, matching the explicit `layout(location = ...)` in tilemap.vs.
 */
export const TILE_VERTEX_LAYOUT: VertexBufferLayout = {
    arrayStride: 32,
    stepMode: 'vertex',
    attributes: [
        { name: 'a_position', shaderLocation: 0, offset: 0,  format: 'float32x2' },
        { name: 'a_uv',       shaderLocation: 1, offset: 8,  format: 'float32x2' },
        { name: 'a_color',    shaderLocation: 2, offset: 16, format: 'float32x4' },
    ],
};

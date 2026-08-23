/**
 * The engine's vertex layouts, written down.
 *
 * These were previously three separate encodings of the same fact, none of which named it: a
 * `_CANON_ATTR` table of names to sizes in `Mesh`, a hand-rolled `offsets` map with the 56-byte stride
 * spelled out as `14 * floatSize` in `initializeAnimatedVAO`, and the shader's own `layout(location=)`
 * declarations. A WebGPU pipeline has to be handed the whole layout up front — it cannot recover it by
 * reflecting a linked program the way WebGL2's `getActiveAttrib` does — so the layout has to exist as
 * data before there is a second backend to hand it to.
 *
 * Pure data and pure functions. No context, no GL enums (those live in `webgl2/glEnums.ts`), so the
 * offset and stride arithmetic that used to be inline in the middle of GL calls is now reachable from
 * the DOM-free test suite.
 */

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
 * The canonical interleaved model vertex: position, normal, uv, tangent, bitangent.
 *
 * This order is the single source of truth — deliberately NOT the shader's reflected attribute
 * enumeration, whose order is driver- and program-dependent and would otherwise scramble the buffer
 * differently for, say, the `default` and `pbr` programs over the same mesh.
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
 * The full 14-float, 56-byte model vertex, with every attribute present.
 *
 * What `createAnimated` writes and what the skinned vertex shaders read. Shader locations are the
 * canonical order here; a program that assigns them differently is handled by
 * {@link packedModelLayout}, which takes the reflected locations instead.
 */
export const MODEL_VERTEX_LAYOUT: VertexBufferLayout = buildLayout(
    MODEL_ATTRIBUTES.map((attribute, index) => ({ name: attribute.name, location: index })),
);

/**
 * The packed layout for whichever standard attributes a program actually declares.
 *
 * The non-animated path interleaves only the attributes present, so the stride is not a constant: a
 * position-and-uv program packs to 20 bytes, not 56. Unknown names are dropped — the caller keeps
 * handling those through the reflected fallback — and the survivors are laid out in canonical order
 * regardless of the order they were reflected in.
 */
export function packedModelLayout(attributes: readonly ReflectedAttribute[]): VertexBufferLayout {
    return buildLayout(attributes);
}

function buildLayout(attributes: readonly ReflectedAttribute[]): VertexBufferLayout {
    const known: { attribute: ModelAttribute; location: number }[] = [];
    // A program may declare the same attribute under two spellings only by mistake; keep the first so
    // the stride cannot double behind the caller's back.
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
 * Per-instance model matrix: a mat4 spread across four consecutive attribute slots.
 *
 * Neither API has a mat4 vertex format — both consume one as four vec4s — so the four-slot expansion
 * is not an implementation detail that can be hidden. `baseLocation` is 5 for every current caller,
 * immediately after the five model attributes.
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
 * Bone indices and weights, each in a buffer of its own rather than interleaved with the model vertex.
 *
 * They are separate because `createAnimated` receives them as separate arrays from the importers, and
 * because the indices are integers — bound with `vertexAttribIPointer`, not the float path. Packing
 * them into the main vertex is the obvious optimisation once the layout is explicit; it is not a
 * change this milestone makes.
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
 * The two bone layouts, at the locations a particular program declares them.
 *
 * The locations are NOT fixed, which is the whole reason this is a function. The lit skinned families
 * put bone data at 5 and 6, after normal/uv/tangent/bitangent; the unlit Basic family has none of those
 * and uses 2 and 3. Binding one family's buffers at the other's locations leaves the attributes unbound
 * — GL_INVALID_OPERATION on the draw, and the reason `AnimatedModel` keys its VAO by layout.
 *
 * Returns null when the program declares no bone attributes, which is every non-skinned program.
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
 * The interleaved model vertex, read by a program that may declare only part of it.
 *
 * Distinct from {@link packedModelLayout}, and the difference is a trap. `packedModelLayout` computes a
 * TIGHT stride from the attributes a program declares, which is correct only when the buffer was
 * written for exactly that program. Model meshes are not: `ModelNode.initializeModel` writes every one
 * of them with the full five-attribute vertex, 56 bytes, whatever draws it later.
 *
 * So a depth-only program that declares just `position` needs offsets from the FULL layout and a stride
 * of 56 — `packedModelLayout` would give it a stride of 12 and walk into the middle of the first
 * vertex's normal. That renders as geometry the right shape in roughly the right place, which is what
 * makes it worth naming: the shadow pass looked plausible and the shading signature caught it.
 *
 * Locations come from the DRAWING program; offsets and stride from the layout the buffer was built to.
 */
export function modelVertexLayout(attributes: readonly ReflectedAttribute[]): VertexBufferLayout {
    const declared = new Map<string, number>();
    for (const attribute of attributes) declared.set(attribute.name, attribute.location);
    return {
        ...MODEL_VERTEX_LAYOUT,
        attributes: MODEL_VERTEX_LAYOUT.attributes
            .filter(a => declared.has(a.name))
            .map(a => ({ ...a, shaderLocation: declared.get(a.name) as number })),
    };
}

/**
 * The tilemap chunk vertex: position.xy | uv.xy | colour.rgba, 8 floats and a 32-byte stride.
 *
 * Genuinely different from the model vertex, and deliberately so — per-cell tint and opacity need a
 * colour attribute, and smuggling it through the normal slot would work today and be a trap forever.
 * What it does NOT need is its own copy of the attribute-binding code, which is what it had.
 *
 * Locations are fixed here rather than reflected, matching the explicit `layout(location = ...)` in
 * shaders/materials/tilemap.vs.
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

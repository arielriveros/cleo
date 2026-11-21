// The engine nodes' properties, declared with the same types a script's fields have (src/core/properties/types.ts):
//
//   declareProperties(VolumetricFogNode, 'Volumetric Fog', [
//     { title: '', props: [
//       { key: 'enabled', type: Boolean, divider: true },
//       { key: 'size', type: Vec3, min: MIN_FOG_VOLUME_SIZE, step: 0.5 },
//       { key: 'albedo', type: Color },
//       { key: 'anisotropy', type: Number, min: -0.9, max: 0.9, step: 0.01 },
//     ] },
//   ])
//
// The editor generates the node's inspector rows from them (features/properties/DeclaredSections.tsx), through
// the one editor of each type that a script's attribute uses too (PropertyField): a colour reads the same on a
// light, a fog and a script. A declaration carries no prose: a row's tooltip is the docs row of its label
// (docs/editor/node-inspector.md), as every inspector row's is. Setters keep their own invariants (a clamp, a
// cone that must stay wider than another), so a row needs no code of the card's.
//
// Part of the full engine only (src/cleo.ts): a published game never reads a declaration, and ships none.

import { typeOfToken, type AssetFieldKind, type PropertyTokenLike, type PropertyType } from '../core/properties/types';
import { isAssetRef, isNodePathRef } from '../core/properties/fieldRefs';
import { nodeAtRelativePath, relativeNodePath } from '../core/save/nodePaths';

/** One property of a node class, as the inspector shows it. */
export interface PropertyDeclaration<N = any> {
    /** The property: a key on the node (`density`), or a dotted path through it (`light.intensity`). */
    key: string;
    type: PropertyTokenLike;
    /** The row's label (what its docs row is found by); the key in words by default (`blendDistance`: Blend Distance). */
    label?: string | ((node: N) => string);
    /** A number's range (a slider when both are set) and step; each may depend on the node. */
    min?: number | ((node: N) => number);
    max?: number | ((node: N) => number);
    step?: number | ((node: N) => number);
    /** Shown, not edited. */
    readonly?: boolean;
    /** A string edited in a text area. */
    multiline?: boolean;
    /** How a slider shows its number (a moon phase as New / Crescent / …); two decimals by default. */
    readout?: (value: number) => string;
    /** Shown only while this holds (a spot light's cone, an area light's shape). */
    when?: (node: N) => boolean;
    /** How to read and write it, when it is not a plain property at `key`. */
    get?: (node: N) => unknown;
    set?: (node: N, value: unknown) => void;
    /** A thin rule under the row, ending a group of rows. */
    divider?: boolean;
    /** For a node property: which nodes it may name (not the node itself, nor what is under it, for a rig). */
    accepts?: (node: N, candidate: any) => boolean;
}

/** A titled group of rows (an empty title: rows straight in the card). */
export interface SectionDeclaration<N = any> {
    title: string;
    props: PropertyDeclaration<N>[];
    when?: (node: N) => boolean;
}

/** What a node class declares: its inspector card's title, and its sections. */
export interface ClassDeclaration<N = any> {
    title: string;
    /** What a change of these properties is to the scene (`SCENE_CHANGED` kind): 'light', 'environment', … */
    kind: string;
    /** The docs page whose section titled like the card holds its rows (editor/node-inspector by default). */
    docs: string;
    sections: SectionDeclaration<N>[];
}

/** How a class's declaration is filed: what a change is to the scene, and where its rows are documented. */
export interface DeclarationOptions {
    kind?: string;
    docs?: string;
}

/** A declared property with its type read, and its label and range settled for one node. */
export type DeclaredProperty<N = any> = Omit<PropertyDeclaration<N>, 'type' | 'label' | 'min' | 'max' | 'step'> & {
    type: PropertyType; label: string; min?: number; max?: number; step?: number;
};

const declared = new Map<Function, ClassDeclaration>();

/**
 * Declare the inspector properties of the nodes of `Class` (and of its subclasses that declare none). `options` is
 * the change's kind ('component' by default) or `{ kind, docs }`.
 */
export function declareProperties<N>(Class: abstract new (...args: any[]) => N, title: string, sections: SectionDeclaration<N>[],
                                     options: string | DeclarationOptions = {}): void {
    for (const s of sections) for (const p of s.props)
        if (!typeOfToken(p.type)) throw new TypeError(`${Class.name}.${p.key}: not a property type`);
    const o = typeof options === 'string' ? { kind: options } : options;
    declared.set(Class, { title, kind: o.kind ?? 'component', docs: o.docs ?? 'editor/node-inspector', sections });
}

/**
 * What the nearest class of `node` that declares its properties declares, or null. With `Class`, that class's own
 * declaration: a node can show the card of a class it extends too (a parallax layer is a sprite).
 */
export function declarationOf(node: object | null | undefined, Class?: Function): ClassDeclaration | null {
    if (Class) return declared.get(Class) ?? null;
    for (let proto = node ? Object.getPrototypeOf(node) : null; proto; proto = Object.getPrototypeOf(proto)) {
        const found = declared.get(proto.constructor);
        if (found) return found;
    }
    return null;
}

/** Every class that declares its properties, with its declaration. */
export function declaredClasses(): ReadonlyMap<Function, ClassDeclaration> {
    return declared;
}

/** `blendDistance` (or `light.blendDistance`) in words: Blend Distance. */
export function labelOfKey(key: string): string {
    const last = key.slice(key.lastIndexOf('.') + 1);
    return last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

/** A declaration with its type read and its label and range settled for `node`. */
export function resolveProperty<N>(decl: PropertyDeclaration<N>, node: N): DeclaredProperty<N> {
    const label = typeof decl.label === 'function' ? decl.label(node) : decl.label ?? labelOfKey(decl.key);
    const num = (v: number | ((n: N) => number) | undefined) => (typeof v === 'function' ? v(node) : v);
    return { ...decl, type: typeOfToken(decl.type)!, label, min: num(decl.min), max: num(decl.max), step: num(decl.step) };
}

/**
 * How a property that keeps an asset's ID (a sky's night texture, `nightSkyTexture: string | null`) is edited as
 * that asset: the editors hand assets as `{ $asset, id }`, as a script's asset field stores them.
 */
export function assetIdAccess<N>(kind: AssetFieldKind, key: string): Pick<PropertyDeclaration<N>, 'get' | 'set'> {
    return {
        get: (n: any) => (typeof n[key] === 'string' && n[key] ? { $asset: kind, id: n[key] } : null),
        set: (n: any, v: unknown) => { n[key] = isAssetRef(v) ? v.id : null; },
    };
}

/**
 * How a property that keeps another node's ID (a camera's focus target, `focusTargetId`) is edited as that node:
 * the editors hand nodes as the path to them from `node` (`{ $nodePath }`), as a script's node field stores them.
 */
export function nodeIdAccess<N>(key: string): Pick<PropertyDeclaration<N>, 'get' | 'set'> {
    return {
        get: (n: any) => {
            const target = typeof n[key] === 'string' && n[key] ? n.scene?.getNodeById?.(n[key]) : null;
            const path = target ? relativeNodePath(n, target) : null;
            return path ? { $nodePath: path } : null;
        },
        set: (n: any, v: unknown) => {
            const target = isNodePathRef(v) ? nodeAtRelativePath(n, v.$nodePath) : null;
            n[key] = target ? target.id : null;
        },
    };
}

/** How a number kept as one of a few values (a resolution: 64, 128, …) is edited as a Choice of their names. */
export function numberChoiceAccess<N>(key: string): Pick<PropertyDeclaration<N>, 'get' | 'set'> {
    return { get: (n: any) => String(n[key]), set: (n: any, v: unknown) => { n[key] = Number(v); } };
}

function owner(node: any, key: string): [any, string] {
    const parts = key.split('.');
    let at = node;
    for (let i = 0; i < parts.length - 1; i++) at = at?.[parts[i]];
    return [at, parts[parts.length - 1]];
}

/** The property's value on `node`. */
export function readProperty<N>(node: N, decl: PropertyDeclaration<N>): unknown {
    if (decl.get) return decl.get(node);
    const [at, last] = owner(node, decl.key);
    return at?.[last];
}

/** Set the property on `node`. A vector or a colour is handed over as a new array. */
export function writeProperty<N>(node: N, decl: PropertyDeclaration<N>, value: unknown): void {
    const v = Array.isArray(value) ? [...value] : value;
    if (decl.set) { decl.set(node, v); return; }
    const [at, last] = owner(node, decl.key);
    if (at) at[last] = v;
}

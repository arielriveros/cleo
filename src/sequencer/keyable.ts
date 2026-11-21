/**
 * What a sequence can key on a node: every property path a property track can drive, with its current value.
 *
 * The editor's Sequencer mode keys a node by diffing this list across an edit (any inspector field, a gizmo
 * drag), so it has to cover what the inspector edits: the transform, authored visibility, every accessor with
 * a setter, one level into getter-only objects (`light.intensity`, `camera.fov`), plain public fields (a class
 * script's fields live there), a model's material properties and the node's custom variables.
 *
 * Values are plain and unrounded: a number, a boolean, a short string, or a numeric vector (a colour is a
 * vector). Anything else — objects, long strings, buffers — is not keyable and is left out, as are identity,
 * structure, asset links and per-frame runtime readouts.
 *
 * The walk mirrors the editor agent bridge's `settableProps` (features/agentBridge/inspect.ts), which rounds
 * for display and caps its output; this one does neither.
 *
 * What the node's classes declare for the inspector (src/properties) names its rows: a declared row whose key
 * is a property path is keyable (one a walk would miss, two levels down, included), and carries the row's
 * label and type, so a colour is a colour and a track reads as the inspector names it. In a published game
 * nothing is declared, and the walk alone answers.
 */

import type { PropertyValueType } from './types';
import type { PropertyType } from '../core/properties/types';
import { declarationsOf, labelOfKey, resolveProperty, type ClassDeclaration } from '../properties/declare';

export interface KeyableProperty {
    /** A property path `compilePropertyPath` resolves on the node. */
    path: string;
    valueType: PropertyValueType;
    value: number | number[] | boolean | string;
    /** Its inspector row's name, when its class declares one: `Light › Intensity (lm)`. */
    label?: string;
    /** Its declared type: a colour, a vector, a choice, ... */
    type?: PropertyType;
}

/** Identity, structure, the transform's other spellings, editor bookkeeping and per-frame readouts. */
const SKIP = new Set([
    'constructor', 'parent', 'children', 'name', 'id', 'nodeType', 'position', 'rotation', 'scale', 'visible',
    'authoredVisible', 'quaternion', 'worldPosition', 'worldRotation', 'worldScale', 'worldQuaternion',
    'worldTransform', 'localTransform', 'matrix', 'scene', 'body', 'trigger', 'velocity', 'onUpdate', 'onStart',
    'script', 'variables', 'editorOnly', 'editorOwned', 'isEditorOwned', 'isGizmo', 'isTerrainChunk',
    'cameraVisible', 'cameraDistance', 'angularVelocity', 'movementDirection', 'markForRemoval',
    // A Sequence node's own data is edited in the Sequencer, never keyed by another sequence.
    'sequence', 'bindings', 'previewCuts', 'autoplay',
]);

/** Longest string worth keying (a UI label, an enum); a data URL or a script body is not. */
const MAX_STRING = 300;
/** Getter-only objects walked one level down list at most this many fields each. */
const NESTED_LIMIT = 48;

const isNumericArray = (v: unknown): v is ArrayLike<number> =>
    (ArrayBuffer.isView(v) && !(v instanceof DataView)) || (Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'number'));

/** An asset or node link (`materialId`, `uiTargetId`, `animationIds`): structure, not a value to animate. */
const isLinkKey = (key: string) => /Ids?$/.test(key);

function keyValue(v: unknown): { valueType: PropertyValueType; value: KeyableProperty['value'] } | undefined {
    if (typeof v === 'number') return Number.isFinite(v) ? { valueType: 'number', value: v } : undefined;
    if (typeof v === 'boolean') return { valueType: 'bool', value: v };
    if (typeof v === 'string') return v.length <= MAX_STRING && !v.startsWith('data:') ? { valueType: 'string', value: v } : undefined;
    if (isNumericArray(v) && v.length <= 16) return { valueType: 'vector', value: Array.from(v) };
    return undefined;
}

function hasChildrenField(v: object): boolean {
    return 'children' in v;
}

function walkObject(target: object, prefix: string, out: KeyableProperty[], seenPaths: Set<string>, nested: boolean, limit: number): void {
    const start = out.length;
    const push = (key: string, value: unknown) => {
        if (out.length - start >= limit) return;
        const path = prefix + key;
        if (seenPaths.has(path)) return;
        const kv = keyValue(value);
        if (!kv) return;
        seenPaths.add(path);
        out.push({ path, ...kv });
    };
    const seen = new Set<string>();
    // Accessors with a setter, from the most derived class up.
    for (let proto = Object.getPrototypeOf(target); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
            if (seen.has(key) || key.startsWith('_') || SKIP.has(key) || isLinkKey(key)) continue;
            seen.add(key);
            if (!d.get) continue;
            let value: unknown;
            try { value = (target as any)[key]; } catch { continue; }
            if (d.set) { push(key, value); continue; }
            // A getter-only object (LightNode.light, CameraNode.camera): its own settable fields, one level down.
            if (nested && value && typeof value === 'object' && !ArrayBuffer.isView(value) && !Array.isArray(value)
                && !(value instanceof Map) && !(value instanceof Set) && !hasChildrenField(value as object)) {
                walkObject(value as object, `${prefix}${key}.`, out, seenPaths, false, NESTED_LIMIT);
            }
        }
    }
    // Plain public fields, a class script's native fields among them.
    for (const key of Object.keys(target)) {
        if (seen.has(key) || key.startsWith('_') || SKIP.has(key) || isLinkKey(key)) continue;
        const value = (target as any)[key];
        if (typeof value === 'function') continue;
        push(key, value);
    }
}

/** A material's own uniforms (`properties`, a Map), as paths under `prefix`. */
function materialProperties(material: unknown, prefix: string, out: KeyableProperty[], seenPaths: Set<string>): void {
    const props = (material as any)?.properties;
    if (!(props instanceof Map)) return;
    for (const [k, v] of props) {
        if (typeof k !== 'string' || k.startsWith('_') || k.includes('.')) continue;
        const kv = keyValue(v);
        if (!kv || kv.valueType === 'string') continue;
        const path = `${prefix}${k}`;
        if (seenPaths.has(path)) continue;
        seenPaths.add(path);
        out.push({ path, ...kv });
    }
}

/** The value at a dotted property path, or undefined. */
function readPath(node: object, path: string): unknown {
    let at: any = node;
    for (const part of path.split('.')) at = at?.[part];
    return at;
}

/** A row's name for a track: its card, its section and its label (`Light › Shadows › Cast Shadows`). */
function rowLabel(decl: ClassDeclaration, section: string, label: string): string {
    return [decl.title, section, label].filter(Boolean).join(' › ');
}

/**
 * The declared rows of `node` that are property paths (not those read through a getter of their own), with
 * their names and types. A row whose key would not resolve on the node is left out.
 */
function declaredPaths(node: object): Map<string, { label: string; type: PropertyType }> {
    const out = new Map<string, { label: string; type: PropertyType }>();
    for (const decl of declarationsOf(node)) for (const section of decl.sections) for (const p of section.props) {
        if (p.get || p.readonly || out.has(p.key)) continue;
        let resolved;
        try { resolved = resolveProperty(p, node as any); } catch { continue; }
        out.set(p.key, { label: rowLabel(decl, section.title, resolved.label || labelOfKey(p.key)), type: resolved.type });
    }
    return out;
}

/** Every property of `node` a sequence can key, with its current value. Stable order: transform first. */
export function keyableProperties(node: object): KeyableProperty[] {
    const out: KeyableProperty[] = [];
    const seenPaths = new Set<string>();
    const n = node as any;
    for (const key of ['position', 'rotation', 'scale'] as const) {
        const kv = keyValue(n[key]);
        if (kv) { out.push({ path: key, ...kv }); seenPaths.add(key); }
    }
    if (typeof n.authoredVisible === 'boolean') { out.push({ path: 'visible', valueType: 'bool', value: n.authoredVisible }); seenPaths.add('visible'); }

    walkObject(node, '', out, seenPaths, true, Number.POSITIVE_INFINITY);

    // The declared rows: named and typed where the walk found them, and added where it did not.
    const declared = declaredPaths(node);
    for (const p of out) {
        const d = declared.get(p.path);
        if (d) { p.label = d.label; p.type = d.type; }
    }
    for (const [path, d] of declared) {
        if (seenPaths.has(path) || SKIP.has(path)) continue;
        const kv = keyValue(readPath(node, path));
        if (!kv) continue;
        seenPaths.add(path);
        out.push({ path, ...kv, label: d.label, type: d.type });
    }

    // A model's materials: the first as `model.material`, the path the Valley's pond key uses; the rest by slot.
    const materials: unknown[] | undefined = Array.isArray(n.model?.materials) ? n.model.materials : undefined;
    if (materials) {
        materials.forEach((m, i) => materialProperties(m, i === 0 ? 'model.material.properties.' : `model.materials.${i}.properties.`, out, seenPaths));
    }

    // Custom variables: the value of each, by name.
    if (n.variables instanceof Map) {
        for (const [name, variable] of n.variables as Map<string, { value: unknown }>) {
            if (typeof name !== 'string' || name.startsWith('_') || name.includes('.')) continue;
            const kv = keyValue(variable?.value);
            if (!kv) continue;
            const path = `variables.${name}.value`;
            if (seenPaths.has(path)) continue;
            seenPaths.add(path);
            out.push({ path, ...kv });
        }
    }
    return out;
}

/** Whether two key values are the same (vectors component-wise, within `eps` for numbers). */
export function sameKeyValue(a: unknown, b: unknown, eps = 1e-6): boolean {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= eps;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!(Math.abs(a[i] - b[i]) <= eps)) return false;
        return true;
    }
    return a === b;
}

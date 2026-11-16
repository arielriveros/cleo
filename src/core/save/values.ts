// Turning a script's values into what a save document can hold, and back. JSON only: numbers, strings,
// booleans, null, arrays and plain objects pass through; two shapes are encoded on the way —
//   { $ta: 'Float32Array', v: [...] }   a typed array (a gl-matrix vec3 is one)
//   { $node: id, path }                 another node, found again by id, else by its name path
// Anything else (a function, a Map, a class instance, NaN) is left out with one warning naming where it was.

import { Node } from '../scene/nodes/node';

/** What {@link encodeSaveValue} returns for a value a save cannot hold. */
export const UNSAVEABLE: unique symbol = Symbol('unsaveable');

const TYPED_ARRAYS: Record<string, new (values: number[]) => ArrayLike<number>> = {
    Float32Array, Float64Array, Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array,
    Uint8ClampedArray,
};

/** Where a value was, for the warning; and how a node is named (its id and path). */
export interface EncodeContext {
    warn(where: string, why: string): void;
    pathOf(node: Node): string | null;
}

function isPlainObject(value: object): boolean {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * The JSON form of `value`, or {@link UNSAVEABLE}. An unsaveable value inside an array or object is
 * dropped from it (an array keeps its other entries in order), not the whole value.
 */
export function encodeSaveValue(value: unknown, where: string, ctx: EncodeContext, seen: Set<object> = new Set()): unknown {
    if (value === null) return null;
    switch (typeof value) {
        case 'string':
        case 'boolean':
            return value;
        case 'number':
            if (Number.isFinite(value)) return value;
            ctx.warn(where, `${value} is not a number a save can hold`);
            return UNSAVEABLE;
        case 'undefined':
            return UNSAVEABLE;   // an unset field: nothing to keep, and nothing to warn about
        case 'object':
            break;
        default:
            ctx.warn(where, `a ${typeof value} cannot be saved`);
            return UNSAVEABLE;
    }
    const obj = value as object;
    if (obj instanceof Node) return { $node: obj.id, path: ctx.pathOf(obj) };
    if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
        const name = obj.constructor?.name;
        if (name && TYPED_ARRAYS[name]) return { $ta: name, v: Array.from(obj as unknown as ArrayLike<number>) };
        ctx.warn(where, `a ${name ?? 'binary view'} cannot be saved`);
        return UNSAVEABLE;
    }
    if (seen.has(obj)) {
        ctx.warn(where, 'it refers back to itself');
        return UNSAVEABLE;
    }
    if (Array.isArray(obj)) {
        seen.add(obj);
        const out: unknown[] = [];
        obj.forEach((item, i) => {
            const enc = encodeSaveValue(item, `${where}[${i}]`, ctx, seen);
            if (enc !== UNSAVEABLE) out.push(enc);
        });
        seen.delete(obj);
        return out;
    }
    if (!isPlainObject(obj)) {
        ctx.warn(where, `a ${obj.constructor?.name ?? 'class instance'} cannot be saved (use plain objects and arrays)`);
        return UNSAVEABLE;
    }
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
        const enc = encodeSaveValue((obj as any)[key], `${where}.${key}`, ctx, seen);
        if (enc !== UNSAVEABLE) out[key] = enc;
    }
    seen.delete(obj);
    return out;
}

/** Whether an encoded value holds a node reference anywhere, which only resolves once the scene is built. */
export function holdsNodeRef(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(holdsNodeRef);
    if (typeof (value as any).$node === 'string') return true;
    return Object.values(value).some(holdsNodeRef);
}

/**
 * The live value for an encoded one. `findNode` resolves a `$node` (by id, then path); a node that is gone
 * reads as null. Without it, a `$node` stays as it is (the caller decodes it later).
 */
export function decodeSaveValue(value: unknown, findNode?: (id: string, path: string | null) => Node | null): unknown {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => decodeSaveValue(v, findNode));
    const obj = value as Record<string, any>;
    if (typeof obj.$node === 'string')
        return findNode ? findNode(obj.$node, typeof obj.path === 'string' ? obj.path : null) : obj;
    if (typeof obj.$ta === 'string' && Array.isArray(obj.v)) {
        const Ctor = TYPED_ARRAYS[obj.$ta];
        if (Ctor) return new Ctor(obj.v);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) out[key] = decodeSaveValue(obj[key], findNode);
    return out;
}

/**
 * A deep, JSON-only copy of a global's value: what `SaveGame.set` stores, so a script that keeps mutating
 * its own array afterwards does not change the save behind its back. Throws on what a save cannot hold —
 * a global is set on purpose, so a value that would silently vanish is a bug worth stopping at.
 */
export function cloneGlobal(key: string, value: unknown): unknown {
    let problem: string | null = null;
    const enc = encodeSaveValue(value, key, {
        warn: (where, why) => { problem ??= `${where}: ${why}`; },
        pathOf: () => null,
    });
    if (problem) throw new Error(`SaveGame.set('${key}'): ${problem}.`);
    if (enc !== UNSAVEABLE && holdsNodeRef(enc))
        throw new Error(`SaveGame.set('${key}'): a node cannot be a global (globals outlive scenes); save its name or id instead.`);
    return enc === UNSAVEABLE ? undefined : enc;
}

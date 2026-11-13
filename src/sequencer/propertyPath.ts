/**
 * Dotted property paths over live objects — `hour`, `camera.fov`, `light.intensity`, `opacity`,
 * `properties.waveStrength` — compiled once and then read and written every frame by a sequence.
 *
 * A segment walks an own property, an accessor anywhere up the prototype chain, an array index, or a
 * `Map` key (a material's `properties`). The transform has methods rather than plain setters on a node, so
 * `position`, `rotation` and `scale` route through `setPosition`/`setRotation`/`setScale`.
 *
 * Writes keep the current value's kind: a number stays a number, and a vector is copied component-wise into
 * a typed-array field that other code holds a reference to (a light's colour), rather than replacing it.
 */

export interface PropertyAccessor {
    readonly path: string;
    /** The current value, or undefined when the path does not resolve right now. */
    get(): unknown;
    /** Assign; returns false when the path does not resolve (the target was replaced or removed). */
    set(value: unknown): boolean;
}

const isNumericArray = (v: unknown): v is ArrayLike<number> & { [i: number]: number } =>
    (ArrayBuffer.isView(v) && !(v instanceof DataView)) || (Array.isArray(v) && v.every(x => typeof x === 'number'));

/** Whether `key` is an ACCESSOR with a setter (as opposed to a plain data field). */
function hasSetter(target: object, key: string): boolean {
    for (let p: any = target; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, key);
        if (d) return !!d.set;
    }
    return false;
}

function step(container: any, key: string): any {
    if (container === null || container === undefined) return undefined;
    if (container instanceof Map) return container.get(key);
    return container[key];
}

const TRANSFORM_SETTERS: Record<string, string> = {
    position: 'setPosition', rotation: 'setRotation', scale: 'setScale',
};

/**
 * Single-segment paths read through another getter: a node's `visible` folds in the renderer's LOD and
 * draw-distance culls, so what was authored (and what a key should hold) is `authoredVisible`.
 */
const READ_ALIASES: Record<string, string> = { visible: 'authoredVisible' };

/** Whether `path` is a node's own transform (`position`, `rotation`, `scale`): writing it moves the world matrix. */
export function isTransformPath(path: string): boolean {
    return path in TRANSFORM_SETTERS;
}

interface VisibilityNode { authoredVisible: boolean; visible: boolean; children: readonly VisibilityNode[] }

const isVisibilityNode = (v: unknown): v is VisibilityNode =>
    !!v && typeof v === 'object' && typeof (v as any).authoredVisible === 'boolean' && Array.isArray((v as any).children);

/**
 * How to put a `visible` write back exactly. The setter recurses into every descendant, so restoring the
 * root's flag alone would show children the scene had hidden: capture each node's own flag, and restore
 * them parent first so every child's own flag lands last. Null when `root` is not a node.
 */
export function captureVisibility(root: unknown): (() => void) | null {
    if (!isVisibilityNode(root)) return null;
    const flags: [VisibilityNode, boolean][] = [];
    const walk = (n: VisibilityNode) => {
        flags.push([n, n.authoredVisible]);
        for (const c of n.children) if (isVisibilityNode(c)) walk(c);
    };
    walk(root);
    return () => {
        for (const [n, v] of flags) if (n.authoredVisible !== v || n === root) n.visible = v;
    };
}

/** Copy a value so a captured "before" cannot be mutated by later writes into the same array. */
export function snapshotValue(v: unknown): unknown {
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<number>);
    if (Array.isArray(v)) return v.slice();
    return v;
}

export function compilePropertyPath(root: object, path: string): PropertyAccessor {
    const parts = path.split('.').filter(p => p.length > 0);
    if (parts.length === 0 || parts.some(p => p.startsWith('_'))) {
        return { path, get: () => undefined, set: () => false };
    }
    const containerOf = (): any => {
        let c: any = root;
        for (let i = 0; i < parts.length - 1; i++) {
            c = step(c, parts[i]);
            if (c === null || typeof c !== 'object') return undefined;
        }
        return c;
    };
    const key = parts[parts.length - 1];
    const transformSetter = parts.length === 1 ? TRANSFORM_SETTERS[key] : undefined;
    const readAlias = parts.length === 1 ? READ_ALIASES[key] : undefined;

    return {
        path,
        get(): unknown {
            const c = containerOf();
            if (c === undefined) return undefined;
            if (readAlias && readAlias in c) return c[readAlias];
            return step(c, key);
        },
        set(value: unknown): boolean {
            const c = containerOf();
            if (c === undefined) return false;
            if (transformSetter && typeof c[transformSetter] === 'function') {
                if (!isNumericArray(value) || value.length < 3) return false;
                c[transformSetter]([value[0], value[1], value[2]]);
                return true;
            }
            if (c instanceof Map) {
                if (!c.has(key)) return false;
                const current = c.get(key);
                if (isNumericArray(current) && isNumericArray(value) && ArrayBuffer.isView(current)) {
                    const n = Math.min(current.length, value.length);
                    for (let i = 0; i < n; i++) current[i] = value[i];
                } else {
                    c.set(key, value);
                }
                return true;
            }
            if (!(key in c)) return false;
            const current = c[key];
            if (typeof current === 'function') return false;
            if (isNumericArray(current) && isNumericArray(value)) {
                // A typed-array FIELD is written in place (other code holds the same array); a setter
                // gets the value.
                if (ArrayBuffer.isView(current) && !hasSetter(c, key)) {
                    const n = Math.min(current.length, value.length);
                    for (let i = 0; i < n; i++) current[i] = value[i];
                    return true;
                }
                c[key] = ArrayBuffer.isView(current) ? Float32Array.from(value as ArrayLike<number>) : Array.from(value as ArrayLike<number>);
                return true;
            }
            c[key] = value;
            return true;
        },
    };
}

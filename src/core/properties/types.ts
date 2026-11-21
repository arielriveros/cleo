// The engine's property types: what a value IS, so every editor of it is the same one.
//
// One table for the whole engine. A script field declares its type the TypeScript way (`tint: Color`,
// `skin: Material`, `door: LightNode`) and the editor's reflection reads it from the source with
// {@link typeFromAnnotation}. An engine node declares its properties with runtime TOKENS of the same names
// (`{ key: 'albedo', type: Color }`, see declare.ts) and {@link typeOfToken} reads those. Both arrive at one
// {@link PropertyType}, which decides how the value is stored, what it holds while the game runs, and the
// widget the inspector shows for it (docs/scripting/attribute-types.md).
//
// A leaf: no engine imports. The classes that are types of their own (Material, Texture, Sound, Tileset, every
// Node) register themselves through registerClassType / setNodeClassTest, so this module never pulls them in.

/** What a NAME field names: the inspector lists the names of that kind the node can reach. */
export type NameKind =
    | 'clip' | 'sound' | 'socket' | 'template' | 'node' | 'trigger' | 'spriteClip'
    | 'action' | 'scene' | 'layer' | 'param';

export const NAME_KINDS: readonly NameKind[] = [
    'clip', 'sound', 'socket', 'template', 'node', 'trigger', 'spriteClip', 'action', 'scene', 'layer', 'param',
];

/**
 * The assets a field can hold as the engine object itself. Stored as the asset's id (`{ $asset, id }`), turned
 * into the object when the script attaches (fieldRefs.ts).
 */
export type AssetFieldKind = 'material' | 'texture' | 'sound' | 'tileset';

export const ASSET_FIELD_KINDS: readonly AssetFieldKind[] = ['material', 'texture', 'sound', 'tileset'];

/** A property's type. Plain JSON, so a reflected script schema can store it. */
export type PropertyType =
    | { kind: 'number'; integer?: true }
    | { kind: 'boolean' }
    | { kind: 'string' }
    /** One of fixed values: a string-literal union (`'melee' | 'ranged'`), or `Choice([...])`, with labels to show. */
    | { kind: 'choice'; values: string[]; labels?: string[] }
    | { kind: 'vector'; size: 2 | 3 | 4 }
    /** Linear RGB (or RGBA with `alpha`), components 0..1: a colour picker. */
    | { kind: 'color'; alpha?: true }
    | { kind: 'name'; name: NameKind }
    | { kind: 'asset'; asset: AssetFieldKind }
    /**
     * A node in the scene: `className` is an engine node class (`Node`, `LightNode`, …), or with `script` the
     * class of a project script, whose nodes are the ones running it.
     */
    | { kind: 'node'; className: string; script?: true }
    /** A collision layer (one bit), or a set of them (`mask`): the project's named layers. */
    | { kind: 'layers'; mask?: true }
    | { kind: 'list'; of: PropertyType };

/** A runtime stand-in for a type, for declarations written in code: `{ key: 'albedo', type: Color }`. */
export interface PropertyToken {
    readonly property: PropertyType;
}

/** What a declaration's `type` may be: a token, `Number` / `Boolean` / `String`, or a class that is a type. */
export type PropertyTokenLike = PropertyToken | NumberConstructor | BooleanConstructor | StringConstructor | Function;

/** A token for `type` (frozen, so a declaration cannot change the shared descriptor). */
export function propertyToken(type: PropertyType): PropertyToken {
    return Object.freeze({ property: deepFreeze(type) });
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const v of Object.values(value)) deepFreeze(v);
        Object.freeze(value);
    }
    return value;
}

/** One of fixed values, as a declaration token: `type: Choice(['rect', 'disk'], ['Rectangle', 'Disk'])`. */
export function Choice(values: readonly string[], labels?: readonly string[]): PropertyToken {
    return propertyToken({ kind: 'choice', values: [...values], ...(labels ? { labels: [...labels] } : {}) });
}

/** A list of `item`, as a declaration token: `type: ListOf(Texture)`. */
export function ListOf(item: PropertyTokenLike): PropertyToken {
    const of = typeOfToken(item);
    if (!of) throw new TypeError('ListOf: not a property type');
    return propertyToken({ kind: 'list', of });
}

/** An integer, as a declaration token. */
export const Integer: PropertyToken = propertyToken({ kind: 'number', integer: true });

/** Classes that are types of their own (Material, Texture, …), registered by the modules that own them. */
const classTypes = new Map<Function, PropertyType>();

/** Make `ctor` a property type: a declaration's `type: Material` then means `type`. */
export function registerClassType(ctor: Function, type: PropertyType): void {
    classTypes.set(ctor, deepFreeze(type));
}

let isNodeClass: (ctor: Function) => boolean = () => false;

/** How to tell a node class (set by node.ts, which this module must not import). */
export function setNodeClassTest(test: (ctor: Function) => boolean): void {
    isNodeClass = test;
}

/** The type a declaration's `type` names, or null when it names none. */
export function typeOfToken(token: unknown): PropertyType | null {
    if (token === Number) return { kind: 'number' };
    if (token === Boolean) return { kind: 'boolean' };
    if (token === String) return { kind: 'string' };
    if (token && typeof token === 'object' && 'property' in token) return (token as PropertyToken).property;
    if (typeof token === 'function') {
        const registered = classTypes.get(token);
        if (registered) return registered;
        if (isNodeClass(token)) return { kind: 'node', className: token.name };
    }
    return null;
}

/* -------------------------------------------------------------------------- */
/* Annotations: a script field's type, read from its source                    */
/* -------------------------------------------------------------------------- */

/** What the reflection knows besides the annotation itself. */
export interface AnnotationContext {
    /** Whether `name` is a project script's class (imported by the script being read): its nodes run it. */
    scriptClass?(name: string): boolean;
}

/** Lower-cased annotation -> type, for the names that are types without anything else. */
const NAMED: Record<string, PropertyType> = {
    number: { kind: 'number' }, string: { kind: 'string' }, boolean: { kind: 'boolean' }, bool: { kind: 'boolean' },
    vec2: { kind: 'vector', size: 2 }, vec3: { kind: 'vector', size: 3 }, vec4: { kind: 'vector', size: 4 },
    '[number,number]': { kind: 'vector', size: 2 },
    '[number,number,number]': { kind: 'vector', size: 3 },
    '[number,number,number,number]': { kind: 'vector', size: 4 },
    color: { kind: 'color' }, coloralpha: { kind: 'color', alpha: true },
    clipname: { kind: 'name', name: 'clip' }, soundname: { kind: 'name', name: 'sound' },
    socketname: { kind: 'name', name: 'socket' }, templatename: { kind: 'name', name: 'template' },
    nodename: { kind: 'name', name: 'node' }, triggername: { kind: 'name', name: 'trigger' },
    spriteclipname: { kind: 'name', name: 'spriteClip' }, actionname: { kind: 'name', name: 'action' },
    scenename: { kind: 'name', name: 'scene' }, layername: { kind: 'name', name: 'layer' },
    paramname: { kind: 'name', name: 'param' },
    collisionlayer: { kind: 'layers' }, collisionmask: { kind: 'layers', mask: true },
    material: { kind: 'asset', asset: 'material' }, texture: { kind: 'asset', asset: 'texture' },
    sound: { kind: 'asset', asset: 'sound' }, tileset: { kind: 'asset', asset: 'tileset' },
};

/**
 * An annotation without what does not change its type: whitespace, `| undefined` / `| null`, `readonly`, a
 * namespace qualifier (`Cleo.ClipName`, `Vec.vec3`), and `Array<X>` spelled `X[]`. Case is kept.
 */
function normalize(annotation: string): string {
    let key = annotation.replace(/\s+/g, '');
    key = key.replace(/\|(undefined|null)\b/g, '').replace(/^(undefined|null)\|/, '');
    key = key.replace(/^readonly/, '');
    key = key.replace(/^(?:Readonly)?Array<(.+)>$/, '$1[]').replace(/^\((.+)\)\[\]$/, '$1[]');
    key = key.replace(/^[A-Za-z_$][A-Za-z0-9_$]*\.(?=[A-Za-z_$])/, '');
    return key;
}

/** A union of string literals (`'a' | "b"`), as its values; undefined for any other annotation. */
export function literalUnionOf(annotation: string): string[] | undefined {
    const parts = annotation.split('|').map(p => p.trim()).filter(p => p && p !== 'undefined' && p !== 'null');
    if (!parts.length) return undefined;
    const out: string[] = [];
    for (const p of parts) {
        const m = /^(['"`])((?:\\.|(?!\1)[^\\])*)\1$/.exec(p);
        if (!m) return undefined;
        out.push(m[2].replace(/\\(.)/g, '$1'));
    }
    return out;
}

/** The type a bare annotation names (no `[]`), or undefined. */
function namedType(key: string, ctx?: AnnotationContext): PropertyType | undefined {
    const named = NAMED[key.toLowerCase()];
    if (named) return named;
    if (/^[A-Za-z_$][\w$]*$/.test(key)) {
        // A project script's class first: those are often named `…Node` too (`SoulsDoorNode`).
        if (ctx?.scriptClass?.(key)) return { kind: 'node', className: key, script: true };
        if (key === 'Node' || /^[A-Z]\w*Node$/.test(key)) return { kind: 'node', className: key };
    }
    return undefined;
}

/**
 * A script field's type from its annotation (`Color`, `Material[]`, `'a' | 'b'`, `LightNode`) and, when that
 * says nothing, its literal default (`= 5`, `= [1, 1, 1]`, `= ['a']`). Never throws: an unknown type with no
 * default is a number, as it always was.
 */
export function typeFromAnnotation(annotation: string, def?: unknown, ctx?: AnnotationContext): PropertyType {
    const key = normalize(annotation ?? '');
    if (key) {
        const whole = namedType(key, ctx);
        if (whole) return whole;
        if (key.endsWith('[]')) {
            const item = key.slice(0, -2);
            // `number[]` is how a vector was typed before the vector types: a 2-, 3- or 4-number default says so.
            if (item === 'number') {
                const size = Array.isArray(def) && def.every(v => typeof v === 'number') ? def.length : 0;
                return size >= 2 && size <= 4 ? { kind: 'vector', size: size as 2 | 3 | 4 } : { kind: 'list', of: { kind: 'number' } };
            }
            const of = namedType(item, ctx) ?? (literalUnionOf(item) ? { kind: 'choice', values: literalUnionOf(item)! } as PropertyType : undefined);
            if (of) return { kind: 'list', of };
        }
        const choices = literalUnionOf(annotation);
        if (choices) return { kind: 'choice', values: choices };
    }
    if (typeof def === 'number') return { kind: 'number' };
    if (typeof def === 'boolean') return { kind: 'boolean' };
    if (typeof def === 'string') return { kind: 'string' };
    if (Array.isArray(def)) {
        if (def.length && def.every(v => typeof v === 'string')) return { kind: 'list', of: { kind: 'string' } };
        if (def.length >= 2 && def.length <= 4 && def.every(v => typeof v === 'number')) return { kind: 'vector', size: def.length as 2 | 3 | 4 };
        if (!def.length && /^string\[\]$/i.test(key)) return { kind: 'list', of: { kind: 'string' } };
        return { kind: 'vector', size: 3 };
    }
    return { kind: 'number' };
}

/* -------------------------------------------------------------------------- */
/* Questions about a type                                                      */
/* -------------------------------------------------------------------------- */

const NAME_LABEL: Record<NameKind, string> = {
    clip: 'ClipName', sound: 'SoundName', socket: 'SocketName', template: 'TemplateName', node: 'NodeName',
    trigger: 'TriggerName', spriteClip: 'SpriteClipName', action: 'ActionName', scene: 'SceneName',
    layer: 'LayerName', param: 'ParamName',
};
const ASSET_LABEL: Record<AssetFieldKind, string> = { material: 'Material', texture: 'Texture', sound: 'Sound', tileset: 'Tileset' };

/** How a type is written in a script: `number`, `Color`, `Material`, `LightNode`, `ClipName[]`, `'a' | 'b'`. */
export function propertyTypeLabel(type: PropertyType): string {
    switch (type.kind) {
        case 'number': return 'number';
        case 'boolean': return 'boolean';
        case 'string': return 'string';
        case 'choice': return type.values.map(v => `'${v}'`).join(' | ');
        case 'vector': return `Vec${type.size}`;
        case 'color': return type.alpha ? 'ColorAlpha' : 'Color';
        case 'name': return NAME_LABEL[type.name];
        case 'asset': return ASSET_LABEL[type.asset];
        case 'node': return type.className;
        case 'layers': return type.mask ? 'CollisionMask' : 'CollisionLayer';
        case 'list': {
            const item = propertyTypeLabel(type.of);
            return type.of.kind === 'choice' ? `(${item})[]` : `${item}[]`;
        }
    }
}

/** The value a field of `type` starts with when it has no literal default of its own. */
export function defaultOf(type: PropertyType): unknown {
    switch (type.kind) {
        case 'number': return 0;
        case 'boolean': return false;
        case 'string': return '';
        case 'name': return '';
        case 'choice': return type.values[0] ?? '';
        case 'vector': return new Array(type.size).fill(0);
        case 'color': return type.alpha ? [1, 1, 1, 1] : [1, 1, 1];
        case 'asset': return null;
        case 'node': return null;
        case 'layers': return type.mask ? -1 : 1;
        case 'list': return [];
    }
}

/** Whether the value is text: a string, a name or a choice (what `@options` and `multiline` apply to). */
export function isTextType(type: PropertyType): boolean {
    return type.kind === 'string' || type.kind === 'name' || type.kind === 'choice';
}

/** Whether two types are the same type. */
export function samePropertyType(a: PropertyType, b: PropertyType): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A stored type as it is now. Script schemas reflected before the property types held a string (`'vec3'`,
 * `'stringList'`) plus `pick` / `choices`; those read as the type they meant.
 */
export function upgradePropertyType(type: unknown, legacy?: { pick?: unknown; choices?: unknown; color?: unknown }): PropertyType {
    if (type && typeof type === 'object' && typeof (type as any).kind === 'string') return type as PropertyType;
    const pick = typeof legacy?.pick === 'string' && (NAME_KINDS as readonly string[]).includes(legacy.pick) ? legacy.pick as NameKind : undefined;
    const choices = Array.isArray(legacy?.choices) ? (legacy!.choices as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
    switch (type) {
        case 'number': return { kind: 'number' };
        case 'boolean': return { kind: 'boolean' };
        case 'vec3': return legacy?.color === true ? { kind: 'color' } : { kind: 'vector', size: 3 };
        case 'stringList': return { kind: 'list', of: pick ? { kind: 'name', name: pick } : { kind: 'string' } };
        default:
            if (pick) return { kind: 'name', name: pick };
            if (choices?.length) return { kind: 'choice', values: choices };
            return { kind: 'string' };
    }
}

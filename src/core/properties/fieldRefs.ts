// Script fields that hold an asset or a node: how they are stored, and how the stored value becomes the engine
// object when the script attaches.
//
//   @attribute skin: Material = null      stored { $asset: 'material', id: 'm_12' }   ->  the Material
//   @attribute door: LightNode = null     stored { $nodePath: '../Gate/Light' }        ->  that node, or null
//
// The stored forms are plain JSON and say what they are, so a published game -- which ships no script schema
// -- needs no field types to resolve them. The editor only ever holds the stored forms (its nodes never run
// their scripts), which keeps template overrides, variants and undo plain JSON too.
//
// An asset is found by id: a texture in the TextureManager, a sound in the AudioManager, and a material or a
// tileset in the game's ONE asset table (registerAssetTable), where each is stored once however many fields
// name it, parsed the first time a field asks, and shared from then on. `src/` has no asset library: the host
// hands over the table, as it hands over its templates (registerTemplates).

import type { Node } from '../scene/nodes/node';
import { Logger } from '../logger';
import { nodeAtRelativePath } from '../save/nodePaths';
import type { AssetFieldKind, PropertyType } from './types';

/** An asset field's stored value. */
export interface AssetFieldRef {
    $asset: AssetFieldKind;
    id: string;
}

/** A node field's stored value: the path from the field's own node (see `relativeNodePath`). */
export interface NodePathRef {
    $nodePath: string;
}

export function isAssetRef(value: unknown): value is AssetFieldRef {
    return !!value && typeof value === 'object' && typeof (value as AssetFieldRef).$asset === 'string' && typeof (value as AssetFieldRef).id === 'string';
}

export function isNodePathRef(value: unknown): value is NodePathRef {
    return !!value && typeof value === 'object' && typeof (value as NodePathRef).$nodePath === 'string';
}

export function assetRef(kind: AssetFieldKind, id: string): AssetFieldRef {
    return { $asset: kind, id };
}

export function nodePathRef(path: string): NodePathRef {
    return { $nodePath: path };
}

/* -------------------------------------------------------------------------- */
/* Assets                                                                      */
/* -------------------------------------------------------------------------- */

/** Finds the asset `id` of one kind, or nothing when the game has none by that id. */
export type AssetResolver = (id: string) => object | null | undefined;

const resolvers = new Map<string, AssetResolver>();
/** Every object a field was given, with the reference it came from: what a save writes for it. */
const refOf = new WeakMap<object, AssetFieldRef>();

/** How the assets of `kind` are found (assetKinds.ts registers the engine's). */
export function registerAssetResolver(kind: AssetFieldKind, resolve: AssetResolver): void {
    resolvers.set(kind, resolve);
}

/** The asset `id` of `kind` as the engine object, or null. */
export function resolveAsset(kind: AssetFieldKind, id: string): object | null {
    const found = resolvers.get(kind)?.(id) ?? null;
    if (found) refOf.set(found, { $asset: kind, id });
    return found;
}

/** The reference an asset object was resolved from (or registered under), or null. */
export function assetRefOf(value: unknown): AssetFieldRef | null {
    return value && typeof value === 'object' ? refOf.get(value) ?? null : null;
}

/** Remember that `obj` is the asset `kind:id`, for an object made outside {@link resolveAsset}. */
export function rememberAssetRef(obj: object, kind: AssetFieldKind, id: string): void {
    refOf.set(obj, { $asset: kind, id });
}

/**
 * The game's shared asset table: each material or tileset a script field names, once, as its serialized
 * JSON. Built by the editor's game data (Play, Play in window, publish), handed over before the scene parses.
 */
export interface AssetTable {
    materials?: Record<string, unknown>;
    tilesets?: Record<string, unknown>;
}

type TableKind = 'material' | 'tileset';
const TABLE_KEYS: Record<TableKind, keyof AssetTable> = { material: 'materials', tileset: 'tilesets' };

const tableJson: Record<TableKind, Map<string, unknown>> = { material: new Map(), tileset: new Map() };
const tableParsed: Record<TableKind, Map<string, object>> = { material: new Map(), tileset: new Map() };
const tableParsers = new Map<TableKind, (json: any) => object>();

/** How a table kind's JSON becomes its object (assetKinds.ts: Material.parse, Tileset.parse). */
export function registerAssetParser(kind: TableKind, parse: (json: any) => object): void {
    tableParsers.set(kind, parse);
    registerAssetResolver(kind, id => tableAsset(kind, id));
}

function tableAsset(kind: TableKind, id: string): object | null {
    const cached = tableParsed[kind].get(id);
    if (cached) return cached;
    const json = tableJson[kind].get(id);
    const parse = tableParsers.get(kind);
    if (json === undefined || !parse) return null;
    try {
        const made = parse(json);
        tableParsed[kind].set(id, made);
        return made;
    } catch (e) {
        Logger.error(`The ${kind} '${id}' in the game's asset table could not be read: ${(e as Error)?.message ?? e}`, 'Script');
        return null;
    }
}

/**
 * Add the entries of `table` to the game's asset table. An id already there keeps its object unless the new
 * JSON is a different one (Play again after an edit), which replaces it for the fields that resolve next.
 */
export function registerAssetTable(table: AssetTable | null | undefined): void {
    if (!table || typeof table !== 'object') return;
    for (const kind of Object.keys(TABLE_KEYS) as TableKind[]) {
        const entries = table[TABLE_KEYS[kind]];
        if (!entries || typeof entries !== 'object') continue;
        for (const [id, json] of Object.entries(entries)) {
            if (tableJson[kind].get(id) === json) continue;
            tableJson[kind].set(id, json);
            tableParsed[kind].delete(id);
        }
    }
}

/** Forget the whole asset table (a new game in the same page). */
export function clearAssetTable(): void {
    for (const kind of Object.keys(TABLE_KEYS) as TableKind[]) {
        tableJson[kind].clear();
        tableParsed[kind].clear();
    }
}

/* -------------------------------------------------------------------------- */
/* Field references on a node                                                  */
/* -------------------------------------------------------------------------- */

/** Whether a stored value is, or is a list holding, a reference of either kind. */
export function holdsFieldRef(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(v => isAssetRef(v) || isNodePathRef(v));
    return isAssetRef(value) || isNodePathRef(value);
}

function holdsNodeRef(value: unknown): boolean {
    return Array.isArray(value) ? value.some(isNodePathRef) : isNodePathRef(value);
}

/** A field waiting for its references: what was stored, and what is on the node now (to see a script's own write). */
interface PendingField {
    stored: unknown;
    written: unknown;
}

const pending = new WeakMap<object, Map<string, PendingField>>();
/**
 * The nodes whose script has attached: the only ones whose references become objects. The editor's own nodes
 * never run their scripts, yet their scene starts and calls `fillScriptRefs` all the same; resolved there, a
 * field would hold a node (or null, before a template's children are in) where the inspector, a save and Play
 * read the stored path.
 */
const attached = new WeakSet<object>();

/**
 * Set aside the fields of `vars` (a node's `scriptVars`, already on the node) whose values hold references, to
 * be resolved when the script attaches ({@link resolveAssetFields}) and before it starts ({@link resolveNodeFields}).
 */
export function noteFieldRefs(node: object, vars: Record<string, unknown>): void {
    let fields: Map<string, PendingField> | undefined;
    for (const name of Object.keys(vars)) {
        const value = vars[name];
        if (!holdsFieldRef(value)) continue;
        fields ??= pending.get(node) ?? new Map();
        fields.set(name, { stored: value, written: (node as any)[name] });
    }
    if (fields) pending.set(node, fields);
}

/** Whether `node` has fields still waiting for a node reference. */
export function hasPendingNodeFields(node: object): boolean {
    const fields = pending.get(node);
    if (!fields) return false;
    for (const f of fields.values()) if (holdsNodeRef(f.stored)) return true;
    return false;
}

/** `kind:node:field` of each reference already reported missing: one warning each per session. */
const reported = new Set<string>();

function reportOnce(key: string, message: string): void {
    if (reported.has(key)) return;
    reported.add(key);
    Logger.warn(message, 'Script');
}

/**
 * Turn the asset references in `node`'s pending fields into the assets. Runs as the script attaches, before
 * any of it runs. A field that also holds node references stays pending for {@link resolveNodeFields}.
 */
export function resolveAssetFields(node: Node): void {
    attached.add(node);
    const fields = pending.get(node);
    if (!fields) return;
    const n = node as any;
    for (const [field, entry] of fields) {
        const one = (v: unknown): unknown => {
            if (!isAssetRef(v)) return v;
            const found = resolveAsset(v.$asset, v.id);
            if (!found) reportOnce(`asset:${node.name}:${field}:${v.$asset}:${v.id}`,
                `'${node.name}': '${field}' names the ${v.$asset} '${v.id}', which this game does not have, so it stays empty.`);
            return found;
        };
        const value = Array.isArray(entry.stored) ? entry.stored.map(one) : one(entry.stored);
        n[field] = value;
        entry.written = value;
        if (!holdsNodeRef(value)) fields.delete(field);
        else entry.stored = value;
    }
    if (!fields.size) pending.delete(node);
}

/**
 * Turn the node references in `node`'s pending fields into the nodes they lead to. Runs with `@child` /
 * `@find` (fillScriptRefs): before `onConstruct`, and `final`ly before `onStart`, for what was spawned in
 * between. A node not there by then stays null, reported once unless `optional(field)` (declared `name?:`).
 * A field the script set itself in the meantime is left as the script set it. A node whose script has not
 * attached (the editor's) keeps its paths as stored.
 */
export function resolveNodeFields(node: Node, final: boolean, optional?: (field: string) => boolean): void {
    const fields = pending.get(node);
    if (!fields || !attached.has(node)) return;
    const n = node as any;
    for (const [field, entry] of fields) {
        if (n[field] !== entry.written) { fields.delete(field); continue; }
        let missing: string | null = null;
        const one = (v: unknown): unknown => {
            if (!isNodePathRef(v)) return v;
            const found = nodeAtRelativePath(node, v.$nodePath);
            if (!found) missing ??= v.$nodePath;
            return found;
        };
        const value = Array.isArray(entry.stored) ? entry.stored.map(one) : one(entry.stored);
        n[field] = value;
        entry.written = value;
        if (missing === null) { fields.delete(field); continue; }
        if (!final) continue;
        fields.delete(field);
        if (!optional?.(field))
            reportOnce(`node:${node.name}:${field}:${missing}`,
                `'${node.name}': '${field}' points at '${missing}', which is not there, so it stays empty. Declare it '${field}?:' if it may be missing.`);
    }
    if (!fields.size) pending.delete(node);
}

/**
 * Whether `value` is something a field of `type` can store: what the editor checks before keeping a node's value
 * when a field changes type (a `weapon: string` that became `weapon: Material` starts over from its default).
 */
export function storedValueFits(type: PropertyType, value: unknown): boolean {
    switch (type.kind) {
        case 'number': return typeof value === 'number';
        case 'boolean': return typeof value === 'boolean';
        case 'string': case 'name': return typeof value === 'string';
        case 'choice': return typeof value === 'string';
        case 'vector': case 'color':
            return Array.isArray(value) && value.length === (type.kind === 'vector' ? type.size : type.alpha ? 4 : 3)
                && value.every(v => typeof v === 'number');
        case 'asset': return value === null || (isAssetRef(value) && value.$asset === type.asset);
        case 'node': return value === null || isNodePathRef(value);
        case 'layers': return typeof value === 'number' && Number.isInteger(value);
        case 'list': return Array.isArray(value) && value.every(v => storedValueFits(type.of, v));
    }
}

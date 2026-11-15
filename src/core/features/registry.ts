// The engine's optional features, as code: what each one plugs into the core when it is installed. A published
// game's player loads only the features the game was built with (applications/editor/src/player/boot.tsx, through
// src/modules/loaders.ts), each a chunk of its own; the full engine (src/cleo.ts) installs all of them
// (src/modules/all.ts). The catalog of the same features, as data, is src/modules/catalog.ts.
//
// The core never imports a feature module as a value: it asks this registry instead -- for the parser of a node
// type, the factory of a render subsystem or of a scene service. Must stay a LEAF (type imports only), so
// that anything in the core can read it without closing a cycle.
import type { Node } from '../scene/nodes/node';

/** Builds a node of a type under `parent` from its JSON (a node class's static `parse`). */
export type NodeParser = (parent: Node, json: any) => void;

/**
 * What a feature plugs in when it is installed. A feature's per-frame work runs where the scene already calls it
 * (through methods on its nodes, or on a service made by a factory below), so there are no scene passes to register.
 */
export interface FeatureRegistrar {
    /** Parse nodes of `type` with `parse`, after `migrate` (an old save's JSON brought up to date). */
    nodeType(type: string, parse: NodeParser, migrate?: (json: any) => any): void;
    /** Put nodes of `ctor` (and its subclasses) in the scene list of kind `bit` (src/core/scene/sceneKinds.ts). */
    nodeKind(ctor: Function, bit: number): void;
    /** A named factory the core asks for: a render subsystem, a scene service. */
    factory(name: string, make: (...args: any[]) => any): void;
}

/** An optional feature's module: `src/modules/<id>/index.ts`'s default export. */
export interface FeatureModule {
    readonly id: string;
    /** Installed after these (when they are installed at all). */
    readonly dependsOn?: readonly string[];
    /** The names it adds to scripts' `import { ... } from 'cleo'`. */
    readonly api: Readonly<Record<string, unknown>>;
    install(registrar: FeatureRegistrar): void;
}

interface Installed {
    module: FeatureModule;
    nodeTypes: Map<string, { parse: NodeParser; migrate?: (json: any) => any }>;
    nodeKinds: [Function, number][];
    factories: Map<string, (...args: any[]) => any>;
}

const installed = new Map<string, Installed>();
/** Installed ids in installation order. */
const order: string[] = [];
/** The features lookups may see; null: every installed one. */
let allowed: ReadonlySet<string> | null = null;
/** Engine names of features a published game was built without, by name: the feature's label. */
let absentNames = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
    version++;
    for (const cb of [...listeners]) cb();
}

/** Bumped by every install, restriction or absent-name change: caches keyed on the feature set compare it. */
export function featuresVersion(): number {
    return version;
}

/** Call `cb` after every change to the installed or allowed features. */
export function onFeaturesChanged(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

/** Install a feature (once; again is a no-op). Its dependencies must already be installed, if present at all. */
export function installFeature(module: FeatureModule): void {
    if (installed.has(module.id)) return;
    const entry: Installed = { module, nodeTypes: new Map(), nodeKinds: [], factories: new Map() };
    module.install({
        nodeType: (type, parse, migrate) => { entry.nodeTypes.set(type, { parse, migrate }); },
        nodeKind: (ctor, bit) => { entry.nodeKinds.push([ctor, bit]); },
        factory: (name, make) => { entry.factories.set(name, make); },
    });
    installed.set(module.id, entry);
    order.push(module.id);
    changed();
}

/** Install several, dependencies first. */
export function installFeatures(modules: readonly FeatureModule[]): void {
    const byId = new Map(modules.map(m => [m.id, m]));
    const visit = (m: FeatureModule, seen: Set<string>) => {
        if (seen.has(m.id) || installed.has(m.id)) return;
        seen.add(m.id);
        for (const dep of m.dependsOn ?? []) { const d = byId.get(dep); if (d) visit(d, seen); }
        installFeature(m);
    };
    const seen = new Set<string>();
    for (const m of modules) visit(m, seen);
}

/**
 * Let lookups see only these features (null: all installed): a published game's set, which Play in window
 * reproduces in the full engine. A feature outside it behaves as if it were not installed.
 */
export function restrictFeatures(ids: Iterable<string> | null): void {
    allowed = ids ? new Set(ids) : null;
    changed();
}

/** Engine names a published game was built without, each with its feature's label (config.absentApi). */
export function setAbsentFeatureNames(names: Readonly<Record<string, string>> | null): void {
    absentNames = new Map(Object.entries(names ?? {}));
    changed();
}

const live = (id: string) => installed.has(id) && (!allowed || allowed.has(id));

/** Whether a feature is installed and allowed. */
export function isFeatureInstalled(id: string): boolean {
    return live(id);
}

/** Whether a feature is installed but kept out by {@link restrictFeatures}. */
export function isFeatureRestrictedOut(id: string): boolean {
    return installed.has(id) && !!allowed && !allowed.has(id);
}

function* liveEntries(): Generator<Installed> {
    for (const id of order) if (live(id)) yield installed.get(id)!;
}

/** The parser a feature registered for a node type, if a live one did. */
export function featureNodeParser(type: string | undefined): { parse: NodeParser; migrate?: (json: any) => any } | undefined {
    if (!type) return undefined;
    for (const e of liveEntries()) { const p = e.nodeTypes.get(type); if (p) return p; }
    return undefined;
}

/** Every live feature's [class, kind bit] pairs. */
export function featureNodeKinds(): [Function, number][] {
    const out: [Function, number][] = [];
    for (const e of liveEntries()) out.push(...e.nodeKinds);
    return out;
}

/** A live feature's factory by name, if one registered it. */
export function featureFactory<T extends (...args: any[]) => any>(name: string): T | undefined {
    for (const e of liveEntries()) { const f = e.factories.get(name); if (f) return f as T; }
    return undefined;
}

/** The script names of every live feature. */
export function liveFeatureApis(): Readonly<Record<string, unknown>>[] {
    return [...liveEntries()].map(e => e.module.api);
}

/** The script names a feature adds, whether or not it is live (empty when not installed). */
export function featureApiNames(id: string): string[] {
    const api = installed.get(id)?.module.api;
    return api ? Object.keys(api).filter(k => k !== 'default') : [];
}

/** A name a script must not find, with the label of the feature it belongs to. */
export interface UnavailableName {
    readonly label: string;
    /**
     * True when an installed feature's own module exports it (a feature kept out by {@link restrictFeatures}):
     * then it is the feature's for certain, even where the full engine's barrel carries it too. False for a
     * name a published game was only told about (config.absentApi), which never hides one the runtime has.
     */
    readonly owned: boolean;
}

/**
 * Names a script must not find: those of installed features kept out by {@link restrictFeatures}, and those a
 * published game says it was built without.
 */
export function unavailableFeatureNames(labelOf: (id: string) => string): Map<string, UnavailableName> {
    const out = new Map<string, UnavailableName>();
    for (const [name, label] of absentNames) out.set(name, { label, owned: false });
    if (allowed) for (const [id, e] of installed) if (!allowed.has(id))
        for (const name of Object.keys(e.module.api)) if (name !== 'default') out.set(name, { label: labelOf(id), owned: true });
    return out;
}

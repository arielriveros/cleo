// The user-script contract: which modules a script may import, how its source is rewritten into
// something `new Function` accepts, and which handlers it can export. Scripts are authored as
// TypeScript ES modules but never loaded as modules — buildFactoryBody() strips the types with Sucrase
// (purely syntactic, line-preserving) and transformScript() rewrites every `import` into a call to
// `__cleoImport`, the wrapper's only parameter and invisible to the script author.
//
// Must import nothing from the engine: node.ts depends on this, so any engine import closes a cycle.
// The engine's public API reaches scripts through registerScriptModule(), which src/cleo.ts calls.
import { transform } from 'sucrase';

export type ScriptModule = Record<string, any>;

/** Handlers a script may export. Anything else it exports is ignored. */
export const SCRIPT_HANDLERS = [
    'onConstruct', 'onStart', 'onSpawn', 'onUpdate', 'onCollision', 'onTrigger', 'onDespawn',
    // UI handlers, listed rather than special-cased so they get onUpdate's throw/rejection guarding.
    'onPress', 'onValueChanged', 'onSubmit',
    // Input actions. Listed here for the same reason: a handler driven by a device event must not be
    // able to throw out of the frame, which is exactly how the old registerKeyPress callbacks escaped.
    'onAction',
    // A ControllerNode's per-frame decision, run in the scene's control pass. Same reason again — it is
    // the one handler that runs OUTSIDE the node loop, so an escape would take the whole frame with it.
    'onThink',
] as const;

/** Built-in modules: the engine API, registered by src/cleo.ts as 'cleo'. */
const modules = new Map<string, ScriptModule>();

/** Makes `exports` importable from scripts as `specifier`. src/cleo.ts registers itself as 'cleo'. */
export function registerScriptModule(specifier: string, exports: ScriptModule): void {
    modules.set(specifier, exports);
}

/**
 * The module a specifier names: a built-in first, else a USER script module (another script asset,
 * addressed by its project path — see {@link normalizeScriptSpecifier}). User modules are evaluated once,
 * on first import, and cached for the rest of the session.
 */
export function resolveScriptModule(specifier: string): ScriptModule {
    const found = modules.get(specifier);
    if (found) return found;
    return loadUserModule(specifier);
}

/**
 * Builds the `__cleoImport` a single script instance sees. `overrides` replaces exports of the same name
 * with values bound to the node running the script. Only names a BUILT-IN module already exports can be
 * overridden, so an override can never smuggle a new global in through an import — and a user module
 * that happens to export a `getData` of its own is never shadowed by the node's.
 */
export function createScriptImporter(overrides: ScriptModule = {}): (specifier: string) => ScriptModule {
    return (specifier: string) => {
        const module = resolveScriptModule(specifier);
        if (!modules.has(specifier)) return module;
        const names = Object.keys(overrides).filter(name => name in module);
        if (names.length === 0) return module;

        const scoped: ScriptModule = { ...module };
        for (const name of names) scoped[name] = overrides[name];
        return scoped;
    };
}

/* -------------------------------------------------------------------------- */
/* User script modules                                                         */
/* -------------------------------------------------------------------------- */
//
// A script may import another script: a helper module (functions, constants, enums) or a shared base
// class. Scripts are addressed by their PROJECT PATH — the asset explorer's folder path without the
// `.script` extension, which is also the file's path in the VS Code workspace mirror:
//
//     /Shared/Math.script   ->  module id '/Shared/Math'   ->  workspace file Shared/Math.ts
//
//     import { clamp01 } from '@/Shared/Math'     project-root form
//     import { clamp01 } from '../Shared/Math'    relative to the importing script
//
// `@/` rather than a bare leading `/`: TypeScript treats `/x` as an absolute DISK path, which no tsconfig
// can remap, so VS Code could never type-check it. `@/*` is an ordinary `paths` alias in every tool.
//
// Unlike a node's own script — evaluated once PER NODE so that its `getData`/`setData` are bound to that
// node — an imported module is evaluated ONCE and shared. Its 'cleo' therefore has no node to bind to;
// see createModuleImporter.

/** A user module's factory: fills `exports` (an object of live getters) and returns nothing useful. */
export type ScriptModuleFactory = (this: any, importer: (specifier: string) => ScriptModule, exports: ScriptModule) => any;

interface ModuleEntry {
    exports: ScriptModule;
    state: 'loading' | 'done' | 'error';
    error?: Error;
}

/** id -> TypeScript source, for the eval path (editor play mode). */
const userSources = new Map<string, string>();
/** id -> precompiled factory, for the no-eval path (published builds). */
let moduleProvider: ((id: string) => ScriptModuleFactory | undefined) | null = null;
/** Evaluated modules, by canonical id. Lives until {@link resetScriptModules}. */
const moduleCache = new Map<string, ModuleEntry>();
/** Ids currently being evaluated, innermost last — what names the chain in a circular-import error. */
const loadingStack: string[] = [];
/** The import chain of the most recent circular import, while the outermost load is in progress. */
let lastCycle: string[] | null = null;
const warnedCase = new Set<string>();

/** Replace the user module sources (and forget everything evaluated). Play mode calls this on start. */
export function setScriptModuleSources(sources: Record<string, string>): void {
    userSources.clear();
    moduleCache.clear();
    addScriptModuleSources(sources);
}

/**
 * Add module sources without disturbing anything already evaluated — what a runtime scene load does, so
 * a module's state survives `Game.loadScene` exactly as it would in a published build.
 */
export function addScriptModuleSources(sources: Record<string, string> | null | undefined): void {
    if (!sources) return;
    for (const [id, source] of Object.entries(sources)) {
        if (typeof source !== 'string') continue;
        if (moduleCache.has(id) && userSources.get(id) === source) continue;
        if (!moduleCache.has(id)) userSources.set(id, source);
    }
}

/** Register the lookup a NO-EVAL build uses to find a module's precompiled factory. */
export function setScriptModuleProvider(provider: ((id: string) => ScriptModuleFactory | undefined) | null): void {
    moduleProvider = provider;
    moduleCache.clear();
}

/** Forget every user module, source and cached evaluation. Called when play starts and stops. */
export function resetScriptModules(): void {
    userSources.clear();
    moduleCache.clear();
    loadingStack.length = 0;
    lastCycle = null;
}

/** The user module ids currently known (sources registered for the eval path). */
export function knownScriptModules(): string[] {
    return [...userSources.keys()];
}

function isRelative(spec: string): boolean {
    return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');
}

/**
 * The canonical module id a specifier names, or the specifier untouched when it is not a script path
 * ('cleo' and any other built-in). `fromId` is the importing script's own id, needed for `./` and `../`.
 *
 *   '@/Shared/Math'                 -> '/Shared/Math'
 *   './Util'     from '/Enemies/Hollow' -> '/Enemies/Util'
 *   '../Shared/Math.ts' from '/Enemies/Hollow' -> '/Shared/Math'
 */
export function normalizeScriptSpecifier(spec: string, fromId?: string): string {
    let path: string;
    if (spec.startsWith('@/')) {
        path = spec.slice(1);
    } else if (isRelative(spec)) {
        if (!fromId)
            throw new Error(`Cannot import '${spec}': a relative import needs the script to be a saved script asset. Use the project-root form '@/…' instead.`);
        const dir = fromId.slice(0, fromId.lastIndexOf('/'));
        path = `${dir}/${spec}`;
    } else if (spec.startsWith('/')) {
        throw new Error(`Cannot import '${spec}': write project-root imports as '@${spec}' (a leading '/' is a disk path to TypeScript).`);
    } else {
        return spec;
    }

    const parts: string[] = [];
    for (const part of path.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!parts.length) throw new Error(`Cannot import '${spec}': it climbs above the project root.`);
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    if (!parts.length) throw new Error(`Cannot import '${spec}': it does not name a script.`);
    parts[parts.length - 1] = parts[parts.length - 1].replace(/\.(ts|js|script)$/i, '');
    return '/' + parts.join('/');
}

/** The factory for `id`, from the provider or compiled from source, plus the id it was found under. */
function findModule(id: string): { id: string; factory: ScriptModuleFactory } | null {
    for (const candidate of [id, `${id}/index`]) {
        const provided = moduleProvider?.(candidate);
        if (provided) return { id: candidate, factory: provided };
        const source = userSources.get(candidate);
        if (source !== undefined) return { id: candidate, factory: compileScriptModule(source, candidate) };
    }
    // Windows and macOS file systems are case-insensitive, so `@/shared/math` type-checks in VS Code
    // against `Shared/Math.ts`. Resolve it the same way, but say so: a case-sensitive deploy would break.
    const lower = id.toLowerCase();
    for (const known of userSources.keys()) {
        if (known.toLowerCase() !== lower && known.toLowerCase() !== `${lower}/index`) continue;
        if (!warnedCase.has(id)) {
            warnedCase.add(id);
            console.warn(`[Script] Import '${id}' matched '${known}' only by ignoring letter case — fix the import's spelling.`);
        }
        return { id: known, factory: compileScriptModule(userSources.get(known)!, known) };
    }
    return null;
}

function loadUserModule(id: string): ScriptModule {
    const cached = moduleCache.get(id);
    if (cached) {
        if (cached.state === 'error') throw cached.error;
        // 'loading' is a circular import: hand back the partial exports. They are live getters, so a
        // function used later works; a value read right now throws, and the error names the cycle.
        const at = loadingStack.indexOf(id);
        if (at >= 0) lastCycle = [...loadingStack.slice(at), id];
        return cached.exports;
    }

    const found = findModule(id);
    if (!found) {
        const known = [...modules.keys(), ...userSources.keys()].map(m => `'${m}'`).join(', ');
        throw new Error(`Cannot import '${id}': no such module. Available: ${known || 'none'}`);
    }
    if (found.id !== id) {
        const existing = moduleCache.get(found.id);
        if (existing) { moduleCache.set(id, existing); return loadUserModule(id); }
    }

    const entry: ModuleEntry = { exports: {}, state: 'loading' };
    moduleCache.set(found.id, entry);
    if (found.id !== id) moduleCache.set(id, entry);
    loadingStack.push(found.id);
    try {
        found.factory.call(undefined, createModuleImporter(), entry.exports);
        entry.state = 'done';
        return entry.exports;
    } catch (e: any) {
        if (e && e.__cleoModuleError) { entry.state = 'error'; entry.error = e; throw e; }
        let message = `Error in script module '${found.id}': ${e?.message ?? e}`;
        if (e instanceof ReferenceError && lastCycle) {
            message += ` — circular import ${lastCycle.join(' → ')}: a value was used before its module finished loading. Use \`import * as\` or move the shared code into a third module.`;
        }
        const error = new Error(message);
        (error as any).__cleoModuleError = true;
        (error as any).cause = e;
        entry.state = 'error';
        entry.error = error;
        throw error;
    } finally {
        loadingStack.pop();
        if (!loadingStack.length) lastCycle = null;
    }
}

/** Stands in for a node when a shared module reads variables with no requester: sees public ones only. */
const PUBLIC_ONLY = { isDescendantOf: () => false } as any;

/**
 * The `__cleoImport` a shared module sees. 'cleo' comes with two changes:
 *
 *   - `getData(target)` with no requester returns PUBLIC variables only (the global one returns all of
 *     them), and `setData` refuses non-public variables. A module is not a node, so it has no standing to
 *     read another node's private state — a base-class method running on a node passes `this`:
 *     `getData(other, this)`.
 *   - `unwrapScriptNode` is identity, as it is for node scripts, so a module cannot strip the proxy off a
 *     node to get past the access checks.
 */
export function createModuleImporter(): (specifier: string) => ScriptModule {
    let scoped: ScriptModule | null = null;
    return (specifier: string) => {
        const module = resolveScriptModule(specifier);
        if (specifier !== 'cleo') return module;
        if (scoped) return scoped;
        const { getData, setData, canAccessVariable } = module;
        scoped = { ...module, unwrapScriptNode: (value: any) => value };
        if (typeof getData === 'function')
            scoped.getData = (target: any, requester?: any) => getData(target, requester ?? PUBLIC_ONLY);
        if (typeof setData === 'function')
            scoped.setData = (target: any, name: string, ...params: any[]) => {
                if (typeof canAccessVariable === 'function' && target && !canAccessVariable(target, PUBLIC_ONLY, name)) {
                    console.warn(`[Script] A shared script module cannot set non-public '${name}' on '${target.name}'. Call it from the node's own script instead.`);
                    return;
                }
                setData(target, name, ...params);
            };
        return scoped;
    };
}

/* -------------------------------------------------------------------------- */
/* Source transform                                                            */
/* -------------------------------------------------------------------------- */

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

// A `/` opens a regex literal only where a value is expected; after a value it is division. Judged by
// the previous token: a keyword like `return` expects a value, an identifier or a closing bracket is one.
const ENDS_A_VALUE = /[A-Za-z0-9_$)\]}`'"]/;
const EXPECTS_A_VALUE = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

function isValuePosition(prevToken: string): boolean {
    if (!prevToken) return true;
    if (EXPECTS_A_VALUE.has(prevToken)) return true;
    return !ENDS_A_VALUE.test(prevToken[prevToken.length - 1]);
}

/** Index just past the string/template literal starting at `start`. Templates may nest `${...}`. */
function skipString(source: string, start: number): number {
    const quote = source[start];
    let i = start + 1;
    while (i < source.length) {
        const c = source[i];
        if (c === '\\') { i += 2; continue; }
        if (c === quote) return i + 1;
        if (quote === '`' && c === '$' && source[i + 1] === '{') {
            let depth = 1;
            i += 2;
            while (i < source.length && depth > 0) {
                const inner = source[i];
                if (inner === '{') depth++;
                else if (inner === '}') depth--;
                else if (inner === '"' || inner === "'" || inner === '`') { i = skipString(source, i); continue; }
                i++;
            }
            continue;
        }
        i++;
    }
    return source.length;
}

/** Index just past the regex literal starting at `start` (a `/` already known to be in value position). */
function skipRegex(source: string, start: number): number {
    let i = start + 1;
    let inClass = false;
    while (i < source.length) {
        const c = source[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n') return start + 1;      // unterminated: it was division after all
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
            i++;
            while (i < source.length && IDENT_PART.test(source[i])) i++;  // flags
            return i;
        }
        i++;
    }
    return source.length;
}

function skipTrivia(source: string, i: number): number {
    while (i < source.length) {
        const c = source[i];
        if (c === '/' && source[i + 1] === '/') { const nl = source.indexOf('\n', i); i = nl === -1 ? source.length : nl; continue; }
        if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
        if (/\s/.test(c)) { i++; continue; }
        return i;
    }
    return i;
}

/** Keeps the rewritten source line-aligned with the author's, so error line numbers still mean something. */
function padLines(original: string): string {
    const lines = original.split('\n').length - 1;
    return '\n'.repeat(lines);
}

interface Statement { code: string; end: number }

/** What one pass over a script found: its rewritten code plus the exports and imports it declared. */
interface TransformState {
    path?: string;
    imports: string[];
    /** `[exportedName, getterBody]`, emitted onto the header line. */
    exports: [string, string][];
    usesExportStar: boolean;
    /** The first `export class X` name — what a node script falls back to when it has no default export. */
    firstClass: string | null;
    counter: number;
}

function importCall(spec: string, st: TransformState): string {
    const id = normalizeScriptSpecifier(spec, st.path);
    if (!st.imports.includes(id)) st.imports.push(id);
    return `__cleoImport(${JSON.stringify(id)})`;
}

/** The quoted specifier starting at or after `from`, and the index just past the statement. */
function readSpecifier(source: string, from: number): { specifier: string; quote: number; end: number } {
    let quote = from;
    while (quote < source.length && source[quote] !== '"' && source[quote] !== "'" && source[quote] !== '`') quote++;
    if (quote >= source.length) throw new Error('Malformed import: expected a module name in quotes');
    const specEnd = skipString(source, quote);
    let end = skipTrivia(source, specEnd);
    if (source[end] === ';') end++;
    return { specifier: source.slice(quote + 1, specEnd - 1), quote, end };
}

// `import { a, b as c } from 'cleo'` -> `const { a, b: c } = __cleoImport('cleo');`
// `import * as cleo from 'cleo'`     -> `const cleo = __cleoImport('cleo');`
// `import Default from 'cleo'`       -> `const Default = __cleoImport('cleo').default;`
// `import 'cleo'`                    -> `__cleoImport('cleo');`
// Script-path specifiers are canonicalised here (`'../Shared/Math'` -> `'/Shared/Math'`), so a compiled
// factory never needs to know where its script lives.
function readImport(source: string, afterKeyword: number, st: TransformState): Statement {
    const i = skipTrivia(source, afterKeyword);
    const { specifier, quote, end } = readSpecifier(source, i);

    let clause = source.slice(i, quote).trim();
    if (clause.endsWith('from')) clause = clause.slice(0, -'from'.length).trim();

    const call = importCall(specifier, st);
    if (!clause) return { code: `${call};`, end };

    const statements: string[] = [];
    const alias = `__cleoMod${st.counter++}`;
    statements.push(`const ${alias} = ${call};`);

    const braceAt = clause.indexOf('{');
    const head = (braceAt === -1 ? clause : clause.slice(0, braceAt)).replace(/,\s*$/, '').trim();
    const named = braceAt === -1 ? '' : clause.slice(braceAt + 1, clause.lastIndexOf('}')).trim();

    if (head.startsWith('*')) {
        const name = head.replace(/^\*\s*as\s*/, '').trim();
        statements.push(`const ${name} = ${alias};`);
    } else if (head) {
        statements.push(`const ${head} = ${alias}.default;`);
    }

    if (named) {
        const bindings = named
            .split(',')
            .map(part => part.trim())
            .filter(Boolean)
            .map(part => {
                const as = part.split(/\s+as\s+/);
                return as.length === 2 ? `${as[0].trim()}: ${as[1].trim()}` : part;
            });
        statements.push(`const { ${bindings.join(', ')} } = ${alias};`);
    }

    return { code: statements.join(' '), end };
}

function wordAt(source: string, i: number): { word: string; end: number } {
    let j = i;
    while (j < source.length && IDENT_PART.test(source[j])) j++;
    return { word: source.slice(i, j), end: j };
}

/** The name declared after `class`/`function` (skipping a generator `*`), or '' when anonymous. */
function declaredName(source: string, keywordEnd: number): string {
    let k = skipTrivia(source, keywordEnd);
    if (source[k] === '*') k = skipTrivia(source, k + 1);
    const { word } = wordAt(source, k);
    return word && word !== 'extends' ? word : '';
}

const CONTINUES = /[.,?:+\-*/%&|^=<>!]/;

/**
 * The names an `export const|let|var` declares: `a = 1, b = f(x, y)` -> ['a', 'b']. Scans depth-0 commas
 * up to the statement's end — a `;`, or a newline that does not continue an expression.
 */
function declaratorNames(source: string, from: number): string[] {
    const names: string[] = [];
    let i = skipTrivia(source, from);
    for (;;) {
        if (source[i] === '{' || source[i] === '[')
            throw new Error('`export const { a, b } = …` (a destructured export) is not supported — export each name on its own.');
        const { word, end } = wordAt(source, i);
        if (!word) throw new Error('Malformed export: expected a variable name');
        names.push(word);
        i = end;

        let depth = 0;
        let last = word[word.length - 1];
        let next = -1;
        while (i < source.length) {
            const c = source[i];
            if (c === '/' && source[i + 1] === '/') { const nl = source.indexOf('\n', i); i = nl === -1 ? source.length : nl; continue; }
            if (c === '/' && source[i + 1] === '*') { const e = source.indexOf('*/', i + 2); i = e === -1 ? source.length : e + 2; continue; }
            if (c === '"' || c === "'" || c === '`') { i = skipString(source, i); last = c; continue; }
            if (c === '/' && /[=(,:[!&|?{};]/.test(last)) { i = skipRegex(source, i); last = 'r'; continue; }
            if (c === '{' || c === '(' || c === '[') depth++;
            else if (c === '}' || c === ')' || c === ']') depth--;
            if (depth === 0 && c === ',') { next = skipTrivia(source, i + 1); break; }
            if (depth <= 0 && c === ';') return names;
            if (depth === 0 && c === '\n') {
                const ahead = skipTrivia(source, i);
                if (!CONTINUES.test(last) && !CONTINUES.test(source[ahead] ?? '')) return names;
            }
            if (!/\s/.test(c)) last = c;
            i++;
        }
        if (next < 0) return names;
        i = next;
    }
}

/** Parse `{ a, b as c }` starting at `open` (the `{`). Returns `[exported, local]` pairs and the index past `}`. */
function readExportList(source: string, open: number): { pairs: [string, string][]; end: number } {
    const close = source.indexOf('}', open);
    if (close < 0) throw new Error('Malformed export: missing `}`');
    const pairs = source.slice(open + 1, close).split(',').map(p => p.trim()).filter(Boolean)
        .filter(p => !/^type\s/.test(p))
        .map(p => {
            const as = p.split(/\s+as\s+/);
            return (as.length === 2 ? [as[1].trim(), as[0].trim()] : [p, p]) as [string, string];
        });
    return { pairs, end: close + 1 };
}

/**
 * One top-level `export`, with `j` just past the keyword. Either replaces the whole statement (`code` +
 * `end`) or strips the keyword and lets the scan resume at the declaration (`resume`). Every exported name
 * becomes a live getter on `__cleoExports`, emitted on the header line.
 */
function readExport(source: string, j: number, st: TransformState): { code: string; end?: number; resume?: number } {
    const at = skipTrivia(source, j);
    const getter = (name: string, local: string) => { st.exports.push([name, `return ${local};`]); };

    if (source[at] === '{') {
        const { pairs, end: afterList } = readExportList(source, at);
        const fromAt = skipTrivia(source, afterList);
        if (wordAt(source, fromAt).word === 'from') {
            const { specifier, end } = readSpecifier(source, fromAt);
            const alias = `__cleoRe${st.counter++}`;
            for (const [name, local] of pairs) getter(name, `${alias}[${JSON.stringify(local)}]`);
            return { code: `const ${alias} = ${importCall(specifier, st)};`, end };
        }
        let end = afterList;
        const semi = skipTrivia(source, end);
        if (source[semi] === ';') end = semi + 1;
        for (const [name, local] of pairs) getter(name, local);
        return { code: '', end };
    }

    if (source[at] === '*') {
        const asAt = skipTrivia(source, at + 1);
        if (wordAt(source, asAt).word === 'as') {
            const nameAt = skipTrivia(source, asAt + 2);
            const { word: ns, end: nsEnd } = wordAt(source, nameAt);
            const { specifier, end } = readSpecifier(source, nsEnd);
            const alias = `__cleoRe${st.counter++}`;
            getter(ns, alias);
            return { code: `const ${alias} = ${importCall(specifier, st)};`, end };
        }
        const { specifier, end } = readSpecifier(source, asAt);
        st.usesExportStar = true;
        return { code: `__cleoExportStar(${importCall(specifier, st)});`, end };
    }

    const { word, end: wordEnd } = wordAt(source, at);
    if (word === 'default') {
        const k = skipTrivia(source, wordEnd);
        const next = wordAt(source, k);
        let keywordEnd = -1;
        if (next.word === 'class' || next.word === 'function') keywordEnd = next.end;
        else if (next.word === 'async') {
            const fn = wordAt(source, skipTrivia(source, next.end));
            if (fn.word === 'function') keywordEnd = fn.end;
        }
        const name = keywordEnd >= 0 ? declaredName(source, keywordEnd) : '';
        if (name) { getter('default', name); return { code: '', resume: k }; }
        getter('default', '__cleoDefault');
        return { code: 'const __cleoDefault = ', resume: k };
    }
    if (word === 'class' || word === 'function' || word === 'async') {
        const keywordEnd = word === 'async' ? wordAt(source, skipTrivia(source, wordEnd)).end : wordEnd;
        const name = declaredName(source, keywordEnd);
        if (!name) throw new Error(`Malformed export: \`export ${word}\` needs a name`);
        getter(name, name);
        if (word === 'class' && !st.firstClass) st.firstClass = name;
        return { code: '', resume: at };
    }
    if (word === 'const' || word === 'let' || word === 'var') {
        for (const name of declaratorNames(source, wordEnd)) getter(name, name);
        return { code: '', resume: at };
    }
    throw new Error(`\`export ${word || source[at] || ''}\` is not supported in a script. Export functions, classes, constants and enums by name, or a default.`);
}

function runTransform(source: string, path?: string): { code: string; st: TransformState } {
    const st: TransformState = { path, imports: [], exports: [], usesExportStar: false, firstClass: null, counter: 0 };
    let out = '';
    let i = 0;
    let depth = 0;
    let prevToken = '';

    while (i < source.length) {
        const c = source[i];

        if (c === '/' && source[i + 1] === '/') {
            const nl = source.indexOf('\n', i);
            const end = nl === -1 ? source.length : nl;
            out += source.slice(i, end);
            i = end;
            continue;
        }
        if (c === '/' && source[i + 1] === '*') {
            const close = source.indexOf('*/', i + 2);
            const end = close === -1 ? source.length : close + 2;
            out += source.slice(i, end);
            i = end;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const end = skipString(source, i);
            out += source.slice(i, end);
            prevToken = c;
            i = end;
            continue;
        }
        if (c === '/' && isValuePosition(prevToken)) {
            const end = skipRegex(source, i);
            out += source.slice(i, end);
            prevToken = 'regex';   // a regex literal is a value: a following `/` is division
            i = end;
            continue;
        }
        if (c === '{' || c === '(' || c === '[') { depth++; out += c; prevToken = c; i++; continue; }
        if (c === '}' || c === ')' || c === ']') { depth--; out += c; prevToken = c; i++; continue; }

        if (IDENT_START.test(c)) {
            let j = i;
            while (j < source.length && IDENT_PART.test(source[j])) j++;
            const word = source.slice(i, j);

            // `import(...)` (dynamic) and `import.meta` are expressions, not statements — leave them be.
            const isImportStatement = word === 'import' && depth === 0 && !/[(.]/.test(source[skipTrivia(source, j)] ?? '');

            if (isImportStatement) {
                const statement = readImport(source, j, st);
                out += statement.code + padLines(source.slice(i, statement.end));
                i = statement.end;
                prevToken = ';';
                continue;
            }

            // Exports become live getters on `__cleoExports` (emitted on the header line), so the
            // statement itself only loses its `export` keyword — on the same line, keeping line numbers.
            if (word === 'export' && depth === 0) {
                const result = readExport(source, j, st);
                if (result.resume !== undefined) {
                    out += result.code;
                    prevToken = result.code ? '=' : ';';
                    i = result.resume;
                } else {
                    out += result.code + padLines(source.slice(i, result.end));
                    prevToken = ';';
                    i = result.end!;
                }
                continue;
            }

            out += word;
            prevToken = word;
            i = j;
            continue;
        }

        out += c;
        if (!/\s/.test(c)) prevToken = c;
        i++;
    }

    return { code: out, st };
}

/** The author's source with all module syntax rewritten away (the export getters are not included). */
export function transformScript(source: string, options: { path?: string } = {}): string {
    return runTransform(source, options.path).code;
}

/** The single header line: strict mode, the exports object, and one getter per export. */
function headerLine(st: TransformState, mode: 'node' | 'module'): string {
    let header = '"use strict";';
    if (mode === 'node') header += ' __cleoExports = __cleoExports || {};';
    if (st.usesExportStar)
        header += ' function __cleoExportStar(s) { for (const k of Object.keys(s)) if (k !== "default" && !Object.prototype.hasOwnProperty.call(__cleoExports, k)) Object.defineProperty(__cleoExports, k, { enumerable: true, configurable: true, get: function () { return s[k]; } }); }';
    for (const [name, body] of st.exports)
        header += ` Object.defineProperty(__cleoExports, ${JSON.stringify(name)}, { enumerable: true, configurable: true, get: function () { ${body} } });`;
    return header;
}

/* -------------------------------------------------------------------------- */
/* Wrapper                                                                     */
/* -------------------------------------------------------------------------- */

export interface ScriptCompileOptions {
    /** The script's module id ('/Enemies/Hollow') — needed for `./` and `../` imports. */
    path?: string;
    /**
     * 'node' (default): a node's own script. Returns its class (the default export, else the first
     * exported class), or nothing for a legacy `this.onX = …` script.
     * 'module': a shared module. Returns nothing; everything it offers is on `__cleoExports`.
     */
    mode?: 'node' | 'module';
}

/**
 * The body of a script factory, shared by the two paths that run scripts: the engine evals it through
 * `new Function('__cleoImport', '__cleoExports', body)` (compileScript / compileScriptModule), and the
 * publisher emits it as source inside `function(__cleoImport, __cleoExports) {...}`.
 *
 * Line-preserving: the header (strict mode plus every export getter) is line 1, exactly where the old
 * `"use strict"` was, and the node-mode return is appended AFTER the author's last line — so a runtime
 * error's line number still points at the author's source. The wrapper must stay a plain `function`: a
 * legacy script assigns its handlers to `this`.
 */
export function buildFactoryBody(source: string, options: ScriptCompileOptions = {}): string {
    const mode = options.mode ?? 'node';
    // Sucrase's 'imports' transform stays off, so `import` statements survive for the rewriter. Its
    // TypeScript transform already drops `import type`, `export type`, `export interface` and
    // `export declare`, and turns `export enum` into `export var`.
    const js = transform(source, { transforms: ['typescript'], preserveDynamicImport: true }).code;
    const { code, st } = runTransform(js, options.path);
    let body = `${headerLine(st, mode)}\n${code}`;
    if (mode === 'node') {
        const fallback = st.firstClass ? `__cleoExports[${JSON.stringify(st.firstClass)}]` : 'undefined';
        body += `\n;return __cleoExports.default !== undefined ? __cleoExports.default : ${fallback};`;
    }
    return body;
}

/**
 * The project-path ids a script imports, canonicalised — what the editor ships alongside it. Type-only
 * imports are not included (Sucrase removes them first). Never throws: a script that does not compile
 * imports nothing as far as the closure is concerned, and its own error surfaces when it runs.
 */
export function listScriptImports(source: string, path?: string): string[] {
    try {
        const js = transform(source, { transforms: ['typescript'], preserveDynamicImport: true }).code;
        return runTransform(js, path).st.imports.filter(id => id.startsWith('/'));
    } catch {
        return [];
    }
}

/**
 * Called with `this` bound to the script's node proxy. A class-based script RETURNS its class constructor
 * (attachScriptFactory harvests the prototype's methods); a `this.onX = ...` script returns nothing and
 * its handlers are collected off the proxy instead.
 */
export type ScriptFactory = (this: any, importer: (specifier: string) => ScriptModule, exports?: ScriptModule) => (new (...args: any[]) => any) | void;

// Compiled node-script factories by path + source. A factory is a pure function of its source — each
// node still CALLS it and gets its own class and state — so one compile serves every node running the
// same script. Without it every spawn re-ran the TypeScript transform: four times per hit in Hollow Keep
// (spark, spray, two blood decals), and a whole enemy's scripts on every respawn.
const COMPILED_LIMIT = 256;
const compiled = new Map<string, ScriptFactory>();
let compileCount = 0;

/** How many node scripts were actually compiled (cache misses) this session — for the perf tooling. */
export function scriptCompileCount(): number { return compileCount; }

/** Forget every cached compile — after the compiler's own behaviour changed (tests, hot reload). */
export function clearScriptCompileCache(): void { compiled.clear(); }

/** Compiles a node's script to its factory. Throws on a syntax error or on unsupported module syntax. */
export function compileScript(source: string, options: { path?: string } = {}): ScriptFactory {
    const key = `${options.path ?? ''}::${source}`;
    const hit = compiled.get(key);
    if (hit) {
        // Refresh its place: the Map's insertion order is the eviction order.
        compiled.delete(key);
        compiled.set(key, hit);
        return hit;
    }
    // eslint-disable-next-line no-new-func
    const factory = new Function('__cleoImport', '__cleoExports', buildFactoryBody(source, { path: options.path, mode: 'node' })) as ScriptFactory;
    compileCount++;
    compiled.set(key, factory);
    if (compiled.size > COMPILED_LIMIT) compiled.delete(compiled.keys().next().value as string);
    return factory;
}

/** Compiles a shared module. `id` is its canonical project path; it names the file in devtools stacks. */
export function compileScriptModule(source: string, id: string): ScriptModuleFactory {
    const body = `${buildFactoryBody(source, { path: id, mode: 'module' })}\n//# sourceURL=cleo-script://${id.replace(/\s/g, '%20')}.ts`;
    // eslint-disable-next-line no-new-func
    return new Function('__cleoImport', '__cleoExports', body) as ScriptModuleFactory;
}

let scriptProvider: ((nodeId: string) => ScriptFactory | undefined) | null = null;

/**
 * Register the lookup a NO-EVAL build uses to find a node's precompiled script factory by node id.
 * A published game ships its scripts as functions in game.scripts.js keyed by node id, with no source
 * left in the scene JSON. Nodes made by `Scene.instantiate` are keyed by `__sourceId`, the id they were
 * copied from. The editor never sets this — its scenes carry source and go through `compileScript`.
 */
export function setScriptProvider(provider: ((nodeId: string) => ScriptFactory | undefined) | null): void {
    scriptProvider = provider;
}

/** The factory registered for `nodeId`, or undefined. See {@link setScriptProvider}. */
export function resolveNodeScript(nodeId: string | undefined): ScriptFactory | undefined {
    if (!scriptProvider || !nodeId) return undefined;
    return scriptProvider(nodeId);
}

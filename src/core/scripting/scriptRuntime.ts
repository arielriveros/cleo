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

const modules = new Map<string, ScriptModule>();

/** Makes `exports` importable from scripts as `specifier`. src/cleo.ts registers itself as 'cleo'. */
export function registerScriptModule(specifier: string, exports: ScriptModule): void {
    modules.set(specifier, exports);
}

export function resolveScriptModule(specifier: string): ScriptModule {
    const found = modules.get(specifier);
    if (!found)
        throw new Error(`Cannot import '${specifier}': no such module. Available: ${[...modules.keys()].map(m => `'${m}'`).join(', ')}`);
    return found;
}

/**
 * Builds the `__cleoImport` a single script instance sees. `overrides` replaces exports of the same name
 * with values bound to the node running the script. Only names the module already exports can be
 * overridden, so an override can never smuggle a new global in through an import.
 */
export function createScriptImporter(overrides: ScriptModule = {}): (specifier: string) => ScriptModule {
    return (specifier: string) => {
        const module = resolveScriptModule(specifier);
        const names = Object.keys(overrides).filter(name => name in module);
        if (names.length === 0) return module;

        const scoped: ScriptModule = { ...module };
        for (const name of names) scoped[name] = overrides[name];
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

interface ImportStatement { code: string; end: number }

// `import { a, b as c } from 'cleo'` -> `const { a, b: c } = __cleoImport('cleo');`
// `import * as cleo from 'cleo'`     -> `const cleo = __cleoImport('cleo');`
// `import Default from 'cleo'`       -> `const Default = __cleoImport('cleo').default;`
// `import 'cleo'`                    -> `__cleoImport('cleo');`
function readImport(source: string, afterKeyword: number, index: number): ImportStatement {
    const i = skipTrivia(source, afterKeyword);

    // An import statement contains exactly one string literal — the specifier — so the next one is it.
    let quote = i;
    while (quote < source.length && source[quote] !== '"' && source[quote] !== "'" && source[quote] !== '`') quote++;
    if (quote >= source.length) throw new Error('Malformed import: expected a module name in quotes');

    const specEnd = skipString(source, quote);
    const specifier = source.slice(quote + 1, specEnd - 1);

    let clause = source.slice(i, quote).trim();
    if (clause.endsWith('from')) clause = clause.slice(0, -'from'.length).trim();

    let end = skipTrivia(source, specEnd);
    if (source[end] === ';') end++;

    const importCall = `__cleoImport(${JSON.stringify(specifier)})`;
    if (!clause) return { code: `${importCall};`, end };

    const statements: string[] = [];
    const alias = `__cleoMod${index}`;
    statements.push(`const ${alias} = ${importCall};`);

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

/** The author's source with all module syntax rewritten away. */
export function transformScript(source: string): string {
    let out = '';
    let i = 0;
    let depth = 0;
    let prevToken = '';
    let imports = 0;

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
                const statement = readImport(source, j, imports++);
                out += statement.code + padLines(source.slice(i, statement.end));
                i = statement.end;
                prevToken = ';';
                continue;
            }

            // A class-based script exports its class, so `export [default]` is rewritten to `return` on
            // the SAME line to keep line numbers aligned. Any other top-level `export` is an error.
            if (word === 'export' && depth === 0) {
                const afterExport = skipTrivia(source, j);
                let k = afterExport;
                while (k < source.length && IDENT_PART.test(source[k])) k++;
                let keywordStart = afterExport;
                if (source.slice(afterExport, k) === 'default') {
                    keywordStart = skipTrivia(source, k);
                    let m = keywordStart;
                    while (m < source.length && IDENT_PART.test(source[m])) m++;
                    k = m;
                }
                const keyword = source.slice(keywordStart, k);
                if (keyword === 'class' || keyword === 'abstract') {
                    out += 'return ';
                    prevToken = 'return';
                    i = keywordStart;   // resume at `class`/`abstract`, emitted as a normal identifier
                    continue;
                }
                throw new Error("`export` is only used to export a script's class, e.g. `export default class MyNode extends Node { ... }`");
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

    return out;
}

/* -------------------------------------------------------------------------- */
/* Wrapper                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The body of the script factory, shared by the two paths that run scripts: the engine evals it through
 * `new Function` (compileScript), and the publisher emits it as source inside `function(__cleoImport)
 * {...}`. There is no postamble — a script assigns its handlers to `this`, so the wrapper must stay a
 * plain `function`; an arrow would capture the wrong `this`.
 */
export function buildFactoryBody(source: string): string {
    // Sucrase's 'imports' transform stays off, so `import` statements survive for transformScript.
    const js = transform(source, { transforms: ['typescript'], preserveDynamicImport: true }).code;
    return `"use strict";\n${transformScript(js)}`;
}

/**
 * Called with `this` bound to the script's node proxy. A class-based script RETURNS its class constructor
 * (attachScriptFactory harvests the prototype's methods); a `this.onX = ...` script returns nothing and
 * its handlers are collected off the proxy instead.
 */
export type ScriptFactory = (this: any, importer: (specifier: string) => ScriptModule) => (new (...args: any[]) => any) | void;

/** Compiles a script to its factory. Throws on a syntax error or on unsupported module syntax. */
export function compileScript(source: string): ScriptFactory {
    // eslint-disable-next-line no-new-func
    return new Function('__cleoImport', buildFactoryBody(source)) as ScriptFactory;
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

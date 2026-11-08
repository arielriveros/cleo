// @ts-check
// engine_api: the Cleo scripting API and its docs as small, scoped lookups.
//
// The source is the engine's own type declarations (dist/**/*.d.ts, written by `npm run build`): exactly
// what `import { ... } from 'cleo'` gives a script and what script_write type-checks against, with the
// engine's JSDoc. They are generated from the code, so they cannot drift from it. The docs (docs/**/*.md)
// come along, split at their headings, so one section can be read instead of a whole file.
//
// The index is built once with the TypeScript compiler (a second or two) and cached on disk under the
// agent host's data folder, keyed by the size and time of every declaration and doc file: a rebuilt engine
// or an edited doc rebuilds it on the next lookup. Lookups are in-process and take milliseconds.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';

/** Bumped when the index's shape changes: an old cache is then rebuilt. */
const FORMAT = 1;
const SIG_MAX = 300;
const SEARCH_BUDGET = 3500;
const SYMBOL_BUDGET = 8000;
const DOC_BUDGET = 6000;

/**
 * @typedef {{ id: string, name: string, container: string | null, kind: string, sig: string, doc: string,
 *   src: string, base?: string, static?: boolean, access?: string, members?: number }} Entry
 * @typedef {{ id: string, file: string, title: string, text: string }} Section
 * @typedef {{ format: number, fingerprint: string, builtAt: string, entries: Entry[], sections: Section[] }} IndexData
 */

// --- files -----------------------------------------------------------------------------------------------

/** @param {string} dir @param {(name: string) => boolean} keep @returns {string[]} absolute paths */
function walk(dir, keep, skipDirs = new Set(['node_modules', 'media'])) {
    /** @type {string[]} */
    const out = [];
    const visit = (/** @type {string} */ d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (!skipDirs.has(e.name)) visit(p); } else if (keep(e.name)) out.push(p);
        }
    };
    visit(dir);
    return out.sort();
}

/** Size and time of every input: the cache is valid while this is unchanged. @param {string} engineRoot */
function fingerprint(engineRoot) {
    const h = crypto.createHash('sha1').update(`${FORMAT}|${ts.version}|`);
    for (const f of [...walk(path.join(engineRoot, 'dist'), n => n.endsWith('.d.ts')), ...walk(path.join(engineRoot, 'docs'), n => n.endsWith('.md'))]) {
        const st = fs.statSync(f);
        h.update(`${path.relative(engineRoot, f)}|${st.size}|${Math.round(st.mtimeMs)}\n`);
    }
    return h.digest('hex');
}

// --- building the index ----------------------------------------------------------------------------------

/** @param {string} s */
const oneLine = s => s.replace(/\s+/g, ' ').trim();
/** @param {string} s @param {number} n */
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** @param {string} doc */
const firstSentence = doc => {
    const flat = oneLine(doc);
    const m = /^(.{20,}?[.!?])(\s|$)/.exec(flat);
    return cut(m ? m[1] : flat, 220);
};

/** A declaration's own text without its JSDoc, on one line: a class or interface only up to its body. @param {ts.Node} node */
function declText(node) {
    const sf = node.getSourceFile();
    let text = node.getText(sf);
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isModuleDeclaration(node) || ts.isEnumDeclaration(node)) {
        const brace = text.indexOf('{');
        if (brace > 0) text = text.slice(0, brace);
    }
    // Comments inside a declaration (a type literal's field docs) read as noise on one line.
    text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    return cut(oneLine(text.replace(/^export\s+/, '').replace(/^declare\s+/, '').replace(/;$/, '')), SIG_MAX);
}

const KEPT_TAGS = new Set(['param', 'returns', 'return', 'example', 'deprecated', 'throws', 'see', 'default', 'remarks']);

/**
 * A declaration's JSDoc, read straight off its node: the comment, then the tags worth showing. (The checker's
 * getDocumentationComment would also walk base types for inherited docs, which costs seconds over the whole
 * API; inherited members are not listed here anyway.)
 * @param {ts.Node} node
 */
function jsDocText(node) {
    // A variable's JSDoc sits on its statement.
    const host = ts.isVariableDeclaration(node) ? node.parent?.parent ?? node : node;
    /** @type {string[]} */
    const out = [];
    for (const d of /** @type {any[]} */ (/** @type {any} */ (host).jsDoc ?? [])) {
        const comment = typeof d.comment === 'string' ? d.comment : ts.getTextOfJSDocComment(d.comment) ?? '';
        if (comment.trim()) out.push(comment.trim());
        for (const tag of d.tags ?? []) {
            const name = tag.tagName?.text;
            if (!KEPT_TAGS.has(name)) continue;
            const param = tag.name ? `${tag.name.getText()} ` : '';
            const text = typeof tag.comment === 'string' ? tag.comment : ts.getTextOfJSDocComment(tag.comment) ?? '';
            out.push(`@${name} ${param}${text}`.trim());
        }
    }
    return out.join('\n');
}

/** @param {ts.Node} node */
function modifiers(node) {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
    return {
        isStatic: mods.some(m => m.kind === ts.SyntaxKind.StaticKeyword),
        isPrivate: mods.some(m => m.kind === ts.SyntaxKind.PrivateKeyword),
        isProtected: mods.some(m => m.kind === ts.SyntaxKind.ProtectedKeyword),
    };
}

/** @param {ts.Declaration} decl */
function kindOf(decl) {
    if (ts.isClassDeclaration(decl)) return 'class';
    if (ts.isInterfaceDeclaration(decl)) return 'interface';
    if (ts.isFunctionDeclaration(decl)) return 'function';
    if (ts.isEnumDeclaration(decl)) return 'enum';
    if (ts.isTypeAliasDeclaration(decl)) return 'type';
    if (ts.isVariableDeclaration(decl)) return (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) ? 'const' : 'let';
    if (ts.isModuleDeclaration(decl) || ts.isSourceFile(decl)) return 'namespace';
    return 'value';
}

/** The engine source a declaration came from: dist/x/y.d.ts -> src/x/y.ts when that exists. */
function srcOf(/** @type {string} */ fileName, /** @type {string} */ engineRoot) {
    const dist = path.join(engineRoot, 'dist');
    const rel = path.relative(dist, fileName);
    if (rel.startsWith('..')) {
        const nm = fileName.replace(/\\/g, '/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
        return nm ? nm[1] : path.basename(fileName);
    }
    const src = path.join('src', rel.replace(/\.d\.ts$/, '.ts'));
    return (fs.existsSync(path.join(engineRoot, src)) ? src : path.join('dist', rel)).replace(/\\/g, '/');
}

/**
 * Index everything the `cleo` module exports, and the members of its classes, interfaces and namespaces.
 * @param {string} engineRoot @returns {Entry[]}
 */
export function indexDeclarations(engineRoot) {
    const barrel = path.join(engineRoot, 'dist', 'cleo.d.ts');
    if (!fs.existsSync(barrel)) throw new Error(`The engine's type declarations are missing (${barrel}). Run "npm run build" in ${engineRoot}.`);
    const program = ts.createProgram([barrel], {
        noEmit: true, skipLibCheck: true, noLib: true, types: [],
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Node10,
    });
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(barrel);
    const moduleSym = sf && checker.getSymbolAtLocation(sf);
    if (!moduleSym) throw new Error(`Could not read ${barrel}.`);

    /** @type {Entry[]} */
    const entries = [];
    const seen = new Set();
    /** @param {Entry} e */
    const add = e => { if (!seen.has(e.id)) { seen.add(e.id); entries.push(e); } };

    /** @param {string} container @param {readonly ts.Node[]} members @param {string} src */
    const addMembers = (container, members, src) => {
        /** @type {Map<string, Entry>} */
        const byName = new Map();
        let count = 0;
        for (const m of members) {
            if (ts.isIndexSignatureDeclaration(m) || ts.isClassStaticBlockDeclaration(m)) continue;
            const isCtor = ts.isConstructorDeclaration(m) || ts.isConstructSignatureDeclaration(m);
            const nameNode = /** @type {any} */ (m).name;
            const name = isCtor ? 'constructor' : nameNode && (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) ? nameNode.text : null;
            if (!name || name.startsWith('_') || name.startsWith('#')) continue;
            const mods = modifiers(m);
            if (mods.isPrivate) continue;
            const sig = declText(m);
            const id = `${container}.${name}`;
            const prev = byName.get(id);
            if (prev) {
                // Overloads and get/set pairs: one entry, every signature.
                if (!prev.sig.includes(sig)) prev.sig = cut(`${prev.sig} | ${sig}`, SIG_MAX * 2);
                if (!prev.doc) prev.doc = jsDocText(m);
                continue;
            }
            const e = {
                id, name, container,
                kind: isCtor ? 'constructor' : ts.isMethodDeclaration(m) || ts.isMethodSignature(m) ? 'method'
                    : ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m) ? 'accessor' : 'property',
                sig, doc: jsDocText(m), src,
                ...(mods.isStatic ? { static: true } : {}), ...(mods.isProtected ? { access: 'protected' } : {}),
            };
            byName.set(id, e);
            add(e);
            count++;
        }
        return count;
    };

    for (const exp of checker.getExportsOfModule(moduleSym)) {
        const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
        const decls = sym.declarations ?? [];
        if (!decls.length) continue;
        const name = exp.name;
        // The declaration that says what it is: a class over its merged interface, a namespace last.
        const decl = decls.find(d => ts.isClassDeclaration(d)) ?? decls.find(d => !ts.isModuleDeclaration(d) && !ts.isSourceFile(d)) ?? decls[0];
        const src = srcOf(decl.getSourceFile().fileName, engineRoot);
        const kind = kindOf(decl);
        /** @type {Entry} */
        const entry = { id: name, name, container: null, kind, sig: '', doc: decls.map(jsDocText).filter(Boolean).join('\n'), src };

        if (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) {
            entry.sig = `${kind} ${name}${(decl.heritageClauses ?? []).map(h => ` ${oneLine(h.getText())}`).join('')}`;
            const ext = decl.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
            if (ext) entry.base = ext.expression.getText();
            add(entry);
            entry.members = addMembers(name, decls.filter(d => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d))
                .flatMap(d => [.../** @type {any} */ (d).members]), src);
        } else if (ts.isFunctionDeclaration(decl)) {
            entry.sig = cut(decls.filter(ts.isFunctionDeclaration).map(d => declText(d).replace(/^function\s+/, 'function ')).join(' | '), SIG_MAX * 2);
            add(entry);
        } else if (ts.isEnumDeclaration(decl)) {
            entry.sig = `enum ${name} { ${decl.members.map(m => m.name.getText()).join(', ')} }`;
            add(entry);
        } else if (ts.isVariableDeclaration(decl)) {
            entry.sig = `${kind} ${declText(decl)}`;
            add(entry);
        } else if (kind === 'namespace') {
            entry.sig = `namespace ${name}`;
            add(entry);
            let count = 0;
            for (const m of checker.getExportsOfModule(sym)) {
                const ms = m.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(m) : m;
                const md = ms.declarations?.[0];
                if (!md || m.name.startsWith('_')) continue;
                add({ id: `${name}.${m.name}`, name: m.name, container: name, kind: kindOf(md), sig: declText(md), doc: jsDocText(md), src: srcOf(md.getSourceFile().fileName, engineRoot) });
                count++;
            }
            entry.members = count;
        } else {
            entry.sig = declText(decl);
            add(entry);
        }
    }
    return entries;
}

/** GitHub-style heading anchor. @param {string} text */
export function slug(text) {
    return text.toLowerCase().replace(/[`*_~[\]()]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
}

/**
 * The docs, split at #, ## and ### headings (never inside code fences). Each section carries the path of
 * headings above it, so "Transforms" under "Node API" reads as "Node API › Transforms".
 * @param {string} engineRoot @returns {Section[]}
 */
export function indexDocs(engineRoot) {
    const docsDir = path.join(engineRoot, 'docs');
    /** @type {Section[]} */
    const sections = [];
    for (const file of walk(docsDir, n => n.endsWith('.md'))) {
        const rel = path.relative(docsDir, file).replace(/\\/g, '/');
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        /** @type {string[]} */
        const trail = [];
        let current = /** @type {{ title: string, slug: string, lines: string[] } | null} */ (null);
        let fence = false;
        const used = new Map();
        const flush = () => {
            if (!current) return;
            const text = current.lines.join('\n').trim();
            if (text) sections.push({ id: `${rel}#${current.slug}`, file: rel, title: current.title, text });
        };
        for (const line of lines) {
            if (/^\s*(```|~~~)/.test(line)) fence = !fence;
            const m = !fence && /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
            if (m) {
                flush();
                const level = m[1].length;
                trail.length = level - 1;
                trail[level - 1] = m[2].replace(/`/g, '');
                let s = slug(m[2]);
                const n = used.get(s) ?? 0;
                used.set(s, n + 1);
                if (n) s = `${s}-${n}`;
                current = { title: trail.filter(Boolean).join(' › '), slug: s, lines: [] };
            } else if (current) {
                current.lines.push(line);
            } else if (line.trim()) {
                current = { title: rel, slug: '', lines: [line] };
            }
        }
        flush();
    }
    return sections;
}

/** A member in a compact list: `setPosition(pos)`, `name`. @param {Entry} m */
function shortMember(m) {
    if (m.kind !== 'method' && m.kind !== 'constructor' && m.kind !== 'function') return m.name;
    const params = /^[^(]*\(([^)]*)\)/.exec(m.sig.replace(/^((static|readonly|protected|abstract)\s+)+/, ''))?.[1] ?? '';
    const names = params.split(',').map(p => p.trim().replace(/^\.\.\./, '...').split(/[?:\s=]/)[0]).filter(Boolean);
    return `${m.kind === 'constructor' ? 'constructor' : m.name}(${names.join(', ')})`;
}

/** Levenshtein distance, giving up past `max`. @param {string} a @param {string} b @param {number} max */
function editDistance(a, b, max) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            best = Math.min(best, cur[j]);
        }
        if (best > max) return max + 1;
        prev = cur;
    }
    return prev[b.length];
}

// --- search ------------------------------------------------------------------------------------------------

/** Words of an identifier or a sentence: camelCase and snake_case split, lowercased, plurals trimmed. @param {string} s */
export function tokens(s) {
    const out = [];
    for (const word of s.split(/[^A-Za-z0-9]+/)) {
        if (!word) continue;
        for (const part of word.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
            let t = part.toLowerCase();
            if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
            if (t) out.push(t);
        }
    }
    return out;
}

/** @typedef {{ entry: Entry, name: Set<string>, container: Set<string>, doc: Set<string>, sig: Set<string>, lower: string }} Prepared */

export class EngineApi {
    /** @param {{ engineRoot: string, cacheDir: string, log?: (m: string) => void }} opts */
    constructor(opts) {
        this.engineRoot = opts.engineRoot;
        this.cacheDir = opts.cacheDir;
        this.log = opts.log ?? (() => {});
        /** @type {Promise<void> | null} */
        this.loading = null;
        /** @type {IndexData | null} */
        this.data = null;
        /** @type {Prepared[]} */
        this.prepared = [];
        /** @type {{ section: Section, heading: Set<string>, body: Map<string, number> }[]} */
        this.preparedDocs = [];
        /** @type {Map<string, number>} */
        this.idf = new Map();
        this.stale = false;
        /** How the last load went, for tests and logs: 'cache' or 'build'. */
        this.lastLoad = '';
        this.checkedAt = 0;
    }

    get cacheFile() {
        const key = crypto.createHash('sha1').update(path.resolve(this.engineRoot).toLowerCase()).digest('hex').slice(0, 12);
        return path.join(this.cacheDir, `${key}.json`);
    }

    /** Load the index (from the cache when the inputs are unchanged, else built and cached). Rechecked every 30 s. */
    load() {
        if (this.loading && Date.now() - this.checkedAt < 30_000) return this.loading;
        this.checkedAt = Date.now();
        this.loading = this._load().catch(err => { this.loading = null; throw err; });
        return this.loading;
    }

    async _load() {
        const fp = fingerprint(this.engineRoot);
        if (this.data?.fingerprint === fp) return;
        /** @type {IndexData | null} */
        let data = null;
        try {
            const cached = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
            if (cached?.format === FORMAT && cached.fingerprint === fp) data = cached;
        } catch { /* no cache yet */ }
        if (data) {
            this.lastLoad = 'cache';
        } else {
            const t0 = Date.now();
            data = { format: FORMAT, fingerprint: fp, builtAt: new Date().toISOString(), entries: indexDeclarations(this.engineRoot), sections: indexDocs(this.engineRoot) };
            this.lastLoad = 'build';
            this.log(`engine_api: indexed ${data.entries.length} symbols and ${data.sections.length} doc sections in ${Date.now() - t0} ms`);
            try {
                fs.mkdirSync(this.cacheDir, { recursive: true });
                fs.writeFileSync(this.cacheFile, JSON.stringify(data));
            } catch (err) { this.log(`engine_api: could not cache the index: ${/** @type {any} */ (err)?.message ?? err}`); }
        }
        this.data = data;
        this.prepare();
        this.stale = this.sourceNewerThanDist();
    }

    /** Whether the engine source changed after its declarations were written (they then miss recent API). */
    sourceNewerThanDist() {
        try {
            const dist = fs.statSync(path.join(this.engineRoot, 'dist', 'cleo.d.ts')).mtimeMs;
            const newest = walk(path.join(this.engineRoot, 'src'), n => n.endsWith('.ts') && !n.endsWith('.d.ts'))
                .reduce((max, f) => Math.max(max, fs.statSync(f).mtimeMs), 0);
            return newest > dist + 2000;
        } catch { return false; }
    }

    prepare() {
        const data = /** @type {IndexData} */ (this.data);
        /** @type {Map<string, number>} */
        const df = new Map();
        const count = (/** @type {Iterable<string>} */ set) => { for (const t of set) df.set(t, (df.get(t) ?? 0) + 1); };
        this.prepared = data.entries.map(entry => {
            const p = {
                entry, lower: entry.name.toLowerCase(),
                name: new Set([...tokens(entry.name), entry.name.toLowerCase()]),
                container: new Set(entry.container ? tokens(entry.container) : []),
                doc: new Set(tokens(entry.doc.slice(0, 400))),
                sig: new Set(tokens(entry.sig)),
            };
            count(new Set([...p.name, ...p.doc]));
            return p;
        });
        const n = this.prepared.length || 1;
        this.idf = new Map([...df].map(([t, c]) => [t, Math.log(1 + n / c)]));
        this.preparedDocs = data.sections.map(section => {
            /** @type {Map<string, number>} */
            const body = new Map();
            for (const t of tokens(section.text)) body.set(t, Math.min(3, (body.get(t) ?? 0) + 1));
            return { section, heading: new Set(tokens(section.title)), body };
        });
    }

    /** @param {string} t */
    weight(t) { return this.idf.get(t) ?? Math.log(1 + (this.prepared.length || 1)); }

    /** @param {string} query */
    rankSymbols(query) {
        const q = [...new Set(tokens(query))];
        const whole = query.trim().toLowerCase();
        /** @type {{ p: Prepared, score: number }[]} */
        const hits = [];
        for (const p of this.prepared) {
            let score = 0;
            let matched = 0;
            for (const t of q) {
                const w = this.weight(t);
                let s = 0;
                if (p.lower === t) s += 8 * w;
                else if (p.name.has(t)) s += 4 * w;
                else if (t.length >= 3 && [...p.name].some(n => n.startsWith(t))) s += 2 * w;
                if (p.container.has(t)) s += 1.5 * w;
                if (p.doc.has(t)) s += 1 * w;
                if (p.sig.has(t)) s += 0.3 * w;
                if (s > 0) matched++;
                score += s;
            }
            if (!score) continue;
            const coverage = matched / q.length;
            score *= 0.4 + coverage * coverage;
            if (p.entry.id.toLowerCase() === whole) score += 50;
            else if (p.lower === whole) score += 25;
            if (p.entry.access === 'protected') score *= 0.9;
            hits.push({ p, score });
        }
        return hits.sort((a, b) => b.score - a.score);
    }

    /** @param {string} query */
    rankDocs(query) {
        const q = [...new Set(tokens(query))];
        /** @type {{ section: Section, score: number }[]} */
        const hits = [];
        for (const d of this.preparedDocs) {
            let score = 0;
            let matched = 0;
            for (const t of q) {
                const w = this.weight(t);
                const s = (d.heading.has(t) ? 4 * w : 0) + (d.body.get(t) ?? 0) * 0.6 * w;
                if (s > 0) matched++;
                score += s;
            }
            if (!score) continue;
            const coverage = matched / q.length;
            hits.push({ section: d.section, score: score * (0.3 + coverage * coverage) });
        }
        return hits.sort((a, b) => b.score - a.score);
    }

    // --- answers -------------------------------------------------------------------------------------------

    note() {
        return this.stale ? '\n(Note: the engine source is newer than its type declarations, so recent API may be missing: run "npm run build" in the engine root.)' : '';
    }

    /** A member's signature as code: `Animator.playAction(name: string): boolean`, `new Scene()`. @param {Entry} e @param {string} sig */
    qualified(e, sig) {
        const bare = sig.replace(/^((static|readonly|protected|abstract|public|declare)\s+)+/, '');
        if (e.kind === 'constructor') return `new ${e.container}${bare.replace(/^constructor/, '')}`;
        const accessor = /^(get|set)\s+/.exec(bare);
        return `${e.static ? 'static ' : ''}${accessor ? accessor[0] : ''}${e.container}.${accessor ? bare.slice(accessor[0].length) : bare}`;
    }

    /** One line for a symbol in a list. @param {Entry} e */
    line(e) {
        const head = e.container ? this.qualified(e, e.sig.split(' | ')[0]) : e.sig;
        const more = e.members ? ` (${e.members} members: engine_api {symbol:"${e.id}"})` : '';
        const doc = e.doc ? ` — ${firstSentence(e.doc)}` : '';
        return cut(`${head}${doc}${more} [${e.src}]`, 420);
    }

    /** @param {{ query?: string, symbol?: string, doc?: string, limit?: number }} args */
    async answer(args) {
        const given = ['query', 'symbol', 'doc'].filter(k => typeof /** @type {any} */ (args)[k] === 'string' && /** @type {any} */ (args)[k].trim());
        if (given.length !== 1) throw new Error('Give exactly one of query (words to search), symbol ("Animator" or "Animator.playAction") or doc ("scripting/node-api.md#transforms").');
        await this.load();
        if (args.query) return { text: this.search(args.query, args.limit ?? 12) };
        if (args.symbol) return { text: this.symbol(args.symbol) };
        return { text: this.doc(/** @type {string} */ (args.doc)) };
    }

    /** @param {string} query @param {number} limit */
    search(query, limit = 12) {
        const symbols = this.rankSymbols(query);
        const docs = this.rankDocs(query).slice(0, 4);
        if (!symbols.length && !docs.length) return `Nothing in the engine API or docs matches "${query}". Try other words, or a class name.${this.note()}`;
        const lines = [`engine_api "${query}": ${Math.min(limit, symbols.length)} of ${symbols.length} symbols`];
        let used = lines[0].length;
        for (const { p } of symbols.slice(0, limit)) {
            const l = this.line(p.entry);
            if (used + l.length > SEARCH_BUDGET) break;
            lines.push(l);
            used += l.length + 1;
        }
        if (docs.length) {
            lines.push('Docs (engine_api {doc:"<id>"} reads one section):');
            for (const { section } of docs) lines.push(cut(`${section.id} — ${section.title}: ${oneLine(section.text)}`, 240));
        }
        return lines.join('\n') + this.note();
    }

    /** @param {string} id */
    find(id) {
        const want = id.trim().replace(/\(\)$/, '').toLowerCase();
        const entries = /** @type {IndexData} */ (this.data).entries;
        const exact = entries.find(e => e.id.toLowerCase() === want);
        if (exact) return [exact];
        if (!want.includes('.')) {
            const members = entries.filter(e => e.container && e.name.toLowerCase() === want);
            if (members.length) return members;
        }
        return [];
    }

    /** Names within a couple of typos of `id` (its last part), then search hits: what a "did you mean" offers. @param {string} id */
    closest(id) {
        const parts = id.trim().split('.');
        const last = parts[parts.length - 1].toLowerCase();
        const container = parts.length > 1 ? parts[0].toLowerCase() : null;
        const max = Math.max(2, Math.floor(last.length / 4));
        const near = /** @type {{ e: Entry, d: number }[]} */ ([]);
        for (const p of this.prepared) {
            if (Math.abs(p.lower.length - last.length) > max) continue;
            const d = editDistance(p.lower, last, max);
            if (d > max) continue;
            const e = p.entry;
            near.push({ e, d: d + (container && e.container?.toLowerCase() !== container ? 1 : 0) + (e.container ? 0.5 : 0) });
        }
        const ids = near.sort((a, b) => a.d - b.d).map(n => n.e.id);
        for (const h of this.rankSymbols(id.replace(/\./g, ' ')).slice(0, 8)) if (!ids.includes(h.p.entry.id)) ids.push(h.p.entry.id);
        return ids.slice(0, 8);
    }

    /** @param {string} id */
    symbol(id) {
        const found = this.find(id);
        if (!found.length) {
            const near = this.closest(id);
            return `No API symbol "${id}".${near.length ? ` Closest: ${near.join(', ')}.` : ''} Search with engine_api {query:"..."}.${this.note()}`;
        }
        if (found.length > 1) {
            return `"${id}" is a member of several types:\n${found.slice(0, 20).map(e => this.line(e)).join('\n')}\nAsk for one: engine_api {symbol:"${found[0].id}"}.${this.note()}`;
        }
        const e = found[0];
        const out = e.container
            ? [`${e.access === 'protected' ? 'protected ' : ''}${e.kind} of ${e.container}  [${e.src}]`, ...e.sig.split(' | ').map(s => this.qualified(e, s))]
            : [`${e.sig}  [${e.src}]`];
        if (e.doc) out.push(cut(e.doc, e.container ? 3000 : 1500));
        const entries = /** @type {IndexData} */ (this.data).entries;
        if (e.base) {
            const base = entries.find(x => !x.container && x.name === e.base?.replace(/<.*$/, ''));
            out.push(base ? `Inherits ${base.name}'s members too: engine_api {symbol:"${base.name}"}.` : `Extends ${e.base}.`);
        }
        if (!e.container && e.members) {
            const members = entries.filter(x => x.container === e.id);
            const groups = /** @type {[string, Entry[]][]} */ ([
                ['Constructor', members.filter(m => m.kind === 'constructor')],
                ['Properties', members.filter(m => (m.kind === 'property' || m.kind === 'accessor' || m.kind === 'const' || m.kind === 'let') && !m.static)],
                ['Methods', members.filter(m => (m.kind === 'method' || m.kind === 'function') && !m.static)],
                ['Static', members.filter(m => m.static)],
                ['Other', members.filter(m => !['constructor', 'property', 'accessor', 'const', 'let', 'method', 'function'].includes(m.kind) && !m.static)],
            ]);
            // Every member with its signature and first doc sentence when that fits; a big class (Node has well
            // over a hundred) gets every member by name instead, so none is hidden past the budget.
            const full = [];
            for (const [title, list] of groups) {
                if (!list.length) continue;
                full.push(`${title}:`);
                for (const m of list) {
                    full.push(cut(`  ${m.access === 'protected' ? '(protected) ' : ''}${m.sig.replace(/^((static|readonly|protected|abstract)\s+)+/, '')}${m.doc ? ` — ${firstSentence(m.doc)}` : ''}`, 360));
                }
            }
            const head = out.join('\n');
            if (head.length + full.join('\n').length + 1 <= SYMBOL_BUDGET) return `${head}\n${full.join('\n')}${this.note()}`;
            const compact = [`${members.length} members, by name (engine_api {symbol:"${e.id}.<name>"} gives one's signature and doc):`];
            for (const [title, list] of groups) {
                if (list.length) compact.push(`${title} (${list.length}): ${list.map(shortMember).join(', ')}`);
            }
            return cut(`${head}\n${compact.join('\n')}`, SYMBOL_BUDGET) + this.note();
        }
        return out.join('\n') + this.note();
    }

    /** One docs section by id ("scripting/node-api.md#transforms"), or a file's list of sections. @param {string} id */
    doc(id) {
        const sections = /** @type {IndexData} */ (this.data).sections;
        const want = id.trim().replace(/^cleo:\/\/docs\//, '').replace(/^docs\//, '').toLowerCase();
        if (want.includes('#')) {
            const s = sections.find(x => x.id.toLowerCase() === want);
            if (s) return `${s.title}  [docs/${s.file}]\n${cut(s.text, DOC_BUDGET)}${s.text.length > DOC_BUDGET ? '\n… (cut; the whole file is the cleo://docs/ resource)' : ''}`;
        }
        const file = want.split('#')[0];
        const inFile = sections.filter(s => s.file.toLowerCase() === file);
        if (inFile.length) {
            return `${want.includes('#') ? `No section "${id}". ` : ''}docs/${inFile[0].file} has ${inFile.length} sections (engine_api {doc:"<id>"}):\n`
                + inFile.map(s => `${s.id} — ${s.title} (${s.text.length} chars)`).join('\n');
        }
        const near = this.rankDocs(want.replace(/[#/.\-]/g, ' ')).slice(0, 6).map(h => h.section.id);
        return `No docs section "${id}".${near.length ? ` Closest: ${near.join(', ')}.` : ''}`;
    }
}

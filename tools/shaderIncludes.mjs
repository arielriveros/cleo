// `#include "..."` resolution for shader sources, in one place.
//
// The directive syntax is deliberately identical to what `ts-shader-loader` already accepts for GLSL —
// line-anchored, quoted, optional trailing semicolon, resolved relative to the including file — so the
// two shader trees do not end up with two conventions. WGSL has no include mechanism of its own, and it
// needs one badly: a program becomes a single module holding both entry points, so the code that used
// to be shared by pairing one vertex shader with many fragment shaders (screen.vs alone serves 27
// programs) has to be shared textually instead.
//
// Unlike ts-shader-loader this tracks the include stack, so a cycle is reported rather than recursing
// until the stack blows.

const INCLUDE = /^[ \t]*#include\s+"([./\w-]+)";?[ \t]*$/gim;

/**
 * Expand every `#include` in `source`.
 *
 * `read(resolvedPath)` returns the file's text; `resolve(fromDir, relative)` returns an absolute-ish
 * key. Both are injected so this works against a filesystem (the webpack loader, the vitest plugin) or
 * against an in-memory map (tests) without knowing which.
 *
 * `onDependency` is called with every resolved path, so the loader can register watch dependencies —
 * without it, editing an included chunk would not rebuild its includers.
 */
export function resolveIncludes(source, fromDir, { read, resolve, onDependency, stack = [], defines } = {}) {
    const expanded = expandIncludes(source, fromDir, { read, resolve, onDependency, stack });
    // Conditionals are evaluated once, over the fully expanded text, so a chunk's `#if` sees the
    // defines its top-level file (or the caller's variant) set before including it.
    return stack.length === 0 ? preprocess(expanded, defines) : expanded;
}

function expandIncludes(source, fromDir, { read, resolve, onDependency, stack }) {
    return source.replace(INCLUDE, (whole, relative) => {
        const target = resolve(fromDir, relative);

        if (stack.includes(target)) {
            const cycle = [...stack, target].map(p => p.split(/[\\/]/).pop()).join(' -> ');
            throw new Error(`shader include cycle: ${cycle}`);
        }

        let text;
        try {
            text = read(target);
        } catch {
            throw new Error(`shader include not found: "${relative}" (from ${fromDir})`);
        }

        if (onDependency) onDependency(target);

        const dir = target.replace(/[\\/][^\\/]*$/, '');
        // Included text keeps its own line structure; a marker comment survives into the generated GLSL
        // and is the only breadcrumb back to the origin file once naga has mangled every identifier.
        const inner = resolveIncludes(text, dir, { read, resolve, onDependency, stack: [...stack, target] });
        return `// --- begin ${relative} ---\n${inner}\n// --- end ${relative} ---`;
    });
}

// --- Conditional compilation ---------------------------------------------------------------------
//
// WGSL has no preprocessor, and a variant of a program (a shadow filter, a stripped particle module)
// used to mean a second copy of its source. This is the minimum C-like subset that avoids that:
//
//   #define NAME [integer]      #undef NAME
//   #ifdef NAME / #ifndef NAME  #if EXPR / #elif EXPR / #else / #endif
//
// EXPR: integers, names (an undefined name is 0, as in C), defined(NAME), ! && || == != < > <= >= and
// parentheses. There is NO macro substitution in code: a define only steers conditionals, so a WGSL
// identifier can never be rewritten behind its author's back.
//
// Directive lines and skipped lines become BLANK lines rather than disappearing, so a naga diagnostic's
// line number still points at the composed source the author can reproduce. WGSL itself never uses
// `#`, so any other line starting with one is an error rather than something to pass through.

// `[^\r]*\r?`: half the sources are CRLF, and `.` stops at the `\r` left after splitting on `\n`.
const DIRECTIVE = /^[ \t]*#[ \t]*(\w+)\b([^\r]*)\r?$/;

/** Evaluate `#if`-family directives in `text`. `defines` seeds the table (a variant's NAME=VAL pairs). */
export function preprocess(text, defines = {}) {
    const table = new Map(Object.entries(defines ?? {}).map(([k, v]) => [k, Number(v)]));
    const lines = text.split('\n');
    // One frame per open #if: whether this branch is live, whether any branch was taken, whether the
    // enclosing context is live, and whether #else was seen.
    const stack = [];
    const live = () => stack.every(f => f.active);
    const where = (i) => {
        for (let j = i; j >= 0; j--) {
            const m = /\/\/ --- begin (.+) ---/.exec(lines[j]);
            if (m) return ` (in ${m[1]}, composed line ${i + 1})`;
        }
        return ` (composed line ${i + 1})`;
    };

    for (let i = 0; i < lines.length; i++) {
        const m = DIRECTIVE.exec(lines[i]);
        if (!m) {
            if (!live()) lines[i] = '';
            continue;
        }
        const [, directive, rest] = m;
        const arg = rest.trim();
        lines[i] = '';
        switch (directive) {
            case 'define': {
                if (!live()) break;
                const d = /^(\w+)(?:\s+(-?\d+))?\s*$/.exec(arg);
                if (!d) throw new Error(`#define needs NAME [integer]: "${arg}"` + where(i));
                table.set(d[1], d[2] === undefined ? 1 : Number(d[2]));
                break;
            }
            case 'undef':
                if (live()) table.delete(arg);
                break;
            case 'ifdef':
            case 'ifndef':
            case 'if': {
                const parentLive = live();
                let cond = false;
                if (parentLive) {
                    if (directive === 'if') cond = evaluate(arg, table, where(i));
                    else cond = table.has(arg) === (directive === 'ifdef');
                }
                stack.push({ active: parentLive && cond, taken: cond, parentLive, sawElse: false });
                break;
            }
            case 'elif': {
                const f = stack.at(-1);
                if (!f) throw new Error('#elif without #if' + where(i));
                if (f.sawElse) throw new Error('#elif after #else' + where(i));
                const cond = f.parentLive && !f.taken && evaluate(arg, table, where(i));
                f.active = cond;
                f.taken = f.taken || cond;
                break;
            }
            case 'else': {
                const f = stack.at(-1);
                if (!f) throw new Error('#else without #if' + where(i));
                if (f.sawElse) throw new Error('second #else' + where(i));
                f.sawElse = true;
                f.active = f.parentLive && !f.taken;
                f.taken = true;
                break;
            }
            case 'endif':
                if (!stack.pop()) throw new Error('#endif without #if' + where(i));
                break;
            case 'include':
                throw new Error('unresolved #include' + where(i));
            default:
                throw new Error(`unknown shader directive #${directive}` + where(i));
        }
    }
    if (stack.length) throw new Error(`${stack.length} unterminated #if block(s)`);
    return lines.join('\n');
}

function evaluate(expression, table, where) {
    const tokens = expression.match(/\d+|\w+|&&|\|\||==|!=|<=|>=|[!<>()]/g) ?? [];
    if (tokens.join('') !== expression.replace(/\s+/g, ''))
        throw new Error(`cannot parse #if expression "${expression}"` + where);
    let p = 0;
    const peek = () => tokens[p];
    const take = (t) => {
        if (tokens[p] !== t) throw new Error(`expected "${t}" in #if "${expression}"` + where);
        p++;
    };
    const primary = () => {
        const t = tokens[p++];
        if (t === undefined) throw new Error(`truncated #if "${expression}"` + where);
        if (t === '(') { const v = or(); take(')'); return v; }
        if (t === '!') return primary() ? 0 : 1;
        if (t === 'defined') {
            const paren = peek() === '(';
            if (paren) p++;
            const name = tokens[p++];
            if (paren) take(')');
            return table.has(name) ? 1 : 0;
        }
        if (/^\d+$/.test(t)) return Number(t);
        if (/^\w+$/.test(t)) return table.get(t) ?? 0;
        throw new Error(`unexpected "${t}" in #if "${expression}"` + where);
    };
    const compare = () => {
        let v = primary();
        while (['==', '!=', '<', '>', '<=', '>='].includes(peek())) {
            const op = tokens[p++], r = primary();
            v = Number(op === '==' ? v === r : op === '!=' ? v !== r : op === '<' ? v < r
                     : op === '>' ? v > r : op === '<=' ? v <= r : v >= r);
        }
        return v;
    };
    const and = () => { let v = compare(); while (peek() === '&&') { p++; const r = compare(); v = Number(!!v && !!r); } return v; };
    const or = () => { let v = and(); while (peek() === '||') { p++; const r = and(); v = Number(!!v || !!r); } return v; };
    const value = or();
    if (p !== tokens.length) throw new Error(`trailing "${tokens[p]}" in #if "${expression}"` + where);
    return !!value;
}

/**
 * The variants a top-level shader declares, one `// @variant <tag> NAME=VAL ...` line each:
 * `[{ tag, defines }]`. A variant is the same module composed with those defines; its build output
 * rides on the base import under `variants[tag]`.
 */
export function listVariants(source) {
    const out = [];
    for (const m of source.matchAll(/^[ \t]*\/\/[ \t]*@variant[ \t]+([\w.]+)((?:[ \t]+\w+(?:=-?\d+)?)*)[ \t]*$/gm)) {
        const defines = {};
        for (const pair of m[2].trim().split(/\s+/).filter(Boolean)) {
            const [name, value] = pair.split('=');
            defines[name] = value === undefined ? 1 : Number(value);
        }
        if (out.some(v => v.tag === m[1])) throw new Error(`duplicate @variant tag "${m[1]}"`);
        out.push({ tag: m[1], defines });
    }
    return out;
}

/** Whether `source` still contains an unresolved directive. Used by tests to catch a skipped pass. */
export function hasUnresolvedIncludes(source) {
    INCLUDE.lastIndex = 0;
    return INCLUDE.test(source);
}

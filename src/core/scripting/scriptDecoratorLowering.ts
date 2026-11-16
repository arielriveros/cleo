// Lowers a script's member decorators into something the rest of the compile can handle.
//
// Scripts may decorate class fields and methods (`@child('Muzzle') muzzle?: Node`, `@onAction('Jump') jump()`,
// see decorators.ts). Neither half of the pipeline after this pass copes with that syntax: Sucrase mangles
// it (a bare member decorator vanishes, `@x(args)` leaves `(args)` behind), and the JS engines scripts run
// on cannot parse decorators at all. So before Sucrase sees the source, this pass
//
//   - blanks every member decorator out, character for character (newlines kept), so every line and
//     column of the author's source stays where it was;
//   - and, right before the decorated class's closing `}` (same line), adds a static block that hands the
//     decorators to `applyScriptDecorators` (from 'cleo') along with what each one decorates:
//
//       static{__cleoImport("cleo").applyScriptDecorators(this,[[[child('Muzzle')],"field","muzzle",1]])}
//
// The decorator expressions are evaluated there, once, when the class is defined, as TC39 evaluates them
// at class definition; and `applyScriptDecorators` calls them with a TC39-shaped context, so a decorator
// works the same here as under a compiler that implements the standard (esbuild, in tests). Using the
// imported decorator in the static block also keeps its import alive through Sucrase's unused-import pass.
//
// What Cleo cannot honour is an error at its source position: a decorator outside a class body (a class
// decorator, or one on a top-level `let`), and one on a static, `#private`, computed or accessor member.
//
// A leaf: imports only the shared lexer.
import { IDENT_PART, IDENT_START, isValuePosition, skipRegex, skipString, skipTrivia } from './scriptLexer';

/** Modifiers that may sit between a member's decorators and its name. */
const MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'static', 'override', 'declare', 'abstract', 'accessor', 'async']);

interface DecoratedMember {
    /** The decorator expressions, `@` dropped, in source order. */
    exprs: string[];
    kind: 'field' | 'method';
    name: string;
    /** Declared `name?:` — the author says it may stay empty. */
    optional: boolean;
}

interface Frame {
    isClass: boolean;
    members: DecoratedMember[];
}

/** A decorator this pass cannot lower. `loc` follows Sucrase's (1-based line, 0-based column). */
function decoratorError(source: string, at: number, message: string): Error {
    const before = source.slice(0, at);
    const line = before.split('\n').length;
    const column = at - (before.lastIndexOf('\n') + 1);
    const error: any = new SyntaxError(`${message} (line ${line})`);
    error.loc = { line, column };
    return error;
}

/** Index just past the bracketed group opening at `open`, stepping over strings, comments and regexes. */
function skipBalanced(source: string, open: number): number {
    let depth = 0;
    let prev = '';
    let i = open;
    while (i < source.length) {
        const c = source[i];
        if (c === '/' && source[i + 1] === '/') { const nl = source.indexOf('\n', i); i = nl === -1 ? source.length : nl; continue; }
        if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
        if (c === '"' || c === "'" || c === '`') { i = skipString(source, i); prev = c; continue; }
        if (c === '/' && isValuePosition(prev)) { i = skipRegex(source, i); prev = 'regex'; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i + 1; }
        if (IDENT_START.test(c)) {
            let j = i;
            while (j < source.length && IDENT_PART.test(source[j])) j++;
            prev = source.slice(i, j);
            i = j;
            continue;
        }
        if (!/\s/.test(c)) prev = c;
        i++;
    }
    return source.length;
}

/** A decorator expression as one line: comments dropped, line breaks turned into spaces. */
function oneLine(expr: string): string {
    let out = '';
    let i = 0;
    while (i < expr.length) {
        const c = expr[i];
        if (c === '/' && expr[i + 1] === '/') { const nl = expr.indexOf('\n', i); i = nl === -1 ? expr.length : nl; continue; }
        if (c === '/' && expr[i + 1] === '*') { const end = expr.indexOf('*/', i + 2); i = end === -1 ? expr.length : end + 2; out += ' '; continue; }
        if (c === '"' || c === "'" || c === '`') { const end = skipString(expr, i); out += expr.slice(i, end); i = end; continue; }
        out += c === '\n' || c === '\r' ? ' ' : c;
        i++;
    }
    return out.trim();
}

/** The identifier at `i`, or '' if there is none. */
function wordAt(source: string, i: number): string {
    if (!IDENT_START.test(source[i] ?? '')) return '';
    let j = i;
    while (j < source.length && IDENT_PART.test(source[j])) j++;
    return source.slice(i, j);
}

/** Whether a member name (or another modifier) starts at `i`: what tells a modifier from a member named like one. */
function startsMemberName(source: string, i: number): boolean {
    const c = source[i] ?? '';
    return IDENT_START.test(c) || c === '#' || c === '[' || c === '"' || c === "'" || c === '*';
}

/**
 * Reads the member a run of decorators decorates, starting just after them: its modifiers, name and kind.
 * Throws for a member Cleo cannot decorate.
 */
function readMember(source: string, from: number, at: number, label: string): Omit<DecoratedMember, 'exprs'> {
    let i = skipTrivia(source, from);
    let accessor = false;
    for (;;) {
        const word = wordAt(source, i);
        if (!word) break;
        const after = skipTrivia(source, i + word.length);
        const isModifier = MODIFIERS.has(word) || word === 'get' || word === 'set';
        if (!isModifier || !startsMemberName(source, after)) break;
        if (word === 'static')
            throw decoratorError(source, at, `${label} is on a static member: script decorators go on a class's instance fields and methods`);
        if (word === 'get' || word === 'set' || word === 'accessor') accessor = true;
        i = after;
    }
    if (accessor)
        throw decoratorError(source, at, `${label} is on an accessor: script decorators go on fields and methods`);
    if (source[i] === '*') i = skipTrivia(source, i + 1);   // a generator method

    let name: string;
    const c = source[i];
    if (c === '#') throw decoratorError(source, at, `${label} is on a #private member: Cleo copies a script's members onto its node, which a #name cannot follow`);
    if (c === '[') throw decoratorError(source, at, `${label} is on a computed member name: give the member a plain name`);
    if (c === '"' || c === "'") {
        const end = skipString(source, i);
        name = source.slice(i + 1, end - 1);
        i = end;
    } else {
        name = wordAt(source, i);
        if (!name) throw decoratorError(source, at, `${label} decorates nothing: put it right before a field or method`);
        i += name.length;
    }

    let j = skipTrivia(source, i);
    const optional = source[j] === '?';
    if (source[j] === '?' || source[j] === '!') j = skipTrivia(source, j + 1);
    const kind = source[j] === '(' || source[j] === '<' ? 'method' : 'field';
    return { kind, name, optional };
}

/** The static block that applies a class's decorators, placed just before its closing brace. */
function staticBlock(members: DecoratedMember[]): string {
    const list = members.map(m => `[[${m.exprs.join(',')}],${JSON.stringify(m.kind)},${JSON.stringify(m.name)},${m.optional ? 1 : 0}]`);
    return `;static{__cleoImport("cleo").applyScriptDecorators(this,[${list.join(',')}])}`;
}

/**
 * The script source with its member decorators lowered (see the top of this file). Line- and column-
 * preserving up to each decorated class's closing brace. A source without decorators comes back as is.
 */
export function lowerScriptDecorators(source: string): string {
    if (!source.includes('@')) return source;

    const stack: Frame[] = [];
    const blanks: [number, number][] = [];
    const inserts: { at: number; text: string }[] = [];
    // After the `class` keyword, until the body's `{`: the heritage clause's bracket depth, so a `{` inside
    // `extends Base<{ a: 1 }>` is not taken for the body.
    let heritage: { depth: number } | null = null;
    let prevToken = '';
    let i = 0;

    while (i < source.length) {
        const c = source[i];

        if (c === '/' && source[i + 1] === '/') { const nl = source.indexOf('\n', i); i = nl === -1 ? source.length : nl; continue; }
        if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
        if (c === '"' || c === "'" || c === '`') { i = skipString(source, i); prevToken = c; continue; }
        if (c === '/' && isValuePosition(prevToken)) { i = skipRegex(source, i); prevToken = 'regex'; continue; }

        if (c === '{') {
            const isClass = !!heritage && heritage.depth === 0;
            if (isClass) heritage = null;
            stack.push({ isClass, members: [] });
            prevToken = c;
            i++;
            continue;
        }
        if (c === '}') {
            const frame = stack.pop();
            if (frame?.isClass && frame.members.length) inserts.push({ at: i, text: staticBlock(frame.members) });
            prevToken = c;
            i++;
            continue;
        }
        if (heritage) {
            if (c === '(' || c === '[' || (c === '<')) heritage.depth++;
            else if (c === ')' || c === ']' || (c === '>' && source[i - 1] !== '=')) heritage.depth--;
        }

        if (c === '@') {
            const frame = stack[stack.length - 1];
            const first = wordAt(source, i + 1);
            const label = `@${first || '…'}`;
            if (!frame?.isClass || heritage) {
                // Past any decorators here, is it a class? Then this is a class decorator.
                let k = i;
                while (source[k] === '@') {
                    k = skipTrivia(source, k + 1);
                    while (IDENT_START.test(source[k] ?? '')) {
                        k += wordAt(source, k).length;
                        if (source[skipTrivia(source, k)] !== '.') break;
                        k = skipTrivia(source, skipTrivia(source, k) + 1);
                    }
                    k = skipTrivia(source, k);
                    if (source[k] === '(') k = skipTrivia(source, skipBalanced(source, k));
                }
                const next = wordAt(source, k);
                const decoratesClass = next === 'class' || next === 'export' || (next === 'abstract' && wordAt(source, skipTrivia(source, k + 8)) === 'class');
                throw decoratorError(source, i, decoratesClass
                    ? `${label} decorates a class: scripts support decorators on a class's fields and methods, not on the class itself`
                    : `${label} is not valid here: decorators go on a class's fields and methods`);
            }

            // One or more decorators, then the member they decorate.
            const exprs: string[] = [];
            let k = i;
            while (source[k] === '@') {
                const start = k;
                let j = k + 1;
                const name = wordAt(source, j);
                if (!name) throw decoratorError(source, start, 'Expected a decorator name after @');
                j += name.length;
                // A dotted path: `@ns.child(...)`.
                for (let dot = skipTrivia(source, j); source[dot] === '.'; dot = skipTrivia(source, j)) {
                    const at = skipTrivia(source, dot + 1);
                    const part = wordAt(source, at);
                    if (!part) throw decoratorError(source, start, `Expected a name after '.' in ${label}`);
                    j = at + part.length;
                }
                const open = skipTrivia(source, j);
                if (source[open] === '(') j = skipBalanced(source, open);
                exprs.push(oneLine(source.slice(start + 1, j)));
                blanks.push([start, j]);
                k = skipTrivia(source, j);
            }
            frame.members.push({ exprs, ...readMember(source, k, i, label) });
            // Carry on from the member itself: its body or initializer is ordinary source.
            prevToken = ';';
            i = k;
            continue;
        }

        if (IDENT_START.test(c)) {
            const word = wordAt(source, i);
            if (word === 'class' && source[i - 1] !== '.') {
                // `class` as a keyword: what follows is a name, `extends`, or the body.
                const next = source[skipTrivia(source, i + word.length)] ?? '';
                if (IDENT_START.test(next) || next === '{') heritage = { depth: 0 };
            }
            prevToken = word;
            i += word.length;
            continue;
        }

        if (!/\s/.test(c)) prevToken = c;
        i++;
    }

    if (!blanks.length) return source;

    // Blank the decorators (newlines kept), then add the static blocks, last first so offsets hold.
    const chars = source.split('');
    for (const [start, end] of blanks)
        for (let p = start; p < end; p++) if (chars[p] !== '\n' && chars[p] !== '\r') chars[p] = ' ';
    let out = chars.join('');
    for (const { at, text } of inserts.sort((a, b) => b.at - a.at))
        out = out.slice(0, at) + text + out.slice(at);
    return out;
}

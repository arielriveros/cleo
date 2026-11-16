// The minimal lexing the script source rewriters share: identifiers, and how to step over a string,
// template, regex literal or comment without mistaking what is inside it for code. A leaf: imports nothing.

export const IDENT_START = /[A-Za-z_$]/;
export const IDENT_PART = /[A-Za-z0-9_$]/;

// A `/` opens a regex literal only where a value is expected; after a value it is division. Judged by
// the previous token: a keyword like `return` expects a value, an identifier or a closing bracket is one.
export const ENDS_A_VALUE = /[A-Za-z0-9_$)\]}`'"]/;
export const EXPECTS_A_VALUE = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

export function isValuePosition(prevToken: string): boolean {
    if (!prevToken) return true;
    if (EXPECTS_A_VALUE.has(prevToken)) return true;
    return !ENDS_A_VALUE.test(prevToken[prevToken.length - 1]);
}

/** Index just past the string/template literal starting at `start`. Templates may nest `${...}`. */
export function skipString(source: string, start: number): number {
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
export function skipRegex(source: string, start: number): number {
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

export function skipTrivia(source: string, i: number): number {
    while (i < source.length) {
        const c = source[i];
        if (c === '/' && source[i + 1] === '/') { const nl = source.indexOf('\n', i); i = nl === -1 ? source.length : nl; continue; }
        if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
        if (/\s/.test(c)) { i++; continue; }
        return i;
    }
    return i;
}

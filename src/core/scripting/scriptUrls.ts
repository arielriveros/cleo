// Where a user script lives, as the browser, its devtools and Cleo's own debugger see it.
//
// Every compiled script is named with a `//# sourceURL` (scriptRuntime.ts compileFactory):
//   cleo-script:///Player/Hero.ts    a script asset, by its module id (the VFS path without `.script`)
//   cleo-inline:///1a2b3c4d.ts       a legacy inline script with no asset, by a hash of its source
// The compile keeps the author's line numbers exactly — line N of the source is line N of that script — so
// a stack frame, a CDP location or a log entry's `source` needs no mapping beyond these URLs. Columns are
// approximate: Sucrase strips type annotations without padding.
//
// A leaf: scriptRuntime.ts (which must import nothing from the engine) and the logger both use it.

/** A position in a user script, in the author's own coordinates (1-based line). */
export interface ScriptSourceLocation {
    /** `cleo-script:///…` or `cleo-inline:///…`. */
    url: string;
    /** 1-based, the author's own line. */
    line: number;
    /** 1-based; approximate (types are stripped without padding, and line 1 carries the export header). */
    column?: number;
}

const SCRIPT_SCHEME = 'cleo-script://';
const INLINE_SCHEME = 'cleo-inline://';

/**
 * Characters a stack-frame parser could trip on are escaped; everything else stays readable. Spaces were
 * already `%20` in module URLs before this file existed.
 */
function encodePath(path: string): string {
    return path.replace(/%/g, '%25').replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function decodePath(path: string): string {
    try { return decodeURIComponent(path); } catch { return path; }
}

/** `/Player/Hero` → `cleo-script:///Player/Hero.ts`. */
export function scriptSourceUrl(moduleId: string): string {
    const id = moduleId.startsWith('/') ? moduleId : `/${moduleId}`;
    return `${SCRIPT_SCHEME}${encodePath(id)}.ts`;
}

/** FNV-1a over UTF-16 units: a stable name for the same inline source on every run. */
function fnv1a(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** A legacy script with no asset (no module id): named by its source. */
export function inlineScriptUrl(source: string): string {
    return `${INLINE_SCHEME}/${fnv1a(source)}.ts`;
}

/** Is this one of ours — a user script rather than engine or app code? */
export function isScriptUrl(url: string | undefined | null): boolean {
    return !!url && (url.startsWith(SCRIPT_SCHEME) || url.startsWith(INLINE_SCHEME));
}

/** `cleo-script:///Player/Hero.ts` → `/Player/Hero`. Null for inline scripts and anything else. */
export function moduleIdOfScriptUrl(url: string | undefined | null): string | null {
    if (!url || !url.startsWith(SCRIPT_SCHEME) || !url.endsWith('.ts')) return null;
    const path = decodePath(url.slice(SCRIPT_SCHEME.length, -3));
    return path.startsWith('/') ? path : null;
}

/** `Hero.ts:42` — how a location is shown in a row. */
export function scriptLocationLabel(location: ScriptSourceLocation): string {
    const id = moduleIdOfScriptUrl(location.url);
    const name = id ? id.slice(id.lastIndexOf('/') + 1) : 'inline';
    return `${name}.ts:${location.line}`;
}

// `    at Hero.onUpdate (cleo-script:///Player/Hero.ts:42:9)` or, without a function name,
// `    at cleo-script:///Player/Hero.ts:42:9`. Firefox/Safari: `onUpdate@cleo-script:///Player/Hero.ts:42:9`.
const FRAME = /(cleo-(?:script|inline):\/\/\/[^\s()]*?\.ts):(\d+)(?::(\d+))?/;

function isLocation(value: any): value is ScriptSourceLocation {
    return !!value && typeof value === 'object' && isScriptUrl(value.url) && Number.isFinite(value.line);
}

/**
 * Where an error points in a user script: a compile error's own position (scriptRuntime's compileFactory
 * attaches `cleoLocation`, from Sucrase's `loc`), else the topmost user-script frame of its stack. The
 * innermost `cause` is asked first: a module's load failure wraps the original, and the wrapper's own
 * stack only reaches the script that imported it. Null when nothing points at a script — an engine
 * error, or a thrown value that is not an Error.
 */
export function scriptLocationOf(error: unknown): ScriptSourceLocation | null {
    const chain: any[] = [];
    for (let e: any = error; e && typeof e === 'object' && chain.length < 4 && !chain.includes(e); e = e.cause) chain.push(e);
    for (const e of chain.reverse()) {
        if (isLocation(e.cleoLocation)) return { ...e.cleoLocation };
        const stack = typeof e.stack === 'string' ? e.stack : '';
        for (const line of stack.split('\n')) {
            const m = FRAME.exec(line);
            if (m) return { url: m[1], line: Number(m[2]), ...(m[3] ? { column: Number(m[3]) } : {}) };
        }
    }
    return null;
}

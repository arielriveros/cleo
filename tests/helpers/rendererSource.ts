import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { expect } from 'vitest';

/**
 * The renderer's source text, for the tests that pin a contract by reading code rather than by running it
 * (constructing a Renderer needs a GPU).
 *
 * `renderer.ts` is being split into `src/graphics/render/`, one subsystem per module. A method that moves
 * keeps its contract, so these tests read `renderer.ts` AND every module under `render/`, concatenated in a
 * stable order with Windows newlines normalised. A test that pins where something lives (one method, one
 * file) asks {@link methodBody}, which finds the method in whichever class now declares it.
 */

const GRAPHICS = join(__dirname, '..', '..', 'src', 'graphics');
const RENDER_DIR = join(GRAPHICS, 'render');

function tsFilesUnder(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir).sort()) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
        else if (entry.endsWith('.ts')) out.push(path);
    }
    return out;
}

/** `renderer.ts` first, then `render/**` in path order. */
export function rendererFiles(): string[] {
    return [join(GRAPHICS, 'renderer.ts'), ...tsFilesUnder(RENDER_DIR)];
}

let cached: string | null = null;

/** Every renderer module's text, concatenated, CRLF normalised to LF. */
export function rendererSource(): string {
    if (cached === null) {
        cached = rendererFiles()
            .map(file => `// ---- ${relative(GRAPHICS, file).split('\\').join('/')}\n`
                         + readFileSync(file, 'utf-8').replace(/\r\n/g, '\n'))
            .join('\n');
    }
    return cached;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The body of the class method `name`, in whichever renderer module declares it: from its declaration
 * (any of `private`/`public`/`protected`, `static`, `async`) to its closing brace at class indentation.
 */
export function methodBody(name: string, source: string = rendererSource()): string {
    const declaration = new RegExp(
        `\\n    (?:(?:private|public|protected) )?(?:static )?(?:async )?${escape(name)}\\s*[(<]`);
    const match = declaration.exec(source);
    expect(match, `${name} not found in the renderer modules`).toBeTruthy();
    const rest = source.slice(match!.index + 1);
    const end = rest.indexOf('\n    }');
    expect(end, `could not find the end of ${name}`).toBeGreaterThan(-1);
    return rest.slice(0, end);
}

/**
 * Assert `needle` does not occur in `source`, while `anchor` (something that must exist for the
 * absence to mean anything) does. A negative assertion on its own passes vacuously once the code it
 * guarded has been renamed or moved.
 */
export function expectAbsent(source: string, needle: string | RegExp, anchor: string | RegExp): void {
    const has = (s: string | RegExp) => typeof s === 'string' ? source.includes(s) : s.test(source);
    expect(has(anchor), `anchor ${String(anchor)} not found: the absence check would be vacuous`).toBe(true);
    expect(has(needle), `${String(needle)} should not appear`).toBe(false);
}

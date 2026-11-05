import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, posix } from 'path';
import ts from 'typescript';

/**
 * The RHI boundary: what code OUTSIDE `src/graphics/rhi/webgl2/` and `src/graphics/rhi/webgpu/` must not
 * contain. The renderer talks to the interfaces in `rhi/` (Device, encoders, resources, ShaderProgram)
 * and never to WebGL or WebGPU themselves — not by a raw call, not through a WebGL-only helper, and not
 * by asking which backend is live (conventions are named device fields: `DeviceCapabilities.conventions`).
 *
 * Every pattern runs over code with comments removed by the TypeScript printer (so a `//` inside a string
 * or a regex literal cannot swallow real code). Most also run with string and JSX text blanked — a
 * message that MENTIONS `navigator.gpu` is not a use of it; `strings: true` rules read the strings, which
 * is where a context name lives. Imports are checked separately, with each specifier resolved against
 * the importing file.
 */
export const BOUNDARY_RULES: readonly { readonly id: string; readonly pattern: RegExp; readonly strings?: boolean }[] = [
    { id: 'gl', pattern: /(?<![\w$.])gl\.\w/ },
    { id: 'GLState', pattern: /\bGLState\b/ },
    { id: 'glDevice', pattern: /\bglDevice\b/ },
    { id: 'setGLContext', pattern: /\bsetGLContext\b/ },
    { id: 'getContext', pattern: /getContext\(\s*['"`]webgl2?['"`]/, strings: true },
    { id: 'drawingBufferColorSpace', pattern: /\bdrawingBufferColorSpace\b/ },
    { id: 'WebGLType', pattern: /\bWebGL(?:2RenderingContext|RenderingContext|Texture|Buffer|Framebuffer|VertexArrayObject|Query|Program|Shader|UniformLocation|Sync)\b/ },
    { id: 'GPUEnum', pattern: /\bGPU(?:BufferUsage|TextureUsage|MapMode|ShaderStage|ColorWrite)\b/ },
    { id: 'navigatorGpu', pattern: /\bnavigator\.gpu\b/ },
    { id: 'backendName', pattern: /\b(?:device|capabilities|_capabilities|caps)\??\.backend\s*[!=]==/ },
];

/** Files that sit on the boundary on purpose, and the rules each may break. */
export const BOUNDARY_ALLOWED: Readonly<Record<string, readonly string[]>> = {
    // The device factory: the one place that names both backends.
    'src/graphics/rhi/createDevice.ts': ['backendImport'],
    // Public API re-exports (`setGLContext`, `WebGL2Device`, `acquireWebGPUDevice`, ...).
    'src/cleo.ts': ['backendImport', 'setGLContext'],
    // Ambient declarations branding WebGL's handle types.
    'src/webglHandles.d.ts': ['WebGLType'],
};

const REPO = join(__dirname, '..', '..');
const BACKENDS = ['src/graphics/rhi/webgl2/', 'src/graphics/rhi/webgpu/'];

function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) out.push(...tsFiles(path));
        else if (/\.tsx?$/.test(entry)) out.push(path);
    }
    return out;
}

const printer = ts.createPrinter({ removeComments: true });

function parse(source: string, fileName: string): ts.SourceFile {
    const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
}

/** `source` without comments. */
export function stripComments(source: string, fileName = 'x.ts'): string {
    return printer.printFile(parse(source, fileName));
}

/** Blank every string, template and JSX text EXCEPT module specifiers (imports, exports, `import()`). */
const blankStrings: ts.TransformerFactory<ts.SourceFile> = context => root => {
    const f = context.factory;
    const visit = (node: ts.Node): ts.Node => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node)) return node;
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return node;
        if (ts.isStringLiteral(node)) return f.createStringLiteral('');
        if (ts.isNoSubstitutionTemplateLiteral(node)) return f.createNoSubstitutionTemplateLiteral('');
        if (ts.isTemplateExpression(node)) {
            const last = node.templateSpans.length - 1;
            return f.createTemplateExpression(f.createTemplateHead(''), node.templateSpans.map((span, i) =>
                f.createTemplateSpan(ts.visitNode(span.expression, visit) as ts.Expression,
                                     i === last ? f.createTemplateTail('') : f.createTemplateMiddle(''))));
        }
        if (ts.isJsxText(node)) return f.createJsxText('');
        return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
};

/** `source` without comments AND without string contents (module specifiers kept). */
export function stripCommentsAndStrings(source: string, fileName = 'x.ts'): string {
    const result = ts.transform(parse(source, fileName), [blankStrings]);
    try { return printer.printFile(result.transformed[0]); }
    finally { result.dispose(); }
}

const SPECIFIER = /\b(?:from|import)\s*\(?\s*['"`]([^'"`]+)['"`]/g;
const BACKEND_PATH = /(?:^|\/)rhi\/(?:webgl2|webgpu)\//;

/**
 * Whether `code` (at repo-relative `fileName`) imports anything inside a backend folder. Specifiers
 * are RESOLVED against the file, so `./webgl2/x` from `rhi/` counts as much as `../rhi/webgl2/x`.
 */
function importsBackend(code: string, fileName: string): boolean {
    const dir = posix.dirname(fileName.split('\\').join('/'));
    for (const m of code.matchAll(SPECIFIER)) {
        const spec = m[1];
        if (BACKEND_PATH.test(spec.startsWith('.') ? posix.join(dir, spec) : spec)) return true;
    }
    return false;
}

/** The rule ids `source`, at repo-relative `fileName`, breaks. */
export function boundaryHits(source: string, fileName = 'src/graphics/x.ts'): string[] {
    const withStrings = stripComments(source, fileName);
    const code = stripCommentsAndStrings(source, fileName);
    const hits = BOUNDARY_RULES.filter(r => r.pattern.test(r.strings ? withStrings : code)).map(r => r.id);
    if (importsBackend(withStrings, fileName)) hits.push('backendImport');
    return hits;
}

/** Every rule each file under `roots` breaks: repo-relative path -> rule ids. Backend folders skipped. */
export function boundaryOffenders(roots: readonly string[]): { scanned: number; offenders: Map<string, string[]> } {
    const offenders = new Map<string, string[]>();
    let scanned = 0;
    for (const root of roots) {
        for (const path of tsFiles(join(REPO, root))) {
            const rel = relative(REPO, path).split('\\').join('/');
            if (BACKENDS.some(b => rel.startsWith(b))) continue;
            scanned++;
            const hits = boundaryHits(readFileSync(path, 'utf-8'), rel);
            if (hits.length) offenders.set(rel, hits);
        }
    }
    return { scanned, offenders };
}

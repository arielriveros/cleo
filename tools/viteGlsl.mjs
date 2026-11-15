// The engine's shader loader, contributed by vite.config.ts and therefore present in every consumer:
// the editor dev server, the editor build, the player build and both vitest suites.
//
// Vite has no raw rule of its own, so `import shader from './x.vs'` would hand `#version 300 es` to its
// JS parser. This restores the "shaders are strings" contract the retired webpack loaders provided, so
// importing node.ts/scene.ts does not drag a bundler config along.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIncludes, listVariants } from './shaderIncludes.mjs';
import { translateWgsl } from './wgslTranslate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHADERS = path.join(ROOT, 'src', 'graphics', 'shaders');
/** The engine module that turns a shader's id into a handle onto the installed library (library mode). */
const LIBRARY_MODULE = path.join(ROOT, 'src', 'graphics', 'shaderLibrary.ts').split(path.sep).join('/');

/** A `.wgsl` file's id: its path under src/graphics/shaders, forward slashes ('wgsl/pbr.wgsl'). */
export function shaderModuleId(file) {
    const rel = path.relative(SHADERS, file);
    return (rel.startsWith('..') ? path.relative(ROOT, file) : rel).split(path.sep).join('/');
}

/**
 * The shader library a library-mode build collects: every `.wgsl` module the build imports, by id, as the
 * loader translated it -- `base` (the module composed without defines) and its `variants` by tag. The build
 * that owns it writes it out (the player's vite.player.config.ts, as shaders.json).
 * @returns {{ modules: Map<string, { base: object, variants?: Record<string, object> }> }}
 */
export function createShaderLibrary() {
    return { modules: new Map() };
}

/**
 * @param {{ library?: ReturnType<typeof createShaderLibrary> }} [options]
 *   `library`: LIBRARY MODE. Each `.wgsl` import becomes a handle onto the shader library the running game
 *   installs (src/graphics/shaderLibrary.ts) instead of carrying its WGSL, GLSL and reflection inline, and its
 *   translation goes into `library`. The published player builds this way, so a game ships only the shader
 *   text it can use; everything else (the editor, the dev server, the tests) imports shaders inline.
 * @returns {import('vite').Plugin}
 */
export function glslRaw(options = {}) {
    const library = options.library;
    return {
        name: library ? 'glsl-raw-library' : 'glsl-raw',
        async transform(_code, id) {
            const file = id.split('?')[0];

            // WGSL is a PROGRAM, not a stage: the import yields { wgsl, vertex, fragment } with the
            // GLSL already generated, exactly as the retired webpack loader emitted it. Translating
            // here rather than shipping raw text keeps a test's view of a shader identical to the build's.
            if (/\.wgsl$/.test(file)) {
                const source = readFileSync(file, 'utf-8');
                const label = path.basename(file);
                const module = shaderModuleId(file);
                const compose = (defines, watch) => resolveIncludes(source, path.dirname(file), {
                    read: (p) => readFileSync(p, 'utf-8'),
                    resolve: (dir, rel) => path.resolve(dir, rel),
                    // An `#include` is invisible to Vite's module graph: the importer is `pbr.wgsl`,
                    // and nothing else links it to the chunk its text came from. Without this the dev
                    // server keeps serving the shader it composed BEFORE the chunk was edited — the
                    // TypeScript beside it hot-reloads, so the engine looks current while its shaders
                    // are hours old, and the only symptom is a validation error naming a line the
                    // source no longer has. Costs one watched file per include.
                    onDependency: watch ? (p) => this.addWatchFile(p) : undefined,
                    defines,
                });
                const translated = await translateWgsl(compose({}, true), label);
                // `// @variant <tag> NAME=VAL` lines: the same module composed with those defines,
                // translated in full (its own WGSL for WebGPU, its own GLSL for WebGL2).
                const variants = listVariants(source);
                const translatedVariants = {};
                for (const { tag, defines } of variants)
                    translatedVariants[tag] = await translateWgsl(compose(defines, false), `${label}~${tag}`);

                if (library) {
                    library.modules.set(module, variants.length ? { base: translated, variants: translatedVariants } : { base: translated });
                    const tags = variants.map(v => v.tag);
                    return {
                        code: `import { shaderModuleHandle } from ${JSON.stringify(LIBRARY_MODULE)};\n` +
                              `export default shaderModuleHandle(${JSON.stringify(module)}, ${JSON.stringify(tags)});`,
                        map: null,
                    };
                }
                // `module` names the file the program came from, so a publish can tell which of the player's
                // library entries a program needs (src/graphics/render/programs.ts programModules).
                translated.module = module;
                if (variants.length) translated.variants = translatedVariants;
                return { code: `export default ${JSON.stringify(translated)};`, map: null };
            }

            if (!/\.(vs|fs|glsl|vert|frag)$/.test(file)) return;
            return { code: `export default ${JSON.stringify(readFileSync(file, 'utf-8'))};`, map: null };
        },
    };
}

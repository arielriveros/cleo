// WGSL -> GLSL ES 300, at build time.
//
// The engine authors shaders in WGSL and generates GLSL for the WebGL2 backend, because that is the
// only direction naga supports: its GLSL *frontend* is Vulkan-flavoured and cannot read the ES dialect
// this engine writes, while its GLSL *backend* emits precisely that dialect. See WEBGPU_ROADMAP.md M3.
//
// Translation is build-time only. No naga wasm reaches a player.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAGA_DIR = path.resolve(HERE, '..', 'src', 'graphics', 'rhi', 'webgpu', 'naga');

let naga = null;

/** Load the vendored naga artifact once per process. It is a `--target web` build, which Node loads
 *  fine as long as the wasm bytes are handed over explicitly rather than fetched. */
async function loadNaga() {
    if (naga) return naga;
    const mod = await import(pathToFileURL(path.join(NAGA_DIR, 'nagaGlsl.js')).href);
    await mod.default({ module_or_path: readFileSync(path.join(NAGA_DIR, 'nagaGlsl_bg.wasm')) });
    naga = mod;
    return naga;
}

/**
 * Entry points declared in a WGSL module, by stage.
 *
 * Found by scanning rather than by convention, so a module is free to name its functions whatever reads
 * best. A program's two stages must live in ONE module: naga emits per entry point, and the varying
 * names it generates (`_vs2fs_location0`) only line up when both sides came from the same module.
 */
export function findEntryPoints(wgsl) {
    const found = {};
    const stages = [['vertex', '@vertex'], ['fragment', '@fragment'], ['compute', '@compute']];
    for (const [stage, attribute] of stages) {
        const re = new RegExp(attribute + '[\\s\\S]{0,120}?\\bfn\\s+([A-Za-z_]\\w*)');
        const match = re.exec(wgsl);
        if (match) found[stage] = match[1];
    }
    return found;
}

/** The `@location(N) name:` pairs declared in one struct body. */
function locationFields(body) {
    const fields = new Map();
    for (const m of body.matchAll(/@location\((\d+)\)\s*([A-Za-z_]\w*)\s*:/g)) fields.set(m[1], m[2]);
    return fields;
}

/** The body of `struct <name> { ... }`, or '' if there is no such struct. */
function structBody(wgsl, name) {
    const re = new RegExp('struct\\s+' + name + '\\s*\\{([\\s\\S]*?)\\}');
    return (wgsl.match(re) || [])[1] || '';
}

/**
 * naga's generated identifiers, mapped back to names this engine can use.
 *
 * naga renames everything it emits: vertex inputs become `_p2vs_locationN`, varyings `_vs2fs_locationN`,
 * fragment outputs `_fs2p_locationN`, and resources `_group_G_binding_B_fs`. That is fine for wgpu,
 * which binds by location and group. It is not fine here: this engine sets uniforms **by name**
 * (`setUniform('u_screenTexture', 0)`) and `Mesh.initializeVAO` matches vertex attributes **by name**
 * against the canonical layout table. Mangled names would silently break both — the uniform set would
 * no-op, and the VAO would fall through to the reflected-layout path and interleave the buffer wrong.
 *
 * The mapping is derived from the WGSL itself rather than from a side table, so it cannot drift from
 * what was authored.
 */
export function buildRenames(wgsl, entryPoints, label = 'shader') {
    const renames = new Map();

    // Resources: `@group(G) @binding(B) var<...> name: type`.
    //
    // A texture/sampler pair collapses into ONE combined GLSL sampler, named after the TEXTURE's
    // binding, so a `_texture` / `_sampler` suffix pair is stripped back to the shared base name:
    // `u_screenTexture_texture` at (0,0) and `u_screenTexture_sampler` at (0,1) both become
    // `u_screenTexture` — the name the renderer already sets.
    const resource = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<[^>]*>)?\s+([A-Za-z_]\w*)/g;
    for (const m of wgsl.matchAll(resource)) {
        const base = m[3].replace(/_(texture|sampler)$/, '');
        for (const suffix of ['vs', 'fs', 'cs']) renames.set('_group_' + m[1] + '_binding_' + m[2] + '_' + suffix, base);
    }

    let vertexReturn = '';
    if (entryPoints.vertex) {
        const signature = new RegExp('fn\\s+' + entryPoints.vertex + '\\s*\\(([\\s\\S]*?)\\)\\s*->\\s*([A-Za-z_]\\w*)');
        const match = wgsl.match(signature);
        const params = (match || [])[1] || '';
        vertexReturn = (match || [])[2] || '';

        // Vertex inputs get the engine's `a_` prefix added here rather than being written that way in
        // the WGSL. That is not cosmetic: naga emits a local copy of each input named exactly as the
        // WGSL parameter is, so renaming the input to the SAME name produces `vec3 a_position =
        // a_position;` — a self-referential declaration that shadows the attribute. Keeping the two
        // namespaces apart is what makes the rename safe.
        for (const m of params.matchAll(/@location\((\d+)\)\s*([A-Za-z_]\w*)\s*:/g)) {
            if (/^a_/.test(m[2]))
                throw new Error(
                    label + ': vertex input "' + m[2] + '" must not start with "a_" — the loader adds ' +
                    'that prefix, and a parameter already carrying it collides with naga\'s local copy');
            renames.set('_p2vs_location' + m[1], 'a_' + m[2]);
        }
    }

    // Varyings, taken from the struct the vertex stage RETURNS. Scoping it to that struct matters: a
    // module with both a vertex-output and a fragment-output struct would otherwise have its varying
    // names picked from whichever declared the location first.
    for (const [location, name] of locationFields(structBody(wgsl, vertexReturn)))
        renames.set('_vs2fs_location' + location, 'v_' + name);

    // Fragment outputs. Named from the return struct when there is one, else `fragColor` for the single
    // output case — which is what nearly every pass in this engine has.
    if (entryPoints.fragment) {
        const signature = new RegExp('fn\\s+' + entryPoints.fragment + '\\s*\\([\\s\\S]*?\\)\\s*->\\s*([A-Za-z_@][\\w\\s@()<>,]*)');
        const returns = (wgsl.match(signature) || [])[1] || '';
        const named = locationFields(structBody(wgsl, returns.trim()));
        if (named.size) for (const [location, name] of named) renames.set('_fs2p_location' + location, name);
        else renames.set('_fs2p_location0', 'fragColor');
    }

    return renames;
}

/**
 * Reduce a generated fragment shader to a REUSABLE GLSL chunk: its structs, uniforms, globals and
 * functions, with the program scaffolding removed.
 *
 * This exists for one consumer. `systems/customShaders.ts` assembles user-authored GLSL at runtime and
 * pastes the shadow library into it as a raw string, so that library has to exist as GLSL — but the
 * engine's own shaders now want it as WGSL, and 239 lines of cascade and bias math cannot be maintained
 * twice without drifting. Authoring it once in WGSL and generating the GLSL half here keeps one source
 * of truth.
 *
 * What is stripped, and why each would break the paste:
 *   - `#version` / `precision`, which may appear only once and must come first in the host shader.
 *   - the fragment output, which the host already declares.
 *   - `main()`, which the host defines itself.
 *
 * The dummy entry point in the source module is not optional: naga emits only functions REACHABLE from
 * an entry point, so anything the module means to export has to be called from it, or it is dead-code
 * eliminated and silently missing from the chunk.
 */
export function extractGlslChunk(glsl, label = 'shader') {
    const withoutMain = glsl.replace(/\nvoid main\(\) \{[\s\S]*\n\}\s*$/, '\n');
    if (withoutMain === glsl)
        throw new Error(label + ': no trailing main() to strip — naga output shape changed');

    const kept = withoutMain
        .split('\n')
        .filter(line => !/^\s*#version\b/.test(line))
        .filter(line => !/^\s*precision\s+\w+\s+\w+\s*;/.test(line))
        .filter(line => !/^\s*layout\(location\s*=\s*\d+\)\s+out\b/.test(line))
        .join('\n')
        .trim();

    if (!kept) throw new Error(label + ': chunk is empty after stripping');
    return kept;
}

/** Apply the rename map. Longest key first, so no key can be a prefix of another. */
function applyRenames(glsl, renames) {
    let out = glsl;
    const ordered = [...renames].sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of ordered) out = out.replace(new RegExp('\\b' + from + '\\b', 'g'), to);
    return out;
}

/**
 * Translate one WGSL module into the GLSL its declared stages need.
 *
 * Returns `{ wgsl, vertex?, fragment?, entryPoints }`. The WGSL is carried through unchanged so the
 * WebGPU backend can consume the same import without a second build path.
 */
export async function translateWgsl(wgsl, label = 'shader') {
    const mod = await loadNaga();
    const entryPoints = findEntryPoints(wgsl);

    if (!entryPoints.vertex && !entryPoints.fragment && !entryPoints.compute)
        throw new Error(label + ': no @vertex, @fragment or @compute entry point found');

    const renames = buildRenames(wgsl, entryPoints, label);
    const out = { wgsl, entryPoints };
    // A module marked `// @glsl-chunk` also exports a pasteable GLSL chunk. Opt-in via a
    // directive rather than always, because the extraction only makes sense for a module whose
    // entry point exists purely to keep its functions alive.
    const isLibrary = /^[ \t]*\/\/[ \t]*@glsl-chunk[ \t]*$/m.test(wgsl);
    for (const stage of ['vertex', 'fragment', 'compute']) {
        const entry = entryPoints[stage];
        if (!entry) continue;
        try {
            out[stage] = applyRenames(mod.wgsl_to_glsl(wgsl, stage, entry), renames);
        } catch (e) {
            // naga's diagnostics carry the WGSL span, which is what the author actually wrote — worth
            // far more than a line number in generated GLSL nobody has seen.
            throw new Error(label + ': ' + stage + ' stage (' + entry + ') failed to translate\n' + (e.message || e));
        }
    }
    if (isLibrary) {
        if (!out.fragment) throw new Error(label + ': @glsl-chunk needs a fragment entry point');
        out.glslChunk = extractGlslChunk(out.fragment, label);
    }
    return out;
}

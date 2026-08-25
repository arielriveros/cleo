// WGSL -> GLSL ES 300, at build time.
//
// The engine authors shaders in WGSL and generates GLSL for the WebGL2 backend, because that is the
// only direction naga supports: its GLSL *frontend* is Vulkan-flavoured and cannot read the ES dialect
// this engine writes, while its GLSL *backend* emits precisely that dialect. See WEBGPU_ROADMAP.md M3.
//
// Translation is build-time only. No naga wasm reaches a player.

import { readFileSync } from 'node:fs';
import path from 'node:path';
// `findResources` / `findUniformBlocks` live in wgslLayout.mjs so the ENGINE can import them too:
// a custom material's WGSL arrives at runtime and has to be reflected with the same code that
// reflects the engine's own at build time. Re-exported here because this module is where every
// existing caller looks for them.
import { findStructs, layoutStruct, flattenLayout, findResources, findUniformBlocks,
         stripLineComments } from './wgslLayout.mjs';
export { findResources, findUniformBlocks };
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
    // Comments stripped first. The window between the stage attribute and `fn` is deliberately narrow
    // so an unrelated function cannot be matched, and a doc comment sitting between the two — legal
    // WGSL, and the natural place to explain what a stage declares — was enough to overrun it. The
    // symptom was a stage silently missing from the translation, surfacing much later as "WebGL2 needs
    // GLSL vertex and fragment stages" from a program that plainly has both.
    const source = stripLineComments(wgsl);
    const stages = [['vertex', '@vertex'], ['fragment', '@fragment'], ['compute', '@compute']];
    for (const [stage, attribute] of stages) {
        const re = new RegExp(attribute + '[\\s\\S]{0,120}?\\bfn\\s+([A-Za-z_]\\w*)');
        const match = re.exec(source);
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
 * The vertex stage's `@location(N) name: type` inputs, as ATTRIBUTES the engine can name.
 *
 * WebGL2 gets this by reflecting the linked program (`getActiveAttrib`); WebGPU has no such call, and
 * a pipeline is handed its vertex layout up front. The engine builds those layouts from a program's
 * reported attributes (`_vertexLayoutsFor` -> `modelVertexLayout`), so a WebGPU program has to be able
 * to report the same list — which means reading it out of the WGSL at build time.
 *
 * The `a_` prefix is added here for the same reason the translator adds it to the generated GLSL: the
 * engine names attributes `a_position` and the WGSL parameter must NOT, or naga's local copy of the
 * input collides with the attribute it was renamed from. Both halves read the same declaration, so
 * they cannot disagree about the name or the location.
 */
export function findVertexInputs(wgsl) {
    const entryPoints = findEntryPoints(wgsl);
    if (!entryPoints.vertex) return [];
    const signature = new RegExp('fn\\s+' + entryPoints.vertex + '\\s*\\(([\\s\\S]*?)\\)\\s*->');
    const params = (wgsl.match(signature) || [])[1] || '';
    const out = [];
    for (const m of params.matchAll(/@location\((\d+)\)\s*([A-Za-z_]\w*)\s*:\s*([^,)]+)/g))
        out.push({ name: 'a_' + m[2], location: Number(m[1]), type: m[3].trim() });
    out.sort((a, b) => a.location - b.location);
    return out;
}

/**
 * The uniform-buffer resources, with the full byte layout of the struct each one points at.
 *
 * WebGL2 does not need this — it asks the driver for `UNIFORM_OFFSET` and friends, which is
 * authoritative in a way a computed layout cannot be. WebGPU has no reflection at all: a uniform buffer
 * is bytes, and the shader reads whatever sits at the offset its struct declares. So the offsets are
 * computed here, from the WGSL uniform address space rules in `wgslLayout.mjs`.
 *
 * They are not taken on faith. `tools/harness/uniformLayoutCheck.js` compares every offset, array
 * stride and matrix stride computed here against what a real driver reports for the same block, across
 * every program in the engine. Where they disagree, the driver is right.
 */
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

    // Resources: naga emits `_group_G_binding_B_<stage>` for each one. A texture/sampler pair collapses
    // into ONE combined GLSL sampler, so both entries rename to the same `glslName` — see findResources.
    for (const r of findResources(wgsl))
        for (const suffix of ['vs', 'fs', 'cs'])
            renames.set('_group_' + r.group + '_binding_' + r.binding + '_' + suffix, r.glslName);

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
 * Undo naga's assumption that every `texture_depth_2d` is a SHADOW sampler.
 *
 * WGSL splits the texture from the sampler, so at the point naga emits the declaration it cannot know
 * whether a `texture_depth_2d` will be paired with a `sampler` or a `sampler_comparison`. It picks the
 * conservative reading and writes `sampler2DShadow` — and GLSL ES 300 has no `textureLod` overload for
 * a shadow sampler, so the program fails to compile with "no matching overloaded function found".
 *
 * The engine does know: these bindings are the G-buffer depth, read as an ordinary value by the
 * screen-space passes, never compared. The COMPARISON depth textures are the shadow maps, which are
 * `texture_depth_2d_array` + `sampler_comparison` and are left completely alone here — naga's
 * `sampler2DArrayShadow` is right for those.
 *
 * Two more spellings have to be walked back with it. WGSL requires an INTEGER exact level for a depth
 * texture where GLSL's `textureLod` takes a float; and sampling a depth texture yields a bare `f32`
 * in WGSL but a `vec4` from a GLSL `sampler2D`, so the result needs `.x` or the assignment fails
 * with "'=' : dimension mismatch".
 *
 * WGSL declares this type only because WebGPU insists on it — a depth-format texture cannot satisfy a
 * `texture_2d<f32>` binding ("None of the supported sample types (UnfilterableFloat|Depth) match the
 * expected sample types (Float)"). So the declaration is driven by one backend and has to be walked
 * back for the other, which is exactly what this file is for.
 */
/** WGSL depth texture type -> the GLSL sampler naga writes for it, and the one a PLAIN read needs. */
const DEPTH_SAMPLERS = {
    'texture_depth_2d':       { shadow: 'sampler2DShadow',      plain: 'sampler2D' },
    'texture_depth_2d_array': { shadow: 'sampler2DArrayShadow', plain: 'sampler2DArray' },
    'texture_depth_cube':     { shadow: 'samplerCubeShadow',    plain: 'samplerCube' },
};

function fixPlainDepthSamplers(glsl, resources) {
    // Which depth textures are read PLAINLY, decided by the sampler each is paired with rather than by
    // the texture's own type. WGSL splits texture from sampler, so at the point naga emits the
    // declaration it cannot know which it will be, and it picks the conservative reading. The engine
    // knows: a `sampler_comparison` is a shadow test, a plain `sampler` is a value read.
    //
    // Keying on the PAIRING rather than on the type is what makes this general. The first version
    // matched `texture_depth_2d` literally, which was right for the nine G-buffer depth bindings and
    // silently wrong the moment `shadowDebug` became a depth ARRAY read with a plain sampler — it kept
    // its `sampler2DArrayShadow` declaration, which has no `textureLod` overload in ES 300.
    const comparison = new Set(resources
        .filter(r => r.kind === 'sampler' && r.type === 'sampler_comparison')
        .map(r => r.glslName));

    let out = glsl;
    for (const resource of resources) {
        const spelling = DEPTH_SAMPLERS[resource.type];
        if (!spelling || comparison.has(resource.glslName)) continue;
        const name = resource.glslName;
        out = out.replace(new RegExp(spelling.shadow + String.raw`(\s+)` + name + String.raw`\b`, 'g'),
                          spelling.plain + '$1' + name);
        // WGSL requires an INTEGER exact level for a depth texture where GLSL's `textureLod` takes a
        // float, and sampling one yields a bare f32 in WGSL against a vec4 from a GLSL sampler.
        out = out.replace(new RegExp(String.raw`(textureLod\(` + name + String.raw`,[^;]*?),\s*0\)`, 'g'),
                          '$1, 0.0).x');
    }

    // `textureLod` on a shadow sampler is the one thing this extension exists for. With every shadow
    // declaration rewritten away it is not merely unnecessary: `require` on an extension the driver may
    // not have is itself a compile error, so a shader that no longer needs it must not ask for it.
    if (!/sampler\w*Shadow\b/.test(out))
        out = out.replace(/^[ \t]*#extension[ \t]+GL_EXT_texture_shadow_lod[ \t]*:[ \t]*\w+[ \t]*\r?\n/m, '');

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
    // Reflection rides along with the translation: both backends need to know what this program binds
    // where, and deriving it from the same source at the same moment is what keeps it from drifting.
    const out = { wgsl, entryPoints, resources: findResources(wgsl), uniformBlocks: findUniformBlocks(wgsl),
                  vertexInputs: findVertexInputs(wgsl) };
    // A module marked `// @glsl-chunk` also exports a pasteable GLSL chunk. Opt-in via a
    // directive rather than always, because the extraction only makes sense for a module whose
    // entry point exists purely to keep its functions alive.
    const isLibrary = /^[ \t]*\/\/[ \t]*@glsl-chunk[ \t]*$/m.test(wgsl);
    // Only the two RASTER stages, and `compute` is missing on purpose rather than by oversight.
    //
    // naga's GLSL backend here targets ES 300, which has no compute stage at all — it rejects the
    // translation outright. So the moment any `.wgsl` declares `@compute`, sending that stage through
    // this loop breaks the BUILD, for both backends, over a stage WebGL2 could never have run. The
    // WGSL is carried through untouched either way, which is all the WebGPU backend needs; a compute
    // module simply has no GLSL half, and `WgslProgram` no longer pretends otherwise.
    for (const stage of ['vertex', 'fragment']) {
        const entry = entryPoints[stage];
        if (!entry) continue;
        try {
            out[stage] = fixPlainDepthSamplers(
                applyRenames(mod.wgsl_to_glsl(wgsl, stage, entry), renames), out.resources);
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

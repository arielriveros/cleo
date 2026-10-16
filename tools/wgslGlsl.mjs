// WGSL -> GLSL ES 300: everything except loading naga itself.
//
// Split out of wgslTranslate.mjs so it can run in a BROWSER as well as at build time: that module reads
// the naga wasm off disk with node:fs, while this one imports nothing but the shared layout rules. The
// build passes in the wasm's `wgsl_to_glsl`; the editor passes in the same function from its own copy of
// the wasm, to compile a particle system's custom-code module for WebGL2 (src/particles/particleCustom.ts).
// One implementation of the renames and the depth-sampler fixups, whichever side runs it.

import { findStructs, layoutStruct, flattenLayout, findResources, findUniformBlocks,
         stripLineComments } from './wgslLayout.mjs';

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

/**
 * The GLSL read functions a depth sample can arrive as once its sampler has been walked back to a plain
 * one. Every one of them returns a `vec4` where WGSL's depth read returns a bare `f32`, so every one of
 * them needs the `.x`.
 *
 * `textureSize` is deliberately absent: it returns an integer size in both languages, so appending a
 * swizzle to it would break the very code this is here to fix.
 */
const DEPTH_READ_CALLS = ['texture', 'textureLod', 'texelFetch'];

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParen(source, open) {
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '(') depth++;
        else if (source[i] === ')' && --depth === 0) return i;
    }
    return -1;
}

/**
 * Append `.x` to every plain read of the depth sampler `name`, and float-ify `textureLod`'s level.
 *
 * A BALANCED-PAREN SCAN, not a regex, and that is the whole reason this is a function. A read's
 * arguments contain calls of their own — `texture(u_depth, vec2(in.uv))` — so a pattern ending at the
 * first `)` lands inside the argument list. The version this replaced sidestepped that by matching only
 * the `textureLod(name, …, 0)` shape, which left a depth read written as a plain `texture(...)` — what
 * `textureSample` translates to — returning a vec4 into an f32. That is a hard compile error
 * ("'=' : dimension mismatch"), it takes the WHOLE renderer down at `_createPrograms` rather than
 * degrading one effect, and `dofComposite.wgsl` shipped exactly that way.
 */
function appendDepthSwizzle(glsl, name) {
    const pattern = new RegExp(String.raw`\b(` + DEPTH_READ_CALLS.join('|') + String.raw`)\(\s*` + name + String.raw`\b`, 'g');
    let out = '';
    let last = 0;
    let match;
    while ((match = pattern.exec(glsl)) !== null) {
        const open = glsl.indexOf('(', match.index);
        const close = matchParen(glsl, open);
        if (close < 0) break;
        let call = glsl.slice(match.index, close + 1);
        // WGSL requires an INTEGER exact level for a depth texture; GLSL's `textureLod` takes a float.
        if (match[1] === 'textureLod') call = call.replace(/,\s*(\d+)\s*\)$/, ', $1.0)');
        out += glsl.slice(last, match.index) + call + '.x';
        last = close + 1;
        pattern.lastIndex = close + 1;
    }
    return out + glsl.slice(last);
}

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
        // Sampling a depth texture yields a bare f32 in WGSL against a vec4 from a GLSL sampler, so
        // every read of it needs the `.x` — whichever call it came out as.
        out = appendDepthSwizzle(out, name);
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
 * `wgslToGlsl(source, stage, entryPoint)` is naga's translator. Returns `{ wgsl, vertex?, fragment?, entryPoints, ... }`. The WGSL is carried through unchanged so the
 * WebGPU backend can consume the same import without a second build path.
 */
export function translateWgslWith(wgslToGlsl, wgsl, label = 'shader') {
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
    let unprunedFragment;
    for (const stage of ['vertex', 'fragment']) {
        const entry = entryPoints[stage];
        if (!entry) continue;
        let glsl;
        try {
            glsl = fixPlainDepthSamplers(applyRenames(wgslToGlsl(wgsl, stage, entry), renames), out.resources);
        } catch (e) {
            // naga's diagnostics carry the WGSL span, which is what the author actually wrote — worth
            // far more than a line number in generated GLSL nobody has seen.
            throw new Error(label + ': ' + stage + ' stage (' + entry + ') failed to translate\n' + (e.message || e));
        }
        if (stage === 'fragment') unprunedFragment = glsl;
        out[stage] = PRUNE ? pruneDeadFunctions(glsl) : glsl;
    }
    if (isLibrary) {
        if (!out.fragment) throw new Error(label + ': @glsl-chunk needs a fragment entry point');
        // From the UNPRUNED text: a library's dummy entry calls nothing, and the chunk exists to carry
        // the functions a custom material will call.
        out.glslChunk = extractGlslChunk(unprunedFragment, label);
    }
    return out;
}

// `CLEO_GLSL_PRUNE=0` keeps every function, for A/B measurement. This module also runs in the editor
// (particle custom code), where there is no `process`.
const PRUNE = typeof process === 'undefined' || process.env?.CLEO_GLSL_PRUNE !== '0';

/**
 * Drop every function `main` cannot reach.
 *
 * naga emits each function the module defines, whichever entry point is being translated, so a stage
 * carries the other stage's code and every chunk its includes dragged in: pbr's vertex stage was 27k
 * characters, 21k of them parallax, BRDF and shadow code only the fragment stage calls. Every byte is
 * parsed and validated again on every compile, on every launch with a cold cache.
 *
 * Works on naga's output shape, which is regular: a definition starts at column 0 as
 * `<type> <name>(<params>) {` and its body closes with `}` at column 0. A function is kept when its
 * name appears as an identifier in a kept body. Struct constructors share a struct's name, never a
 * function's, so they cannot keep anything alive by accident.
 */
export function pruneDeadFunctions(glsl) {
    const DEF = /^(?!struct\b)[A-Za-z_][\w ]*?\b([A-Za-z_]\w*)\(([^)]*)\) \{$/gm;
    const fns = new Map();
    for (const m of glsl.matchAll(DEF)) {
        const start = m.index;
        const close = glsl.indexOf('\n}', start);
        if (close < 0) return glsl; // not the shape this expects; leave it alone
        const end = close + 2;
        const name = m[1];
        if (fns.has(name)) return glsl; // overloads: naga never emits them, so bail rather than guess
        fns.set(name, { start, end, body: glsl.slice(start + m[0].length, end) });
    }
    if (!fns.has('main')) return glsl;

    const kept = new Set(['main']);
    const queue = ['main'];
    while (queue.length) {
        const body = fns.get(queue.pop()).body;
        for (const id of body.match(/\b[A-Za-z_]\w*(?=\s*\()/g) ?? []) {
            if (fns.has(id) && !kept.has(id)) { kept.add(id); queue.push(id); }
        }
    }
    if (kept.size === fns.size) return glsl;

    let out = '';
    let at = 0;
    for (const [name, { start, end }] of [...fns].sort((a, b) => a[1].start - b[1].start)) {
        if (kept.has(name)) continue;
        out += glsl.slice(at, start);
        // Swallow the blank line naga leaves after each definition, so the output stays tidy.
        at = glsl.startsWith('\n\n', end) ? end + 2 : glsl.startsWith('\n', end) ? end + 1 : end;
    }
    return out + glsl.slice(at);
}

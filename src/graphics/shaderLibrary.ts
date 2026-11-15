// The shader library of a published game: the text and reflection of each shader program the game ships, by
// module id ('wgsl/pbr.wgsl'), carried in its game.bin. In every other build a `.wgsl` import IS its program,
// WGSL, generated GLSL and reflection inline (tools/viteGlsl.mjs). The published player is built in library
// mode instead: each import is a handle made here, and its fields read the library the game installs before
// the engine starts. That is what lets a publish leave out the shader text a game cannot use -- the variants
// its program list does not name, the GLSL of a WebGPU-only game -- where the player would otherwise carry
// every program's every variant for both graphics APIs (17 MB of a 25 MB bundle).
//
// Must import nothing: every shader module imports this one.

/** One program's text and reflection: what a `.wgsl` import yields (see src/wgsl.d.ts). */
export interface ShaderModuleData {
    readonly wgsl: string;
    readonly vertex?: string;
    readonly fragment?: string;
    readonly entryPoints: { readonly vertex?: string; readonly fragment?: string; readonly compute?: string };
    readonly resources: readonly unknown[];
    readonly vertexInputs: readonly unknown[];
    readonly uniformBlocks: readonly unknown[];
    readonly glslChunk?: string;
}

/** A module in the library: the program composed without defines, and the variants the game ships. */
export interface ShaderLibraryEntry {
    readonly base: ShaderModuleData;
    readonly variants?: Readonly<Record<string, ShaderModuleData>>;
}

/** Every shipped module, by id. */
export type ShaderLibrary = Readonly<Record<string, ShaderLibraryEntry>>;

const FIELDS = ['wgsl', 'vertex', 'fragment', 'entryPoints', 'resources', 'vertexInputs', 'uniformBlocks', 'glslChunk'] as const;

let installed: ShaderLibrary | null = null;
/** Bumped by each install, so a handle's cached variant list is rebuilt against the new library. */
let generation = 0;
let handles = 0;

/** Install the library the shader handles read. A published game's boot does, before the engine starts. */
export function installShaderLibrary(library: ShaderLibrary | null): void {
    installed = library;
    generation++;
}

/** Whether this build's shaders are handles onto a library (the published player) rather than inline. */
export function shadersAreLibraryHandles(): boolean {
    return handles > 0;
}

/**
 * Whether a program's module came with the game: false for a handle onto a module a publish left out (a
 * feature the project turns off), true for everything else, inline programs included.
 */
export function shaderIsShipped(program: unknown): boolean {
    const id = (program as { module?: unknown } | null)?.module;
    if (!installed || typeof id !== 'string' || !handleIds.has(program as object)) return true;
    return !!installed[id];
}

/** The handles made here, so shaderIsShipped tells one from an inline program with the same fields. */
const handleIds = new WeakSet<object>();

function entryOf(id: string): ShaderLibraryEntry {
    if (!installed) throw new Error(`Shader ${id}: no shader library is installed (the game's game.bin carries it)`);
    const entry = installed[id];
    if (!entry) throw new Error(`Shader ${id} was not shipped with this game: its feature is off for the project (Project ▸ Features)`);
    return entry;
}

function handleOnto(id: string, read: () => ShaderModuleData): Record<string, unknown> {
    const handle: Record<string, unknown> = { module: id };
    for (const field of FIELDS)
        Object.defineProperty(handle, field, { enumerable: true, get: () => read()[field] });
    return handle;
}

/**
 * The value a `.wgsl` import has in the published player: an object whose fields read module `id` from the
 * installed library. `variants` holds a handle for each of `tags` the game shipped, so a variant left out
 * reads as absent and its program falls back to the family's base (see ProgramRegistry.buildOnDemand).
 */
export function shaderModuleHandle(id: string, tags: readonly string[]): Record<string, unknown> {
    handles++;
    const handle = handleOnto(id, () => entryOf(id).base);
    handleIds.add(handle);
    if (!tags.length) return handle;
    let cached: Record<string, unknown> | null = null;
    let cachedFor = -1;
    const variantHandles = new Map<string, Record<string, unknown>>();
    Object.defineProperty(handle, 'variants', {
        enumerable: true,
        get: () => {
            if (cached && cachedFor === generation) return cached;
            // A module the game did not ship has no variants either: the registry looks at every program's,
            // shipped or not, and builds none of an unshipped one.
            if (installed && !installed[id]) return undefined;
            const shipped = entryOf(id).variants ?? {};
            const out: Record<string, unknown> = {};
            for (const tag of tags) {
                if (!shipped[tag]) continue;
                // One object per tag for the session: programs are cached by their descriptor object.
                let v = variantHandles.get(tag);
                if (!v) {
                    v = handleOnto(id, () => {
                        const data = entryOf(id).variants?.[tag];
                        if (!data) throw new Error(`Shader ${id}~${tag} was not shipped with this game`);
                        return data;
                    });
                    variantHandles.set(tag, v);
                }
                out[tag] = v;
            }
            cached = out;
            cachedFor = generation;
            return out;
        },
    });
    return handle;
}

// Which of the published player's shaders a game ships. The player is built with its shaders as handles onto
// a library (src/graphics/shaderLibrary.ts) and leaves every program's text and reflection in shaders.json
// beside it, all 17 MB of it: each module's base program and every variant, WGSL and GLSL. A publish copies
// the part the game can use into its game.bin:
//   - every module's BASE program: a pass asks for its program by name the moment it runs, and a base the
//     game lacks would stop that frame. The bases' runtime branches also stand in for any variant left out.
//   - the VARIANTS the game's program list names (config.graphics.programs, `pbr~pcf`): what the player
//     builds at boot. With no list (Options ▸ Project ▸ Only used shaders off) the game builds variants as it
//     goes, so it gets all of them.
//   - nothing of the features the project leaves out (Project ▸ Features): their nodes and settings are gone
//     from the game, so their programs never run.
//   - the programs' GLSL only when the game may run on WebGL 2 (Options ▸ Project ▸ WebGL 2 fallback). The
//     GLSL chunks custom materials paste in stay either way: on WebGPU those compile from GLSL too.
// Pure, so a test can check a selection without a built player.

/** One program's text and reflection, as shaders.json holds it. */
export type ShaderData = Record<string, unknown>;
export interface ShaderEntry { base: ShaderData; variants?: Record<string, ShaderData> }
export type ShaderLibraryJson = Record<string, ShaderEntry>;

export interface ShaderSelectionOptions {
  /** The game's program list: physical names, `name~tag` for a variant. Undefined: no list, every variant. */
  programs?: readonly string[];
  /** Each program-table name's module id (the engine's programModules()). */
  programModules: Readonly<Record<string, string>>;
  /** Keep the GLSL: the game may run on WebGL 2. */
  webgl2: boolean;
  /** Modules of the features the game leaves out. One a listed program still draws with ships all the same. */
  leaveOut?: ReadonlySet<string>;
}

/**
 * The fields of a program only WebGL 2 reads: its GLSL stages. Not `glslChunk`, the GLSL a custom material's
 * prelude pastes in (shadowsChunk, clusteredLightsChunk): a custom material compiles from GLSL on WebGPU too.
 */
const GLSL_FIELDS = ['vertex', 'fragment'];

const withoutGlsl = (data: ShaderData): ShaderData =>
  Object.fromEntries(Object.entries(data).filter(([k]) => !GLSL_FIELDS.includes(k)));

/** The variant tags a program list names, by module id. */
export function variantsNamed(programs: readonly string[], programModules: Readonly<Record<string, string>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const physical of programs) {
    const at = physical.indexOf('~');
    if (at < 0) continue;
    const module = programModules[physical.slice(0, at)];
    if (!module) continue;
    let tags = out.get(module);
    if (!tags) out.set(module, tags = new Set());
    tags.add(physical.slice(at + 1));
  }
  return out;
}

/** The part of `library` a game ships (see the note at the top). */
export function selectShaders(library: ShaderLibraryJson, options: ShaderSelectionOptions): ShaderLibraryJson {
  const named = options.programs ? variantsNamed(options.programs, options.programModules) : null;
  const keep = (data: ShaderData) => options.webgl2 ? data : withoutGlsl(data);
  const out: ShaderLibraryJson = {};
  const listed = options.programs
    ? new Set(options.programs.map(p => options.programModules[p.split('~')[0]]).filter(Boolean))
    : null;
  for (const [id, entry] of Object.entries(library)) {
    if (options.leaveOut?.has(id) && !listed?.has(id)) continue;
    const shipped: ShaderEntry = { base: keep(entry.base) };
    if (entry.variants) {
      const tags = named ? [...(named.get(id) ?? [])].filter(t => entry.variants![t]) : Object.keys(entry.variants);
      if (tags.length) shipped.variants = Object.fromEntries(tags.map(t => [t, keep(entry.variants![t])]));
    }
    out[id] = shipped;
  }
  return out;
}

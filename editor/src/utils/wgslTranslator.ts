import { setWgslTranslator, hasWgslTranslator } from 'cleo'

/**
 * Loads the vendored naga WASM and installs it as the engine's GLSL -> WGSL translator.
 *
 * Custom materials are user GLSL stored inside saved projects, so checking one against WebGPU has to
 * happen in the app rather than at build time like the engine's own shaders. The engine therefore keeps
 * only a slot (`setWgslTranslator`); this fills it, and a published game never does.
 *
 * Two deliberate choices keep 1.3 MB of shader compiler out of everyone's way:
 *
 *   - **`webpackIgnore`.** The import is left for the browser to resolve at runtime, so naga never enters
 *     the editor bundle. Webpack would otherwise follow it and inline the glue, and the wasm alongside it.
 *   - **Called on demand**, from the custom-material inspector, not at boot. A user who never opens a
 *     custom material never downloads it.
 *
 * The artifact is copied to `naga/` by CopyWebpackPlugin from the engine's vendored directory, so there
 * is one copy in the repository and no build step to remember.
 */

let loading: Promise<boolean> | null = null

/** Resolve a path against the page's base, so this works under a sub-path deployment. */
const assetUrl = (file: string) => new URL(`naga/${file}`, document.baseURI).href

async function load(): Promise<boolean> {
  try {
    const mod: any = await import(/* webpackIgnore: true */ assetUrl('nagaGlsl.js'))
    await mod.default({ module_or_path: assetUrl('nagaGlsl_bg.wasm') })
    // naga's own errors are thrown as JS Errors carrying its diagnostic; passing them straight through
    // is the point — the material editor shows that text, and it names the GLSL construct at fault.
    setWgslTranslator((glsl: string) => mod.glsl_to_wgsl(glsl, 'fragment'))
    return true
  } catch (e) {
    // Not fatal, and deliberately not surfaced as an error dialog. Without a translator the Compile
    // button still compiles and applies the shader; it just cannot report a WebGPU verdict, which is
    // exactly how a build without the artifact should behave.
    console.warn('[cleo] WGSL translator unavailable; WebGPU compatibility will not be checked.', e)
    return false
  }
}

/** Install the translator if it is not already installed. Safe and cheap to call repeatedly. */
export function ensureWgslTranslator(): Promise<boolean> {
  if (hasWgslTranslator()) return Promise.resolve(true)
  if (!loading) loading = load()
  return loading
}

import { setWgslTranslator, hasWgslTranslator } from 'cleo'

/**
 * Loads the vendored naga WASM and installs it as the engine's GLSL -> WGSL translator. Custom materials
 * are user GLSL, so the WebGPU check happens in the app; the engine keeps only a slot
 * (`setWgslTranslator`) and a published game never fills it.
 *
 * Two rules keep 1.3 MB of shader compiler out of the bundle: the import must keep `webpackIgnore` so the
 * browser resolves it at runtime, and it must be called on demand from the custom-material inspector
 * rather than at boot. The artifact is copied to `naga/` by CopyWebpackPlugin.
 */

let loading: Promise<boolean> | null = null

/** Resolve a path against the page's base, so this works under a sub-path deployment. */
const assetUrl = (file: string) => new URL(`naga/${file}`, document.baseURI).href

async function load(): Promise<boolean> {
  try {
    const mod: any = await import(/* webpackIgnore: true */ assetUrl('nagaGlsl.js'))
    await mod.default({ module_or_path: assetUrl('nagaGlsl_bg.wasm') })
    // naga's errors carry its diagnostic, which names the GLSL construct at fault; pass them through
    // untouched so the material editor can show that text.
    setWgslTranslator((glsl: string) => mod.glsl_to_wgsl(glsl, 'fragment'))
    return true
  } catch (e) {
    // Not fatal: without a translator the Compile button still compiles and applies the shader, it just
    // cannot report a WebGPU verdict.
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

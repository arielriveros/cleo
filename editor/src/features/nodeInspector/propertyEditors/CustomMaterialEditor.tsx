import { useEffect, useRef, useState } from 'react'
import { ModelNode, CustomMaterial, customSeedTemplate, tryCompileCustom, vulkanUnsupportedReason } from 'cleo'
import type { CustomBaseType, CustomRenderMode } from 'cleo'
import { useEventBus } from '../../EventBusContext'
import { useDocument } from '../../DocumentContext'
import { seedCustomMaterial } from '../../../utils/customMaterials'
import { ensureWgslTranslator } from '../../../utils/wgslTranslator'
import GlslCodeEditor from '../scriptEditor/GlslCodeEditor'
import CustomUniformsEditor from './CustomUniformsEditor'
import { Select, Field, Hint, Button } from '../../../components/ui'

const BASES: { value: string, label: string }[] = [
  { value: 'scratch', label: 'From scratch' },
  { value: 'basic', label: 'Basic' },
  { value: 'blinn_phong', label: 'Blinn-Phong' },
  { value: 'pbr', label: 'PBR' },
]
const baseKey = (b: CustomBaseType) => (b == null ? 'scratch' : b)
const keyToBase = (k: string): CustomBaseType => (k === 'scratch' ? null : k as CustomBaseType)

/**
 * Inspector body for a custom (user-authored shader) material. Provides the render-mode toggle
 * (forward = final color / deferred = G-buffer surface), the "extend base" scaffold chooser, the GLSL
 * source editor, and the user-uniforms editor. Kept preview-live by only advancing the material's shader
 * key (`refreshType`) on a successful compile — a broken edit shows the error and keeps rendering the
 * last good program.
 *
 * **Compiling is explicit** (the Compile button / Ctrl+Enter), not automatic while typing. GL shader
 * compilation and program linking are synchronous main-thread calls with no async variant, so the old
 * debounced-on-every-pause compile froze the whole editor — viewport, input and all — for the duration,
 * repeatedly, mid-keystroke. Typing now only stores the text; the user chooses when to pay for a compile.
 */
export default function CustomMaterialEditor(props: { node: ModelNode }) {
  const eventEmitter = useEventBus()
  const { saveActiveTab } = useDocument()
  const mat = props.node.model.material as CustomMaterial
  const [source, setSource] = useState(mat.fragmentSource)
  const [error, setError] = useState<string | null>(null)
  // The WebGPU verdict from the last compile. Separate state from `error` on purpose: a material that
  // fails to translate still compiles, still renders and is still worth saving — it just will not run on
  // a WebGPU backend. Folding the two together would either block a working shader or bury a real
  // portability problem in a banner the user learns to ignore.
  const [wgslWarning, setWgslWarning] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [, force] = useState(0)
  const timer = useRef<number | null>(null)
  // The source the live program and the error banner currently reflect. Anything typed since is unapplied,
  // which is what the Compile button's enabled state and the "unapplied" hint are driven from. Set on a
  // FAILED compile too: the error shown does describe that text.
  const [compiledSource, setCompiledSource] = useState(mat.fragmentSource)

  const recompile = (src = mat.fragmentSource) => {
    const res = tryCompileCustom(mat.renderMode, src, mat.uniforms)
    setError(res.ok ? null : (res.error ?? 'Compile error'))

    if (!res.ok) {
      // Nothing to say about WebGPU when the shader does not compile at all; the GL diagnostic is the
      // one with real line numbers, and a second failure about the same source is just noise.
      setWgslWarning(null)
      return { ok: false, wgsl: null as string | null }
    }

    if (res.wgsl) { setWgslWarning(null); return { ok: true, wgsl: res.wgsl } }
    // No WGSL and no error means no translator is installed, which is not something to warn about.
    setWgslWarning(res.wgslError
      ? 'Compiles and runs on WebGL2, but will not run on WebGPU:\n' + res.wgslError
      : vulkanUnsupportedReason(mat.renderMode))
    return { ok: true, wgsl: null }
  }

  /**
   * Store `src`, compile it, and on success advance the shader key so the preview picks it up. This is the
   * only path that compiles a source edit, and it runs solely on explicit user action.
   */
  const compileNow = (src: string) => {
    // A pending store from onSourceChange would otherwise write the same text again and re-dirty the tab.
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    mat.fragmentSource = src
    const res = recompile(src)
    if (res.ok) {
      mat.refreshType()
      // Stamped AFTER refreshType, never before: `compiledWgslType` records the hash this WGSL was
      // produced from, and comparing it against a hash computed from the previous source would mark a
      // fresh translation stale (or, worse, an old one current).
      mat.compiledWgsl = res.wgsl
      mat.compiledWgslType = res.wgsl ? mat.type : null
    }
    setCompiledSource(src)
    eventEmitter.emit('SCENE_CHANGED')
  }

  // Re-sync when the inspected material changes. Seed a blank material (e.g. one created without a scaffold).
  useEffect(() => {
    if (!mat.fragmentSource) seedCustomMaterial(mat, mat.baseType, mat.renderMode)
    setSource(mat.fragmentSource)
    setCompiledSource(mat.fragmentSource)
    // Fetch naga before the opening compile, so the first verdict the user sees is a real one rather
    // than "not checked". It is a dynamic import of ~1.3 MB, so it happens here — on opening a custom
    // material — and not at editor boot.
    ensureWgslTranslator().then(() => recompile(mat.fragmentSource))
  }, [props.node])

  // Drop a pending store if the inspector closes mid-debounce — it would otherwise write to a material the
  // user has navigated away from.
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  // Typing stores the text (cheap, and needed so the edit saves and survives a tab switch) but does NOT
  // compile. Still debounced, purely to keep SCENE_CHANGED churn down — not to throttle GL work.
  const onSourceChange = (src: string) => {
    setSource(src)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      mat.fragmentSource = src
      eventEmitter.emit('SCENE_CHANGED')
    }, 300)
  }

  /** Typed-but-not-yet-compiled edits exist: the preview and the error banner are both out of date. */
  const isStale = source !== compiledSource

  // --- Save -------------------------------------------------------------------------------------
  //
  // Deliberately NOT gated on a clean compile. Saving a shader mid-edit is a normal thing to want —
  // stopping for the day on something that does not compile yet, or keeping a WebGL2-only material that
  // simply cannot be translated. A disabled Save would make the editor lose work to protect a rule the
  // user never agreed to. So it always saves, and says what it is saving instead.

  /** Why saving now stores something other than what is on screen, or null when it does not. */
  const saveWarning = isStale
    ? 'Saves the source as typed. The compiled preview is older — Compile first to save what you see.'
    : error
      ? 'Saves source that does not compile. The material will fall back to the magenta shader until it does.'
      : wgslWarning
        ? 'Saves without WGSL: this material runs on WebGL2 but not on WebGPU.'
        : null

  const saveTitle = saveWarning ?? 'Save this material to the library (Ctrl+S)'

  const save = async () => {
    setSaving(true)
    // saveActiveTab reads the material off the tab's own scene, so the latest typed text has to be
    // committed first — otherwise a save within the 300 ms store debounce would write the previous text.
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    mat.fragmentSource = source
    try { await saveActiveTab() } finally { setSaving(false) }
  }

  // Replacing the scaffold (base or mode change) discards the current source — confirm if the user edited it.
  const wouldDiscard = () => mat.fragmentSource.trim() !== customSeedTemplate(mat.baseType, mat.renderMode).trim()

  const changeBase = (k: string) => {
    const base = keyToBase(k)
    if (base === mat.baseType) return
    if (wouldDiscard() && !window.confirm('Change the base scaffold? This replaces the current shader source.')) return
    seedCustomMaterial(mat, base, mat.renderMode)
    setSource(mat.fragmentSource)
    // Discrete user action replacing the whole source with a known-good scaffold — compile it straight
    // away rather than leaving the user with an "unapplied" badge on something they did not type.
    compileNow(mat.fragmentSource)
    force(n => n + 1)
  }

  // Keep the material-tab preview camera's pass list in step with the mode: a screen material previews
  // as a fullscreen camera pass (same instance, so source/uniform edits stay live), any other mode as
  // the sphere's surface. Only touches the editor preview camera, never a game camera.
  const syncPreviewCamera = () => {
    const cam = props.node.scene?.activeCamera
    if (!cam || !cam.name.startsWith('__editor__')) return
    if (mat.renderMode === 'screen') cam.screenMaterials = [mat]
    else if (cam.screenMaterials.includes(mat)) cam.screenMaterials = cam.screenMaterials.filter(m => m !== mat)
  }

  const changeMode = (mode: CustomRenderMode) => {
    if (mode === mat.renderMode) return
    if (wouldDiscard() && !window.confirm('Switch render mode? Each mode uses a different shader entry point, so this replaces the source.')) return
    seedCustomMaterial(mat, mat.baseType, mode)
    syncPreviewCamera()
    setSource(mat.fragmentSource)
    compileNow(mat.fragmentSource)
    force(n => n + 1)
  }

  const onUniformsChange = (structural: boolean) => {
    // A changed declaration set changes the assembled source, so the preview is wrong until it recompiles.
    // Also a discrete action (add/remove/retype a uniform), not typing — so it compiles immediately, on
    // the LATEST editor text rather than mat.fragmentSource, which can lag it by one debounce.
    if (structural) compileNow(source)
    else eventEmitter.emit('SCENE_CHANGED')
  }

  return (
    <div className='w-full p-2'>
      <div className='flex items-center gap-3 mb-2 flex-wrap'>
        <Field label='Mode' className='w-auto'>
          <Select value={mat.renderMode} onChange={e => changeMode(e.target.value as CustomRenderMode)}>
            <option value='forward'>Forward (lit color)</option>
            <option value='deferred'>Deferred (G-buffer)</option>
            <option value='screen'>Screen (post-process)</option>
          </Select>
        </Field>
        {mat.renderMode !== 'screen' && (
          <Field label='Extend base' className='w-auto' labelClassName='w-auto'>
            <Select value={baseKey(mat.baseType)} onChange={e => changeBase(e.target.value)}>
              {BASES.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
            </Select>
          </Field>
        )}
      </div>

      <Hint className='mb-2'>
        {mat.renderMode === 'forward'
          ? 'Write vec4 fragment() returning the final lit color. Lights, shadows, the env map and helpers (accumulateLight, shadowCalculation) are available.'
          : mat.renderMode === 'deferred'
            ? 'Write void surface(inout Surface s) filling the G-buffer (albedo/normal/metallic/roughness/emissive); the engine lights it with SSAO/IBL/shadows.'
            : 'Write vec4 fragment() sampling u_screenTexture at fragTexCoord — runs as a fullscreen pass from a camera’s Screen-Space Materials list (linear HDR, before tonemapping). Built-ins: u_depth, u_time, u_resolution, u_viewPos, u_invViewProj, u_sunDir/u_sunUV/u_sunVisible, reconstructWorldPos(uv, depth).'}
      </Hint>

      <GlslCodeEditor
        value={source}
        onChange={onSourceChange}
        error={error}
        warning={wgslWarning}
        onSubmit={() => { if (isStale) compileNow(source) }}
        headerRight={
          <>
            {isStale && <span className='text-[10px] text-warning' title='The preview still shows the last compiled shader'>unapplied edits</span>}
            <Button
              size='sm'
              variant={isStale ? 'primary' : 'default'}
              disabled={!isStale}
              onClick={() => compileNow(source)}
              title={isStale ? 'Compile and apply (Ctrl+Enter)' : 'No changes to compile'}
            >
              Compile
            </Button>
            <Button
              size='sm'
              variant={isStale ? 'default' : 'primary'}
              disabled={saving}
              onClick={save}
              title={saveTitle}
            >
              {saving ? 'Saving…' : saveWarning ? 'Save ⚠' : 'Save'}
            </Button>
          </>
        }
      />

      <CustomUniformsEditor material={mat} onChange={onUniformsChange} />
    </div>
  )
}

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
import { confirmDialog } from '../../dialogs/dialogStore'

const BASES: { value: string, label: string }[] = [
  { value: 'scratch', label: 'From scratch' },
  { value: 'basic', label: 'Basic' },
  { value: 'blinn_phong', label: 'Blinn-Phong' },
  { value: 'pbr', label: 'PBR' },
]
const MODES: { value: CustomRenderMode, label: string }[] = [
  { value: 'forward', label: 'Forward (lit color)' },
  { value: 'deferred', label: 'Deferred (G-buffer)' },
  { value: 'screen', label: 'Screen (post-process)' },
]
const baseKey = (b: CustomBaseType) => (b == null ? 'scratch' : b)
const keyToBase = (k: string): CustomBaseType => (k === 'scratch' ? null : k as CustomBaseType)

/**
 * Inspector body for a custom (user-authored shader) material: render-mode toggle, "extend base"
 * scaffold chooser, GLSL source editor and user-uniforms editor. The material's shader key
 * (`refreshType`) only advances on a successful compile, so a broken edit keeps the last good program.
 * Compiling is explicit (Compile button / Ctrl+Enter): GL compile and link are synchronous main-thread
 * calls, so compiling while typing stalls the whole editor.
 */
export default function CustomMaterialEditor(props: { node: ModelNode }) {
  const eventEmitter = useEventBus()
  const { saveActiveTab } = useDocument()
  const mat = props.node.model.material as CustomMaterial
  const [source, setSource] = useState(mat.fragmentSource)
  const [error, setError] = useState<string | null>(null)
  // WebGPU verdict from the last compile, kept separate from `error`: a material that fails to translate
  // still compiles and renders, it just will not run on a WebGPU backend.
  const [wgslWarning, setWgslWarning] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [, force] = useState(0)
  const timer = useRef<number | null>(null)
  // The source the live program and the error banner reflect; set on a FAILED compile too. Anything typed
  // since is unapplied, which drives the Compile button's enabled state.
  const [compiledSource, setCompiledSource] = useState(mat.fragmentSource)

  const recompile = (src = mat.fragmentSource) => {
    const res = tryCompileCustom(mat.renderMode, src, mat.uniforms)
    setError(res.ok ? null : (res.error ?? 'Compile error'))

    if (!res.ok) {
      // A shader that does not compile at all has no WebGPU verdict worth reporting.
      setWgslWarning(null)
      return { ok: false, wgsl: null as string | null }
    }

    if (res.wgsl) { setWgslWarning(null); return { ok: true, wgsl: res.wgsl } }
    // No WGSL and no error means no translator is installed.
    setWgslWarning(res.wgslError
      ? 'Compiles and runs on WebGL2, but will not run on WebGPU:\n' + res.wgslError
      : vulkanUnsupportedReason(mat.renderMode))
    return { ok: true, wgsl: null }
  }

  /** Store `src`, compile it, and on success advance the shader key so the preview picks it up. */
  const compileNow = (src: string) => {
    // Cancel the pending store; it would otherwise rewrite the same text and re-dirty the tab.
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    mat.fragmentSource = src
    const res = recompile(src)
    if (res.ok) {
      mat.refreshType()
      // Must be stamped AFTER refreshType: `compiledWgslType` records the hash this WGSL came from.
      mat.compiledWgsl = res.wgsl
      mat.compiledWgslType = res.wgsl ? mat.type : null
    }
    setCompiledSource(src)
    eventEmitter.emit('SCENE_CHANGED')
  }

  useEffect(() => {
    if (!mat.fragmentSource) seedCustomMaterial(mat, mat.baseType, mat.renderMode)
    setSource(mat.fragmentSource)
    setCompiledSource(mat.fragmentSource)
    // naga is a ~1.3 MB dynamic import, pulled in on opening a custom material rather than at editor boot.
    ensureWgslTranslator().then(() => recompile(mat.fragmentSource))
  }, [props.node])

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  // Typing only stores the text, it never compiles. The debounce is to keep SCENE_CHANGED churn down.
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
  // Never gated on a clean compile: saving mid-edit always stores the source as typed.

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
    // saveActiveTab reads the material off the tab's own scene, so flush the pending store first.
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    mat.fragmentSource = source
    try { await saveActiveTab() } finally { setSaving(false) }
  }

  // Replacing the scaffold discards the current source — confirm if the user edited it.
  const wouldDiscard = () => mat.fragmentSource.trim() !== customSeedTemplate(mat.baseType, mat.renderMode).trim()

  const changeBase = async (k: string) => {
    const base = keyToBase(k)
    if (base === mat.baseType) return
    if (wouldDiscard()) {
      const ok = await confirmDialog({
        title: `Change the base scaffold to “${BASES.find(b => b.value === k)?.label ?? k}”?`,
        message: 'This replaces the current shader source.',
        confirmLabel: 'Replace source',
        tone: 'warning',
      })
      // The <select> is controlled by mat.baseType, which has not moved, so React already restored the
      // DOM node when this handler first awaited. Re-rendering pins it there without relying on that.
      if (!ok) { force(n => n + 1); return }
    }
    seedCustomMaterial(mat, base, mat.renderMode)
    setSource(mat.fragmentSource)
    // A discrete action, not typing: compile the new scaffold immediately.
    compileNow(mat.fragmentSource)
    force(n => n + 1)
  }

  // Keeps the material-tab preview camera's pass list in step with the mode: a screen material previews as
  // a fullscreen camera pass, any other mode as the sphere's surface. Editor preview camera only.
  const syncPreviewCamera = () => {
    const cam = props.node.scene?.activeCamera
    if (!cam || !cam.name.startsWith('__editor__')) return
    if (mat.renderMode === 'screen') cam.screenMaterials = [mat]
    else if (cam.screenMaterials.includes(mat)) cam.screenMaterials = cam.screenMaterials.filter(m => m !== mat)
  }

  const changeMode = async (mode: CustomRenderMode) => {
    if (mode === mat.renderMode) return
    if (wouldDiscard()) {
      const ok = await confirmDialog({
        title: `Switch render mode to “${MODES.find(m => m.value === mode)?.label ?? mode}”?`,
        message: 'Each mode uses a different shader entry point, so this replaces the current source.',
        confirmLabel: 'Switch mode',
        tone: 'warning',
      })
      if (!ok) { force(n => n + 1); return }
    }
    seedCustomMaterial(mat, mat.baseType, mode)
    syncPreviewCamera()
    setSource(mat.fragmentSource)
    compileNow(mat.fragmentSource)
    force(n => n + 1)
  }

  const onUniformsChange = (structural: boolean) => {
    // Compile the LATEST editor text, not mat.fragmentSource, which can lag it by one debounce.
    if (structural) compileNow(source)
    else eventEmitter.emit('SCENE_CHANGED')
  }

  return (
    <div className='w-full p-2'>
      <div className='flex items-center gap-3 mb-2 flex-wrap'>
        <Field label='Mode' className='w-auto'>
          <Select value={mat.renderMode} onChange={e => { void changeMode(e.target.value as CustomRenderMode) }}>
            {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        </Field>
        {mat.renderMode !== 'screen' && (
          <Field label='Extend base' className='w-auto' labelClassName='w-auto'>
            <Select value={baseKey(mat.baseType)} onChange={e => { void changeBase(e.target.value) }}>
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

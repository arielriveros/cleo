import { useEffect, useRef, useState } from 'react'
import { ModelNode, CustomMaterial, customSeedTemplate, tryCompileCustom } from 'cleo'
import type { CustomBaseType, CustomRenderMode } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import { seedCustomMaterial } from '../../../utils/customMaterials'
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
  const { eventEmitter } = useCleoEngine()
  const mat = props.node.model.material as CustomMaterial
  const [source, setSource] = useState(mat.fragmentSource)
  const [error, setError] = useState<string | null>(null)
  const [, force] = useState(0)
  const timer = useRef<number | null>(null)
  // The source the live program and the error banner currently reflect. Anything typed since is unapplied,
  // which is what the Compile button's enabled state and the "unapplied" hint are driven from. Set on a
  // FAILED compile too: the error shown does describe that text.
  const [compiledSource, setCompiledSource] = useState(mat.fragmentSource)

  const recompile = (src = mat.fragmentSource) => {
    const res = tryCompileCustom(mat.renderMode, src, mat.uniforms)
    setError(res.ok ? null : (res.error ?? 'Compile error'))
    return res.ok
  }

  /**
   * Store `src`, compile it, and on success advance the shader key so the preview picks it up. This is the
   * only path that compiles a source edit, and it runs solely on explicit user action.
   */
  const compileNow = (src: string) => {
    // A pending store from onSourceChange would otherwise write the same text again and re-dirty the tab.
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    mat.fragmentSource = src
    if (recompile(src)) mat.refreshType()
    setCompiledSource(src)
    eventEmitter.emit('SCENE_CHANGED')
  }

  // Re-sync when the inspected material changes. Seed a blank material (e.g. one created without a scaffold).
  useEffect(() => {
    if (!mat.fragmentSource) seedCustomMaterial(mat, mat.baseType, mat.renderMode)
    setSource(mat.fragmentSource)
    setCompiledSource(mat.fragmentSource)
    // One compile per material opened, to surface any error the stored source already has. Discrete and
    // user-initiated (selecting the node), unlike the per-keystroke compiles this replaced.
    recompile(mat.fragmentSource)
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
          </>
        }
      />

      <CustomUniformsEditor material={mat} onChange={onUniformsChange} />
    </div>
  )
}

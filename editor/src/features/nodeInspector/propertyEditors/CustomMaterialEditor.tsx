import { useEffect, useRef, useState } from 'react'
import { ModelNode, CustomMaterial, customSeedTemplate, tryCompileCustom } from 'cleo'
import type { CustomBaseType, CustomRenderMode } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import { seedCustomMaterial } from '../../../utils/customMaterials'
import GlslCodeEditor from '../scriptEditor/GlslCodeEditor'
import CustomUniformsEditor from './CustomUniformsEditor'
import { Select, Field, Hint } from '../../../components/ui'

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
 * source editor (with live compile-error surfacing), and the user-uniforms editor. Kept preview-live by
 * only advancing the material's shader key (`refreshType`) on a successful compile — a broken edit shows
 * the error and keeps rendering the last good program.
 */
export default function CustomMaterialEditor(props: { node: ModelNode }) {
  const { eventEmitter } = useCleoEngine()
  const mat = props.node.model.material as CustomMaterial
  const [source, setSource] = useState(mat.fragmentSource)
  const [error, setError] = useState<string | null>(null)
  const [, force] = useState(0)
  const timer = useRef<number | null>(null)

  const recompile = (src = mat.fragmentSource) => {
    const res = tryCompileCustom(mat.renderMode, src, mat.uniforms)
    setError(res.ok ? null : (res.error ?? 'Compile error'))
    return res.ok
  }

  // Re-sync when the inspected material changes. Seed a blank material (e.g. one created without a scaffold).
  useEffect(() => {
    if (!mat.fragmentSource) seedCustomMaterial(mat, mat.baseType, mat.renderMode)
    setSource(mat.fragmentSource)
    recompile(mat.fragmentSource)
  }, [props.node])

  // Debounced commit of a source edit. Always store the text (so it saves / survives); only advance the
  // shader key on a clean compile so the live preview keeps the last good program while editing.
  const onSourceChange = (src: string) => {
    setSource(src)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      mat.fragmentSource = src
      if (recompile(src)) mat.refreshType()
      eventEmitter.emit('SCENE_CHANGED')
    }, 300)
  }

  // Replacing the scaffold (base or mode change) discards the current source — confirm if the user edited it.
  const wouldDiscard = () => mat.fragmentSource.trim() !== customSeedTemplate(mat.baseType, mat.renderMode).trim()

  const changeBase = (k: string) => {
    const base = keyToBase(k)
    if (base === mat.baseType) return
    if (wouldDiscard() && !window.confirm('Change the base scaffold? This replaces the current shader source.')) return
    seedCustomMaterial(mat, base, mat.renderMode)
    setSource(mat.fragmentSource)
    recompile(mat.fragmentSource)
    force(n => n + 1)
    eventEmitter.emit('SCENE_CHANGED')
  }

  const changeMode = (mode: CustomRenderMode) => {
    if (mode === mat.renderMode) return
    if (wouldDiscard() && !window.confirm('Switch render mode? Forward and deferred use different shader entry points, so this replaces the source.')) return
    seedCustomMaterial(mat, mat.baseType, mode)
    setSource(mat.fragmentSource)
    recompile(mat.fragmentSource)
    force(n => n + 1)
    eventEmitter.emit('SCENE_CHANGED')
  }

  const onUniformsChange = (structural: boolean) => {
    // A changed declaration set changes the assembled source; recompile and, on success, advance the key
    // (a failing decl set keeps the last good program, matching the source-edit behavior).
    if (structural && recompile()) mat.refreshType()
    eventEmitter.emit('SCENE_CHANGED')
  }

  return (
    <div className='w-full p-2'>
      <div className='flex items-center gap-3 mb-2 flex-wrap'>
        <Field label='Mode' className='w-auto'>
          <Select value={mat.renderMode} onChange={e => changeMode(e.target.value as CustomRenderMode)}>
            <option value='forward'>Forward (lit color)</option>
            <option value='deferred'>Deferred (G-buffer)</option>
          </Select>
        </Field>
        <Field label='Extend base' className='w-auto' labelClassName='w-auto'>
          <Select value={baseKey(mat.baseType)} onChange={e => changeBase(e.target.value)}>
            {BASES.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
          </Select>
        </Field>
      </div>

      <Hint className='mb-2'>
        {mat.renderMode === 'forward'
          ? 'Write vec4 fragment() returning the final lit color. Lights, shadows, the env map and helpers (accumulateLight, shadowCalculation) are available.'
          : 'Write void surface(inout Surface s) filling the G-buffer (albedo/normal/metallic/roughness/emissive); the engine lights it with SSAO/IBL/shadows.'}
      </Hint>

      <GlslCodeEditor value={source} onChange={onSourceChange} error={error} />

      <CustomUniformsEditor material={mat} onChange={onUniformsChange} />
    </div>
  )
}

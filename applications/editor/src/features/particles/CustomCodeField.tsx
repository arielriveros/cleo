import { useEffect, useState } from 'react'
import { compileParticleCustomCode, customCodeKey, type CompiledCustomCode } from 'cleo'
import GlslCodeEditor from '../nodeInspector/scriptEditor/GlslCodeEditor'
import { Button } from '../../components/ui'
import { ensureWgslTranslator } from '../../utils/wgslTranslator'

// The custom-code module's editor: WGSL in, a validated compile out. The source runs only once Compile
// has validated THIS text (see src/particles/particleCustomCode.ts) — so an edit in progress never
// reaches the GPU half-typed, and the preview keeps the last good behaviour until the next compile.

export default function CustomCodeField(props: {
  source: string
  compiled: CompiledCustomCode | null
  onChange: (patch: { source?: string; compiled?: CompiledCustomCode | null }, coalesce?: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => { ensureWgslTranslator().then(setReady) }, [])

  const current = !!props.compiled && props.compiled.key === customCodeKey(props.source)
  const compile = async () => {
    setBusy(true)
    try {
      await ensureWgslTranslator()
      props.onChange({ compiled: compileParticleCustomCode(props.source) })
    } finally { setBusy(false) }
  }

  const status = !props.compiled ? 'Not compiled — the emitter runs without it.'
    : !current ? 'Edited since the last compile — the last compiled version is NOT running; compile to apply.'
    : props.compiled.ok ? 'Compiled. Running on both WebGPU and WebGL2.'
    : 'Compile failed — the emitter runs without it.'

  return (
    <div className='flex flex-col gap-1'>
      <GlslCodeEditor
        value={props.source}
        onChange={source => props.onChange({ source }, true)}
        onSubmit={compile}
        error={current && props.compiled && !props.compiled.ok ? props.compiled.error ?? 'Compile failed.' : null}
        headerRight={
          <Button size='sm' variant={current && props.compiled?.ok ? 'subtle' : 'primary'} disabled={busy || !ready}
                  onClick={compile} title={ready ? 'Validate and apply (Ctrl+Enter)' : 'Loading the shader compiler…'}>
            {busy ? 'Compiling…' : 'Compile'}
          </Button>
        } />
      <div className='text-ui-xs text-dim'>
        {status} Reads and writes <code>(*p).position</code>, <code>velocity</code>, <code>age</code>,{' '}
        <code>lifetime</code>, <code>size</code>, <code>rotation</code>, <code>spin</code>, <code>color</code>,{' '}
        <code>seed</code>; <code>dt</code> and <code>custom</code> are in scope. Set <code>lifetime = 0.0</code> to kill.
      </div>
    </div>
  )
}

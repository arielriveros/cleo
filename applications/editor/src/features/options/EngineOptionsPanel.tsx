import { useCleoEngine } from '../EngineContext'
import RendererSettingsPanel from '../renderer/RendererSettingsPanel'
import PerformancePanel from '../renderer/PerformancePanel'
import { Button, Field, NumberInput, Section, Slider, VectorInput } from '../../components/ui'
import { OptionsPageBody, OptionsShell, OPTION_LABEL, useOptionsPage } from './OptionsShell'
import { DEFAULT_PROJECT_SETTINGS, type EngineRuntimeSettings } from './projectSettings'

// Options ▸ Engine: how the engine renders and runs THIS game. Renderer settings are saved with the open
// scene (each scene keeps its own look); the runtime settings are project-wide and ship in the build.

type Page = 'renderer' | 'performance' | 'runtime'

export default function EngineOptionsPanel() {
  const [page, setPage] = useOptionsPage<Page>('engine', 'renderer')
  return (
    <OptionsShell
      page={page}
      onPage={setPage}
      pages={[
        { value: 'renderer', label: 'Renderer', doc: 'editor/options#renderer' },
        { value: 'performance', label: 'Performance', doc: 'editor/options#performance' },
        { value: 'runtime', label: 'Runtime', doc: 'editor/options#runtime' },
      ]}
    >
      {page === 'renderer' && <RendererSettingsPanel />}
      {page === 'performance' && <PerformancePanel />}
      {page === 'runtime' && <RuntimeOptions />}
    </OptionsShell>
  )
}

function RuntimeOptions() {
  const { projectSettings, setProjectSettings } = useCleoEngine()
  const e = projectSettings.engine
  const set = (patch: Partial<EngineRuntimeSettings>) =>
    setProjectSettings(prev => ({ ...prev, engine: { ...prev.engine, ...patch } }))
  const d = DEFAULT_PROJECT_SETTINGS.engine

  return (
    <OptionsPageBody>
      {/* The explanations live in docs/editor/options.md › Runtime: each Field label's card is its row there. */}
      <Section title='Physics'>
        <Field label='Gravity (m/s²)' labelClassName={OPTION_LABEL}>
          <VectorInput value={e.gravity} onChange={v => set({ gravity: [v[0], v[1], v[2]] })}
            step={0.1} reset={[...d.gravity]} precision={2} />
        </Field>
        <Field label='Max substeps / frame' labelClassName={OPTION_LABEL}>
          <NumberInput value={e.maxSubsteps} min={1} max={32} step={1}
            onChange={v => set({ maxSubsteps: Math.max(1, Math.min(32, Math.round(v))) })} />
        </Field>
        <Field label='Simulation range (m)' labelClassName={OPTION_LABEL}>
          <NumberInput value={e.simulationRange} min={0} max={100000} step={5}
            onChange={v => set({ simulationRange: Math.max(0, v) })} />
        </Field>
      </Section>

      <Section title='Frame timing'>
        <Field label='Max frame delta (s)' labelClassName={OPTION_LABEL}>
          <NumberInput value={e.maxFrameDelta} min={1 / 240} max={0.5} step={0.01}
            onChange={v => set({ maxFrameDelta: Math.max(1 / 240, Math.min(0.5, v)) })} />
        </Field>
      </Section>

      <Section title='Audio'>
        <Slider label='Master volume' labelClassName={OPTION_LABEL} min={0} max={1} step={0.01}
          value={e.masterVolume} onChange={v => set({ masterVolume: v })}
          readout={v => `${Math.round(v * 100)}%`} />
      </Section>

      <Button size='sm' variant='ghost' onClick={() => set({ ...d, gravity: [...d.gravity] })}>
        Reset runtime options
      </Button>
    </OptionsPageBody>
  )
}

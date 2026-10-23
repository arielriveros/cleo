import { useCleoEngine } from '../EngineContext'
import RendererSettingsPanel from '../renderer/RendererSettingsPanel'
import PerformancePanel from '../renderer/PerformancePanel'
import { Button, Field, Hint, NumberInput, Section, Slider, VectorInput } from '../../components/ui'
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
        { value: 'renderer', label: 'Renderer', title: 'Graphics API, debug channels, quality and post-processing (saved with the open scene)' },
        { value: 'performance', label: 'Performance', title: 'Live frame-time breakdown' },
        { value: 'runtime', label: 'Runtime', title: 'Physics, frame timing and audio — project-wide, shipped with the game' },
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
      <Hint className='mb-3'>Project-wide: every scene runs with these, in the editor's Play and in the published game.</Hint>

      <Section title='Physics'>
        <Field label='Gravity (m/s²)' labelClassName={OPTION_LABEL}
          hint='World gravity vector. Earth is (0, -9.81, 0); a top-down or space game often wants zero.'>
          <VectorInput value={e.gravity} onChange={v => set({ gravity: [v[0], v[1], v[2]] })}
            step={0.1} reset={[...d.gravity]} precision={2} />
        </Field>
        <Field label='Max substeps / frame' labelClassName={OPTION_LABEL}
          hint={'Each frame advances physics in equal substeps of at most 1/60 s, up to this many. Past it the '
            + 'substeps grow longer: the world still covers the frame, in coarser steps. Lower = less work on '
            + 'slow frames, less stable stacks and joints.'}>
          <NumberInput value={e.maxSubsteps} min={1} max={32} step={1}
            onChange={v => set({ maxSubsteps: Math.max(1, Math.min(32, Math.round(v))) })} />
        </Field>
        <Field label='Simulation range (m)' labelClassName={OPTION_LABEL}
          hint={'Dynamic bodies farther than this from the camera are frozen in place: still solid to rays, '
            + 'the camera and other bodies, but not simulated, until the camera comes back. 0 = simulate '
            + 'everything. A body can opt out (Always) or set its own range in its Physics panel.'}>
          <NumberInput value={e.simulationRange} min={0} max={100000} step={5}
            onChange={v => set({ simulationRange: Math.max(0, v) })} />
        </Field>
      </Section>

      <Section title='Frame timing'>
        <Field label='Max frame delta (s)' labelClassName={OPTION_LABEL}
          hint={'The longest frame the simulation will step. A slower frame (a hitch, a breakpoint, a tab-out) '
            + 'slows the whole game down instead of taking a bigger step. 0.1 s = slows below 10 fps.'}>
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

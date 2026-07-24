import { useAnimationField } from './AnimationFieldContext'
import Collapsable from '../../components/Collapsable'
import { SegmentedControl } from '../../components/ui'
import type { AnimationFieldAxis } from '../../utils/animationFields'

// Sidebar inspector for the Animation Field editor. The plot owns placement (that IS the data); this panel
// owns everything the plot cannot express: the field's name, its mode, the axis ranges, and per-sample
// details like which clip a point plays and its rate scale.

const input = 'bg-control text-white border border-control-hover rounded px-1 py-0.5 text-xs'
const btn = 'px-2 py-1 rounded bg-primary hover:bg-primary-hover text-white border border-primary-active text-xs'
const ghost = 'px-1.5 py-0.5 rounded border border-control-hover hover:bg-control text-xs'
const danger = 'px-1.5 py-0.5 rounded bg-red-700 hover:bg-red-600 text-white text-xs'

function NoField() {
  return <div className='flex h-full w-full flex-col bg-surface-raised p-3 text-sm text-gray-400'>No animation field open.</div>
}

export default function AnimationFieldPanel() {
  const {
    field, clips, clipDurations, target, weights, selected, setSelected,
    setName, setMode, setAxis, addSample, setSample, removeSample, save, dirty,
  } = useAnimationField()

  if (!field) return <NoField />
  const is2D = field.mode === '2d'
  const weightOf = (clipName: string) => weights.find(w => w.clipName === clipName)?.weight ?? 0

  // A blend paces itself against each clip's OWN authored length, so a clip several times shorter than the
  // rest of the field plays that corner at several times the speed — which reads as "only the run animation
  // is broken" and is invisible without the numbers. Compared against the MEDIAN so one bad clip cannot
  // define what normal looks like.
  //
  // Only SHORT outliers are flagged. A long clip plays slowly, which is both far less jarring and usually
  // deliberate — an idle is routinely several times the length of a walk, and warning about that every time
  // would be noise. The 2.5x band also leaves a genuine run/walk cadence difference (~1.7x) alone.
  const lengths = field.samples.map(s => clipDurations[s.clipName]).filter(d => d > 0).sort((a, b) => a - b)
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0
  const isOutlier = (d: number) => median > 0 && d > 0 && d < median / 2.5

  return (
    <div className='flex h-full w-full flex-col overflow-y-auto bg-surface-raised text-white'>
      <div className='border-b border-border p-2'>
        <button className={btn + ' w-full'} onClick={save}
          title='Write this field to the library and refresh every animation state playing it'>
          Save Field{dirty ? ' •' : ''}
        </button>
      </div>

      <Collapsable title='Field' defaultOpen>
        <div className='flex flex-col gap-2 p-2'>
          <label className='flex items-center gap-1'>
            <span className='w-[42px] shrink-0 text-[10px] text-gray-400'>Name</span>
            <input className={input + ' min-w-0 flex-1'} value={field.name} onChange={e => setName(e.target.value)} />
          </label>

          <div className='flex items-center gap-1'>
            <span className='w-[42px] shrink-0 text-[10px] text-gray-400'>Axes</span>
            <SegmentedControl<'1d' | '2d'>
              size='sm' value={field.mode} onChange={setMode}
              options={[
                { value: '1d', label: '1D', title: 'One input axis — blends along a line' },
                { value: '2d', label: '2D', title: 'Two input axes — blends across a plane' },
              ]} />
          </div>
          {/* Switching to 1D keeps each sample's y — it is simply not read — so flipping back restores the
              layout instead of flattening it. Worth saying, since the plot visibly collapses. */}
          {!is2D && <p className='-mt-1 text-[10px] text-gray-500'>Y positions are kept and restored if you switch back to 2D.</p>}

          <AxisRow label='X' axis={field.xAxis} onChange={p => setAxis('x', p)} />
          {is2D && <AxisRow label='Y' axis={field.yAxis} onChange={p => setAxis('y', p)} />}
        </div>
      </Collapsable>

      <Collapsable title='Samples' badge={field.samples.length || undefined} defaultOpen>
        <div className='flex flex-col gap-1 p-2'>
          {clips.length === 0 && (
            <p className='text-[11px] text-warning'>
              {target
                ? 'This model has no animation clips. Import some in the Animation Editor first.'
                : 'The field’s model could not be previewed.'}
            </p>
          )}

          {field.samples.length === 0 && clips.length > 0 && (
            <p className='text-[11px] text-gray-400'>None yet — double-click the plot to drop a clip.</p>
          )}

          {field.samples.map((s, i) => {
            const w = weightOf(s.clipName)
            const missing = !!s.clipName && !clips.includes(s.clipName)
            const length = clipDurations[s.clipName] ?? 0
            const outlier = isOutlier(length)
            return (
              <div
                key={i}
                className={`flex flex-col gap-1 rounded border p-1.5 ${selected === i ? 'border-selected' : 'border-control'}`}
                onClick={() => setSelected(i)}>
                <div className='flex items-center gap-1'>
                  <select className={input + ' min-w-0 flex-1'} value={s.clipName}
                    onChange={e => setSample(i, { clipName: e.target.value })}>
                    <option value=''>(no clip)</option>
                    {missing && <option value={s.clipName}>{s.clipName} — missing</option>}
                    {clips.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <span className='w-[34px] shrink-0 text-right text-[10px] tabular-nums text-highlight'
                    title='Live weight at the current preview point'>
                    {w > 0.001 ? `${(w * 100).toFixed(0)}%` : ''}
                  </span>
                  <button className={danger + ' shrink-0'} title='Remove sample' onClick={() => removeSample(i)}>✕</button>
                </div>

                <div className='flex items-center gap-1 text-[10px]'>
                  <span className='text-gray-400'>x</span>
                  <input className={input + ' w-[56px]'} type='number' step='any' value={s.x}
                    onChange={e => setSample(i, { x: parseFloat(e.target.value) || 0 })} />
                  {is2D && <>
                    <span className='text-gray-400'>y</span>
                    <input className={input + ' w-[56px]'} type='number' step='any' value={s.y ?? 0}
                      onChange={e => setSample(i, { y: parseFloat(e.target.value) || 0 })} />
                  </>}
                  {/* Rate scale changes what this clip contributes to the blended duration, which is what
                      keeps a differently-authored clip in step with the rest instead of sliding. */}
                  {/* The clip's authored length. The blend paces itself against this, so it is the number
                      that explains a corner of the field running at the wrong speed. */}
                  <span className={`ml-auto tabular-nums ${outlier ? 'text-warning' : 'text-dim'}`}
                    title={outlier
                      ? `Only ${length.toFixed(2)}s, against a median of ${median.toFixed(2)}s in this field — so this clip plays about ${(median / length).toFixed(1)}x faster than the rest. Correct it with the rate below.`
                      : 'Authored length of this clip — the blend paces itself against this'}>
                    {length > 0 ? `${length.toFixed(2)}s` : '—'}
                  </span>
                  <span className='text-gray-400' title='Playback rate for this clip inside the blend'>rate</span>
                  <input className={input + ' w-[48px]'} type='number' step='0.1' min='0.01' value={s.rateScale ?? 1}
                    onChange={e => {
                      const v = parseFloat(e.target.value)
                      setSample(i, { rateScale: Number.isFinite(v) && v > 0 ? v : undefined })
                    }} />
                </div>
                {outlier && (
                  <button
                    className={ghost + ' self-start border-warning text-warning'}
                    title={`Sets the rate to ${(length / median).toFixed(2)} so this clip's cycle lasts as long as the rest of the field's`}
                    onClick={() => setSample(i, { rateScale: Number((length / median).toFixed(3)) })}>
                    ⚠ {(median / length).toFixed(1)}× faster than the rest — slow it to match
                  </button>
                )}
              </div>
            )
          })}

          <button className={ghost + ' mt-1 self-start'} disabled={clips.length === 0} onClick={() => addSample()}>
            + Sample
          </button>
        </div>
      </Collapsable>
    </div>
  )
}

function AxisRow({ label, axis, onChange }: {
  label: string
  axis: AnimationFieldAxis
  onChange: (patch: Partial<AnimationFieldAxis>) => void
}) {
  return (
    <div className='flex items-center gap-1'>
      <span className='w-[42px] shrink-0 text-[10px] text-gray-400'>{label}</span>
      <input className={input + ' min-w-0 flex-1'} value={axis.name} title='Axis name'
        onChange={e => onChange({ name: e.target.value })} />
      <input className={input + ' w-[52px]'} type='number' step='any' value={axis.min} title='Minimum'
        onChange={e => onChange({ min: parseFloat(e.target.value) || 0 })} />
      <input className={input + ' w-[52px]'} type='number' step='any' value={axis.max} title='Maximum'
        onChange={e => onChange({ max: parseFloat(e.target.value) || 0 })} />
    </div>
  )
}

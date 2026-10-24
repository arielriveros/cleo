import { DEFAULT_AXIS_SMOOTHING, DEFAULT_WEIGHT_SMOOTHING, coincidentSamples } from 'cleo'
import { useAnimationField } from './AnimationFieldContext'
import Collapsable from '../../components/Collapsable'
import { Button, OptionalNumberInput, Select, SegmentedControl, TextInput, Toggle, cn, hintClass } from '../../components/ui'
import { toRuntimeField } from '../../utils/animationFields'
import type { AnimationFieldAxis } from '../../utils/animationFields'

// Sidebar inspector for the Animation Field editor: the field's name, mode and axis ranges, plus per-sample
// clip and rate scale. Sample placement belongs to the plot.

// Number fields are OptionalNumberInput, not NumberInput: NumberInput coerces a partial value ("-") to 0,
// which is exactly the negative-entry bug the handlers below avoid, and these fields also allow blank = default.
// OptionalNumberInput reports a cleared box as `undefined` and never emits half-typed text.
const input = 'px-1 py-0.5'
const fieldLabel = 'w-[42px] shrink-0 text-ui-xs text-muted'
/** A warning-coloured call-to-action inside a sample card. */
const warnBtn = 'border-warning text-warning hover:text-warning'

function NoField() {
  return <div className='flex h-full w-full flex-col bg-surface-raised p-3 text-ui text-muted'>No blend space open.</div>
}

export default function AnimationFieldPanel() {
  const {
    field, clips, clipDurations, target, weights, selected, setSelected,
    setName, setMode, setAxis, setWeightSmoothing, addSample, setSample, removeSample, save, dirty,
  } = useAnimationField()

  if (!field) return <NoField />
  const is2D = field.mode === '2d'
  const weightOf = (clipName: string) => weights.find(w => w.clipName === clipName)?.weight ?? 0

  // A blend paces itself against each clip's OWN authored length, so a much shorter clip plays its corner
  // much faster. Compared against the MEDIAN, and only SHORT outliers are flagged; the 2.5x band clears a
  // genuine run/walk cadence difference (~1.7x).
  const lengths = field.samples.map(s => clipDurations[s.clipName]).filter(d => d > 0).sort((a, b) => a - b)
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0
  const isOutlier = (d: number) => median > 0 && d > 0 && d < median / 2.5

  // Samples on the same coordinate split one sample's worth of weight. A wrapping axis makes its two ends
  // the same point while the plot draws them at opposite edges, so this has to be said out loud.
  const coincidentWith: Record<number, string> = {}
  for (const group of coincidentSamples(toRuntimeField(field))) {
    for (const i of group) {
      const others = group.filter(j => j !== i).map(j => field.samples[j].clipName || `#${j + 1}`)
      coincidentWith[i] = others.join(', ')
    }
  }

  // A sample outside its axis range cannot be previewed: every drag clamps back into the range and the probe
  // cannot be dragged out to meet it. At runtime the range is only a normalization basis and nothing clamps,
  // so the clip plays only if the bound parameter reaches that far.
  const outside = (v: number, axis: AnimationFieldAxis) =>
    v < Math.min(axis.min, axis.max) || v > Math.max(axis.min, axis.max)

  /** Widen an axis just past a sample that fell outside it, so the plot can draw and drag it again. */
  const widenTo = (which: 'x' | 'y', v: number) => {
    const axis = which === 'x' ? field.xAxis : field.yAxis
    const lo = Math.min(axis.min, axis.max)
    const hi = Math.max(axis.min, axis.max)
    // Headroom, so the sample lands inside the plot rather than on its border where a grab also clamps it.
    const pad = Math.max((hi - lo) * 0.1, Math.abs(v) * 0.1, 0.1)
    const round = (n: number) => Number(n.toFixed(3))
    if (v < lo) setAxis(which, { min: round(v - pad) })
    else if (v > hi) setAxis(which, { max: round(v + pad) })
  }

  return (
    <div className='flex h-full w-full flex-col overflow-y-auto bg-surface-raised text-fg'>
      <div className='border-b border-border p-2'>
        <Button variant='primary' size='sm' className='w-full' onClick={save}
          title='Write this field to the library and refresh every animation state playing it'>
          Save Field{dirty ? ' •' : ''}
        </Button>
      </div>

      <Collapsable title='Field' defaultOpen>
        <div className='flex flex-col gap-2 p-2'>
          <label className='flex items-center gap-1'>
            <span className={fieldLabel}>Name</span>
            <TextInput className='min-w-0 flex-1 px-1 py-0.5' value={field.name} onChange={setName} />
          </label>

          <div className='flex items-center gap-1'>
            <span className={fieldLabel}>Axes</span>
            <SegmentedControl<'1d' | '2d'>
              size='sm' value={field.mode} onChange={setMode}
              options={[
                { value: '1d', label: '1D', title: 'One input axis — blends along a line' },
                { value: '2d', label: '2D', title: 'Two input axes — blends across a plane' },
              ]} />
          </div>
          {/* Switching to 1D keeps each sample's y — it is simply not read — so flipping back restores the
              layout instead of flattening it. Worth saying, since the plot visibly collapses. */}
          {!is2D && <p className={cn(hintClass, '-mt-1')}>Y positions are kept and restored if you switch back to 2D.</p>}

          <AxisRow label='X' axis={field.xAxis} onChange={p => setAxis('x', p)} />
          {is2D && <AxisRow label='Y' axis={field.yAxis} onChange={p => setAxis('y', p)} />}
        </div>
      </Collapsable>

      <Collapsable title='Smoothing' defaultOpen>
        <div className='flex flex-col gap-2 p-2'>
          {/* This block is the answer to a blend that vibrates. The parameters driving a field are MEASURED —
              a body's speed, a heading off the physics solver — and carry frame-to-frame noise that lands in
              the pose one-for-one unless it is filtered here. Only applies in Play; the preview below always
              shows the field exactly as authored, so placing samples stays direct. */}
          <AxisSmoothingRow label='X' axis={field.xAxis} onChange={p => setAxis('x', p)} />
          {is2D && <AxisSmoothingRow label='Y' axis={field.yAxis} onChange={p => setAxis('y', p)} />}

          <label className='flex items-center gap-1'>
            <span className={fieldLabel}>Weights</span>
            <OptionalNumberInput
              className={cn(input, 'w-[56px]')}
              title={'Seconds for a clip’s weight to catch up. Smoothing the probe cannot stop a clip entering or '
                + 'leaving the mix between two frames; this makes a departing clip fade instead of vanish. '
                + `Blank = default (${DEFAULT_WEIGHT_SMOOTHING}s), 0 = off.`}
              value={field.weightSmoothing}
              placeholder={String(DEFAULT_WEIGHT_SMOOTHING)}
              onChange={v => setWeightSmoothing(v !== undefined && v >= 0 ? v : undefined)} />
            <span className={hintClass}>s — how fast a clip fades in or out of the mix</span>
          </label>
        </div>
      </Collapsable>

      <Collapsable title='Samples' badge={field.samples.length || undefined} defaultOpen>
        <div className='flex flex-col gap-1 p-2'>
          {clips.length === 0 && (
            <p className='text-ui-sm text-warning'>
              {target
                ? 'This model has no animation clips. Import some in the Animation Editor first.'
                : 'The field’s model could not be previewed.'}
            </p>
          )}

          {field.samples.length === 0 && clips.length > 0 && (
            <p className='text-ui-sm text-muted'>None yet — double-click the plot to drop a clip.</p>
          )}

          {field.samples.map((s, i) => {
            const w = weightOf(s.clipName)
            const missing = !!s.clipName && !clips.includes(s.clipName)
            const length = clipDurations[s.clipName] ?? 0
            const outlier = isOutlier(length)
            const offX = outside(s.x, field.xAxis)
            const offY = is2D && outside(s.y ?? 0, field.yAxis)
            return (
              <div
                key={i}
                className={`flex flex-col gap-1 rounded border p-1.5 ${selected === i ? 'border-selected' : 'border-control'}`}
                onClick={() => setSelected(i)}>
                <div className='flex items-center gap-1'>
                  <Select className='min-w-0 flex-1 px-1 py-0.5' value={s.clipName}
                    onChange={e => setSample(i, { clipName: e.target.value })}>
                    <option value=''>(no clip)</option>
                    {missing && <option value={s.clipName}>{s.clipName} — missing</option>}
                    {clips.map(c => <option key={c} value={c}>{c}</option>)}
                  </Select>
                  <span className='w-[34px] shrink-0 text-right text-ui-xs tabular-nums text-highlight'
                    title='Live weight at the current preview point'>
                    {w > 0.001 ? `${(w * 100).toFixed(0)}%` : ''}
                  </span>
                  <Button variant='remove' size='sm' className='shrink-0 px-1.5' title='Remove sample' onClick={() => removeSample(i)}>✕</Button>
                </div>

                <div className='flex items-center gap-1 text-ui-xs'>
                  {/* `|| 0` here used to make a negative coordinate impossible to type: a number input reports
                      "" for the partial value "-", so parseFloat gives NaN and the field snapped back to 0
                      before the digits arrived. Ignoring an unparseable value instead leaves the browser
                      holding the half-typed text, which is what lets "-1.5" be entered at all. */}
                  <span className='text-muted'>x</span>
                  <OptionalNumberInput className={cn(input, 'w-[56px]')} value={s.x}
                    onChange={v => { if (v !== undefined) setSample(i, { x: v }) }} />
                  {is2D && <>
                    <span className='text-muted'>y</span>
                    <OptionalNumberInput className={cn(input, 'w-[56px]')} value={s.y ?? 0}
                      onChange={v => { if (v !== undefined) setSample(i, { y: v }) }} />
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
                  <span className='text-muted' title='Playback rate for this clip inside the blend'>rate</span>
                  <OptionalNumberInput className={cn(input, 'w-[48px]')} value={s.rateScale ?? 1}
                    onChange={v => setSample(i, { rateScale: v !== undefined && v > 0 ? v : undefined })} />
                  {/* Every clip in a field is posed at ONE shared phase — that is what stops the feet
                      sliding — which assumes they all start at the same point in the gait. Clips from
                      different sources routinely do not, and two walk cycles half a lap apart put the legs in
                      opposition rather than in step. */}
                  <span className='text-muted' title='Where this clip sits in its own cycle, 0..1'>phase</span>
                  <OptionalNumberInput className={cn(input, 'w-[48px]')} value={s.phaseOffset ?? 0}
                    title={'Shifts this clip around its own cycle, as a fraction. Use it when a clip starts on '
                      + 'the opposite foot to the rest of the field — the legs will fight otherwise, worst '
                      + 'where two clips are mixed evenly.'}
                    onChange={v => setSample(i, { phaseOffset: v !== undefined && v !== 0 ? v : undefined })} />
                  <Button
                    variant='subtle' size='sm' className='shrink-0 px-1.5'
                    title='Shift this clip by half a cycle — the fix when it starts on the opposite foot'
                    onClick={() => setSample(i, {
                      phaseOffset: Math.abs((s.phaseOffset ?? 0) - 0.5) < 1e-6 ? undefined : 0.5,
                    })}>
                    ½
                  </Button>
                </div>
                {outlier && (
                  <Button
                    variant='ghost' size='sm' className={cn(warnBtn, 'self-start px-1.5')}
                    title={`Sets the rate to ${(length / median).toFixed(2)} so this clip's cycle lasts as long as the rest of the field's`}
                    onClick={() => setSample(i, { rateScale: Number((length / median).toFixed(3)) })}>
                    ⚠ {(median / length).toFixed(1)}× faster than the rest — slow it to match
                  </Button>
                )}
                {(offX || offY) && (
                  <div className='flex flex-col gap-1'>
                    <p className='text-ui-xs text-warning'>
                      ⚠ Outside the {offX ? `${field.xAxis.name || 'X'} range (${field.xAxis.min}..${field.xAxis.max})` : ''}
                      {offX && offY ? ' and ' : ''}
                      {offY ? `${field.yAxis.name || 'Y'} range (${field.yAxis.min}..${field.yAxis.max})` : ''}
                      {' '}— the plot clamps to the range, so this point cannot be dragged or previewed, and it only
                      ever plays if the bound parameter reaches that far in Play.
                      {((offX && s.x < 0) || (offY && (s.y ?? 0) < 0)) && (
                        <> A negative coordinate usually never plays: every speed built-in except <b>forwardSpeed</b> and
                        {' '}<b>lateralSpeed</b> is a magnitude and can never go below zero.</>
                      )}
                    </p>
                    <div className='flex gap-1'>
                      {offX && (
                        <Button variant='ghost' size='sm' className={cn(warnBtn, 'px-1.5')}
                          title={`Widens the ${field.xAxis.name || 'X'} axis so this sample sits inside the plot again`}
                          onClick={() => widenTo('x', s.x)}>Widen {field.xAxis.name || 'X'} to fit</Button>
                      )}
                      {offY && (
                        <Button variant='ghost' size='sm' className={cn(warnBtn, 'px-1.5')}
                          title={`Widens the ${field.yAxis.name || 'Y'} axis so this sample sits inside the plot again`}
                          onClick={() => widenTo('y', s.y ?? 0)}>Widen {field.yAxis.name || 'Y'} to fit</Button>
                      )}
                    </div>
                  </div>
                )}
                {coincidentWith[i] && (
                  <p className='text-ui-xs text-warning'>
                    ⚠ Same point as {coincidentWith[i]} — they split one sample's weight between them.
                    {is2D && ' On a wrapping axis the two ends are the same place even though the plot draws them apart.'}
                  </p>
                )}
              </div>
            )
          })}

          <Button variant='subtle' size='sm' className='mt-1 self-start px-1.5' disabled={clips.length === 0} onClick={() => addSample()}>
            + Sample
          </Button>
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
    <>
      <div className='flex items-center gap-1'>
        <span className={fieldLabel}>{label}</span>
        <TextInput className='min-w-0 flex-1 px-1 py-0.5' value={axis.name} title='Axis name'
          onChange={name => onChange({ name })} />
        {/* Unparseable input is IGNORED rather than coerced to 0 — see the note on the sample coordinates.
            Coercing is what made a negative minimum unreachable, and a negative minimum is exactly what an
            axis bound to a signed speed needs. */}
        <OptionalNumberInput className={cn(input, 'w-[52px]')} value={axis.min} title='Minimum'
          onChange={v => { if (v !== undefined) onChange({ min: v }) }} />
        <OptionalNumberInput className={cn(input, 'w-[52px]')} value={axis.max} title='Maximum'
          onChange={v => { if (v !== undefined) onChange({ max: v }) }} />
      </div>
      {looksAngular(axis) && !axis.wrap && (
        <Button
          variant='ghost' size='sm' className={cn(warnBtn, 'self-start px-1.5')}
          title={'A heading wraps: +180 and -180 are the same direction. Without Wrap, turning through that seam '
            + 'moves the probe across the entire axis in one frame and the whole blend snaps — which is the usual '
            + 'cause of an animation field spasming while the character turns.'}
          onClick={() => onChange({ wrap: true })}>
          ⚠ {axis.min}..{axis.max} looks like a heading — turn Wrap on
        </Button>
      )}
    </>
  )
}

/**
 * Whether an axis's range spans a full turn, making it almost certainly a heading. Drives a suggestion
 * only — never wrap an axis automatically, since -180..180 may be a clamped lean.
 */
function looksAngular(axis: AnimationFieldAxis): boolean {
  return Math.abs((axis.max - axis.min) - 360) < 1e-6
}

/** Per-axis probe filtering. */
function AxisSmoothingRow({ label, axis, onChange }: {
  label: string
  axis: AnimationFieldAxis
  onChange: (patch: Partial<AnimationFieldAxis>) => void
}) {
  const num = (v: number | undefined) => v !== undefined && v >= 0 ? v : undefined
  return (
    <div className='flex items-center gap-1'>
      <span className={fieldLabel}>{label}</span>

      <span className='text-ui-xs text-muted' title='Seconds for the probe to catch up to the parameter'>lag</span>
      <OptionalNumberInput
        className={cn(input, 'w-[52px]')}
        title={`Seconds for the probe to catch up to its parameter. Blank = default (${DEFAULT_AXIS_SMOOTHING}s), 0 = track it exactly.`}
        value={axis.smoothing} placeholder={String(DEFAULT_AXIS_SMOOTHING)}
        onChange={v => onChange({ smoothing: num(v) })} />

      <span className='text-ui-xs text-muted'>dead</span>
      <OptionalNumberInput
        className={cn(input, 'w-[52px]')}
        title={'Movement smaller than this, in axis units, is ignored outright. Damping only slows a jitter down; '
          + 'a deadband removes it. Raise it if the pose still shivers while the character stands still.'}
        value={axis.deadzone} placeholder='0'
        onChange={v => onChange({ deadzone: num(v) })} />

      <Toggle
        className='ml-auto text-ui-xs' label='wrap' checked={!!axis.wrap}
        title={'Treat min..max as a circle, so max is next to min. Required for a heading axis in degrees: '
          + 'without it, turning through ±180 jumps the probe across the whole range and the blend snaps.'}
        onChange={v => onChange({ wrap: v })} />
    </div>
  )
}

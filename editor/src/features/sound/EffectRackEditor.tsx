import { defaultEffect, EFFECT_KINDS } from 'cleo'
import type { EffectKind, SoundEffect } from 'cleo'
import { Button, Select, Slider, Toggle, hintClass, sectionTitleClass } from '../../components/ui'

// The DSP rack: an ordered list of inserts, each toggleable, movable and removable.
//
// ORDER IS THE POINT, which is why this is a list with arrows rather than a fixed set of collapsible
// sections. A lowpass before a distortion is a muffled sound; the same two the other way round is a
// bright, fizzy one. The engine reads this array in order (see EffectRack), so what is on screen is the
// signal path.
//
// Built on the same idioms as `PostChainList` in CameraEditor — the other ordered effect list in the
// editor — so the two behave identically: ↑/↓ ghost buttons, a per-row toggle, and a placeholder-first
// Select to add.

const LABELS: Record<EffectKind, string> = {
  filter: 'Filter',
  distortion: 'Distortion',
  delay: 'Delay',
  reverb: 'Reverb',
  compressor: 'Compressor',
}

const ICONS: Record<EffectKind, string> = {
  filter: '🎚️',
  distortion: '🔥',
  delay: '🔁',
  reverb: '🌊',
  compressor: '📉',
}

const FILTER_TYPES = [
  { value: 'lowpass', label: 'Low-pass' },
  { value: 'highpass', label: 'High-pass' },
  { value: 'bandpass', label: 'Band-pass' },
]

type Props = {
  effects: SoundEffect[]
  onChange: (effects: SoundEffect[]) => void
}

export default function EffectRackEditor({ effects, onChange }: Props) {
  const replace = (index: number, effect: SoundEffect) =>
    onChange(effects.map((e, i) => (i === index ? effect : e)))

  const move = (index: number, delta: number) => {
    const to = index + delta
    if (to < 0 || to >= effects.length) return
    const next = effects.slice()
    const [row] = next.splice(index, 1)
    next.splice(to, 0, row)
    onChange(next)
  }

  const remove = (index: number) => onChange(effects.filter((_, i) => i !== index))
  const add = (kind: EffectKind) => onChange([...effects, defaultEffect(kind)])

  return (
    <div className='flex flex-col gap-1'>
      <div className={sectionTitleClass}>Effects</div>

      {effects.length === 0 && (
        <div className={hintClass}>
          No inserts. Signal passes through untouched.
        </div>
      )}

      {effects.map((effect, index) => (
        <div key={index} className='rounded border border-border bg-surface-raised p-1.5 flex flex-col gap-1'>
          <div className='flex items-center gap-1'>
            <span className='text-[11px]'>{ICONS[effect.kind]}</span>
            <span className='text-[11px] flex-1'>{LABELS[effect.kind]}</span>
            <Toggle
              checked={effect.enabled}
              onChange={enabled => replace(index, { ...effect, enabled })}
              title={effect.enabled ? 'Bypass this insert' : 'Enable this insert'}
            />
            <Button
              variant='ghost' size='icon' title='Move earlier in the chain'
              disabled={index === 0} onClick={() => move(index, -1)}
            >↑</Button>
            <Button
              variant='ghost' size='icon' title='Move later in the chain'
              disabled={index === effects.length - 1} onClick={() => move(index, 1)}
            >↓</Button>
            <Button variant='ghost' size='icon' title='Remove this insert' onClick={() => remove(index)}>×</Button>
          </div>

          {/* Params stay visible while bypassed, just dimmed: a bypassed insert is still being authored. */}
          <div className={effect.enabled ? '' : 'opacity-45'}>
            <EffectParams effect={effect} onChange={next => replace(index, next)} />
          </div>
        </div>
      ))}

      <Select
        value=''
        title='Append an insert to the end of the chain'
        onChange={e => {
          const kind = e.target.value as EffectKind
          if (kind) add(kind)
          e.currentTarget.value = ''
        }}
      >
        <option value=''>Add effect…</option>
        {EFFECT_KINDS.map(kind => (
          <option key={kind} value={kind}>{LABELS[kind]}</option>
        ))}
      </Select>

      <div className={hintClass}>
        Inserts run top to bottom. Order matters — a filter before a distortion is not the same patch as
        one after it. Effects need Web Audio; a device that falls back to HTML5 audio plays the sample dry.
      </div>
    </div>
  )
}

/** The parameter rows for one insert. Every control writes a whole replacement effect, never a mutation. */
function EffectParams({ effect, onChange }: { effect: SoundEffect; onChange: (e: SoundEffect) => void }) {
  switch (effect.kind) {
    case 'filter':
      return (
        <div className='flex flex-col gap-1'>
          <Select
            value={effect.type}
            onChange={e => onChange({ ...effect, type: e.target.value as typeof effect.type })}
          >
            {FILTER_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          <Slider
            label='Cutoff' min={20} max={20000} step={10} value={effect.frequency}
            readout={v => `${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)} Hz`}
            title='20 Hz to 20 kHz — the audible range. A low-pass at the top does nothing.'
            onChange={frequency => onChange({ ...effect, frequency })}
          />
          <Slider
            label='Q' min={0.1} max={20} step={0.1} value={effect.q}
            title='Resonance at the cutoff. High values ring.'
            onChange={q => onChange({ ...effect, q })}
          />
        </div>
      )

    case 'distortion':
      return (
        <div className='flex flex-col gap-1'>
          <Slider
            label='Drive' min={0} max={1} step={0.01} value={effect.drive}
            title='0 is a straight line through — no colouring at all.'
            onChange={drive => onChange({ ...effect, drive })}
          />
          <Select
            value={effect.oversample}
            title='Oversampling reduces the aliasing hard clipping produces, at some CPU cost.'
            onChange={e => onChange({ ...effect, oversample: e.target.value as typeof effect.oversample })}
          >
            <option value='none'>No oversampling</option>
            <option value='2x'>2x oversample</option>
            <option value='4x'>4x oversample</option>
          </Select>
        </div>
      )

    case 'delay':
      return (
        <div className='flex flex-col gap-1'>
          <Slider
            label='Time' min={0} max={5} step={0.01} value={effect.time}
            readout={v => `${(v * 1000).toFixed(0)} ms`}
            onChange={time => onChange({ ...effect, time })}
          />
          <Slider
            label='Feedback' min={0} max={0.95} step={0.01} value={effect.feedback}
            title='Held below 1 — at or above it the echo grows without bound and pins the output.'
            onChange={feedback => onChange({ ...effect, feedback })}
          />
          <Slider
            label='Mix' min={0} max={1} step={0.01} value={effect.mix}
            onChange={mix => onChange({ ...effect, mix })}
          />
        </div>
      )

    case 'reverb':
      return (
        <div className='flex flex-col gap-1'>
          <Slider
            label='Decay' min={0.05} max={10} step={0.05} value={effect.decay}
            readout={v => `${v.toFixed(2)} s`}
            title='How long the tail rings. Changing it regenerates the impulse, which costs a moment.'
            onChange={decay => onChange({ ...effect, decay })}
          />
          <Slider
            label='Pre-delay' min={0} max={0.5} step={0.005} value={effect.preDelay}
            readout={v => `${(v * 1000).toFixed(0)} ms`}
            title='Gap before the tail starts. Larger values read as a bigger room.'
            onChange={preDelay => onChange({ ...effect, preDelay })}
          />
          <Slider
            label='Mix' min={0} max={1} step={0.01} value={effect.mix}
            onChange={mix => onChange({ ...effect, mix })}
          />
        </div>
      )

    case 'compressor':
      return (
        <div className='flex flex-col gap-1'>
          <Slider
            label='Threshold' min={-100} max={0} step={1} value={effect.threshold}
            readout={v => `${v.toFixed(0)} dB`}
            onChange={threshold => onChange({ ...effect, threshold })}
          />
          <Slider
            label='Ratio' min={1} max={20} step={0.5} value={effect.ratio}
            readout={v => `${v.toFixed(1)}:1`}
            onChange={ratio => onChange({ ...effect, ratio })}
          />
          <Slider
            label='Knee' min={0} max={40} step={1} value={effect.knee}
            readout={v => `${v.toFixed(0)} dB`}
            onChange={knee => onChange({ ...effect, knee })}
          />
          <Slider
            label='Attack' min={0} max={1} step={0.001} value={effect.attack}
            readout={v => `${(v * 1000).toFixed(0)} ms`}
            onChange={attack => onChange({ ...effect, attack })}
          />
          <Slider
            label='Release' min={0} max={1} step={0.005} value={effect.release}
            readout={v => `${(v * 1000).toFixed(0)} ms`}
            onChange={release => onChange({ ...effect, release })}
          />
        </div>
      )
  }
}

import { BUS_IDS } from 'cleo'
import type { BusId } from 'cleo'
import { Field, NumberInput, SegmentedControl, Slider, TextInput, Toggle, hintClass, sectionTitleClass } from '../../components/ui'
import { formatDuration } from '../../utils/audioSources'
import { useSound } from './SoundContext'
import EffectRackEditor from './EffectRackEditor'

// The sound-sample inspector, hosted in the Properties panel. The twin of TextureSettingsPanel.

const BUS_LABELS: Record<BusId, string> = {
  master: 'Master',
  music: 'Music',
  sfx: 'SFX',
  ui: 'UI',
}

const BUSES = BUS_IDS.map(id => ({ value: id, label: BUS_LABELS[id] }))

export default function SoundSettingsPanel() {
  const { asset, source, patch, rename, peaks } = useSound()

  if (!asset) return null
  const s = asset.settings

  return (
    <div className='flex flex-col gap-3 p-2'>
      <Field label='Name'>
        <TextInput value={asset.name} onChange={rename} />
      </Field>

      <div>
        <div className={sectionTitleClass}>Source</div>
        <div className={hintClass}>
          {asset.source.kind === 'audio'
            ? source
              ? `${source.name} · ${formatDuration(source.duration || peaks?.duration || 0)} · ${(source.byteSize / 1024).toFixed(0)} KB`
              : 'The audio file this sample reads is missing. Its settings are intact.'
            : 'Registered at runtime — there is no file in the project behind this sample.'}
        </div>
      </div>

      <div className='flex flex-col gap-1'>
        <div className={sectionTitleClass}>Level</div>
        <Slider
          label='Volume' min={0} max={1} step={0.01} value={s.volume}
          title='The sample&apos;s own gain. A Sound node multiplies its own volume on top of this.'
          onChange={volume => patch({ volume })}
        />
        <Slider
          label='Pan' min={-1} max={1} step={0.01} value={s.pan}
          readout={v => (v === 0 ? 'C' : v < 0 ? `L ${Math.round(-v * 100)}` : `R ${Math.round(v * 100)}`)}
          title='Stereo position. Ignored by a SPATIAL Sound node, whose panner owns the stereo field.'
          onChange={pan => patch({ pan })}
        />
        <Slider
          label='Rate' min={0.5} max={4} step={0.01} value={s.rate}
          readout={v => `${v.toFixed(2)}x`}
          title='Playback speed. Pitch follows it — there is no time-stretch.'
          onChange={rate => patch({ rate })}
        />
      </div>

      <div className='flex flex-col gap-1'>
        <div className={sectionTitleClass}>Looping</div>
        <Toggle
          label='Loop'
          checked={s.loop}
          onChange={loop => patch({ loop })}
          title='Repeat the sample. Drag the region handles on the waveform to set the points.'
        />
        {s.loop && (
          <>
            <Field label='Start' hint='Seconds'>
              <NumberInput
                value={s.loopStart} min={0} step={0.01}
                onChange={loopStart => patch({ loopStart })}
              />
            </Field>
            <Field label='End' hint='Seconds. 0 means the end of the file.'>
              <NumberInput
                value={s.loopEnd} min={0} step={0.01}
                onChange={loopEnd => patch({ loopEnd })}
              />
            </Field>
            <div className={hintClass}>
              A region takes effect on the next play — a buffer&apos;s loop points are read when it starts.
            </div>
          </>
        )}
      </div>

      <div className='flex flex-col gap-1'>
        <div className={sectionTitleClass}>Fades</div>
        <Slider
          label='In' min={0} max={10} step={0.05} value={s.fadeIn}
          readout={v => (v === 0 ? 'off' : `${v.toFixed(2)} s`)}
          onChange={fadeIn => patch({ fadeIn })}
        />
        <Slider
          label='Out' min={0} max={10} step={0.05} value={s.fadeOut}
          readout={v => (v === 0 ? 'off' : `${v.toFixed(2)} s`)}
          title='A stop is deferred until this ramp completes.'
          onChange={fadeOut => patch({ fadeOut })}
        />
      </div>

      <div className='flex flex-col gap-1'>
        <div className={sectionTitleClass}>Routing</div>
        <Field label='Bus' hint='Where this sample&apos;s output is mixed.'>
          <SegmentedControl value={s.bus} onChange={bus => patch({ bus })} options={BUSES} size='sm' grow />
        </Field>
        <Toggle
          label='Preload'
          checked={s.preload}
          onChange={preload => patch({ preload })}
          title='Decode at load rather than on first play. Worth it for a sound that must not be late.'
        />
        <div className={hintClass}>
          Preload applies on the next load — this sample is already decoded in the editor.
        </div>
      </div>

      <EffectRackEditor effects={s.effects} onChange={effects => patch({ effects })} />
    </div>
  )
}

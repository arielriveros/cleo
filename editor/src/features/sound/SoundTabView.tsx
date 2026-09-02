import { useCallback } from 'react'
import { AudioManager } from 'cleo'
import { Button, TextInput, Toggle } from '../../components/ui'
import { formatDuration } from '../../utils/audioSources'
import { useSound } from './SoundContext'
import SoundWaveform from './SoundWaveform'

// The sound tab's main area: the waveform, the transport, and the loop region. A sample has no 3D
// preview, so nothing here touches the renderer — the same shape as TextureTabView.

/** `0:01.234`, precise enough to place a loop point by eye against the readout. */
function timecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(3)}`
}

export default function SoundTabView() {
  const {
    asset, source, peaks, rename, save, dirty, patch,
    playing, position, duration, play, stop, pause,
  } = useSound()

  const onLoopRegion = useCallback((start: number, end: number) => {
    // Written as authored seconds, and `loopEnd === duration` is deliberately NOT collapsed to 0 here:
    // the user dragged the handle to the end, and next time they open the tab it should still be a
    // region they can drag back, not a setting that silently became "the whole file".
    patch({ loopStart: Math.max(0, start), loopEnd: Math.max(0, end) })
  }, [patch])

  const onSeek = useCallback((seconds: number) => {
    if (!asset) return
    const sound = AudioManager.Instance.getSound(asset.id)
    // Only meaningful while something is sounding: howler's seek addresses a voice, and there is no
    // voice to move when stopped. Clicking while stopped is a no-op rather than a surprise playback.
    if (sound && playing) sound.howl.seek(seconds)
  }, [asset, playing])

  if (!asset) return null

  const settings = asset.settings
  const missing = asset.source.kind === 'audio' && !source

  return (
    <div className='absolute inset-0 flex flex-col bg-surface-sunken text-white'>
      <div className='h-[30px] shrink-0 flex items-center gap-2 px-2 border-b border-border bg-surface-raised'>
        <TextInput className='w-44' value={asset.name} onChange={rename} title='Sound name' />
        <span className='text-[11px] text-muted'>
          {formatDuration(duration)}
          {peaks ? ` · ${peaks.sampleRate} Hz · ${peaks.channels === 1 ? 'mono' : `${peaks.channels} ch`}` : ''}
          {source?.mime ? ` · ${source.mime.replace('audio/', '')}` : ''}
        </span>

        <div className='ml-auto flex items-center gap-1'>
          <Button size='sm' variant='ghost' onClick={play} title='Play from the start'>▶</Button>
          <Button size='sm' variant='ghost' onClick={pause} disabled={!playing} title='Pause'>❚❚</Button>
          <Button size='sm' variant='ghost' onClick={stop} title='Stop'>■</Button>
          <span className='text-[11px] text-muted w-32 text-center tabular-nums'>
            {timecode(position)} / {timecode(duration)}
          </span>
          <Button size='sm' onClick={save} disabled={!dirty} title='Save this sound (Ctrl+S)'>Save</Button>
        </div>
      </div>

      <div className='flex-1 min-h-0 p-2'>
        {missing ? (
          <div className='w-full h-full flex items-center justify-center text-xs text-muted'>
            The audio file this sample reads is missing. Its settings are intact — re-import the file, or
            point the sample at another one.
          </div>
        ) : (
          <SoundWaveform
            peaks={peaks}
            duration={duration}
            position={position}
            playing={playing}
            loop={settings.loop}
            loopStart={settings.loopStart}
            loopEnd={settings.loopEnd}
            onLoopRegion={onLoopRegion}
            onSeek={onSeek}
          />
        )}
      </div>

      <div className='h-[26px] shrink-0 flex items-center gap-3 px-2 text-[11px] text-muted border-t border-border'>
        <Toggle
          label='Loop'
          checked={settings.loop}
          onChange={checked => patch({ loop: checked })}
          title='Repeat this sample. A region can then be dragged on the waveform.'
        />
        {settings.loop ? (
          <span className='tabular-nums'>
            Region {timecode(settings.loopStart)} → {settings.loopEnd > settings.loopStart ? timecode(settings.loopEnd) : 'end'}
          </span>
        ) : (
          <span>Looping off — the sample plays once per trigger.</span>
        )}
        <span className='ml-auto'>
          A loop region takes effect on the next play; a voice already sounding keeps the points it started with.
        </span>
      </div>
    </div>
  )
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AudioManager } from 'cleo'
import type { SoundSettings } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useDocument } from '../DocumentContext'
import { withSoundSource } from '../../utils/soundSamples'
import type { SoundSampleAsset, SoundSource } from '../../utils/soundSamples'
import type { AudioSourceAsset } from '../../utils/audioSources'
import { extractPeaks } from './waveform'
import type { Peaks } from './waveform'

// The sound editing session: one working copy of the open sample, shared by the waveform view in the
// viewport slot and the settings panel in Properties. The direct twin of TextureProvider.
//
// It wraps the whole dock (Editor.tsx) so either panel can be dragged anywhere without tying the working
// copy to one panel's mount.
//
// IT ALSO OWNS THE PREVIEW VOICE. Only one sample previews at a time and only from this tab, so the voice
// belongs to the session rather than to either panel — a panel that unmounts mid-playback must not leave
// a note sounding, and both panels need to see the same playhead.

type SoundContextValue = {
  /** The working copy, or null when no sound tab is active. */
  asset: SoundSampleAsset | null
  /** The audio source behind it, when it has one. Null for a runtime sample. */
  source: AudioSourceAsset | null
  /** The drawable envelope, or null while decoding (or when this browser cannot decode the format). */
  peaks: Peaks | null
  /** Patch the playback settings, mark the tab dirty, and retune the LIVE sound so the preview follows. */
  patch: (p: Partial<SoundSettings>) => void
  rename: (name: string) => void
  /** Re-point the sample at another audio source. */
  setSource: (source: SoundSource) => void
  save: () => void
  dirty: boolean

  // Transport
  playing: boolean
  /** Playhead in seconds. Polled off the live voice while playing. */
  position: number
  duration: number
  play: () => void
  stop: () => void
  pause: () => void
}

const SoundContext = createContext<SoundContextValue | null>(null)

export function useSound(): SoundContextValue {
  const ctx = useContext(SoundContext)
  if (!ctx) throw new Error('useSound must be used within a SoundProvider')
  return ctx
}

export function SoundProvider({ children }: { children: React.ReactNode }) {
  const {
    editingSoundId, soundSamples, audioSources, saveSoundSample, previewSoundSettings, activeTab,
    registerSoundApply, updateAudioSource,
  } = useCleoEngine()
  const { markTabDirty, dirtyTabs } = useDocument()

  const [asset, setAsset] = useState<SoundSampleAsset | null>(null)
  const loadedIdRef = useRef<string | null>(null)

  // Adopt the tab's asset when it changes. Guarded on the id rather than on the library array, so saving —
  // which rewrites the library — does not discard the working copy still being edited.
  useEffect(() => {
    if (!editingSoundId) {
      loadedIdRef.current = null
      setAsset(null)
      return
    }
    if (loadedIdRef.current === editingSoundId) return
    const found = soundSamples.find(s => s.id === editingSoundId)
    if (!found) return
    loadedIdRef.current = editingSoundId
    setAsset(structuredClone(found))
  }, [editingSoundId, soundSamples])

  const tabId = activeTab.kind === 'soundSample' ? activeTab.id : null

  const source = useMemo(() => {
    if (!asset) return null
    const id = asset.source.kind === 'audio' ? asset.source.audioId : undefined
    return id ? audioSources.find(a => a.id === id) ?? null : null
  }, [asset, audioSources])

  // ---- Waveform ---------------------------------------------------------------------------------

  const [peaks, setPeaks] = useState<Peaks | null>(null)
  const sampleId = asset?.id ?? null

  useEffect(() => {
    setPeaks(null)
    if (!sampleId) return
    const bytes = AudioManager.Instance.getSource(sampleId)
    if (!bytes) return

    // Guarded against the tab switching mid-decode: a stale result must not overwrite the new sample's.
    let cancelled = false
    void extractPeaks(bytes.bytes).then(result => {
      if (cancelled) return
      setPeaks(result)
    })
    return () => { cancelled = true }
  }, [sampleId])

  // Backfill the audio source's decoded properties, which the reconciler could not know. Runs off the
  // decode we already paid for rather than triggering a second one.
  const sourceId = source?.id
  const sourceNeedsInfo = !!source && !source.duration
  useEffect(() => {
    if (!peaks || !sourceId || !sourceNeedsInfo) return
    const record = audioSources.find(a => a.id === sourceId)
    if (!record) return
    updateAudioSource(sourceId, {
      ...record,
      duration: peaks.duration,
      sampleRate: peaks.sampleRate,
      channels: peaks.channels,
    })
  }, [peaks, sourceId, sourceNeedsInfo, audioSources, updateAudioSource])

  // ---- Editing ----------------------------------------------------------------------------------

  const patch = useCallback((p: Partial<SoundSettings>) => {
    setAsset(prev => {
      if (!prev) return prev
      const next = { ...prev, settings: { ...prev.settings, ...p } }
      // Straight to howler, before the save. Volume, filter cutoff and reverb mix are things you cannot
      // judge from a form field, so the preview has to follow the control rather than the commit.
      previewSoundSettings(next)
      return next
    })
    if (tabId) markTabDirty(tabId, 'sound-edit')
  }, [tabId, markTabDirty, previewSoundSettings])

  const rename = useCallback((name: string) => {
    setAsset(prev => (prev ? { ...prev, name } : prev))
    if (tabId) markTabDirty(tabId, 'sound-edit')
  }, [tabId, markTabDirty])

  const setSource = useCallback((next: SoundSource) => {
    // withSoundSource, not a spread: the duplicated `audioIds` the reference walkers scan have to be
    // re-derived, or a bundle ships the bytes of the file this sample no longer reads.
    setAsset(prev => (prev ? withSoundSource(prev, next) : prev))
    if (tabId) markTabDirty(tabId, 'sound-edit')
  }, [tabId, markTabDirty])

  const save = useCallback(() => { if (asset) saveSoundSample(asset) }, [asset, saveSoundSample])

  // Hand the save back to EngineContext so Ctrl+S, Save All and the close-tab prompt can reach the working
  // copy — they only know tab ids.
  useEffect(() => {
    if (!tabId) return
    registerSoundApply({ tabId, apply: save })
    return () => registerSoundApply(null)
  }, [tabId, save, registerSoundApply])

  // ---- Transport --------------------------------------------------------------------------------

  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const voiceRef = useRef<number | null>(null)

  const stop = useCallback(() => {
    const sound = sampleId ? AudioManager.Instance.getSound(sampleId) : undefined
    if (sound && voiceRef.current !== null) sound.stop(voiceRef.current)
    voiceRef.current = null
    setPlaying(false)
    setPosition(0)
  }, [sampleId])

  const play = useCallback(() => {
    const sound = sampleId ? AudioManager.Instance.getSound(sampleId) : undefined
    if (!sound) return
    if (voiceRef.current !== null) sound.stop(voiceRef.current)
    const voice = sound.play()
    if (voice === null) return
    voiceRef.current = voice
    setPlaying(true)
  }, [sampleId])

  const pause = useCallback(() => {
    const sound = sampleId ? AudioManager.Instance.getSound(sampleId) : undefined
    if (sound && voiceRef.current !== null) sound.pause(voiceRef.current)
    setPlaying(false)
  }, [sampleId])

  // Poll the playhead. An interval rather than rAF: this drives one thin line at ~30 Hz, and a rAF loop
  // would keep the whole panel re-rendering at display rate for no visible gain.
  useEffect(() => {
    if (!playing || !sampleId) return
    const timer = window.setInterval(() => {
      const sound = AudioManager.Instance.getSound(sampleId)
      if (!sound || voiceRef.current === null) return
      // A one-shot ends on its own; notice and reset rather than leaving the button stuck on "playing".
      if (!sound.isPlaying(voiceRef.current)) {
        voiceRef.current = null
        setPlaying(false)
        setPosition(0)
        return
      }
      setPosition(sound.seek(voiceRef.current))
    }, 33)
    return () => window.clearInterval(timer)
  }, [playing, sampleId])

  // Never leave a preview sounding after the tab closes or the sample changes.
  useEffect(() => () => {
    const sound = sampleId ? AudioManager.Instance.getSound(sampleId) : undefined
    if (sound && voiceRef.current !== null) sound.stop(voiceRef.current)
    voiceRef.current = null
  }, [sampleId])

  const duration = peaks?.duration
    ?? (sampleId ? AudioManager.Instance.getSound(sampleId)?.duration ?? 0 : 0)

  const value = useMemo<SoundContextValue>(() => ({
    asset, source, peaks, patch, rename, setSource, save,
    dirty: !!(tabId && dirtyTabs[tabId]),
    playing, position, duration, play, stop, pause,
  }), [asset, source, peaks, patch, rename, setSource, save, tabId, dirtyTabs,
       playing, position, duration, play, stop, pause])

  return <SoundContext.Provider value={value}>{children}</SoundContext.Provider>
}

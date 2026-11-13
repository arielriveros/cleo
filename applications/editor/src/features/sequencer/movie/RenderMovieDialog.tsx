import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Field, Hint, NumberInput, SegmentedControl, Select, Toggle } from '@cleo/app-kit/ui'
import { Modal, ModalFooter, ModalHeader } from '@cleo/app-kit/ui/Modal'
import { toast } from '@cleo/app-kit/feedback/toastStore'
import { frameCountFor, frameRateOf } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import { useSequenceEditor } from '../SequenceEditorContext'
import {
  CODEC_LABEL, DEFAULT_MOVIE_SETTINGS, FPS_PRESETS, LARGE_FRAME_PIXELS, QUANTIZER, RESOLUTION_PRESETS, SAMPLE_PRESETS,
  encodableCodecs, safeFileName, validateMovieSettings, type MovieCodec, type MovieSettings,
} from './movieOutput'
import { canWriteMovies, pickMovieFile, pickMovieFolder } from './movieFiles'
import { runMovieJob, type MovieJobProgress, type MovieJobResult, type MovieTarget } from './runMovie'

// Render Movie: the settings for rendering the open sequence to a movie, then the render's progress.
//
// The render is offline (runMovie.ts): every frame is exactly 1/fps of the game, drawn as long as it takes,
// so the movie has no frame-time lag whatever the machine. What costs time is samples x frames.

const SETTINGS_KEY = 'cleo_movie_settings'

/** The last settings used for this sequence, else the last used at all, else the defaults; the range fitted. */
function loadSettings(assetId: string | null, duration: number): MovieSettings {
  const read = (key: string): Partial<MovieSettings> | null => {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
  }
  const own = assetId ? read(`${SETTINGS_KEY}:${assetId}`) : null
  const base = { ...DEFAULT_MOVIE_SETTINGS, ...(read(SETTINGS_KEY) ?? {}), ...(own ?? {}) }
  if (!own) { base.from = 0; base.to = duration }
  base.to = Math.min(Math.max(base.to, base.from), duration) || duration
  return base
}

function saveSettings(assetId: string | null, s: MovieSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, from: undefined, to: undefined }))
    if (assetId) localStorage.setItem(`${SETTINGS_KEY}:${assetId}`, JSON.stringify(s))
  } catch { /* quota */ }
}

const clock = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
const megabytes = (bytes: number): string => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`

export default function RenderMovieDialog({ onClose }: { onClose: () => void }) {
  const ed = useSequenceEditor()
  const { instance, startMovieSession, stopPlay } = useCleoEngine()
  // What it films, taken when the dialog opens: the render moves to the scene tab, where the Sequencer
  // context has no sequence any more.
  const [film] = useState(() => ({
    assetId: ed.asset?.id ?? null, name: ed.asset?.name ?? ed.seq?.name ?? 'Movie', contextNodeId: ed.contextNodeId,
    seq: ed.seq ? structuredClone(ed.seq) : null,
  }))
  const seq = film.seq
  const duration = seq?.duration ?? 10
  const assetId = film.assetId
  const [s, setS] = useState<MovieSettings>(() => loadSettings(assetId, duration))
  const set = (patch: Partial<MovieSettings>) => setS(prev => ({ ...prev, ...patch }))
  const [codecs, setCodecs] = useState<MovieCodec[] | null>(null)
  const [phase, setPhase] = useState<'settings' | 'rendering' | 'done' | 'failed'>('settings')
  const [progress, setProgress] = useState<MovieJobProgress | null>(null)
  const [result, setResult] = useState<MovieJobResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const maxSize = instance?.renderer.maxMovieSize ?? 4096
  const preset = RESOLUTION_PRESETS.find(p => p.width === s.width && p.height === s.height)?.label ?? 'Custom'
  const [customSize, setCustomSize] = useState(preset === 'Custom')
  const fpsPreset = FPS_PRESETS.includes(s.fps) ? String(s.fps) : 'custom'

  // Which codecs this machine encodes at this size and rate. Probed again when either changes.
  useEffect(() => {
    let live = true
    setCodecs(null)
    const timer = setTimeout(() => {
      void encodableCodecs(s).then(list => {
        if (!live) return
        setCodecs(list)
        if (list.length && !list.includes(s.codec)) set({ codec: list[0], quantizer: QUANTIZER[list[0]].maximum })
      })
    }, 200)
    return () => { live = false; clearTimeout(timer) }
  }, [s.width, s.height, s.fps])

  // The latest frame, drawn into the progress view. The dialog owns each picture once it is handed over: drawn
  // once, then closed (a picture the render replaced before it was drawn is closed unseen).
  const drawn = useRef<ImageBitmap | null>(null)
  useEffect(() => {
    const canvas = previewRef.current, bitmap = progress?.preview
    if (!bitmap || bitmap === drawn.current) return
    if (drawn.current) drawn.current.close()
    drawn.current = bitmap
    if (!canvas) return
    try {
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    } catch { /* a picture that could not be drawn is only a missed preview */ }
  }, [progress?.preview])
  useEffect(() => () => { drawn.current?.close() }, [])

  const invalid = validateMovieSettings(s, maxSize)
    ?? (s.format === 'mp4' && codecs !== null && codecs.length === 0 ? 'This machine cannot encode video at this size and rate. Try a smaller frame, or PNG frames.' : null)
  const estimate = useMemo(() => frameCountFor(Math.max(0, s.to - s.from), frameRateOf(Math.max(1, s.fps || 1))), [s.from, s.to, s.fps])

  const start = async () => {
    if (!seq || invalid) return
    // The picker first, while this click still counts as one: a browser refuses it after an await.
    let target: MovieTarget | null = null
    const base = safeFileName(film.name)
    try {
      if (s.format === 'mp4') {
        const file = await pickMovieFile(`${base}.mp4`, 'mp4')
        if (file) target = { kind: 'file', file }
      } else {
        const folder = await pickMovieFolder()
        if (folder) target = { kind: 'folder', folder, base }
      }
    } catch (e) {
      toast.error(String((e as Error).message ?? e))
      return
    }
    if (!target || !instance) return
    saveSettings(assetId, s)
    abort.current = new AbortController()
    setPhase('rendering')
    setProgress(null)
    try {
      const done = await runMovieJob({ instance, startMovieSession, stopPlay }, {
        assetId: assetId ?? '', name: film.name, contextNodeId: film.contextNodeId, workingCopy: seq,
      }, s, target, { signal: abort.current.signal, onProgress: setProgress })
      setResult(done)
      setPhase('done')
    } catch (e) {
      setError(String((e as Error).message ?? e))
      setPhase('failed')
    } finally {
      abort.current = null
    }
  }

  const rendering = phase === 'rendering'
  const close = () => { if (!rendering) onClose() }

  if (phase !== 'settings') {
    const p = progress
    const perFrame = p && p.frames > 0 ? p.elapsedMs / p.frames : 0
    const left = p && perFrame > 0 ? Math.max(0, p.estimatedFrames - p.frames) * perFrame : 0
    const fraction = p ? Math.min(1, (p.sequenceTime - p.from) / Math.max(1e-6, p.to - p.from)) : 0
    return (
      <Modal onClose={close} className='w-[460px]'>
        <ModalHeader title='Render Movie' aside={film.name} />
        <div className='flex flex-col gap-2 px-4 py-3 text-ui'>
          <canvas ref={previewRef} className='w-full rounded border border-border bg-black' style={{ aspectRatio: `${s.width} / ${s.height}` }} />
          <div className='h-1.5 w-full overflow-hidden rounded bg-control'>
            <div className='h-full bg-primary transition-[width]' style={{ width: `${(phase === 'done' ? 1 : fraction) * 100}%` }} />
          </div>
          {phase === 'rendering' && (
            <div className='grid grid-cols-2 gap-x-4 gap-y-0.5 text-ui-sm tabular-nums text-muted'>
              <span>{!p || p.phase === 'warmup' ? 'Warming up: settling the light' : p.phase === 'held' ? `Held at ${p.sequenceTime.toFixed(2)} s by the sequence` : `Frame ${p.frames} of about ${p.estimatedFrames}`}</span>
              <span className='text-right'>{p ? `${p.sequenceTime.toFixed(2)} s of ${p.to.toFixed(2)} s` : ''}</span>
              <span>{p ? `Elapsed ${clock(p.elapsedMs)}` : ''}</span>
              <span className='text-right'>{perFrame > 0 ? `Left about ${clock(left)}` : ''}</span>
              <span>{perFrame > 0 ? `${(perFrame / 1000).toFixed(2)} s a frame` : ''}</span>
              <span className='text-right'>{p ? megabytes(p.bytes) : ''}</span>
            </div>
          )}
          {phase === 'done' && result && (
            <Hint>
              {result.reason === 'cancelled' ? 'Cancelled. Kept ' : 'Wrote '}{result.frames} frames ({result.seconds.toFixed(2)} s
              {result.hasAudio ? ', with sound' : ', no sound'}): {result.output}, {megabytes(result.bytes)}. Took {clock(result.elapsedMs)}.
            </Hint>
          )}
          {phase === 'failed' && <p className='text-ui-sm text-danger'>{error}</p>}
          {rendering && <Hint>The editor is busy until the render ends. Cancel keeps the frames rendered so far.</Hint>}
        </div>
        <ModalFooter>
          {rendering
            ? <Button variant='ghost' onClick={() => abort.current?.abort()}>Cancel</Button>
            : <Button onClick={onClose}>Close</Button>}
        </ModalFooter>
      </Modal>
    )
  }

  const totalRenders = estimate * s.samples
  return (
    <Modal onClose={close} className='w-[460px]'>
      <ModalHeader title='Render Movie' aside={film.name} />
      <div className='flex flex-col px-4 py-2'>
        <Field label='Resolution'>
          <SegmentedControl size='sm' value={customSize ? 'Custom' : preset}
            options={[...RESOLUTION_PRESETS.map(p => ({ value: p.label, label: p.label })), { value: 'Custom', label: 'Custom' }]}
            onChange={v => {
              const p = RESOLUTION_PRESETS.find(r => r.label === v)
              setCustomSize(!p)
              if (p) set({ width: p.width, height: p.height })
            }} />
        </Field>
        {customSize && (
          <Field label='Size'>
            <div className='flex flex-1 items-center gap-1'>
              <NumberInput value={s.width} min={16} max={maxSize} step={2} onChange={v => set({ width: Math.round(v) })} />
              <span className='text-dim'>x</span>
              <NumberInput value={s.height} min={16} max={maxSize} step={2} onChange={v => set({ height: Math.round(v) })} />
            </div>
          </Field>
        )}
        <Field label='Frame rate'>
          <div className='flex flex-1 items-center gap-1'>
            <Select value={fpsPreset} onChange={e => { if (e.target.value !== 'custom') set({ fps: Number(e.target.value) }) }}>
              {FPS_PRESETS.map(f => <option key={f} value={String(f)}>{f} fps</option>)}
              <option value='custom'>Custom</option>
            </Select>
            {fpsPreset === 'custom' && <NumberInput value={s.fps} min={1} max={240} onChange={v => set({ fps: v })} />}
          </div>
        </Field>
        <Field label='Range'>
          <div className='flex flex-1 items-center gap-1'>
            <NumberInput value={s.from} min={0} max={duration} step={0.1} onChange={v => set({ from: Math.max(0, v) })} />
            <span className='text-dim'>to</span>
            <NumberInput value={s.to} min={0} max={duration} step={0.1} onChange={v => set({ to: Math.min(duration, v) })} />
            <span className='text-dim'>s</span>
          </div>
        </Field>
        <Field label='Samples'>
          <SegmentedControl size='sm' value={s.samples} options={SAMPLE_PRESETS.map(n => ({ value: n, label: String(n) }))}
            onChange={v => set({ samples: v })} />
        </Field>
        <Field label='Shutter'>
          <div className='flex flex-1 items-center gap-1'>
            <NumberInput value={s.shutterAngle} min={0} max={360} step={15} onChange={v => set({ shutterAngle: Math.min(360, Math.max(0, v)) })} />
            <span className='text-dim'>degrees</span>
          </div>
        </Field>
        <Field label='Pre-roll'>
          <div className='flex flex-1 items-center gap-1'>
            <NumberInput value={s.preRoll} min={0} max={30} step={0.5} onChange={v => set({ preRoll: Math.max(0, v) })} />
            <span className='text-dim'>s</span>
          </div>
        </Field>
        <div className='my-1 flex gap-4'>
          <Toggle checked={s.cinematic} onChange={v => set({ cinematic: v })} label='Cinematic quality' />
          <Toggle checked={s.audio} onChange={v => set({ audio: v })} label='Sound' />
        </div>
        <Field label='Format'>
          <SegmentedControl size='sm' value={s.format} options={[{ value: 'mp4', label: 'MP4' }, { value: 'png', label: 'PNG frames' }]}
            onChange={v => set({ format: v })} />
        </Field>
        {s.format === 'mp4' && (
          <>
            <Field label='Codec'>
              <Select value={codecs === null ? '' : s.codec} disabled={!codecs?.length}
                onChange={e => { const c = e.target.value as MovieCodec; set({ codec: c, quantizer: QUANTIZER[c].maximum }) }}>
                {codecs === null && <option value=''>Checking this machine…</option>}
                {codecs?.map(c => <option key={c} value={c}>{CODEC_LABEL[c]}</option>)}
              </Select>
            </Field>
            <Field label='Quality'>
              <div className='flex flex-1 items-center gap-1'>
                <SegmentedControl size='sm' value={s.quality}
                  options={[{ value: 'maximum', label: 'Maximum' }, { value: 'high', label: 'High' }, { value: 'custom', label: 'Custom' }]}
                  onChange={v => set({ quality: v })} />
                {s.quality === 'custom' && (
                  <NumberInput value={s.quantizer} min={0} max={QUANTIZER[s.codec].max}
                    title={`Quantizer, 0 to ${QUANTIZER[s.codec].max}: lower is better`} onChange={v => set({ quantizer: v })} />
                )}
              </div>
            </Field>
          </>
        )}
        <Hint className='mt-2'>
          About {estimate} frames, {totalRenders} renders{s.samples > 1 ? ` (${s.samples} samples a frame)` : ''}.
          {s.width * s.height > LARGE_FRAME_PIXELS ? ' A frame this large may run out of GPU memory.' : ''}
        </Hint>
        {invalid && <p className='mt-1 text-ui-sm text-danger'>{invalid}</p>}
        {!canWriteMovies() && <p className='mt-1 text-ui-sm text-danger'>This browser cannot write files to disk. Use Chrome or Edge, or the desktop editor.</p>}
      </div>
      <ModalFooter>
        <Button variant='ghost' onClick={onClose}>Cancel</Button>
        <Button disabled={!!invalid || !canWriteMovies() || (s.format === 'mp4' && !codecs?.length)} onClick={() => void start()}>Render…</Button>
      </ModalFooter>
    </Modal>
  )
}

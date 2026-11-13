import { describe, it, expect } from 'vitest'
import { Scene, SequenceNode, parseSequence } from 'cleo'
import {
  DEFAULT_MOVIE_SETTINGS, QUANTIZER, fallbackBitrate, frameFileName, quantizerFor, safeFileName, validateMovieSettings,
} from '../src/features/sequencer/movie/movieOutput'
import { movieNodeFor } from '../src/features/sequencer/movie/runMovie'

// The Render Movie dialog's arithmetic: what each quality means on each codec, what a frame may be, the files'
// names, and which Sequence node a movie films.

describe('movie quality', () => {
  it('maps Maximum, High and a custom quantizer onto each codec\'s own scale', () => {
    expect(quantizerFor({ codec: 'avc', quality: 'maximum', quantizer: 0 })).toBe(QUANTIZER.avc.maximum)
    expect(quantizerFor({ codec: 'av1', quality: 'high', quantizer: 0 })).toBe(QUANTIZER.av1.high)
    expect(quantizerFor({ codec: 'vp9', quality: 'custom', quantizer: 99 })).toBe(63)
    expect(quantizerFor({ codec: 'avc', quality: 'custom', quantizer: 14.6 })).toBe(15)
    for (const q of Object.values(QUANTIZER)) expect(q.maximum).toBeLessThan(q.high)
  })

  it('falls back to a bitrate that scales with the pixels per second', () => {
    const hd = fallbackBitrate({ width: 1920, height: 1080, fps: 60, quality: 'maximum' })
    expect(hd).toBeGreaterThan(40e6)
    expect(fallbackBitrate({ width: 3840, height: 2160, fps: 60, quality: 'maximum' })).toBe(hd * 4)
    expect(fallbackBitrate({ width: 1920, height: 1080, fps: 60, quality: 'high' })).toBeLessThan(hd)
  })
})

describe('validateMovieSettings', () => {
  const ok = { ...DEFAULT_MOVIE_SETTINGS, to: 10 }
  it('accepts the defaults and refuses what cannot be drawn or encoded', () => {
    expect(validateMovieSettings(ok, 8192)).toBeNull()
    expect(validateMovieSettings({ ...ok, width: 8193 }, 8192)).toMatch(/at most 8192/)
    expect(validateMovieSettings({ ...ok, width: 1921 }, 8192)).toMatch(/even/)
    // PNG frames need no even size.
    expect(validateMovieSettings({ ...ok, width: 1921, format: 'png' }, 8192)).toBeNull()
    expect(validateMovieSettings({ ...ok, fps: 0 }, 8192)).toMatch(/frame rate/)
    expect(validateMovieSettings({ ...ok, from: 5, to: 5 }, 8192)).toMatch(/range/)
  })
})

describe('movie files', () => {
  it('names frames in order, wide enough for an hour at 240 fps', () => {
    expect(frameFileName('Valley Tour', 0)).toBe('Valley Tour_000000.png')
    expect(frameFileName('Valley Tour', 864000)).toBe('Valley Tour_864000.png')
  })
  it('makes a name every file system accepts', () => {
    expect(safeFileName('Act 1: The "Valley"?')).toBe('Act 1 The Valley')
    expect(safeFileName('  ...  ')).toBe('Movie')
  })
})

describe('movieNodeFor', () => {
  const timeline = parseSequence({ name: 'Tour', duration: 4, slots: [], tracks: [], markers: [] })

  it('films the node the tab was opened from, else the first linking the asset, else a host with the working copy', () => {
    const scene = new Scene()
    const a = new SequenceNode('A', { sequence: timeline, sequenceId: 'tour' })
    const b = new SequenceNode('B', { sequence: timeline, sequenceId: 'tour' })
    const other = new SequenceNode('Other', { sequence: timeline, sequenceId: 'day' })
    for (const n of [other, a, b]) scene.addNode(n)
    const ref = { assetId: 'tour', name: 'Tour', contextNodeId: b.id, workingCopy: timeline }
    expect(movieNodeFor(scene, ref)).toEqual({ node: b, host: false })
    expect(movieNodeFor(scene, { ...ref, contextNodeId: null }).node).toBe(a)
    const hosted = movieNodeFor(scene, { ...ref, assetId: 'unlinked' })
    expect(hosted.host).toBe(true)
    expect(hosted.node.isEditorOwned).toBe(true)
    expect(hosted.node.sequence.duration).toBe(4)
  })
})

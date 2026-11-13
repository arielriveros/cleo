import { parseSequence } from 'cleo'
import type { SequenceData } from 'cleo'

// A sequence as a file: `<name>.sequence.json`, the SequenceData exactly as the node carries it, two-space
// JSON with a trailing newline. That is the format the Valley's checked-in tour is in
// (tools/valley/cinematic/valley-tour.sequence.json), so a tour tweaked in the editor exports straight over it.

export const SEQUENCE_FILE_SUFFIX = '.sequence.json'

export function sequenceToText(seq: SequenceData): string {
  return JSON.stringify(seq, null, 2) + '\n'
}

/** Read a sequence file. Throws with a readable message when the text is not JSON. */
export function sequenceFromText(text: string): SequenceData {
  let json: unknown
  try { json = JSON.parse(text) } catch (e) { throw new Error(`Not a sequence file: ${(e as Error).message}`) }
  if (!json || typeof json !== 'object' || !Array.isArray((json as any).tracks)) throw new Error('Not a sequence file: it has no tracks.')
  return parseSequence(json)
}

/** The file name a sequence exports as. */
export function sequenceFileName(seq: SequenceData): string {
  const stem = seq.name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').toLowerCase() || 'sequence'
  return stem + SEQUENCE_FILE_SUFFIX
}

/** Save a sequence through the browser's download. */
export function downloadSequence(seq: SequenceData): void {
  const blob = new Blob([sequenceToText(seq)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = sequenceFileName(seq)
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Ask for a `.sequence.json` and read it. Resolves null when the picker is dismissed. */
export function pickSequenceFile(): Promise<SequenceData | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) { resolve(null); return }
      try { resolve(sequenceFromText(await file.text())) } catch (e) { reject(e) }
    }
    input.click()
  })
}

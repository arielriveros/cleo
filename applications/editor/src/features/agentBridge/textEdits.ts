// script_write `edits`: exact replacements in a script's saved source, each `old` matching exactly once,
// applied in order. Pure, so the rules (and their messages) are unit-tested.

export interface TextEdit { old: string; new: string }

function count(haystack: string, needle: string): number {
  let n = 0
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++
  return n
}

/** 1-based line numbers where `needle` starts in `text`, the first few. */
function linesOf(text: string, needle: string, max = 5): number[] {
  const out: number[] = []
  for (let i = text.indexOf(needle); i >= 0 && out.length < max; i = text.indexOf(needle, i + needle.length))
    out.push(text.slice(0, i).split('\n').length)
  return out
}

/**
 * `source` with every edit applied in order. Throws, naming the edit, when an `old` is not found (with the
 * line its first line is on, when that much matches) or is found more than once (with where).
 */
export function applyTextEdits(source: string, edits: readonly TextEdit[]): string {
  let text = source
  edits.forEach((e, i) => {
    const n = count(text, e.old)
    if (n === 1) { text = text.replace(e.old, () => e.new); return }
    const what = `edit ${i + 1}`
    if (n > 1) throw new Error(`${what}: its old text is found ${n} times (lines ${linesOf(text, e.old).join(', ')}): include more of the lines around it so it matches once.`)
    const first = e.old.split('\n').find(l => l.trim())?.trim()
    const near = first ? linesOf(text, first, 3) : []
    throw new Error(`${what}: its old text is not in the script${near.length ? ` (its first line "${first}" is at line ${near.join(', ')}; the rest differs, whitespace included)` : ''}. script_read shows the saved source.`)
  })
  return text
}

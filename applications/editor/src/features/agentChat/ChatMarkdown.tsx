import { Fragment, type ReactNode } from 'react'

// The small Markdown subset Claude's replies use: paragraphs, headings, bullet and numbered lists, fenced
// code, inline code, bold, italics and links. Rendered as React elements, never as HTML, so nothing in a
// reply (or in a node name it quotes) can inject markup.

interface Block { type: 'p' | 'h' | 'ul' | 'ol' | 'code'; level?: number; lines: string[]; lang?: string }

function parseBlocks(src: string): Block[] {
  const out: Block[] = []
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*```(\w*)/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++ // the closing fence (or the end of a still-streaming reply)
      out.push({ type: 'code', lines: body, lang: fence[1] })
      continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) { out.push({ type: 'h', level: heading[1].length, lines: [heading[2]] }); i++; continue }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''))
      out.push({ type: 'ul', lines: items })
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))
      out.push({ type: 'ol', lines: items })
      continue
    }
    if (!line.trim()) { i++; continue }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])
      && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) para.push(lines[i++])
    out.push({ type: 'p', lines: para })
  }
  return out
}

/** Inline spans: `code`, **bold**, *italic* / _italic_, [text](http...). */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  let n = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${keyBase}-${n++}`
    if (m[1]) out.push(<code key={k} className='px-1 py-px rounded bg-surface-sunken text-fg font-mono text-ui-sm'>{m[1].slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k} className='font-semibold text-fg'>{m[2].slice(2, -2)}</strong>)
    else if (m[3]) out.push(<em key={k}>{m[3].slice(1, -1)}</em>)
    else if (m[4]) {
      const label = m[4].slice(1, m[4].indexOf(']'))
      out.push(<a key={k} href={m[5]} target='_blank' rel='noopener noreferrer' className='text-highlight underline'>{label}</a>)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function ChatMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text)
  return (
    <div className='flex flex-col gap-1.5 leading-relaxed break-words'>
      {blocks.map((b, i) => {
        const key = `b${i}`
        switch (b.type) {
          case 'code':
            return (
              <pre key={key} className='m-0 p-2 rounded bg-surface-sunken border border-border-subtle overflow-x-auto font-mono text-ui-sm text-fg whitespace-pre'>
                {b.lines.join('\n')}
              </pre>
            )
          case 'h':
            return <div key={key} className='font-semibold text-fg mt-1'>{inline(b.lines[0], key)}</div>
          case 'ul':
            return <ul key={key} className='m-0 pl-4 list-disc flex flex-col gap-0.5'>{b.lines.map((l, j) => <li key={j}>{inline(l, `${key}-${j}`)}</li>)}</ul>
          case 'ol':
            return <ol key={key} className='m-0 pl-4 list-decimal flex flex-col gap-0.5'>{b.lines.map((l, j) => <li key={j}>{inline(l, `${key}-${j}`)}</li>)}</ol>
          default:
            return <p key={key} className='m-0'>{b.lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l, `${key}-${j}`)}</Fragment>)}</p>
        }
      })}
    </div>
  )
}

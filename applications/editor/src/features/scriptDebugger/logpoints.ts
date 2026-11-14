// A logpoint is a breakpoint whose condition logs and answers false, so the game never stops on it. The
// message is the author's text with `{expression}` parts, evaluated where the line runs:
//   "hit {other.name} for {damage}"  →  Logger row: hit  Goblin  for  12   (each value as itself)
// The game page defines `globalThis.__cleoLogpoint(url, line, ...parts)` (player/session.tsx), which logs
// under the 'Logpoint' scope with the line as the row's source, so the Console links back to it.

export interface MessagePart { text?: string; expr?: string }

/** Split `a {b} c` into text and expression parts. `{{` and `}}` are literal braces. */
export function parseLogMessage(message: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let text = '';
  for (let i = 0; i < message.length; i++) {
    const c = message[i];
    if (c === '{' && message[i + 1] === '{') { text += '{'; i++; continue; }
    if (c === '}' && message[i + 1] === '}') { text += '}'; i++; continue; }
    if (c !== '{') { text += c; continue; }
    // An expression up to its matching close brace (object literals and blocks nest).
    let depth = 1, j = i + 1;
    for (; j < message.length && depth; j++) {
      if (message[j] === '{') depth++;
      else if (message[j] === '}') depth--;
    }
    if (depth) { text += message.slice(i); break; } // unclosed: the rest is text
    const expr = message.slice(i + 1, j - 1).trim();
    if (text) { parts.push({ text }); text = ''; }
    if (expr) parts.push({ expr });
    i = j - 1;
  }
  if (text) parts.push({ text });
  return parts;
}

/**
 * The breakpoint condition for a logpoint at `url`:`line`. Each expression is evaluated on its own, so one
 * that throws logs its error in its place and the others still show. Always false: never stops.
 */
export function logpointCondition(message: string, url: string, line: number): string {
  const args = parseLogMessage(message).map(p =>
    p.text !== undefined
      ? JSON.stringify(p.text)
      : `(() => { try { return (${p.expr}); } catch (e) { return '<' + e + '>'; } })()`,
  );
  return `(globalThis.__cleoLogpoint && globalThis.__cleoLogpoint(${JSON.stringify(url)}, ${line}${args.map(a => `, ${a}`).join('')}), false)`;
}

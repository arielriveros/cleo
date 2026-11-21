// What the script editor offers after an `@` in a class body: the script decorators of 'cleo/decorators',
// the snippet each one inserts, and the import line it needs. Pure text work, no Monaco, so the suite can
// hold it (tests/decoratorHelp.test.ts); tsCompletions.ts turns it into completion items.
//
// The decorators' documentation is NOT here: the completion list shows the engine's own doc comments
// (src/core/scripting/decorators.ts), read through the TypeScript worker.

/** The module scripts import decorators from (src/decorators.ts). */
export const DECORATOR_MODULE = 'cleo/decorators';

export interface DecoratorEntry {
  name: string;
  /** What it goes on. Listed first before a member of that kind. */
  target: 'field' | 'method';
  /** What choosing it inserts after the `@`, as a Monaco snippet. */
  snippet: string;
  /** Its first argument is a name the project knows (input actions, pick kinds): ask for suggestions there. */
  suggestInside?: boolean;
}

/** Every decorator 'cleo/decorators' exports, in the order the list shows them within a kind. */
export const DECORATORS: readonly DecoratorEntry[] = [
  { name: 'attribute', target: 'field', snippet: 'attribute' },
  { name: 'save', target: 'field', snippet: 'save' },
  { name: 'child', target: 'field', snippet: "child('${1:Name}')" },
  { name: 'find', target: 'field', snippet: "find('${1:Name}')" },
  { name: 'pick', target: 'field', snippet: "pick('$1')", suggestInside: true },
  { name: 'options', target: 'field', snippet: "options('${1:list}')" },
  { name: 'synced', target: 'field', snippet: 'synced' },
  { name: 'observable', target: 'field', snippet: 'observable' },
  { name: 'animParam', target: 'field', snippet: "animParam('${1:Param}')" },
  { name: 'onAction', target: 'method', snippet: "onAction('$1')", suggestInside: true },
  { name: 'onTap', target: 'method', snippet: "onTap('$1')", suggestInside: true },
  { name: 'onHold', target: 'method', snippet: "onHold('$1', ${2:0.5})", suggestInside: true },
  { name: 'onEvent', target: 'method', snippet: "onEvent('${1:Name}')" },
  { name: 'eventListener', target: 'method', snippet: "eventListener('${1:Name}')" },
  { name: 'eventDispatch', target: 'method', snippet: "eventDispatch('${1:Name}')" },
  { name: 'onClipEvent', target: 'method', snippet: "onClipEvent('${1:footstep}')" },
  { name: 'animTrigger', target: 'method', snippet: "animTrigger('$1')", suggestInside: true },
  { name: 'animAction', target: 'method', snippet: "animAction('${1:clip}')" },
  { name: 'every', target: 'method', snippet: 'every(${1:0.5})' },
  { name: 'onEnter', target: 'method', snippet: "onEnter('${1:Player}')" },
  { name: 'onExit', target: 'method', snippet: "onExit('${1:Player}')" },
  { name: 'netcall', target: 'method', snippet: "netcall({ to: '${1|host,all,owner|}' })" },
];

/**
 * The decorators in the order to list them for the member after the cursor: those that go on it first, the
 * rest after; all of them, in table order, when no member follows yet.
 */
export function decoratorsFor(member: 'field' | 'method' | null): { entry: DecoratorEntry; fits: boolean }[] {
  const all = DECORATORS.map(entry => ({ entry, fits: member === null || entry.target === member }));
  return [...all.filter(d => d.fits), ...all.filter(d => !d.fits)];
}

/** A text insertion: `text` at `offset` of the source. */
export interface TextInsert { offset: number; text: string }

// `import { a, b as c } from 'cleo/decorators'`, on one line or several.
const DECORATOR_IMPORT = /\bimport\s*\{([^}]*)\}\s*from\s*(['"])cleo\/decorators\2/;
// Any import statement: its clause holds no quotes, so the first quoted string is its module.
const ANY_IMPORT = /^[ \t]*import\b[^'"]*(['"])[^'"\n]*\1[ \t]*;?/gm;
// The engine's own import, which the decorators' line goes under.
const CLEO_IMPORT = /^[ \t]*import\b[^'"]*(['"])cleo\1[ \t]*;?/m;

/** The local names an import clause binds: `a, b as c` -> a, c. */
function boundNames(clause: string): string[] {
  return clause.split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+as\s+/).pop()!.replace(/^type\s+/, '').trim());
}

/**
 * Where the source must change so `name` is imported from 'cleo/decorators': into the braces of the import it
 * already has, or as a new line under the `cleo` import (else under the last import, else at the top). Null
 * when it is imported already.
 */
export function decoratorImportEdit(source: string, name: string): TextInsert | null {
  const existing = DECORATOR_IMPORT.exec(source);
  if (existing) {
    const clause = existing[1];
    if (boundNames(clause).includes(name)) return null;
    // Just after the last name in the braces (before any trailing space or comma).
    const open = existing.index + existing[0].indexOf('{') + 1;
    const trimmed = clause.replace(/[\s,]*$/, '');
    if (!trimmed.trim()) return { offset: open, text: ` ${name} ` };
    return { offset: open + trimmed.length, text: `, ${name}` };
  }

  const cleo = CLEO_IMPORT.exec(source);
  let after = cleo ? cleo.index + cleo[0].length : -1;
  const quote = cleo?.[1] ?? "'";
  if (after < 0) for (const m of source.matchAll(ANY_IMPORT)) after = m.index! + m[0].length;
  const line = `import { ${name} } from ${quote}${DECORATOR_MODULE}${quote}`;
  if (after < 0) return { offset: 0, text: `${line}\n` };
  const eol = source[after] === '\r' ? '\r\n' : '\n';
  return { offset: after, text: `${eol}${line}` };
}

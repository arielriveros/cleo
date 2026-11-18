// The script editor's completion list: TypeScript's, as Monaco gives it, except after an `@` in a class body,
// where it is the script decorators (decoratorHelp.ts) with their snippets, their docs and their import.
//
// Why this replaces Monaco's own TypeScript completion provider instead of adding one beside it: Monaco
// asks every provider whose selector scores highest and MERGES their lists, and no selector scores above
// a plain language id, which is what tsMode registers with. A decorator provider beside it would come with
// TypeScript's ~1000 globals after every `@` and a second, bare entry for each decorator already imported.
// So `completionItems` is switched off in the mode configuration, and `typeScriptSuggestions` below does
// what tsMode's SuggestAdapter does, line for line: monaco-editor 0.52.2,
// esm/vs/language/typescript/tsMode.js, `SuggestAdapter` and `tagToString`. Re-check it on a Monaco upgrade.
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { decoratorSiteAt, type DecoratorSite } from 'cleo';
import { DECORATORS, DECORATOR_MODULE, decoratorImportEdit, decoratorsFor } from './decoratorHelp';

type Model = Monaco.editor.ITextModel;
type Item = Monaco.languages.CompletionItem;

/** The parts of TypeScript's completion and details results this reads (Monaco types the worker `any`). */
interface DisplayPart { text: string }
interface TsTag { name: string; text?: DisplayPart[] | string }
interface TsEntry { name: string; kind: string; kindModifiers?: string; sortText: string; replacementSpan?: { start: number; length: number } }
interface TsDetails { name: string; kind: string; displayParts?: DisplayPart[]; documentation?: DisplayPart[]; tags?: TsTag[] }

/** A TypeScript item, as SuggestAdapter keeps them for resolving: where it was asked for. */
interface TsItem extends Item { uri: Monaco.Uri; position: Monaco.IPosition; offset: number }

const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Installs the script editor's completion provider for TypeScript models. Call once, before an editor
 * mounts (ensureMonaco).
 */
export function registerScriptCompletions(monaco: typeof Monaco): void {
  const defaults = monaco.languages.typescript.typescriptDefaults;
  defaults.setModeConfiguration({ ...defaults.modeConfiguration, completionItems: false });
  // The decorators' docs come from a module that imports them all, so a decorator is documented in the
  // list before the script imports it. Not under file:///cleo/: with baseUrl 'file:///', that is where
  // TypeScript looks for 'cleo/decorators' FIRST.
  defaults.addExtraLib(HELP_SOURCE, HELP_URI);

  monaco.languages.registerCompletionItemProvider('typescript', {
    triggerCharacters: ['.', '@'],
    async provideCompletionItems(model, position) {
      const site = decoratorSiteAt(model.getValue(), model.getOffsetAt(position));
      if (site) return { suggestions: await decoratorItems(monaco, model, position, site) };
      return typeScriptSuggestions(monaco, model, position);
    },
    async resolveCompletionItem(item) {
      return 'uri' in item ? resolveTypeScriptItem(monaco, item as TsItem) : item;
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Decorators                                                                  */
/* -------------------------------------------------------------------------- */

const HELP_URI = 'file:///.cleo/decoratorHelp.ts';
const HELP_SOURCE = `import { ${DECORATORS.map(d => d.name).join(', ')} } from '${DECORATOR_MODULE}'\n`;

/** Each decorator's signature and doc comment, read once from the worker (they change with an engine build). */
let docs: Promise<Map<string, { detail: string; documentation: string }>> | null = null;

function decoratorDocs(monaco: typeof Monaco, uri: Monaco.Uri) {
  docs ??= (async () => {
    const out = new Map<string, { detail: string; documentation: string }>();
    try {
      const worker = await (await monaco.languages.typescript.getTypeScriptWorker())(uri);
      // At the end of the help module every decorator is in scope, so its completion details are the ones a
      // script that imported it would get.
      await Promise.all(DECORATORS.map(async ({ name }) => {
        const details: TsDetails | undefined = await worker.getCompletionEntryDetails(HELP_URI, HELP_SOURCE.length, name);
        if (!details) return;
        // Read through the help module's import, the signature comes as `(alias) function child(…)` plus a
        // line `import child`; the list shows the declaration alone.
        const detail = partsText(details.displayParts).replace(/^\(alias\) /, '').replace(/\s*\nimport \S+\s*$/, '');
        out.set(name, { detail, documentation: documentationOf(details) });
      }));
    } catch {
      // The worker still starting, or its program not yet holding the help module: nothing to show yet.
    }
    // Ask again next time unless every decorator came back, rather than keep a list without its docs.
    if (out.size < DECORATORS.length) docs = null;
    return out;
  })();
  return docs;
}

async function decoratorItems(monaco: typeof Monaco, model: Model, position: Monaco.IPosition, site: DecoratorSite): Promise<Item[]> {
  const source = model.getValue();
  const offset = model.getOffsetAt(position);
  // Replace the name typed so far and the rest of it, should the cursor be inside one.
  let end = offset;
  while (end < source.length && IDENT_PART.test(source[end])) end++;
  const start = model.getPositionAt(site.at + 1);
  const stop = model.getPositionAt(end);
  const range = new monaco.Range(start.lineNumber, start.column, stop.lineNumber, stop.column);
  // Already followed by arguments (`@onA|ction('Jump')`): insert the name alone.
  let next = end;
  while (next < source.length && (source[next] === ' ' || source[next] === '\t')) next++;
  const hasArgs = source[next] === '(';
  const known = await decoratorDocs(monaco, model.uri).catch(() => new Map());

  return decoratorsFor(site.member).map(({ entry, fits }, i): Item => {
    const edit = decoratorImportEdit(source, entry.name);
    const doc = known.get(entry.name);
    const at = edit && model.getPositionAt(edit.offset);
    return {
      label: { label: entry.name, description: entry.target },
      kind: monaco.languages.CompletionItemKind.Function,
      // Before TypeScript's ordering ('11' and up): those that fit the member first, in table order.
      sortText: `0${fits ? 0 : 1}${String(i).padStart(2, '0')}`,
      filterText: entry.name,
      range,
      insertText: hasArgs ? entry.name : entry.snippet,
      insertTextRules: hasArgs ? undefined : monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      detail: doc?.detail ?? `${entry.target} decorator from '${DECORATOR_MODULE}'`,
      documentation: doc ? { value: doc.documentation } : undefined,
      additionalTextEdits: at ? [{ range: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column), text: edit!.text }] : undefined,
      command: entry.suggestInside && !hasArgs ? { id: 'editor.action.triggerSuggest', title: 'Suggest' } : undefined,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* TypeScript (tsMode's SuggestAdapter)                                        */
/* -------------------------------------------------------------------------- */

async function typeScriptSuggestions(monaco: typeof Monaco, model: Model, position: Monaco.Position): Promise<Monaco.languages.CompletionList | undefined> {
  const wordInfo = model.getWordUntilPosition(position);
  const wordRange = new monaco.Range(position.lineNumber, wordInfo.startColumn, position.lineNumber, wordInfo.endColumn);
  const resource = model.uri;
  const offset = model.getOffsetAt(position);
  const worker = await (await monaco.languages.typescript.getTypeScriptWorker())(resource);
  if (model.isDisposed()) return;
  const info: { entries: TsEntry[] } | undefined = await worker.getCompletionsAtPosition(resource.toString(), offset);
  if (!info || model.isDisposed()) return;
  const suggestions = info.entries.map((entry): TsItem => {
    let range: Monaco.IRange = wordRange;
    if (entry.replacementSpan) {
      const p1 = model.getPositionAt(entry.replacementSpan.start);
      const p2 = model.getPositionAt(entry.replacementSpan.start + entry.replacementSpan.length);
      range = new monaco.Range(p1.lineNumber, p1.column, p2.lineNumber, p2.column);
    }
    const tags: Monaco.languages.CompletionItemTag[] = [];
    if (entry.kindModifiers !== undefined && entry.kindModifiers.indexOf('deprecated') !== -1)
      tags.push(monaco.languages.CompletionItemTag.Deprecated);
    return {
      uri: resource,
      position,
      offset,
      range,
      label: entry.name,
      insertText: entry.name,
      sortText: entry.sortText,
      kind: convertKind(monaco, entry.kind),
      tags,
    };
  });
  return { suggestions };
}

async function resolveTypeScriptItem(monaco: typeof Monaco, item: TsItem): Promise<Item> {
  const worker = await (await monaco.languages.typescript.getTypeScriptWorker())(item.uri);
  const details: TsDetails | undefined = await worker.getCompletionEntryDetails(item.uri.toString(), item.offset, item.label as string);
  if (!details) return item;
  return {
    ...item,
    label: details.name,
    kind: convertKind(monaco, details.kind),
    detail: partsText(details.displayParts),
    documentation: { value: documentationOf(details) },
  };
}

function convertKind(monaco: typeof Monaco, kind: string): Monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'primitive type': case 'keyword': return K.Keyword;
    case 'var': case 'local var': return K.Variable;
    case 'property': case 'getter': case 'setter': return K.Field;
    case 'function': case 'method': case 'construct': case 'call': case 'index': return K.Function;
    case 'enum': return K.Enum;
    case 'module': return K.Module;
    case 'class': return K.Class;
    case 'interface': return K.Interface;
    case 'warning': return K.File;
  }
  return K.Property;
}

function partsText(parts: DisplayPart[] | undefined): string {
  return parts ? parts.map(p => p.text).join('') : '';
}

function documentationOf(details: TsDetails): string {
  let out = partsText(details.documentation);
  for (const tag of details.tags ?? []) out += `\n\n${tagText(tag)}`;
  return out;
}

function tagText(tag: TsTag): string {
  let label = `*@${tag.name}*`;
  if (tag.name === 'param' && Array.isArray(tag.text) && tag.text.length) {
    const [param, ...rest] = tag.text;
    label += `\`${param.text}\``;
    if (rest.length > 0) label += ` — ${rest.map(r => r.text).join(' ')}`;
  } else if (Array.isArray(tag.text)) {
    label += ` — ${tag.text.map(r => r.text).join(' ')}`;
  } else if (tag.text) {
    label += ` — ${tag.text}`;
  }
  return label;
}

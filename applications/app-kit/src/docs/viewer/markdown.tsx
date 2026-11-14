import React, { useMemo, useState } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import { cn } from '../../ui/cn';
import { CopyIcon, HashIcon, ImageIcon } from '../../ui/icons';
import { resolveDocLink, slugify, type DocLink } from '../parseDocs';
import { highlight, highlightable } from './highlight';

// The docs viewer's markdown renderer: `marked` lexes the page (GitHub-flavoured: tables, escaped pipes,
// blocks inside quotes and lists, bare-URL links), and the tokens become React elements here -- never an
// HTML string -- styled with the design tokens.
//
// Every block, list item and table row carries `data-line`, its 1-based line in the page's source. The
// docs index records the same line for each entry (parseDocs), which is how a tooltip, F1 or a What's
// This? click scrolls the viewer to the exact row it came from.
//
// Images are not bundled with the apps, so an image shows as its caption (the docs' alt text is a full
// caption, written for exactly this).

export interface MarkdownViewProps {
  /** Page id (`editor/rendering`): what relative links resolve against. */
  page: string;
  source: string;
  /** Whether a page id is bundled; links to anything else render as inert text. */
  hasPage: (page: string) => boolean;
  /** A click on a link that stays in the docs (or leaves for the web). */
  onLink: (link: DocLink) => void;
}

/** The tokens of a page, lexed once per source text. */
export function lexDocs(source: string): Token[] {
  return marked.lexer(source.replace(/\r\n?/g, '\n'), { gfm: true });
}

const newlines = (s: string) => { let n = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++; return n; };

/** Each token with its start line: `base` plus the newlines of everything before it. */
function withLines<T extends { raw: string }>(tokens: T[], base: number): Array<[T, number]> {
  const out: Array<[T, number]> = [];
  let line = base;
  for (const t of tokens) {
    out.push([t, line]);
    line += newlines(t.raw);
  }
  return out;
}

/** GitHub's heading ids for a page, in order: the slug, numbered on repeats (`quality`, `quality-1`). */
export function headingIds(tokens: Token[]): Map<Token, string> {
  const ids = new Map<Token, string>();
  const seen = new Map<string, number>();
  const visit = (list: Token[]) => {
    for (const t of list) {
      if (t.type === 'heading') {
        const base = slugify((t as Tokens.Heading).text);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        ids.set(t, n ? `${base}-${n}` : base);
      } else if (t.type === 'blockquote') {
        visit((t as Tokens.Blockquote).tokens);
      }
    }
  };
  visit(tokens);
  return ids;
}

// ---------------------------------------------------------------------------------------------------
// Inline

interface Ctx {
  page: string;
  hasPage: (page: string) => boolean;
  onLink: (link: DocLink) => void;
  ids: Map<Token, string>;
}

const UNRELEASED = /^\(unreleased/i;

function Unreleased({ text }: { text: string }) {
  return (
    <span title={text.replace(/^\(|\)$/g, '')}
      className='inline-block align-middle mx-0.5 px-1.5 rounded-full border border-warning/50 bg-warning/10 text-warning font-mono text-ui-2xs uppercase tracking-wide not-italic'>
      unreleased
    </span>
  );
}

function ImageCaption({ alt, block }: { alt: string; block?: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-start gap-2 rounded border border-dashed border-border bg-surface-sunken/60 text-dim italic',
      block ? 'flex w-full px-3 py-2' : 'px-1.5 py-0.5 text-ui',
    )}>
      <span className='w-4 h-4 shrink-0 mt-0.5 not-italic'><ImageIcon /></span>
      <span>{alt || 'Image'}</span>
    </span>
  );
}

function DocAnchor({ ctx, href, children }: { ctx: Ctx; href: string; children: React.ReactNode }) {
  const link = resolveDocLink(ctx.page, href);
  const live = link.kind === 'external' || (link.kind === 'page' && ctx.hasPage(link.page));
  if (!live) {
    return (
      <span title={`Not in the bundled docs: ${href}`} className='text-muted underline decoration-dotted underline-offset-2'>
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      title={link.kind === 'external' ? href : undefined}
      onClick={e => { e.preventDefault(); ctx.onLink(link); }}
      className='text-highlight underline-offset-2 hover:underline cursor-pointer'
    >
      {children}
    </a>
  );
}

function renderInline(tokens: Token[] | undefined, ctx: Ctx): React.ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'text': {
        const tt = t as Tokens.Text;
        return tt.tokens ? <React.Fragment key={i}>{renderInline(tt.tokens, ctx)}</React.Fragment> : tt.text;
      }
      case 'escape': return (t as Tokens.Escape).text;
      case 'strong': return <strong key={i} className='font-semibold text-fg'>{renderInline((t as Tokens.Strong).tokens, ctx)}</strong>;
      case 'em': {
        const em = t as Tokens.Em;
        if (UNRELEASED.test(em.text)) return <Unreleased key={i} text={em.text} />;
        return <em key={i}>{renderInline(em.tokens, ctx)}</em>;
      }
      case 'del': return <del key={i}>{renderInline((t as Tokens.Del).tokens, ctx)}</del>;
      case 'codespan':
        return (
          <code key={i} className='font-mono text-ui px-1 py-px rounded border border-border-subtle bg-surface-sunken text-fg break-words'>
            {(t as Tokens.Codespan).text}
          </code>
        );
      case 'br': return <br key={i} />;
      case 'link': {
        const l = t as Tokens.Link;
        return <DocAnchor key={i} ctx={ctx} href={l.href}>{renderInline(l.tokens, ctx)}</DocAnchor>;
      }
      case 'image': return <ImageCaption key={i} alt={(t as Tokens.Image).text} />;
      // No raw HTML in the docs; a stray `<tag>` in prose is shown as written, never interpreted.
      case 'html': return (t as Tokens.HTML).text;
      default: return 'text' in t ? String((t as { text: unknown }).text) : t.raw;
    }
  });
}

// ---------------------------------------------------------------------------------------------------
// Blocks

const HEADING_CLASS: Record<number, string> = {
  1: 'text-ui-3xl font-semibold text-fg mt-1 mb-4',
  2: 'text-ui-2xl font-semibold text-fg mt-9 mb-3 pb-1.5 border-b border-border-subtle',
  3: 'text-ui-xl font-semibold text-fg mt-7 mb-2',
  4: 'text-doc font-semibold text-fg mt-5 mb-1.5',
  5: 'text-ui font-semibold uppercase tracking-wide text-muted mt-4 mb-1',
  6: 'text-ui font-semibold uppercase tracking-wide text-dim mt-4 mb-1',
};

function CodeBlock({ code, lang, line }: { code: string; lang?: string; line: number }) {
  const [copied, setCopied] = useState(false);
  const runs = useMemo(() => highlight(code, lang), [code, lang]);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div data-line={line} className='group relative my-4 rounded border border-border-subtle bg-surface-sunken'>
      <pre className={cn('overflow-x-auto px-3.5 py-3 font-mono text-ui text-fg select-text', highlightable(lang) ? 'leading-relaxed' : 'leading-tight')}>
        <code>
          {runs.map((r, i) => (r.kind === 'plain' ? r.text : <span key={i} className={`cleo-code-${r.kind}`}>{r.text}</span>))}
        </code>
      </pre>
      <button
        type='button'
        onClick={copy}
        title={copied ? 'Copied' : 'Copy'}
        aria-label='Copy code'
        className={cn(
          'absolute top-1.5 right-1.5 w-6 h-6 p-1 rounded border border-border-subtle bg-surface-raised text-muted hover:text-fg',
          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity',
          copied && 'opacity-100 text-success-fg',
        )}
      >
        <CopyIcon />
      </button>
    </div>
  );
}

function Table({ token, line, ctx }: { token: Tokens.Table; line: number; ctx: Ctx }) {
  const hasHeader = token.header.some(c => c.text.trim() !== '');
  return (
    <div data-line={line} className='my-4 overflow-x-auto rounded border border-border-subtle'>
      <table className='w-full border-collapse text-left'>
        {hasHeader && (
          <thead className='bg-surface-raised'>
            <tr>
              {token.header.map((c, i) => (
                <th key={i} className='px-3 py-1.5 font-semibold text-fg border-b border-border align-bottom'>
                  {renderInline(c.tokens, ctx)}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {token.rows.map((row, r) => (
            // The header row and the `|---|` delimiter come first, so row r sits two lines below them.
            <tr key={r} data-line={line + 2 + r} className='border-b border-border-subtle last:border-0 align-top even:bg-surface-raised/30'>
              {row.map((c, i) => (
                <td key={i} className='px-3 py-1.5'>{renderInline(c.tokens, ctx)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListBlock({ token, line, ctx }: { token: Tokens.List; line: number; ctx: Ctx }) {
  const Tag = token.ordered ? 'ol' : 'ul';
  return (
    <Tag
      data-line={line}
      start={token.ordered && token.start !== '' && token.start !== 1 ? token.start : undefined}
      className={cn('my-3 pl-6 space-y-1 marker:text-dim', token.ordered ? 'list-decimal' : 'list-disc')}
    >
      {withLines(token.items, line).map(([item, itemLine], i) => (
        <li key={i} data-line={itemLine} className='pl-1'>
          <Blocks tokens={item.tokens} base={itemLine} ctx={ctx} tight={!item.loose} />
        </li>
      ))}
    </Tag>
  );
}

function Blocks({ tokens, base, ctx, tight = false }: { tokens: Token[]; base: number; ctx: Ctx; tight?: boolean }) {
  return (
    <>
      {withLines(tokens, base).map(([t, line], i) => <Block key={i} token={t} line={line} ctx={ctx} tight={tight} />)}
    </>
  );
}

function Block({ token, line, ctx, tight }: { token: Token; line: number; ctx: Ctx; tight: boolean }) {
  switch (token.type) {
    case 'space':
    case 'def':
      return null;
    case 'heading': {
      const h = token as Tokens.Heading;
      const id = ctx.ids.get(token);
      const Tag = `h${Math.min(6, Math.max(1, h.depth))}` as 'h2';
      return (
        <Tag id={id} data-line={line} className={cn('group scroll-mt-4 font-doc', HEADING_CLASS[h.depth] ?? HEADING_CLASS[6])}>
          {renderInline(h.tokens, ctx)}
          {id && h.depth > 1 && (
            <a
              href={`#${id}`}
              onClick={e => { e.preventDefault(); ctx.onLink({ kind: 'page', page: ctx.page, anchor: id }); }}
              aria-label='Link to this section'
              className='inline-block align-middle ml-1.5 w-3.5 h-3.5 text-dim opacity-0 group-hover:opacity-100 hover:text-highlight transition-opacity'
            >
              <HashIcon />
            </a>
          )}
        </Tag>
      );
    }
    case 'paragraph': {
      const p = token as Tokens.Paragraph;
      // A paragraph that is only a picture becomes its caption, as a block.
      const only = p.tokens.filter(t => !(t.type === 'text' && !(t as Tokens.Text).text.trim()));
      if (only.length === 1 && only[0].type === 'image') {
        return <div data-line={line} className='my-4'><ImageCaption block alt={(only[0] as Tokens.Image).text} /></div>;
      }
      return <p data-line={line} className={tight ? 'my-0' : 'my-3'}>{renderInline(p.tokens, ctx)}</p>;
    }
    case 'text': {
      // A tight list item's text: inline content, no paragraph margins.
      const t = token as Tokens.Text;
      return <span data-line={line}>{t.tokens ? renderInline(t.tokens, ctx) : t.text}</span>;
    }
    case 'blockquote': {
      const q = token as Tokens.Blockquote;
      return (
        <blockquote data-line={line}
          className='my-4 rounded-r border-l-2 border-highlight/60 bg-surface-sunken/70 px-4 py-1 text-muted [&_strong]:text-fg'>
          <Blocks tokens={q.tokens} base={line} ctx={ctx} />
        </blockquote>
      );
    }
    case 'list': return <ListBlock token={token as Tokens.List} line={line} ctx={ctx} />;
    case 'code': {
      const c = token as Tokens.Code;
      return <CodeBlock code={c.text} lang={c.lang || undefined} line={line} />;
    }
    case 'table': return <Table token={token as Tokens.Table} line={line} ctx={ctx} />;
    case 'hr': return <hr data-line={line} className='my-6 border-0 border-t border-border-subtle' />;
    case 'html': return <p data-line={line} className='my-3'>{(token as Tokens.HTML).text}</p>;
    default:
      return <p data-line={line} className='my-3'>{token.raw}</p>;
  }
}

/** One docs page, rendered. */
export function MarkdownView({ page, source, hasPage, onLink }: MarkdownViewProps) {
  const tokens = useMemo(() => lexDocs(source), [source]);
  const ids = useMemo(() => headingIds(tokens), [tokens]);
  const ctx: Ctx = { page, hasPage, onLink, ids };
  return (
    <article className='font-doc text-doc text-fg/90 select-text break-words'>
      <Blocks tokens={tokens} base={1} ctx={ctx} />
    </article>
  );
}

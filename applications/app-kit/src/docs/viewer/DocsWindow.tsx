import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../ui/Button';
import { cn } from '../../ui/cn';
import { controlClass } from '../../ui/inputs';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, HomeIcon, SearchIcon, SidebarIcon } from '../../ui/icons';
import { getDocIndex, getDocSource, getDocsVersion, pageOrder, subscribeDocs } from '../docIndex';
import { headingLine, type DocLink } from '../parseDocs';
import { DOCS_WINDOW_ATTR } from '../whatsThis';
import { searchDocs, type DocSearchHit } from './docSearch';
import {
  closeDocs, getDocsHome, getDocsViewerState, goBack, goForward, noteDocsScroll, openDocs, subscribeDocsViewer,
  type DocTarget,
} from './docsViewerStore';
import { MarkdownView } from './markdown';

// Help > Documentation: the docs, read inside the app. A floating window, not a modal -- the editor keeps
// working under it, so a page can stay open beside the panel it describes. Dragged by its header, resized
// from its edges, and remembered (position, size, sidebar) per app.

interface Rect { x: number; y: number; w: number; h: number }
interface Stored extends Rect { sidebar: boolean }

const MIN_W = 380;
const MIN_H = 260;
/** How much of the window must stay on screen when the app window shrinks or it is dragged away. */
const KEEP_VISIBLE = 120;
const HEADER_H = 32;

function defaultRect(): Rect {
  const w = Math.min(820, Math.max(MIN_W, Math.round(window.innerWidth * 0.5)));
  const h = Math.min(Math.max(MIN_H, Math.round(window.innerHeight * 0.78)), window.innerHeight - 48);
  return { x: Math.max(8, window.innerWidth - w - 24), y: 48, w, h };
}

function clampRect(r: Rect): Rect {
  const w = Math.max(MIN_W, Math.min(r.w, window.innerWidth));
  const h = Math.max(MIN_H, Math.min(r.h, window.innerHeight));
  const x = Math.min(Math.max(r.x, KEEP_VISIBLE - w), window.innerWidth - KEEP_VISIBLE);
  const y = Math.min(Math.max(r.y, 0), window.innerHeight - HEADER_H);
  return { x, y, w, h };
}

function load(key: string): Stored {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Stored>;
      if ([s.x, s.y, s.w, s.h].every(v => typeof v === 'number' && Number.isFinite(v))) {
        return { ...clampRect(s as Rect), sidebar: s.sidebar !== false };
      }
    }
  } catch { /* a corrupt entry falls back to the default */ }
  return { ...defaultRect(), sidebar: true };
}

/** The sidebar's groups: one per docs folder, in the order the README first reaches them. */
const GROUP_NAMES: Record<string, string> = { '': 'Overview', editor: 'Editor', creator: 'Creator', scripting: 'Scripting', reference: 'Reference' };

function groupsOf(order: string[]): Array<{ name: string; pages: string[] }> {
  const groups = new Map<string, string[]>();
  for (const id of order) {
    const folder = id.includes('/') ? id.slice(0, id.indexOf('/')) : '';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder)!.push(id);
  }
  return [...groups].map(([folder, pages]) => ({ name: GROUP_NAMES[folder] ?? folder, pages }));
}

/** The element a target line lands on: the last block starting at or before it, preferring a row or item. */
function elementForLine(root: HTMLElement, line: number): HTMLElement | null {
  let bestLine = -1;
  let candidates: HTMLElement[] = [];
  root.querySelectorAll<HTMLElement>('[data-line]').forEach(el => {
    const l = Number(el.dataset.line);
    if (!(l <= line)) return;
    if (l > bestLine) { bestLine = l; candidates = [el]; } else if (l === bestLine) candidates.push(el);
  });
  if (!candidates.length) return null;
  const preferred = candidates.find(el => /^(TR|LI|H[1-6]|P)$/.test(el.tagName));
  return preferred ?? candidates[candidates.length - 1];
}

function flash(el: HTMLElement) {
  el.classList.remove('cleo-docs-flash');
  // Restart the animation when the same element is the target twice in a row.
  void el.offsetWidth;
  el.classList.add('cleo-docs-flash');
  window.setTimeout(() => el.classList.remove('cleo-docs-flash'), 2000);
}

type Edge = 'e' | 'w' | 's' | 'se' | 'sw';
const EDGE_CLASS: Record<Edge, string> = {
  e: 'top-2 bottom-3 right-0 w-1.5 cursor-ew-resize',
  w: 'top-2 bottom-3 left-0 w-1.5 cursor-ew-resize',
  s: 'left-3 right-3 bottom-0 h-1.5 cursor-ns-resize',
  se: 'right-0 bottom-0 w-3 h-3 cursor-nwse-resize',
  sw: 'left-0 bottom-0 w-3 h-3 cursor-nesw-resize',
};

export interface DocsWindowProps {
  /** localStorage key for the window's position, size and sidebar. */
  storageKey: string;
}

export function DocsWindow({ storageKey }: DocsWindowProps) {
  const state = useSyncExternalStore(subscribeDocsViewer, getDocsViewerState);
  const docsVersion = useSyncExternalStore(subscribeDocs, getDocsVersion);
  const [stored, setStored] = useState<Stored>(() => load(storageKey));
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const storedRef = useRef(stored);
  storedRef.current = stored;

  const persist = useCallback((next: Stored) => {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* storage full or blocked */ }
  }, [storageKey]);

  // Keep the window reachable when the app window shrinks.
  useEffect(() => {
    const onResize = () => setStored(s => ({ ...s, ...clampRect(s) }));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Focus on open, so Esc and Alt+arrows work at once.
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);

  const index = getDocIndex();
  const current = state.current;
  const pageId = current?.page ?? getDocsHome();
  const page = index.pages.get(pageId);
  const source = getDocSource(pageId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupsOf(pageOrder()), [docsVersion]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hits = useMemo(() => searchDocs(getDocIndex(), query), [query, docsVersion]);
  const hasPage = useCallback((id: string) => getDocSource(id) !== undefined, []);

  const onLink = useCallback((link: DocLink) => {
    if (link.kind === 'external') { window.open(link.href, '_blank', 'noopener,noreferrer'); return; }
    if (link.kind === 'page') openDocs({ page: link.page, anchor: link.anchor });
  }, []);

  // Each navigation: back/forward restores where the reader was; a target line or anchor scrolls to it and
  // marks it; anything else starts at the top.
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main || !current) return;
    if (current.scroll !== undefined) { main.scrollTop = current.scroll; return; }
    let el: HTMLElement | null = null;
    if (current.anchor) {
      el = main.querySelector<HTMLElement>(`[id="${CSS.escape(current.anchor)}"]`);
      if (!el) {
        const line = headingLine(index, current.page, current.anchor);
        if (line !== undefined) el = elementForLine(main, line);
      }
    } else if (current.line !== undefined) {
      el = elementForLine(main, current.line);
    }
    if (!el) { main.scrollTop = 0; return; }
    main.scrollTop += el.getBoundingClientRect().top - main.getBoundingClientRect().top - 16;
    flash(el);
    // `nav` is the trigger: the same place reopened should scroll and flash again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nav]);

  // Keep the open page's entry in the contents in view as the reader moves between pages.
  useEffect(() => {
    rootRef.current?.querySelector('[data-current-page]')?.scrollIntoView({ block: 'nearest' });
  }, [pageId, stored.sidebar]);

  const go = (target: DocTarget) => { openDocs(target); };

  // ----- drag and resize -------------------------------------------------------------------------------

  const startGesture = (e: React.PointerEvent, apply: (dx: number, dy: number, start: Rect) => Rect) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const start: Rect = { ...storedRef.current };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => setStored(s => ({ ...s, ...clampRect(apply(ev.clientX - x0, ev.clientY - y0, start)) }));
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      persist(storedRef.current);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const onHeaderDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('button, input')) return;
    startGesture(e, (dx, dy, s) => ({ ...s, x: s.x + dx, y: s.y + dy }));
  };

  const onEdgeDown = (edge: Edge) => (e: React.PointerEvent) => startGesture(e, (dx, dy, s) => {
    let { x, w, h } = s;
    if (edge.includes('e')) w = Math.max(MIN_W, s.w + dx);
    if (edge.includes('w')) { w = Math.max(MIN_W, s.w - dx); x = s.x + (s.w - w); }
    if (edge.includes('s')) h = Math.max(MIN_H, s.h + dy);
    return { x, y: s.y, w, h };
  });

  const toggleSidebar = () => setStored(s => { const next = { ...s, sidebar: !s.sidebar }; persist(next); return next; });

  // ----- keys --------------------------------------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent) => {
    const inSearch = e.target === searchRef.current;
    if (e.key === 'Escape') {
      if (inSearch && query) setQuery('');
      else closeDocs();
    } else if (e.altKey && e.key === 'ArrowLeft') goBack();
    else if (e.altKey && e.key === 'ArrowRight') goForward();
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'k')) {
      if (!stored.sidebar) toggleSidebar();
      window.setTimeout(() => searchRef.current?.select(), 0);
    } else if (inSearch && hits.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setSelected(i => Math.max(0, Math.min(hits.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (inSearch && e.key === 'Enter' && hits[selected]) {
      go(hits[selected].target);
    } else return;
    // Handled here: the editor's own shortcuts must not also act on it.
    e.preventDefault();
    e.stopPropagation();
  };

  const { x, y, w, h, sidebar } = stored;
  const title = page?.title ?? pageId;

  return createPortal(
    <div
      ref={rootRef}
      {...{ [DOCS_WINDOW_ATTR]: '' }}
      role='dialog'
      aria-label='Documentation'
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className='fixed z-[900] flex flex-col overflow-hidden rounded-md border border-border bg-surface shadow-panel outline-none focus-visible:outline-none'
      style={{ left: x, top: y, width: w, height: h }}
    >
      <div
        onPointerDown={onHeaderDown}
        className='flex items-center gap-0.5 h-8 shrink-0 px-1 bg-surface-sunken border-b border-border cursor-move select-none'
      >
        <HeaderButton title={sidebar ? 'Hide the contents' : 'Show the contents'} active={sidebar} onClick={toggleSidebar}><SidebarIcon /></HeaderButton>
        <HeaderButton title='Back (Alt+Left)' disabled={!state.back.length} onClick={goBack}><ChevronLeftIcon /></HeaderButton>
        <HeaderButton title='Forward (Alt+Right)' disabled={!state.forward.length} onClick={goForward}><ChevronRightIcon /></HeaderButton>
        <HeaderButton title='Start page' onClick={() => go({ page: getDocsHome() })}><HomeIcon /></HeaderButton>
        <div className='min-w-0 flex-1 px-2 text-ui font-semibold text-fg truncate' title={title}>{title}</div>
        <HeaderButton title='Close (Esc)' onClick={closeDocs}><CloseIcon /></HeaderButton>
      </div>

      <div className='flex flex-1 min-h-0'>
        {sidebar && (
          <aside className='w-56 shrink-0 flex flex-col min-h-0 border-r border-border-subtle bg-surface-sunken/60'>
            <div className='p-2 border-b border-border-subtle'>
              <label className='relative block'>
                <span className='absolute left-1.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dim pointer-events-none'><SearchIcon /></span>
                <input
                  ref={searchRef}
                  value={query}
                  onChange={e => { setQuery(e.target.value); setSelected(0); }}
                  placeholder='Search the docs'
                  aria-label='Search the docs'
                  className={cn(controlClass, 'w-full pl-6')}
                />
              </label>
            </div>
            <nav className='flex-1 min-h-0 overflow-y-auto py-1.5 text-ui'>
              {query.trim()
                ? <SearchResults hits={hits} selected={selected} onPick={go} query={query} />
                : groups.map(g => (
                  <div key={g.name} className='mb-2'>
                    <div className='px-3 pt-1.5 pb-0.5 text-ui-xs uppercase tracking-wide text-dim'>{g.name}</div>
                    {g.pages.map(id => {
                      const p = index.pages.get(id);
                      const isCurrent = id === pageId;
                      return (
                        <div key={id}>
                          <button
                            type='button'
                            data-current-page={isCurrent ? '' : undefined}
                            onClick={() => go({ page: id })}
                            className={cn(
                              'block w-full text-left px-3 py-0.5 truncate hover:bg-control/60',
                              isCurrent ? 'text-fg bg-selected/20 border-l-2 border-highlight pl-[10px]' : 'text-muted',
                            )}
                            title={p?.title ?? id}
                          >
                            {p?.title ?? id}
                          </button>
                          {isCurrent && p && (
                            <div className='pb-1'>
                              {p.headings.filter(hd => hd.level === 2 && !hd.pseudo).map(hd => (
                                <button
                                  key={hd.anchor}
                                  type='button'
                                  onClick={() => go({ page: id, line: hd.line })}
                                  className='block w-full text-left pl-6 pr-3 py-px truncate text-ui-sm text-dim hover:text-fg'
                                  title={hd.text}
                                >
                                  {hd.text}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
            </nav>
          </aside>
        )}

        <div
          ref={mainRef}
          className='flex-1 min-w-0 overflow-y-auto bg-surface'
          onScroll={e => noteDocsScroll((e.target as HTMLElement).scrollTop)}
        >
          <div className='mx-auto max-w-[760px] px-8 pt-6 pb-16'>
            {source !== undefined
              ? <MarkdownView page={pageId} source={source} hasPage={hasPage} onLink={onLink} />
              : (
                <div className='text-ui-lg text-muted'>
                  <p className='mb-3'>This page is not part of the docs bundled with this app: <code className='font-mono'>{pageId}</code></p>
                  <Button size='sm' onClick={() => go({ page: getDocsHome() })}>Start page</Button>
                </div>
              )}
          </div>
        </div>
      </div>

      {(Object.keys(EDGE_CLASS) as Edge[]).map(edge => (
        <div key={edge} onPointerDown={onEdgeDown(edge)} className={cn('absolute z-10', EDGE_CLASS[edge])} />
      ))}
    </div>,
    document.body,
  );
}

function HeaderButton({ title, onClick, disabled, active, children }: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant='ghost'
      size='icon'
      title={title}
      aria-label={title}
      disabled={disabled}
      active={active}
      onClick={onClick}
      className='w-6 h-6 p-1 cursor-pointer'
    >
      {children}
    </Button>
  );
}

function SearchResults({ hits, selected, onPick, query }: {
  hits: DocSearchHit[];
  selected: number;
  onPick: (t: DocTarget) => void;
  query: string;
}) {
  if (!hits.length) {
    return <div className='px-3 py-2 text-ui-sm text-dim'>{query.trim().length < 2 ? 'Type two letters or more.' : 'Nothing matches.'}</div>;
  }
  return (
    <div>
      {hits.map((hit, i) => (
        <button
          key={`${hit.target.page}:${hit.target.line ?? 0}:${hit.label}`}
          type='button'
          onClick={() => onPick(hit.target)}
          className={cn('block w-full text-left px-3 py-1 hover:bg-control/60', i === selected && 'bg-selected/20')}
        >
          <div className='text-fg truncate'>{hit.label}</div>
          <div className='text-ui-xs text-dim truncate'>{hit.crumb}</div>
          {hit.snippet && <div className='text-ui-xs text-muted line-clamp-2'>{hit.snippet}</div>}
        </button>
      ))}
    </div>
  );
}

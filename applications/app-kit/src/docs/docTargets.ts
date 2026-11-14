import { useCallback, useRef } from 'react';
import { getDocIndex } from './docIndex';
import { DocFramesContext } from './DocScope';
import { breadcrumb, headingLine, resolveDocKey, resolveTerm, type DocEntry, type DocFrame } from './parseDocs';
import type { DocTarget } from './viewer/docsViewerStore';

// From a piece of the UI back to the docs that describe it: what Help > What's This? and F1 use.
//
// Three sources, most precise first:
//   1. elements registered here -- every docs hover-card trigger (useDocTooltip) and the rows of the
//      field widgets -- map straight to their entry;
//   2. an element's own name (aria-label, title, short text) looked up in the docs scope it sits in;
//   3. that scope itself: the enclosing Collapsable / Section heading, else the panel's page.
//
// The scope is React context (DocScope / DocRegion render no DOM), so it is read from the element's React
// fiber: the nearest DocFramesContext provider above it holds the whole frame chain. Walking fibers, not
// the DOM, also follows portals -- a modal's content sits under the DocScope that rendered it.

// ---------------------------------------------------------------------------------------------------
// The registry

const targets = new WeakMap<Element, () => DocEntry | null>();

/** Map an element to a docs entry (read lazily, so it is always the element's current one). */
export function registerDocTarget(el: Element, entry: () => DocEntry | null): void {
  targets.set(el, entry);
}

/**
 * A stable ref callback that registers its element for `entry`. For a widget's whole row (a Field's
 * label, a Toggle's button), so a click anywhere on it -- not only on the label text -- finds the row.
 */
export function useDocTargetRef<T extends Element>(entry: DocEntry | null): (el: T | null) => void {
  const latest = useRef(entry);
  latest.current = entry;
  return useCallback((el: T | null) => { if (el) registerDocTarget(el, () => latest.current); }, []);
}

// ---------------------------------------------------------------------------------------------------
// The hover card that is showing, for F1

let activeCard: DocEntry | null = null;

export function setActiveCardEntry(entry: DocEntry | null): void {
  activeCard = entry;
}

export function getActiveCardEntry(): DocEntry | null {
  return activeCard;
}

// ---------------------------------------------------------------------------------------------------
// What's This? mode flag (the overlay lives in whatsThis.tsx; cards read this to stay closed)

let inspecting = false;
const inspectListeners = new Set<() => void>();

export function isInspecting(): boolean {
  return inspecting;
}

export function setInspecting(on: boolean): void {
  if (inspecting === on) return;
  inspecting = on;
  for (const l of inspectListeners) l();
}

export function subscribeInspecting(listener: () => void): () => void {
  inspectListeners.add(listener);
  return () => { inspectListeners.delete(listener); };
}

// ---------------------------------------------------------------------------------------------------
// The docs scope of an element, from its React fiber

/** The part of a React fiber this reads. */
export interface FiberLike {
  type?: unknown;
  memoizedProps?: Record<string, unknown> | null;
  return?: FiberLike | null;
}

type ContextLike = { Provider?: unknown };

/**
 * The value of the nearest provider of `context` at or above `fiber`, or null. A provider fiber's `type`
 * is `context.Provider` in React 18 (an object whose `_context` is the context) and the context itself
 * in React 19; both are accepted. A consumer fiber also carries `_context` but has no `value` prop, so
 * the walk goes past it.
 */
export function framesFromFiber(fiber: FiberLike | null | undefined, context: ContextLike = DocFramesContext): DocFrame[] | null {
  for (let f = fiber; f; f = f.return) {
    const t = f.type as { _context?: unknown } | null | undefined;
    const isProvider = t !== null && t !== undefined && (t === context || t === context.Provider || t._context === context);
    if (isProvider && f.memoizedProps && 'value' in f.memoizedProps) return (f.memoizedProps.value as DocFrame[]) ?? null;
  }
  return null;
}

function fiberOf(el: Node | null): FiberLike | null {
  // Own keys only: React sets `__reactFiber$<id>` on the node itself, and a for-in would also walk the
  // hundreds of enumerable properties every DOM prototype carries.
  for (let n: Node | null = el; n; n = n.parentNode) {
    const key = Object.keys(n).find(k => k.startsWith('__reactFiber$'));
    if (key) return (n as unknown as Record<string, FiberLike>)[key];
  }
  return null;
}

/** The docs scope chain an element renders in, innermost first; empty outside every DocScope. */
export function reactFrames(el: Element): DocFrame[] {
  return framesFromFiber(fiberOf(el)) ?? [];
}

// ---------------------------------------------------------------------------------------------------
// Element -> docs

export interface ResolvedDoc {
  target: DocTarget;
  /** What the docs call it: the entry's label, the section heading or the page title. */
  label: string;
  /** Where that sits: "Rendering › Shadows". */
  crumb: string;
  /** The element to outline: the registered trigger or row, the named element, or the hovered one. */
  box: Element;
  /** True when the element itself has an entry; false for a fallback to its section or page. */
  exact: boolean;
  /** Which step found it: a registered element, the element's name, its scope, or nothing (`home`). */
  source: 'entry' | 'name' | 'scope' | 'home';
}

const NAME_LEVELS = 4;
const BOX_SELECTOR = 'button, a, input, select, textarea, label, tr, li, [role="button"], [role="tab"], [role="switch"], canvas';
const MAX_TEXT = 40;

/** Name candidates of an element: its aria-label, its title, then short visible text with a letter in it. */
function namesOf(el: Element): string[] {
  const out: string[] = [];
  const aria = el.getAttribute('aria-label');
  if (aria) out.push(aria);
  const title = el.getAttribute('title');
  if (title) out.push(title);
  if (el.childElementCount <= 3) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length >= 2 && text.length <= MAX_TEXT && /\p{L}/u.test(text)) out.push(text);
  }
  return out;
}

function fromEntry(entry: DocEntry, box: Element, source: ResolvedDoc['source']): ResolvedDoc {
  return {
    target: { page: entry.page, line: entry.line },
    label: entry.label,
    crumb: breadcrumb(getDocIndex(), entry),
    box,
    exact: source !== 'scope',
    source,
  };
}

function pageTitle(page: string): string {
  return getDocIndex().pages.get(page)?.title ?? page;
}

/**
 * The docs for a UI element: its own entry when it has one, else the section or page it sits in, else
 * `home` (the app's index page). Never null, so a click anywhere opens something.
 */
export function resolveElementDoc(el: Element, home: string): ResolvedDoc {
  const index = getDocIndex();

  // 1. A registered trigger or row, on the element or above it.
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
    const entry = targets.get(n)?.();
    if (entry) return fromEntry(entry, n, 'entry');
  }

  const frames = reactFrames(el);
  // What a fallback outlines: the control or row the pointer is on, not the glyph inside it.
  const box = el.closest(BOX_SELECTOR) ?? el;

  // 2. The element's name, looked up where it sits (an icon button's title, a tab's text). Outside every
  //    scope (a launcher, a home page) the app's own index page is where it would be described.
  const nameFrames: DocFrame[] = frames.length ? frames : index.pages.has(home) ? [{ page: home }] : [];
  if (nameFrames.length) {
    let n: Element | null = el;
    for (let level = 0; n && level < NAME_LEVELS; level++, n = n.parentElement) {
      for (const name of namesOf(n)) {
        const entry = resolveTerm(index, nameFrames, name, 'title');
        if (entry) return fromEntry(entry, n, 'name');
      }
    }
  }

  // 3. The innermost scope: its section's heading, else its page.
  const frame = frames[0];
  if (frame && index.pages.has(frame.page)) {
    if (frame.section !== undefined) {
      const entry = resolveDocKey(index, [], `${frame.page}#${frame.section}`);
      if (entry) return fromEntry(entry, box, 'scope');
      const line = headingLine(index, frame.page, frame.section);
      const heading = index.pages.get(frame.page)!.headings.find(h => h.anchor === frame.section);
      return { target: { page: frame.page, line }, label: heading?.text ?? pageTitle(frame.page), crumb: pageTitle(frame.page), box, exact: false, source: 'scope' };
    }
    return { target: { page: frame.page }, label: pageTitle(frame.page), crumb: pageTitle(frame.page), box, exact: false, source: 'scope' };
  }

  // 4. Nothing describes it: the app's own index page.
  return { target: { page: home }, label: pageTitle(home), crumb: pageTitle(home), box, exact: false, source: 'home' };
}

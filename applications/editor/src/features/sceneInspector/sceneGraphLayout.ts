// The Scene panel's data model, its filter, and the Graph view's layout.
//
// Pure: no React, no DOM, no engine nodes. The tree and the graph both read a NodeDescription snapshot
// built by SceneInspector, and the editor's node-env test suite can exercise everything here directly.

/** One row of the scene tree, as SceneInspector snapshots it from the engine. */
export interface NodeDescription {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  spawnOnStart: boolean;
  templateId?: string;
  scriptId?: string;
  children: NodeDescription[];
}

// --- filter -----------------------------------------------------------------------------------------

/** The one name test both views filter by. Case-blind and trimmed, as react-arborist trims its searchTerm. */
export const nameMatches = (name: string, term: string): boolean =>
  name.toLowerCase().includes(term.trim().toLowerCase());

/**
 * The tree as react-arborist shows it under a search term: every node whose name matches, plus that
 * node's ancestors for context. A match's own children are dropped unless they match too (arborist's
 * `flattenAndFilterTree`). An empty term returns `root` itself; `null` means nothing matches.
 */
export function filterSceneTree(root: NodeDescription, term: string): NodeDescription | null {
  if (!term.trim()) return root;
  const walk = (node: NodeDescription): NodeDescription | null => {
    const children = node.children.map(walk).filter((c): c is NodeDescription => c !== null);
    return children.length || nameMatches(node.name, term) ? { ...node, children } : null;
  };
  return walk(root);
}

// --- graph layout -----------------------------------------------------------------------------------

export const CARD_W = 160;
export const CARD_H = 28;
/** Between neighbouring columns under one parent. */
export const H_GAP = 16;
/** Between a parent's card and its children's row. The edges' bus runs at half this. */
export const V_GAP = 40;
/** Between cards stacked in one column. */
export const STACK_GAP = 6;
/** A stacked column sits this far right of its column's left edge; its trunk runs down the middle of it. */
export const STACK_INDENT = 16;

/** Where a dragged node would land relative to a card: as its previous sibling, its last child, or its next sibling. */
export type DropZone = 'before' | 'inside' | 'after';

export interface GraphCard {
  id: string;
  desc: NodeDescription;
  /** Top-left corner, in flow coordinates. */
  x: number;
  y: number;
  depth: number;
  /** Laid out in a column of childless siblings rather than side by side: its siblings are above and below it. */
  stacked: boolean;
  hasChildren: boolean;
  collapsed: boolean;
  /** Descendants hidden by collapsing this card (0 when open). */
  hiddenCount: number;
}

export interface GraphLink {
  id: string;
  source: string;
  target: string;
  /** `top` for a child laid out side by side, `left` for one in a stacked column. */
  targetHandle: 'top' | 'left';
}

export interface SceneGraphLayout {
  rootId: string;
  /** Pre-order: a parent before its children, siblings in their scene order. */
  cards: GraphCard[];
  links: GraphLink[];
  byId: Map<string, GraphCard>;
  parentOf: Map<string, string>;
  width: number;
  height: number;
}

type Column =
  | { kind: 'stack'; items: NodeDescription[]; width: number; height: number }
  | { kind: 'subtree'; node: NodeDescription; block: Block; width: number; height: number };

interface Block { width: number; height: number; columns: Column[]; columnsWidth: number }

const countDescendants = (node: NodeDescription): number =>
  node.children.reduce((n, child) => n + 1 + countDescendants(child), 0);

/**
 * A top-down tree that stays narrow enough for a side panel. Under each parent, its children are split
 * in scene order into columns: every child with children of its own is a column holding its subtree, and
 * each RUN of consecutive childless siblings stacks into a single column. So sibling order reads left to
 * right, then top to bottom, and a root with forty leaves is one column, not forty.
 *
 * A collapsed node lays out no children and counts as childless, so it can stack.
 */
export function layoutSceneGraph(root: NodeDescription, collapsed: ReadonlySet<string>): SceneGraphLayout {
  const shown = (node: NodeDescription) => (collapsed.has(node.id) ? [] : node.children);

  const measure = (node: NodeDescription): Block => {
    const columns: Column[] = [];
    let run: NodeDescription[] = [];
    const flush = () => {
      if (!run.length) return;
      columns.push({ kind: 'stack', items: run, width: STACK_INDENT + CARD_W, height: run.length * CARD_H + (run.length - 1) * STACK_GAP });
      run = [];
    };
    for (const child of shown(node)) {
      if (!shown(child).length) { run.push(child); continue; }
      flush();
      const block = measure(child);
      columns.push({ kind: 'subtree', node: child, block, width: block.width, height: block.height });
    }
    flush();
    const columnsWidth = columns.reduce((w, c) => w + c.width, 0) + Math.max(0, columns.length - 1) * H_GAP;
    const tallest = columns.reduce((h, c) => Math.max(h, c.height), 0);
    return {
      width: Math.max(CARD_W, columnsWidth),
      height: columns.length ? CARD_H + V_GAP + tallest : CARD_H,
      columns,
      columnsWidth,
    };
  };

  const cards: GraphCard[] = [];
  const links: GraphLink[] = [];
  const byId = new Map<string, GraphCard>();
  const parentOf = new Map<string, string>();

  const addCard = (desc: NodeDescription, x: number, y: number, depth: number, stacked: boolean) => {
    const isCollapsed = desc.children.length > 0 && collapsed.has(desc.id);
    const card: GraphCard = {
      id: desc.id, desc, x, y, depth, stacked,
      hasChildren: desc.children.length > 0,
      collapsed: isCollapsed,
      hiddenCount: isCollapsed ? countDescendants(desc) : 0,
    };
    cards.push(card);
    byId.set(card.id, card);
  };
  const link = (parent: NodeDescription, child: NodeDescription, targetHandle: GraphLink['targetHandle']) => {
    links.push({ id: `${parent.id}->${child.id}`, source: parent.id, target: child.id, targetHandle });
    parentOf.set(child.id, parent.id);
  };

  const place = (node: NodeDescription, block: Block, left: number, top: number, depth: number) => {
    // Centred over its columns (and its columns centred in the block), so a narrow parent of wide
    // children sits in the middle of them.
    addCard(node, left + block.width / 2 - CARD_W / 2, top, depth, false);
    let columnLeft = left + (block.width - block.columnsWidth) / 2;
    const childTop = top + CARD_H + V_GAP;
    for (const column of block.columns) {
      if (column.kind === 'stack') {
        column.items.forEach((item, i) => {
          link(node, item, 'left');
          addCard(item, columnLeft + STACK_INDENT, childTop + i * (CARD_H + STACK_GAP), depth + 1, true);
        });
      } else {
        link(node, column.node, 'top');
        place(column.node, column.block, columnLeft, childTop, depth + 1);
      }
      columnLeft += column.width + H_GAP;
    }
  };

  const block = measure(root);
  place(root, block, 0, 0, 0);
  return { rootId: root.id, cards, links, byId, parentOf, width: block.width, height: block.height };
}

/** The drop zone a pointer at `fraction` (0..1) along a card's sibling axis falls in: the outer quarters are between siblings. */
export const zoneAt = (fraction: number): DropZone => (fraction < 0.25 ? 'before' : fraction > 0.75 ? 'after' : 'inside');

export type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * Arrow-key navigation in the graph: the card nearest `fromId` in that direction, measured between card
 * centres (all cards are one size, so corners do), with sideways distance weighing double so ArrowDown
 * prefers the card below over one far across. Cards within ~63° of the arrow come first, so ArrowRight
 * from a parent reaches its neighbour rather than its own stacked child just below and to the right; only
 * when nothing lies in that cone (a parent far above a wide row of children) is anything ahead accepted.
 */
export function nearestInDirection(cards: readonly GraphCard[], fromId: string, dir: Direction): string | null {
  const from = cards.find(c => c.id === fromId);
  if (!from) return null;
  const [ax, ay] = dir === 'up' ? [0, -1] : dir === 'down' ? [0, 1] : dir === 'left' ? [-1, 0] : [1, 0];
  const pick = (cone: boolean): string | null => {
    let best: string | null = null;
    let bestScore = Infinity;
    for (const card of cards) {
      if (card === from) continue;
      const dx = card.x - from.x, dy = card.y - from.y;
      const along = dx * ax + dy * ay;
      const across = Math.abs(dx * ay - dy * ax);
      if (along <= 0 || (cone && across > 2 * along)) continue;
      const score = along + 2 * across;
      if (score < bestScore) { bestScore = score; best = card.id; }
    }
    return best;
  };
  return pick(true) ?? pick(false);
}

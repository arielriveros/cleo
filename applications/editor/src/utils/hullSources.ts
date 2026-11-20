// Which meshes a convex hull is built from: a hull shape's `sources`, and the picker that edits them.
//
// A source is a path of node names from the hull's fit source (the Collider, or the node a meshless Trigger is
// under -- see shapeFitSource): 'Body', 'Vehicle/Wheels/Wheel FL'. A path takes the node and everything under
// it; a path ending in '/.' takes that node's own mesh alone ('.' the fit source's own). No `sources` at all is
// every mesh, as a hull has always been. Paths, not ids: they survive placing a template and regenerating ids.
// Pure: the tree comes from editorHelpers' hullSourceTree.

/** One node of a fit source's tree that holds a mesh a hull can take, or leads to one. Depth first. */
export interface HullSourceEntry {
  /** Names from the fit source, '/'-joined; '' is the fit source itself. */
  path: string;
  name: string;
  /** 0 for the fit source. */
  depth: number;
  /** It holds a mesh of its own a hull can take (not only ones under it). */
  mesh: boolean;
}

/** Whether the mesh at `path` is one `sources` take. */
export function inHullSources(path: string, sources?: readonly string[]): boolean {
  if (!sources) return true;
  for (const s of sources) {
    if (s === '.') { if (path === '') return true; continue; }
    if (s.endsWith('/.')) { if (path === s.slice(0, -2)) return true; continue; }
    if (path === s || path.startsWith(s + '/')) return true;
  }
  return false;
}

/** The entries under entry `i` in the tree, itself included: its index range, end exclusive. */
function subtree(tree: readonly HullSourceEntry[], i: number): [number, number] {
  let end = i + 1;
  while (end < tree.length && tree[end].depth > tree[i].depth) end++;
  return [i, end];
}

/** The paths of the meshes `sources` take, of those the tree has. */
export function includedMeshes(tree: readonly HullSourceEntry[], sources?: readonly string[]): Set<string> {
  return new Set(tree.filter(e => e.mesh && inHullSources(e.path, sources)).map(e => e.path));
}

/** Whether all, some or none of the meshes under entry `i` (its own included) are in `included`. */
export function hullEntryState(tree: readonly HullSourceEntry[], i: number, included: ReadonlySet<string>): 'all' | 'some' | 'none' {
  const [from, to] = subtree(tree, i);
  let on = 0, all = 0;
  for (let k = from; k < to; k++) if (tree[k].mesh) { all++; if (included.has(tree[k].path)) on++; }
  return on === 0 ? 'none' : on === all ? 'all' : 'some';
}

/** `included` with every mesh under entry `i` switched on, or off when they all already were. */
export function toggleHullEntry(tree: readonly HullSourceEntry[], i: number, included: ReadonlySet<string>): Set<string> {
  const next = new Set(included);
  const on = hullEntryState(tree, i, included) !== 'all';
  const [from, to] = subtree(tree, i);
  for (let k = from; k < to; k++) if (tree[k].mesh) { if (on) next.add(tree[k].path); else next.delete(tree[k].path); }
  return next;
}

/**
 * The `sources` that take exactly the meshes in `included`, as few paths as can say it: a node whose meshes are
 * all in is its path alone. Undefined when they are all in (every mesh, the default); empty when none are.
 */
export function hullSourcesFor(tree: readonly HullSourceEntry[], included: ReadonlySet<string>): string[] | undefined {
  if (tree.length === 0) return [];
  if (hullEntryState(tree, 0, included) === 'all') return undefined;
  const out: string[] = [];
  const walk = (i: number) => {
    const state = hullEntryState(tree, i, included);
    if (state === 'none') return;
    // (Never the fit source itself: all of it in is no sources at all, above.)
    if (state === 'all') { out.push(tree[i].path); return; }
    if (tree[i].mesh && included.has(tree[i].path)) out.push(tree[i].path === '' ? '.' : tree[i].path + '/.');
    const [, to] = subtree(tree, i);
    for (let k = i + 1; k < to; k = subtree(tree, k)[1]) walk(k);
  };
  walk(0);
  return out;
}

import { engineEventBus } from '../eventBus';

/**
 * The asset reference graph: one directed graph of "asset A references asset B through field F", with a
 * reverse index and monotonic per-asset revisions.
 *
 * DELIBERATELY KIND-AGNOSTIC. A node is `{ kind: string; id: string }` and nothing here knows what a
 * material or a tileset is — `src/` has no asset-library concept at all, and must not grow one. The host
 * (the editor) owns the per-kind readers that turn an asset record into edges and feeds them in through
 * {@link AssetGraph.setEdges}. That is the same module-level injection shape `registerTemplates` and
 * `registerFoliageSourceResolver` already use for a cross-cutting dependency the engine cannot own.
 *
 * WHY A GRAPH RATHER THAN THE SETS WE HAD. The project already computed "which texture ids are used
 * anywhere" a dozen times over, as flat `Set<string>`s. A set can answer "is this orphaned"; it cannot
 * answer "who references it", "through which field", or "what else breaks if I change it" — and the last
 * one is what propagation needs. The edge's `field` is exactly the attribution those walks threw away.
 *
 * A published game never populates this, so it costs nothing at runtime.
 */

/** An asset's identity. `kind` is opaque to this module; the host defines the vocabulary. */
export interface AssetRef {
  kind: string;
  id: string;
}

/** `${kind}:${id}` — unique across kinds, which matters because an image and a texture share an id. */
export type AssetKey = string;

export function assetKey(kind: string, id: string): AssetKey {
  return `${kind}:${id}`;
}

export function refKey(ref: AssetRef): AssetKey {
  return assetKey(ref.kind, ref.id);
}

/**
 * One outgoing reference.
 *
 * `field` names where the reference physically lives — `__materialId`, `textures.baseTexture`,
 * `lods[1].modelId`, `animationIds[]`. It is not decoration: it is what turns "something uses this" into
 * a diagnosis, both in the reference viewer and in the delete-confirmation dialog.
 */
export interface AssetEdge {
  from: AssetKey;
  to: AssetKey;
  field: string;
}

/** What {@link AssetGraph.setEdges} is given: a target plus the field the reference sits in. */
export interface EdgeTarget {
  to: AssetRef;
  field: string;
}

export class AssetGraph {
  /** key -> its outgoing edges. Also the node table: a key present here has been declared. */
  private _out = new Map<AssetKey, AssetEdge[]>();
  /**
   * key -> the edges pointing AT it. Holds the SAME edge objects as `_out`, never copies, so the two
   * indices cannot describe different graphs.
   */
  private _in = new Map<AssetKey, AssetEdge[]>();
  /**
   * Identity for every key ever mentioned — declared nodes AND edge targets that were never declared.
   * Kept so a key never has to be parsed back into a ref: an id may itself contain a colon (a texture id
   * is a user-facing name), and splitting on the first one would be a silent corruption.
   */
  private _refs = new Map<AssetKey, AssetRef>();
  private _revisions = new Map<AssetKey, number>();

  /**
   * Replace ALL outgoing edges of one node, and declare it as existing.
   *
   * The only write path — there is deliberately no incremental `addEdge`. An extractor re-reads a whole
   * asset and produces its whole edge list, so a reference the user REMOVED has to disappear; with an
   * incremental API that removal is invisible and the stale edge lives forever.
   */
  setEdges(ref: AssetRef, targets: EdgeTarget[]): void {
    const key = refKey(ref);
    this._refs.set(key, ref);

    // Unlink the previous targets FIRST. Doing it after would drop a self-edge that survives the update,
    // since the unlink filters `_in` by `from`.
    this._unlinkOutgoing(key);

    const edges: AssetEdge[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      if (!target || !target.to || !target.to.id) continue;
      const to = refKey(target.to);
      // The same target through the same field twice is one edge; through two DIFFERENT fields it is two,
      // because a material reading one texture in both its albedo and its emissive slot is two references.
      const dedupe = `${to}:${target.field}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      this._refs.set(to, target.to);
      const edge: AssetEdge = { from: key, to, field: target.field };
      edges.push(edge);
      const incoming = this._in.get(to);
      if (incoming) incoming.push(edge);
      else this._in.set(to, [edge]);
    }

    this._out.set(key, edges);
  }

  /**
   * Forget a node and its outgoing edges.
   *
   * Its INCOMING edges are deliberately left in place: an asset that was deleted while something still
   * referenced it is precisely the broken-reference case {@link dangling} exists to surface. Silently
   * dropping those edges would hide the defect rather than report it.
   *
   * The revision is kept too, so a consumer holding an old revision still sees a change if an asset is
   * deleted and one with the same id is imported back.
   */
  removeNode(ref: AssetRef): void {
    const key = refKey(ref);
    this._unlinkOutgoing(key);
    this._out.delete(key);
  }

  /** True when the asset has been declared — as opposed to merely being pointed at by a dangling edge. */
  has(key: AssetKey): boolean {
    return this._out.has(key);
  }

  /** The identity behind a key, for any key the graph has seen. */
  refOf(key: AssetKey): AssetRef | undefined {
    return this._refs.get(key);
  }

  /** Every declared node, in insertion order. */
  keys(): AssetKey[] {
    return [...this._out.keys()];
  }

  /** What this asset references. A copy — callers must not be able to corrupt the index. */
  outgoing(key: AssetKey): AssetEdge[] {
    const edges = this._out.get(key);
    return edges ? [...edges] : [];
  }

  /** What references this asset. The reverse index, maintained by {@link setEdges}. */
  incoming(key: AssetKey): AssetEdge[] {
    const edges = this._in.get(key);
    return edges ? [...edges] : [];
  }

  /** Everything this asset transitively references, nearest first. Excludes `key` itself. */
  dependencies(key: AssetKey, maxDepth = Infinity): AssetKey[] {
    return this._walk(key, maxDepth, (k) => {
      const edges = this._out.get(k);
      return edges ? edges.map((e) => e.to) : [];
    });
  }

  /** Everything that transitively references this asset, nearest first. Excludes `key` itself. */
  dependents(key: AssetKey, maxDepth = Infinity): AssetKey[] {
    return this._walk(key, maxDepth, (k) => {
      const edges = this._in.get(k);
      return edges ? edges.map((e) => e.from) : [];
    });
  }

  /**
   * Edges whose target was never declared — a reference pointing at an asset that does not exist.
   *
   * Free, given the edge table, and it is a defect class nothing in the project could previously see: the
   * explorer's audit finds assets missing from the EXPLORER, which is the opposite direction.
   */
  dangling(): AssetEdge[] {
    const out: AssetEdge[] = [];
    for (const edges of this._out.values())
      for (const edge of edges) if (!this._out.has(edge.to)) out.push(edge);
    return out;
  }

  /**
   * How many times this asset (or anything it depends on) has changed.
   *
   * A monotonic counter, NOT a content hash, mirroring `Model.geometryVersion` /
   * `ModelNode._initializedGeometry`: a consumer stores the number it last saw and compares. Hashing here
   * would mean walking a model's vertex buffers on every library change, and the graph is asked this
   * question far more often than an asset actually changes.
   */
  revisionOf(key: AssetKey): number {
    return this._revisions.get(key) ?? 0;
  }

  /**
   * Mark an asset changed: bump its revision and that of every asset transitively depending on it, then
   * announce the whole set as ONE `ASSET_CHANGED`.
   *
   * This is the propagation the feature exists for — changing a texture bumps the material reading it and
   * the model embedding that material, without anyone having written that hop by hand.
   *
   * Returns every asset whose revision moved, origin first.
   */
  touch(ref: AssetRef): AssetRef[] {
    const key = refKey(ref);
    this._refs.set(key, ref);

    const affected: AssetRef[] = [ref];
    this._revisions.set(key, this.revisionOf(key) + 1);
    for (const dependent of this.dependents(key)) {
      this._revisions.set(dependent, this.revisionOf(dependent) + 1);
      affected.push(this._refs.get(dependent) ?? { kind: '', id: dependent });
    }

    // One dispatch for the whole cascade rather than one per node: a listener that cares about a single
    // asset can filter, and a listener that repaints wants to do it once.
    engineEventBus.emit('ASSET_CHANGED', { origin: ref, affected });
    return affected;
  }

  /** Drop every node, edge and revision. For a project switch. */
  clear(): void {
    this._out.clear();
    this._in.clear();
    this._refs.clear();
    this._revisions.clear();
  }

  /** Remove `key`'s outgoing edges from its targets' incoming lists. */
  private _unlinkOutgoing(key: AssetKey): void {
    const previous = this._out.get(key);
    if (!previous) return;
    for (const edge of previous) {
      const incoming = this._in.get(edge.to);
      if (!incoming) continue;
      const next = incoming.filter((e) => e.from !== key);
      if (next.length) this._in.set(edge.to, next);
      else this._in.delete(edge.to);
    }
  }

  /**
   * Breadth-first walk over one direction, cycle-safe.
   *
   * The visited set is not optional: a cycle is reachable in practice — a template whose subtree embeds a
   * node referencing that same template — and without it this hangs the editor rather than misreporting.
   */
  private _walk(start: AssetKey, maxDepth: number, next: (key: AssetKey) => AssetKey[]): AssetKey[] {
    if (maxDepth < 1) return [];
    const seen = new Set<AssetKey>([start]);
    const out: AssetKey[] = [];
    let frontier = [start];
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const following: AssetKey[] = [];
      for (const key of frontier) {
        for (const neighbour of next(key)) {
          if (seen.has(neighbour)) continue;
          seen.add(neighbour);
          out.push(neighbour);
          following.push(neighbour);
        }
      }
      frontier = following;
    }
    return out;
  }
}

/**
 * The process-wide graph, and the single source of truth for cross-asset references.
 *
 * A singleton for the same reason `TextureManager` and `engineEventBus` are: every consumer must be
 * looking at the same edges, and threading one through the editor's context tree would mean every module
 * that wants to ask "what uses this" takes a parameter it has no other use for.
 */
export const assetGraph = new AssetGraph();

import { brushFalloffWeight } from "../../terrain/brushFalloff";
import { parseSkinnedCloth, type SkinnedClothData } from "./skinnedClothData";

/**
 * Painting a skinned model's cloth weights (AnimatedModel.skinnedCloth): the pure half of the editor's
 * Cloth brush. Weights live here as one float per mesh vertex — 0 skinned, up to 1 free — and are
 * converted to and from the stored, sparse form.
 *
 * Every operation paints a vertex's TWINS with it (the other vertices at its position: a UV seam, a
 * hard edge), because the simulation welds them into one particle. Painting one and not its twin is what
 * opens a crack as the cloth swings.
 */

/** The simulation settings a painted cloth carries besides its weights. */
export type ClothSettings = Omit<SkinnedClothData, 'vertices' | 'weights' | 'backstops'>;

export const DEFAULT_CLOTH_SETTINGS: ClothSettings = {
    maxDistance: 0.3, stiffness: 1, bend: 0.2, damping: 0.5, mass: 2, gravityScale: 1.3,
    thickness: 0.012, windResponse: 0.5, backstop: 0.02, substeps: 10,
};

/** Weights at or below this are not stored: the vertex stays skinned. */
export const UNPAINTED = 0.001;

/** A model's stored cloth as one weight per vertex (0 where not listed). */
export function weightsFromCloth(cloth: SkinnedClothData | null | undefined, vertexCount: number): Float32Array {
    const out = new Float32Array(vertexCount);
    if (!cloth) return out;
    cloth.vertices.forEach((v, i) => { if (v < vertexCount) out[v] = cloth.weights[i]; });
    return out;
}

/**
 * Per-vertex weights (and settings) back to the stored form: a NEW object every time — the runtime
 * rebuilds its simulation when the object changes (ModelNode.stepSkinnedCloth). Null when nothing is painted.
 * Per-vertex backstops are not kept: a painted cloth uses the uniform `backstop`.
 */
export function clothFromWeights(weights: Float32Array, settings: ClothSettings): SkinnedClothData | null {
    const vertices: number[] = [], w: number[] = [];
    for (let v = 0; v < weights.length; v++) {
        if (weights[v] <= UNPAINTED) continue;
        vertices.push(v);
        w.push(Math.round(Math.min(1, weights[v]) * 1000) / 1000);
    }
    if (!vertices.length) return null;
    const { colliders, ...rest } = settings;
    return parseSkinnedCloth({ ...rest, vertices, weights: w, ...(colliders?.length ? { colliders } : {}) });
}

/** The settings of a stored cloth (or the defaults), without its weights. */
export function settingsOf(cloth: SkinnedClothData | null | undefined): ClothSettings {
    if (!cloth) return { ...DEFAULT_CLOTH_SETTINGS };
    const { vertices: _v, weights: _w, backstops: _b, ...rest } = cloth;
    return { ...DEFAULT_CLOTH_SETTINGS, ...rest };
}

/** Each vertex's twins: `twins[v]` lists every vertex at v's position, v included. */
export function twinsOf(positions: ArrayLike<number>): number[][] {
    const n = positions.length / 3;
    const byKey = new Map<string, number[]>();
    const key = (v: number) => `${Math.round(positions[v * 3] * 1e4)},${Math.round(positions[v * 3 + 1] * 1e4)},${Math.round(positions[v * 3 + 2] * 1e4)}`;
    for (let v = 0; v < n; v++) {
        const k = key(v);
        let list = byKey.get(k);
        if (!list) byKey.set(k, list = []);
        list.push(v);
    }
    const out: number[][] = new Array(n);
    for (const list of byKey.values()) for (const v of list) out[v] = list;
    return out;
}

/** Each vertex's neighbours along the mesh's edges (welded: a twin's neighbours are its own). */
export function neighboursOf(indices: ArrayLike<number>, twins: number[][]): Set<number>[] {
    const out: Set<number>[] = Array.from({ length: twins.length }, () => new Set<number>());
    for (let t = 0; t + 2 < indices.length; t += 3) {
        const tri = [indices[t], indices[t + 1], indices[t + 2]];
        for (let e = 0; e < 3; e++) {
            const a = tri[e], b = tri[(e + 1) % 3];
            for (const x of twins[a]) for (const y of twins[b]) { out[x].add(y); out[y].add(x); }
        }
    }
    return out;
}

export type ClothBrushMode = 'paint' | 'erase' | 'smooth';

export interface ClothDab {
    /** Brush centre, in the mesh's own (bind) space. */
    center: [number, number, number];
    /** Brush radius, mesh space. */
    radius: number;
    /** 0..1: how far one dab moves a weight toward its goal. */
    strength: number;
    /** 0..1: the edge softness (see brushFalloffWeight). */
    falloff: number;
    mode: ClothBrushMode;
    /** The weight `paint` lays down (erase goes to 0). */
    value: number;
}

/**
 * Apply one dab to `weights` in place. Returns the vertices it changed (for an overlay to redraw).
 * `neighbours` is only read by `smooth`.
 */
export function brushDab(positions: ArrayLike<number>, weights: Float32Array, twins: number[][], dab: ClothDab,
                         neighbours: Set<number>[] | null = null): number[] {
    const [cx, cy, cz] = dab.center;
    const r2 = dab.radius * dab.radius;
    const changed: number[] = [];
    const before = dab.mode === 'smooth' ? Float32Array.from(weights) : null;
    for (let v = 0; v < weights.length; v++) {
        if (twins[v][0] !== v) continue;   // once per position: its twins follow
        const dx = positions[v * 3] - cx, dy = positions[v * 3 + 1] - cy, dz = positions[v * 3 + 2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const k = Math.min(1, Math.max(0, dab.strength)) * brushFalloffWeight(Math.sqrt(d2) / dab.radius, dab.falloff);
        if (k <= 0) continue;
        let goal: number;
        if (dab.mode === 'erase') goal = 0;
        else if (dab.mode === 'paint') goal = Math.min(1, Math.max(0, dab.value));
        else {
            const ring = neighbours?.[v];
            if (!ring || ring.size === 0) continue;
            let sum = 0;
            for (const u of ring) sum += before![u];
            goal = sum / ring.size;
        }
        const next = weights[v] + (goal - weights[v]) * k;
        if (Math.abs(next - weights[v]) < 1e-6) continue;
        for (const t of twins[v]) { weights[t] = next; changed.push(t); }
    }
    return changed;
}

/**
 * Set every vertex of the welded, connected piece containing `seed` to `value`, and return them.
 * `indices` may be restricted to one submesh's range (`start`, `count`) to keep a fill inside a material.
 */
export function fillPiece(indices: ArrayLike<number>, twins: number[][], weights: Float32Array, seed: number, value: number,
                          start = 0, count = indices.length): number[] {
    const adjacency = new Map<number, number[]>();
    const link = (a: number, b: number) => { let l = adjacency.get(a); if (!l) adjacency.set(a, l = []); l.push(b); };
    for (let t = start; t + 2 < start + count; t += 3) {
        const a = indices[t], b = indices[t + 1], c = indices[t + 2];
        link(a, b); link(b, a); link(b, c); link(c, b); link(a, c); link(c, a);
    }
    const seen = new Set<number>();
    const stack = [...twins[seed]];
    for (const s of stack) seen.add(s);
    while (stack.length) {
        const v = stack.pop()!;
        for (const u of [...(adjacency.get(v) ?? []), ...twins[v]]) if (!seen.has(u)) { seen.add(u); stack.push(u); }
    }
    const out = [...seen];
    for (const v of out) weights[v] = value;
    return out;
}

/** Set every vertex of the triangles `[start, start + count)` (a material's submesh) to `value`. */
export function fillRange(indices: ArrayLike<number>, twins: number[][], weights: Float32Array, start: number, count: number, value: number): number[] {
    const out = new Set<number>();
    for (let t = start; t < start + count; t++) for (const v of twins[indices[t]]) out.add(v);
    for (const v of out) weights[v] = value;
    return [...out];
}

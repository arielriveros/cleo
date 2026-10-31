import { mat4, quat, vec3 } from 'gl-matrix';
import type { Buffer as RhiBuffer } from '../graphics/rhi/resources';
import { Geometry } from '../core/geometry';
import { Model } from '../graphics/model';
import type { Mesh } from '../graphics/mesh';
import {
    Material, TerrainFoliageRule, FoliageCollision, foliageRuleKey, applyWind, windConfigOf,
    FOLIAGE_DENSITY_UNIT, DEFAULT_FOLIAGE_DENSITY,
} from '../graphics/material';
import type { FoliageOrientation } from '../graphics/material';
import { parseOctahedralInfo, type OctahedralImpostorInfo } from './octahedralImpostor';

export type FoliageKind = 'mesh' | 'billboard';

export interface FoliageParams {
    /** Blades/props per SQUARE METRE — the brush multiplies it by the disc area, whole-terrain
     *  generation by the terrain area, so the same number means the same look at any scale. */
    density: number;
    minScale: number;
    maxScale: number;
}

const DEFAULT_PARAMS: FoliageParams = { density: DEFAULT_FOLIAGE_DENSITY.billboard, minScale: 0.8, maxScale: 1.4 };
export const MAX_INSTANCES = 200000;

/**
 * Squared distance at which a cell should be culled, given whether it is currently drawn.
 *
 * The foliage distance cull is a step function: the frame a cell crosses it, the whole cell's instance
 * count appears (or vanishes) at once. Undamped, a cell parked on the boundary flips every frame on
 * sub-metre camera jitter and pays that cost repeatedly. The band is asymmetric in the cheap direction —
 * appear at the threshold, disappear only past `threshold × hysteresis` — so the expensive transition
 * (coming in) happens at the authored distance and the free one is what gets delayed.
 *
 * Lives here rather than in the renderer so it can be tested without a GL context; the per-cell LOD band
 * a few lines below its call site has used the same ×0.9 shape all along.
 */
export function foliageCullLimitSq(maxD2: number, wasVisible: boolean, hysteresis: number): number {
    if (!isFinite(maxD2)) return maxD2;
    return wasVisible ? maxD2 * hysteresis * hysteresis : maxD2;
}

/**
 * The distance a layer is drawn to.
 *
 * An explicit cull (the model asset's) wins. Otherwise a MESH layer is drawn past its own last band —
 * half as far again beyond where its impostor (or last LOD level) takes over — and never less than the
 * scene's foliage distance. Before, "no cull set" meant the scene's 65 m, while generated LOD bands
 * start at ~8x the model's diameter: a 10 m pine's LOD1 began at 80 m and its impostor at 320 m, so
 * only LOD0 ever drew and every tree vanished at 65 m without becoming its impostor.
 *
 * Grass (billboard layers) keeps the scene distance. 0 or less = unlimited.
 */
export function foliageEffectiveCull(
    layer: { kind: FoliageKind; cullDistance: number; levels: readonly { distance: number }[];
             billboardModel: unknown; billboardDistance: number },
    sceneDistance: number,
): number {
    if (layer.cullDistance > 0) return layer.cullDistance;
    if (!(sceneDistance > 0)) return 0;
    if (layer.kind !== 'mesh') return sceneDistance;
    let lastBand = 0;
    if (layer.billboardModel && Number.isFinite(layer.billboardDistance) && layer.billboardDistance > 0)
        lastBand = layer.billboardDistance;
    else if (layer.levels.length > 1)
        lastBand = layer.levels[layer.levels.length - 1].distance;
    return lastBand > 0 ? Math.max(sceneDistance, lastBand * 1.5) : sceneDistance;
}

/** Width of the dithered crossfade around a band edge at `distance`: 10% of it, at least 3 m. */
export function foliageFadeWidth(distance: number): number {
    return Math.max(3, distance * 0.1);
}

/**
 * Where one draw bucket fades in and out, in metres from the camera, per INSTANCE (see
 * chunks/instancedVertex.wgsl). `in*`: the ramp over which it appears, as the previous level dissolves;
 * `out*`: the ramp over which it dissolves into the next level, or into nothing at the cull distance.
 * An empty ramp (start == end) means no fade on that side. `lo..hi` is the range a cell must overlap
 * to be drawn in the bucket at all.
 */
export interface FoliageBand { inStart: number; inEnd: number; outStart: number; outEnd: number; lo: number; hi: number }

/**
 * The band of every bucket of `layer` (levels, then the impostor at index `levels.length`), or null for
 * a bucket that is never drawn (a level that starts beyond the impostor or the cull). Adjacent buckets
 * share their ramp exactly — one's fade-out IS the next one's fade-in — so with complementary dither the
 * two always cover a pixel exactly once and a level change never shows a hole or a double image.
 */
export function foliageLodBands(
    layer: { levels: readonly { distance: number }[]; billboardModel: unknown; billboardDistance: number },
    cull: number,
): (FoliageBand | null)[] {
    const far = cull > 0 ? cull : Infinity;
    const impostor = !!layer.billboardModel && Number.isFinite(layer.billboardDistance);
    const impostorAt = impostor ? Math.max(0, layer.billboardDistance) : Infinity;
    const starts: { slot: number; start: number }[] = [];
    layer.levels.forEach((l, i) => {
        const start = i === 0 ? 0 : Math.max(0, l.distance);
        if (start < impostorAt && start < far) starts.push({ slot: i, start });
    });
    if (impostor && impostorAt < far) starts.push({ slot: layer.levels.length, start: impostorAt });
    starts.sort((a, b) => a.start - b.start);

    const out: (FoliageBand | null)[] = new Array(layer.levels.length + 1).fill(null);
    for (let k = 0; k < starts.length; k++) {
        const { slot, start } = starts[k];
        const inW = k === 0 || start <= 0 ? 0 : foliageFadeWidth(start);
        const next = k + 1 < starts.length ? starts[k + 1].start : far;
        const outW = Number.isFinite(next) ? foliageFadeWidth(next) : 0;
        const band: FoliageBand = {
            inStart: start - inW, inEnd: start,
            outStart: Number.isFinite(next) ? next - outW : 0, outEnd: Number.isFinite(next) ? next : 0,
            lo: start - inW, hi: Number.isFinite(next) ? next : Infinity,
        };
        out[slot] = band;
    }
    return out;
}

/**
 * How many newly-visible cells to admit this frame, from `pending.length` waiting.
 *
 * `firstSight` — no cell of the layer was up last frame — means a scene load or the camera arriving at a
 * new landscape. Budgeting there would not smooth a spike, it would fade the whole layer in over a
 * second, so everything is admitted at once and the load cost is paid as it always was. The budget is for
 * the steady state, where a moving camera crosses a few cell boundaries at a time.
 */
export function foliageAdmitCount(pendingCount: number, budget: number, firstSight: boolean): number {
    if (firstSight || budget <= 0) return pendingCount;
    return Math.min(budget, pendingCount);
}

/** Shared empty scratch, so a layer that has never packed anything holds no buffer of its own. */
const EMPTY_SCRATCH = new Float32Array(0);

/**
 * Triangles one merged foliage draw may submit before it is split in two.
 *
 * Merging removed the only thing that used to bound a foliage submission: one draw per spatial cell
 * meant ~a cell's worth of instances each, and a driver could preempt between them. Merged, a whole
 * layer can land in ONE `drawElementsInstanced` — and `generateFoliageEverywhere` followed by a
 * layer's "first sight" (which skips the admission budget on purpose) makes every cell visible on the
 * same frame. A heavy prototype at that scale is seconds of GPU work in a single submission, which is
 * a TDR timeout and a removed device, not a slow frame.
 *
 * The budget is on TRIANGLES rather than instances because that is what the cost actually tracks: the
 * same instance count is trivial for a grass card and ruinous for a 200k-triangle tree.
 */
export const FOLIAGE_DRAW_TRIANGLE_BUDGET = 4_000_000;

/** Ceiling regardless of how light the prototype is, so a grass field is not one colossal draw. */
export const FOLIAGE_DRAW_MAX_INSTANCES = 8192;

/**
 * Floor, so a very heavy prototype still batches. Below this the split costs more than it saves, and
 * the per-cell drawing this replaced averaged about this many instances per call anyway — so a
 * capped merged draw is never worse than what it replaced.
 */
export const FOLIAGE_DRAW_MIN_INSTANCES = 8;

/**
 * How much of a detail level's instances survive, per level away from the base.
 *
 * Density scaling, as an open-world renderer does it: LOD reduces the cost of ONE instance, this
 * reduces how many there are. Neither alone bounds a scatter — density and cull distance can still
 * ask for hundreds of millions of triangles, and nothing downstream refuses.
 *
 * 1.0 disables it entirely and every instance draws, which is exactly what happened before this existed.
 */
export const FOLIAGE_DENSITY_FALLOFF = 0.75;

/** Never thin past this, however many levels deep: a band that keeps a quarter already reads as thinner. */
export const FOLIAGE_DENSITY_FLOOR = 0.25;

/**
 * Fraction of each cell's instances a draw bucket keeps.
 *
 * Two properties matter more than the curve. It is **monotonically non-increasing** with distance, and
 * `packFoliageInstances` takes a PREFIX — so the set a far band draws is a strict subset of the set a
 * near band draws. An instance that thinned out at one distance cannot pop back in at a greater one,
 * which is the artefact that makes naive density scaling unusable.
 *
 * The impostor bucket inherits the last mesh level's fraction rather than returning to 1.0. Cards are
 * nearly free, so keeping them all would cost little — but it would also mean trees reappearing as
 * the camera backs away, which reads as a bug however cheap it is.
 */
export function foliageKeepFraction(bucket: number, levelCount: number, falloff: number,
                                    kind: FoliageKind = 'billboard'): number {
    // Mesh props are never thinned. Dropping a quarter of a cell's TREES the frame it changes level is a
    // pop nobody can miss — LOD already makes a distant tree cheap. Thinning is a fill-rate tool for grass.
    if (kind === 'mesh') return 1;
    if (!(falloff > 0) || falloff >= 1) return 1;
    // Bucket `levelCount` is the impostor; clamp it onto the last mesh level.
    const level = Math.max(0, Math.min(bucket, levelCount - 1));
    return Math.max(FOLIAGE_DENSITY_FLOOR, Math.pow(falloff, level));
}

/** Instances one draw may carry, given the triangle count of a single instance of the prototype. */
export function foliageChunkLimit(trianglesPerInstance: number): number {
    if (!(trianglesPerInstance > 0)) return FOLIAGE_DRAW_MAX_INSTANCES;
    const byTriangles = Math.floor(FOLIAGE_DRAW_TRIANGLE_BUDGET / trianglesPerInstance);
    return Math.max(FOLIAGE_DRAW_MIN_INSTANCES, Math.min(FOLIAGE_DRAW_MAX_INSTANCES, byTriangles));
}

/**
 * Where to cut `cells` into runs whose instance totals stay within `limit`. Returns the END index of
 * each run, so run k is `cells[out[k-1] .. out[k])`.
 *
 * A cell is never split: its matrices are contiguous and a draw cannot start part-way into an instance
 * buffer without a base-instance offset, which WebGL2 does not have. So a single cell larger than the
 * limit goes alone and overshoots, which is the honest outcome — the fix for that is a smaller cell
 * size, not a smaller draw.
 */
export function foliageChunkBounds(cells: readonly FoliageCell[], limit: number, out: number[]): number[] {
    out.length = 0;
    const cap = Math.max(1, limit);
    let running = 0;
    for (let i = 0; i < cells.length; i++) {
        // Break BEFORE adding, and only when the run already has something in it.
        if (running > 0 && running + cells[i].count > cap) { out.push(i); running = 0; }
        running += cells[i].count;
    }
    if (cells.length > 0) out.push(cells.length);
    return out;
}

/**
 * One draw bucket's instances, merged into a single GPU buffer.
 *
 * Foliage used to issue one instanced draw PER SPATIAL CELL per prototype sub-model, and again per
 * shadow cascade — draw count proportional to terrain area, which is what a 241 ms CPU frame against
 * a 48 ms GPU looks like. Every one of those draws also landed on its own VAO, because the WebGL2 VAO
 * cache keys on the instance buffer and each cell had a different one.
 *
 * Merging is the shape an engine with instanced-static-mesh components uses: the visible cells of one
 * detail level go into one buffer and are drawn once per sub-model. Cells stay the unit of CULLING —
 * only the unit of SUBMISSION changes.
 */
export interface FoliageBatch {
    /** Merged per-instance matrices. Renderer-owned: allocated, resized and destroyed by the renderer. */
    buffer: RhiBuffer | null;
    /** Instances currently in `buffer`. */
    count: number;
    /** The keep-fraction this pack was made with; a changed density setting has to repack. */
    keep: number;
    /**
     * Instances `buffer` has ROOM for, which is >= `count`.
     *
     * Kept so a changed cell set is a sub-write into existing storage rather than a fresh allocation.
     * `bufferData` re-specifies the whole buffer, and doing that every frame a camera crosses a cell
     * boundary makes the driver rename a multi-megabyte resource per frame; growth is rare, writes are
     * not. Grows with slack so a set that oscillates by a cell does not reallocate on every crossing.
     */
    capacity: number;
    /** Cell indices packed, in order. Grow-only; only the first `cellCount` entries are live. */
    cells: Int32Array;
    cellCount: number;
    /** The `layer.version` this pack was made from; a rebuild moved the instances underneath it. */
    version: number;
}

export function createFoliageBatch(): FoliageBatch {
    return { buffer: null, count: 0, capacity: 0, keep: 1, cells: new Int32Array(0), cellCount: 0, version: -1 };
}

/**
 * Whether `batch` still describes exactly `cells` at `version`.
 *
 * Compared element-wise rather than hashed on purpose: the sets are cell-sized (tens to hundreds), so
 * the two cost the same, and a hash collision here would silently draw last frame's instances until
 * the visible set happened to change again — a bug that would look like corrupted placement.
 *
 * The cull hysteresis and the admission budget are what make this pay: a parked camera produces the
 * same list every frame, so a parked camera repacks and uploads nothing at all.
 */
export function foliageBatchStale(batch: FoliageBatch, cells: readonly FoliageCell[], version: number,
                                  keep: number): boolean {
    if (batch.version !== version || batch.cellCount !== cells.length || batch.keep !== keep) return true;
    for (let i = 0; i < cells.length; i++) if (batch.cells[i] !== cells[i].index) return true;
    return false;
}

/**
 * Total instances across `cells` once `keep` has thinned them — the length the merged buffer needs.
 *
 * `ceil`, so a cell never thins to nothing: a lone tree on a hilltop is exactly the instance whose
 * disappearance would be noticed.
 */
export function foliageBatchInstances(cells: readonly FoliageCell[], keep: number = 1): number {
    let n = 0;
    for (const c of cells) n += keep >= 1 ? c.count : Math.min(c.count, Math.ceil(c.count * keep));
    return n;
}

/**
 * Copy every cell's matrices into `out` back to back. Returns the instance count written.
 *
 * `out` must hold `foliageBatchInstances(cells) * 16` floats. A cell's matrices are already packed and
 * static — baked once in `_rebuild` — so this is a run of memcpys, not per-instance maths.
 */
export function packFoliageInstances(cells: readonly FoliageCell[], out: Float32Array,
                                     keep: number = 1): number {
    let at = 0;
    for (const c of cells) {
        // A PREFIX, never a sample: instances were scattered in random order, so the first N are already
        // a spatially even subset, and prefixes NEST. That nesting is what stops an instance dropped at
        // one detail level from reappearing at a coarser one.
        const take = keep >= 1 ? c.count : Math.min(c.count, Math.ceil(c.count * keep));
        const floats = take * 16;
        out.set(c.matrices.subarray(0, floats), at);
        at += floats;
    }
    return at / 16;
}

/** Record which cells a batch now holds, so the next frame can skip an identical repack. */
export function rememberFoliageBatch(batch: FoliageBatch, cells: readonly FoliageCell[], version: number,
                                     keep: number): void {
    if (batch.cells.length < cells.length) batch.cells = new Int32Array(cells.length);
    for (let i = 0; i < cells.length; i++) batch.cells[i] = cells[i].index;
    batch.cellCount = cells.length;
    batch.version = version;
    batch.keep = keep;
}

/**
 * GPU buffers left behind by layers disposed with their terrain. The renderer's foliage pass only walks
 * LIVE landscapes, so this queue is the only way those buffers still reach a `destroy()`.
 */
const ORPHANED_FOLIAGE_BUFFERS: RhiBuffer[] = [];

/** Drain the buffers of disposed foliage layers. Called by the renderer, which owns the GL context. */
export function collectOrphanedFoliageBuffers(): RhiBuffer[] {
    if (ORPHANED_FOLIAGE_BUFFERS.length === 0) return [];
    return ORPHANED_FOLIAGE_BUFFERS.splice(0, ORPHANED_FOLIAGE_BUFFERS.length);
}

/**
 * Prototype meshes of disposed layers. The same story as ORPHANED_FOLIAGE_BUFFERS, for the other half
 * of a layer's GPU footprint: `_applyMeshPrototype` replaces `levels`/`billboardModel` wholesale, and
 * a dropped JS reference frees no VBO, IBO or VAO.
 */
const ORPHANED_FOLIAGE_MESHES: Mesh[] = [];

/** Drain the prototype meshes of disposed foliage layers. Called by the renderer. */
export function collectOrphanedFoliageMeshes(): Mesh[] {
    if (ORPHANED_FOLIAGE_MESHES.length === 0) return [];
    return ORPHANED_FOLIAGE_MESHES.splice(0, ORPHANED_FOLIAGE_MESHES.length);
}

/**
 * A spatial-grid cell of a foliage layer: the packed instance matrices whose XZ position falls in it,
 * plus a cached world-space AABB for frustum/distance culling. Each cell owns a static GPU buffer,
 * lazily created by the renderer's foliage pass.
 */
export interface FoliageCell {
    matrices: Float32Array;              // packed mat4s for this cell (16 floats/instance)
    count: number;
    indices: Int32Array;                 // instance indices in this cell (see forEachInstanceNear)
    min: [number, number, number];       // world AABB (instance extents, expanded by geometry size)
    max: [number, number, number];
    /**
     * Bounds of the instance ORIGINS alone (no geometry padding). What the per-instance LOD crossfade
     * measures a cell's distance span with: the padded box is loose by a whole tree height, which would
     * put every cell near a band edge into three buckets instead of two.
     */
    pmin: [number, number, number];
    pmax: [number, number, number];
    /**
     * Position in `layer.cells`, assigned by `_rebuild`. The identity a packed batch is keyed on, so
     * the renderer can tell "the same cells as last frame" from "a different set" without hashing.
     */
    index: number;
    lod: number;                          // current detail level (renderer-owned hysteresis memory)
    /**
     * Was this cell drawn last frame? Renderer-owned, like `lod`.
     *
     * Two jobs, both about the DISTANCE CULL being a step function. It is the state the cull's hysteresis
     * band tests against, so a cell hovering on the boundary cannot flip in and out on sub-metre camera
     * jitter; and it is how the renderer tells a cell that is merely still visible from one that is
     * newly visible and therefore subject to the per-frame admission budget.
     */
    visible: boolean;
    /** Scratch for {@link sortFoliageFrontToBack}: the cell's distance ring from the sort eye. */
    ring?: number;
    /**
     * Renderer-owned: whether the cell cast a shadow last frame, for the hysteresis on the foliage shadow
     * distance (a cell on the boundary must not flicker its shadow on sub-metre camera motion).
     */
    shadowCast?: boolean;
}

/** Metres per distance ring in the front-to-back foliage order. */
export const FOLIAGE_SORT_RING = 8;
/** How far the camera moves before the front-to-back order is re-derived. */
export const FOLIAGE_SORT_REFRESH = 4;

/**
 * Order a bucket's cells nearest first, so the trees in front fill the depth buffer before the ones behind
 * them are rasterized and those fail the early depth test instead of being shaded and overwritten.
 *
 * By RING (`ringSize` metres of distance from `eye`), and stably: cells in one ring keep their grid order.
 * A batch is repacked whenever its cell order changes (foliageBatchStale compares element-wise), so the
 * order must not churn on every small camera move — the caller holds `eye` still until the camera has
 * moved FOLIAGE_SORT_REFRESH metres, and coarse rings mean a cell rarely changes rank even then.
 */
export function sortFoliageFrontToBack(cells: FoliageCell[], eye: ArrayLike<number>, ringSize = FOLIAGE_SORT_RING): void {
    if (cells.length < 2) return;
    for (const c of cells) {
        const x = (c.pmin[0] + c.pmax[0]) / 2 - eye[0];
        const y = (c.pmin[1] + c.pmax[1]) / 2 - eye[1];
        const z = (c.pmin[2] + c.pmax[2]) / 2 - eye[2];
        c.ring = Math.floor(Math.sqrt(x * x + y * y + z * z) / ringSize);
    }
    cells.sort((a, b) => (a.ring! - b.ring!) || (a.index - b.index));
}

/** One detail level of a mesh foliage layer: the sub-mesh models drawn per instance (transforms baked
 *  into the geometry editor-side) and the camera distance at which the level takes over. */
export interface FoliageLodLevel {
    models: Model[];
    distance: number;                     // levels[0].distance is always 0
}

/**
 * Build a two-quad crossed billboard (an "X"), base at y=0, UV 0..1, up-facing normals. Unit-sized by
 * default, which is the BILLBOARD layer contract: per-instance scale is then the tuft height in metres.
 * A mesh layer's impostor passes the prototype's authored footprint instead (`_applyMeshPrototype`).
 */
export function crossQuadGeometry(width: number = 1, height: number = 1): Geometry {
    const hw = width * 0.5;
    const positions: [number, number, number][] = [
        [-hw, 0, 0], [hw, 0, 0], [hw, height, 0], [-hw, height, 0],
        [0, 0, -hw], [0, 0, hw], [0, height, hw], [0, height, -hw],
    ];
    const normals: [number, number, number][] = positions.map(() => [0, 1, 0]);
    const uvs: [number, number][] = [
        [0, 0], [1, 0], [1, 1], [0, 1],
        [0, 0], [1, 0], [1, 1], [0, 1],
    ];
    const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
    return new Geometry(positions, normals, uvs, [], [], indices);
}

/**
 * The card an OCTAHEDRAL impostor draws on: one quad over the captured sphere, facing +Z in the
 * prototype's own space — a sensible flat stand-in for anything that draws it as ordinary geometry (the
 * overdraw view). The impostor program ignores the positions: it rebuilds the quad facing the camera from
 * the uv, corner (0, 0) at the top left (geometryFoliageImpostor.wgsl).
 */
export function octahedralQuadGeometry(info: OctahedralImpostorInfo): Geometry {
    const [cx, cy, cz] = info.center, r = info.radius;
    const positions: [number, number, number][] = [
        [cx - r, cy - r, cz], [cx + r, cy - r, cz], [cx + r, cy + r, cz], [cx - r, cy + r, cz],
    ];
    const normals: [number, number, number][] = positions.map(() => [0, 0, 1]);
    const uvs: [number, number][] = [[0, 1], [1, 1], [1, 0], [0, 0]];
    return new Geometry(positions, normals, uvs, [], [], [0, 1, 2, 0, 2, 3]);
}

/**
 * One GPU-instanced foliage layer for a terrain: either a scattered mesh prop (trees/rocks) or a textured
 * cross-quad billboard (grass). Stores compact per-instance data (position + yaw + uniform scale), bucketed
 * into a spatial grid of {@link FoliageCell}s; the renderer's foliage pass draws each visible cell (culling
 * off-screen/far ones) in its own instanced call.
 */
export class FoliageLayer {
    public readonly kind: FoliageKind;
    /**
     * Display name. Mutable, and what exclude lists match on — so it is not this layer's identity.
     * A rename follows the rule; see `key`.
     */
    public name: string;
    /**
     * Stable identity, the map key `Terrain._foliageByKey` files this layer under.
     *
     * Separate from `name` because a rename used to orphan a populated layer: the terrain looked the
     * layer up by the rule's new name, missed, and built a second one — leaving the scattered instances
     * drawn by a layer nothing could reach, and which `pruneFoliage` would not collect because it was
     * not empty. Defaults to the name so a layer with no rule behind it behaves exactly as before.
     */
    public key: string;
    /** The primary model — always levels[0].models[0]. */
    public model: Model;
    public textureId: string | null;
    public params: FoliageParams;

    // Detail levels (mesh layers; billboard layers always have exactly one). Per-cell selection happens
    // in the renderer's foliage pass, by the same distance bands a mesh asset's LodGroup uses.
    public levels: FoliageLodLevel[];
    // Optional impostor: past this distance instances draw as textured cross-quads (the farthest LOD).
    public billboardModel: Model | null = null;
    public billboardTextureId: string | null = null;
    public billboardDistance = Infinity;
    /**
     * Set when the impostor is OCTAHEDRAL (terrain/octahedralImpostor.ts): `billboardTextureId` is then an
     * N x N atlas of views, `billboardNormalTextureId` its normals, and `billboardModel` one camera-facing
     * quad instead of the crossed card. Null for the classic single-view card.
     */
    public billboardOctahedral: OctahedralImpostorInfo | null = null;
    public billboardNormalTextureId: string | null = null;

    /**
     * The leaf translucency the far octahedral impostor carries: the highest
     * `translucency` among the materials of the coarsest mesh level — the one the impostor replaces — so
     * a back-lit crown keeps its glow across the hand-off. Derived, never serialized. The impostor atlas
     * mixes trunk and leaves under this one value; at impostor distance the trunk is a few pixels.
     */
    public get farTranslucency(): number {
        const level = this.levels[this.levels.length - 1];
        let t = 0;
        for (const model of level?.models ?? [])
            for (const m of model.materials) t = Math.max(t, (m.properties.get('translucency') as number | undefined) ?? 0);
        return t;
    }
    /** Hide instances beyond this camera distance; 0 = use the renderer's global foliage cull distance. */
    public cullDistance = 0;
    /**
     * Whether these instances rasterize into the shadow cascades. Off by default: switching it on adds
     * one instanced draw per cell PER CASCADE. This flag drives the shadow pass directly — the impostor
     * materials stay authored `castShadow: false` for the colour pass.
     */
    public castShadows = false;
    /** See `TerrainFoliageRule.cameraDither`: the camera rig's see-through hole may cut these instances. */
    public cameraDither = false;
    /**
     * How a mesh instance stands (see `TerrainFoliageRule.orientation`): upright, tilted to the ground's
     * normal, or at a random orientation. Applied when the instance matrices are built -- the stored
     * record stays [x, y, z, yaw, scale], so changing it never re-scatters anything.
     */
    public orientation: FoliageOrientation = 'up';
    /** The ground's normal at a world x/z, supplied by the terrain that holds this layer. */
    private _normalSampler: ((x: number, z: number) => ArrayLike<number>) | null = null;
    /** Static physics proxy for nearby instances, or null for non-collidable foliage. Mirrored from the
     *  rule onto the LAYER, since a published build rebuilds layers from the serialized foliage blob
     *  without re-parsing terrain materials. */
    public collision: FoliageCollision | null = null;

    // Compact instance data, stride 5: [x, y, z, yaw, scale].
    private _instances: number[] = [];
    public count = 0;
    public version = 0;

    /**
     * Merged instance buffers by DRAW BUCKET: index i is detail level i, and `levels.length` is the
     * billboard impostor. Each bucket holds a LIST, because a bucket is split into chunks small enough
     * to keep one submission bounded — see {@link foliageChunkLimit}. Renderer-owned, like
     * `cell.visible` and `cell.lod`; the layer only holds them so they can be freed with it.
     */
    public batches: FoliageBatch[][] = [];
    /** The same, one per shadow cascade: a cascade sees a different set of cells from the camera. */
    public shadowBatches: FoliageBatch[][] = [];
    /**
     * The cells selected for each colour bucket this frame, parallel to {@link batches}.
     *
     * Renderer-owned frame state. It lives here rather than in a per-frame Map because the CULL that
     * fills it and the PASS that draws from it are deliberately separated: every instance upload has to
     * happen while no render pass is open (see `Renderer._packFoliageBatch`), so the selection runs in
     * the frame prologue and the pass only binds and draws what it finds here.
     */
    public buckets: FoliageCell[][] = [];
    /**
     * Renderer-owned: the colour buckets' draw segments when the GPU culled this layer this frame
     * (graphics/foliageGpuCulling.ts), and whether it did — the draw reads these instead of {@link batches}.
     */
    public gpuBatches: FoliageBatch[][] = [];
    public gpuCulled = false;
    /** Renderer-owned: the eye the front-to-back cell order was last derived from (sortFoliageFrontToBack). */
    public sortEye: [number, number, number] | null = null;
    /**
     * CPU staging for whichever batch is being packed. Shared across buckets and grow-only: both
     * backends COPY on upload, so it is free the moment `reallocateBuffer` returns.
     */
    public batchScratch: Float32Array = EMPTY_SCRATCH;

    // Spatial grid over the instances (world XZ), rebuilt on scatter/erase. Cell world-unit size:
    // larger = fewer draw calls but looser culling.
    public cells: FoliageCell[] = [];
    /**
     * Grid cell size for culling and instance bucketing.
     *
     * MUST match the renderer's `_foliageCellSize`. The renderer reconciles any mismatch on its first
     * frame (`layer.cellSize !== this._foliageCellSize` -> `setCellSize`), and that call is a full
     * `_rebuild()` over every instance plus a re-upload of every cell buffer — so a default that differs
     * buys a guaranteed hitch on the first frame after every scene load. `deserialize` restores the
     * stored value for the same reason.
     */
    public cellSize = 13;

    // Whether the (static) per-vertex mesh + VAO have been uploaded (set by the renderer's foliage pass).
    public initialized = false;

    // Prototype meshes orphaned by a prototype swap, drained + disposed by the renderer.
    //
    // Meshes, not raw buffers: a Mesh owns a VAO and several buffers and knows how to release them. Before this queue existed, every refresh leaked the whole
    // outgoing LOD chain — which mattered little when the only trigger was a manual re-sync, and
    // matters now that a model or material save re-derives automatically.
    private _retiredMeshes: Mesh[] = [];

    // Set by pushInstance(); commit() rebuilds once for a whole batch.
    private _dirty = false;

    private _q = quat.create();
    private _m = mat4.create();
    private readonly _tilt = quat.create();
    private readonly _n = vec3.create();

    constructor(kind: FoliageKind, name: string, model: Model, textureId: string | null, params?: Partial<FoliageParams>) {
        this.kind = kind;
        this.name = name;
        this.key = name;   // callers that build from a rule overwrite this with foliageRuleKey(rule)
        this.model = model;
        this.textureId = textureId;
        this.params = { ...DEFAULT_PARAMS, ...params };
        this.levels = [{ models: [model], distance: 0 }];
    }

    public static Billboard(name: string, textureId: string, params?: Partial<FoliageParams>): FoliageLayer {
        const material = Material.Basic({ color: [1, 1, 1], texture: textureId }, { side: 'double', castShadow: false });
        return new FoliageLayer('billboard', name, new Model(crossQuadGeometry(), material), textureId, params);
    }

    public static Mesh(name: string, model: Model, params?: Partial<FoliageParams>): FoliageLayer {
        return new FoliageLayer('mesh', name, model, null, params);
    }

    /** Build a runtime layer from a terrain-material foliage rule (billboard texture or mesh model,
     *  optionally with LOD levels, a billboard impostor and a cull distance). */
    public static fromRule(rule: TerrainFoliageRule): FoliageLayer {
        const params: Partial<FoliageParams> = {};
        if (rule.density !== undefined) params.density = rule.density;
        if (rule.minScale !== undefined) params.minScale = rule.minScale;
        if (rule.maxScale !== undefined) params.maxScale = rule.maxScale;
        if (rule.kind === 'billboard') {
            const bb = FoliageLayer.Billboard(rule.name, rule.textureId || 'Null', params);
            bb.key = foliageRuleKey(rule);
            bb.collision = rule.collision ?? null;
            bb.castShadows = !!rule.castShadows;
            // Must be read here as well as in `_applyMeshPrototype`, or a billboard rule's cull distance
            // is dropped and the layer falls back to the renderer's global.
            bb.cullDistance = Math.max(0, Number(rule.cullDistance) || 0);
            bb._applyBillboardWind(rule);
            return bb;
        }
        const base = (rule.models?.length ? rule.models[0] : rule.model);
        const layer = FoliageLayer.Mesh(rule.name, Model.parse(base), params);
        layer.key = foliageRuleKey(rule);
        layer._applyMeshPrototype(rule);
        return layer;
    }

    /** (Re-)derive the mesh prototypes (LOD level models, billboard impostor, cull distance) from a rule
     *  or serialized-layer payload. `src.models`/`src.lods` hold flattened Model.serialize() JSON;
     *  legacy single-`model` payloads still load (one level, no impostor). */
    private _applyMeshPrototype(src: any): void {
        if (this.kind !== 'mesh') return;
        this.setOrientation(parseFoliageOrientation(src.orientation));
        const baseModels: any[] | null = src.models?.length ? src.models : (src.model ? [src.model] : null);
        // Levels are only rebuilt when the payload carries a base — appending `lods` to levels that were
        // kept from before would duplicate them on every refresh.
        if (baseModels) {
            this._retireMeshes(this.levels.flatMap(l => l.models));
            this.levels = [{ models: baseModels.map((m: any) => Model.parse(m)), distance: 0 }];
            if (Array.isArray(src.lods)) {
                for (const l of src.lods)
                    if (l?.models?.length)
                        this.levels.push({ models: l.models.map((m: any) => Model.parse(m)), distance: Math.max(0, Number(l.distance) || 0) });
            }
        }
        this.model = this.levels[0].models[0];
        if (src.billboard?.textureId) {
            const material = Material.Basic({ color: [1, 1, 1], texture: src.billboard.textureId }, { side: 'double', castShadow: false });
            // Octahedral only with BOTH atlases: without its normals it would light as a black card.
            const octahedral = parseOctahedralInfo(src.billboard.octahedral);
            const normalId: string | null = typeof src.billboard.textures?.normal === 'string' ? src.billboard.textures.normal : null;
            if (this.billboardModel) this._retireMeshes([this.billboardModel]);
            if (octahedral && normalId) {
                this.billboardModel = new Model(octahedralQuadGeometry(octahedral), material);
                this.billboardOctahedral = octahedral;
                this.billboardNormalTextureId = normalId;
            } else {
                // Sized to the prototype it replaces, NOT 1x1: an instance scale MULTIPLIES the authored size
                // on the mesh but IS the size in metres on a unit quad, so a unit card would not match.
                const [w, h] = this._prototypeFootprint();
                this.billboardModel = new Model(crossQuadGeometry(w, h), material);
                this.billboardOctahedral = null;
                this.billboardNormalTextureId = null;
            }
            this.billboardTextureId = src.billboard.textureId;
            this.billboardDistance = Math.max(0, Number(src.billboard.distance) || 0);
        } else {
            if (this.billboardModel) this._retireMeshes([this.billboardModel]);
            this.billboardModel = null;
            this.billboardTextureId = null;
            this.billboardDistance = Infinity;
            this.billboardOctahedral = null;
            this.billboardNormalTextureId = null;
        }
        this.cullDistance = Math.max(0, Number(src.cullDistance) || 0);
        this.collision = src.collision ?? null;
        this.castShadows = !!src.castShadows;
        this.cameraDither = !!src.cameraDither;
        this.initialized = false; // new Model objects — the foliage pass re-uploads their meshes
    }

    /**
     * Authored width and height of LOD0, in the prototype's own space — the box the impostor must match.
     * Width is the LARGER horizontal extent.
     */
    private _prototypeFootprint(): [number, number] {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const model of this.levels[0]?.models ?? []) {
            const bb = model.geometry.boundingBox;
            minX = Math.min(minX, bb.min[0]); maxX = Math.max(maxX, bb.max[0]);
            minY = Math.min(minY, bb.min[1]); maxY = Math.max(maxY, bb.max[1]);
            minZ = Math.min(minZ, bb.min[2]); maxZ = Math.max(maxZ, bb.max[2]);
        }
        const w = Math.max(maxX - minX, maxZ - minZ);
        const h = maxY - minY;
        // A degenerate or empty prototype falls back to the unit quad rather than collapsing the card.
        return [Number.isFinite(w) && w > 1e-4 ? w : 1, Number.isFinite(h) && h > 1e-4 ? h : 1];
    }

    /**
     * Swap this layer's prototypes for an updated rule WITHOUT touching the scattered instances (used
     * when the source mesh asset, its material, or the terrain material was edited).
     *
     * Instance matrices carry only position, yaw and scale — a prototype's own transform is baked into
     * its vertices editor-side — so a geometry or material edit cannot invalidate one. That is what
     * lets hand-painted placement survive an edit, and it is why this refreshes cell EXTENTS rather
     * than rebuilding: the AABBs pad by the prototype's size, so only they depend on the new geometry.
     *
     * `density` is the one field this cannot absorb, because it decides how many instances should
     * exist rather than what they look like. It is reported back instead; the caller owns the choice
     * to re-scatter, since that is the one operation here that discards the user's placement.
     */
    /** A billboard layer's wind lives on its card's material, where the renderer reads every layer's. */
    private _applyBillboardWind(src: { windStrength?: number; windStiffness?: number; windFlutter?: number }): void {
        if (this.kind !== 'billboard') return;
        // A tuft is all canopy and no trunk: any flutter makes it move like leaves rather than rigidly.
        const flutter = Math.max(0, Number(src.windFlutter) || 0);
        applyWind(this.model.material, {
            windStrength: src.windStrength ?? 0, windStiffness: src.windStiffness ?? 1,
            windRole: flutter > 0 ? 'leaves' : 'plant', windFlutter: flutter,
        });
    }

    public setPrototype(rule: TerrainFoliageRule): { densityChanged: boolean } {
        const prevDensity = this.params.density;
        const prevMin = this.params.minScale, prevMax = this.params.maxScale;
        if (rule.density !== undefined) this.params.density = rule.density;
        if (rule.minScale !== undefined) this.params.minScale = rule.minScale;
        if (rule.maxScale !== undefined) this.params.maxScale = rule.maxScale;
        this.castShadows = !!rule.castShadows;

        // A scale RANGE change is different from every other field here: per-instance scale really is
        // baked into the matrices. Re-rolling it in place keeps each instance's position and yaw, so
        // the pattern is untouched while the plants take their new sizes.
        const scaleChanged = this.params.minScale !== prevMin || this.params.maxScale !== prevMax;

        if (this.kind === 'billboard') {
            this.collision = rule.collision ?? null;
            this.cullDistance = Math.max(0, Number(rule.cullDistance) || 0);
            const tex = rule.textureId || 'Null';
            if (tex !== this.textureId) {
                this.textureId = tex;
                const material = Material.Basic({ color: [1, 1, 1], texture: tex }, { side: 'double', castShadow: false });
                this._retireMeshes(this.levels.flatMap(l => l.models));
                this.model = new Model(crossQuadGeometry(), material);
                this.levels = [{ models: [this.model], distance: 0 }];
                this.initialized = false;
            }
            // A billboard's card is a unit quad, so its geometry extent never changes — but
            // `_instanceExtent` multiplies by `params.maxScale`, which just might have. This branch
            // used to return without refreshing anything, leaving the cell AABBs too tight and
            // culling tall tufts at the screen edge.
            this._applyBillboardWind(rule);
            if (scaleChanged) this._rerollScales();
            else this._refreshExtents();
            return { densityChanged: this.params.density !== prevDensity };
        }

        this._applyMeshPrototype(rule);
        if (scaleChanged) this._rerollScales();
        else this._refreshExtents();
        return { densityChanged: this.params.density !== prevDensity };
    }

    /** Queue prototype meshes for the renderer to dispose. Safe on models never uploaded. */
    private _retireMeshes(models: Model[]): void {
        for (const m of models) if (m.mesh) this._retiredMeshes.push(m.mesh);
    }

    /** Prototype meshes orphaned by a prototype swap; the renderer disposes these. Returns and clears. */
    public collectRetiredMeshes(): Mesh[] {
        const m = this._retiredMeshes;
        this._retiredMeshes = [];
        return m;
    }

    /**
     * Re-pad every cell's AABB against the current prototype, touching nothing else.
     *
     * The cheap half of `_rebuild`. A prototype swap does not move an instance, so re-bucketing them,
     * reallocating every matrix array and bumping `version` — which forces the renderer to re-upload
     * every cell's buffer — is all work whose result is identical to what was already there. Only the
     * extent padding actually depends on the new geometry.
     *
     * `cell.lod` MUST be reset when the level count or the impostor changes: the renderer indexes the
     * billboard bucket at `layer.levels.length`, so a cell remembering a level that no longer exists
     * would select past the end. `_rebuild` got this for free by allocating fresh cells.
     */
    private _refreshExtents(): void {
        const extent = this._instanceExtent();
        const buckets = this.levels.length + (this.billboardModel ? 1 : 0);
        for (const c of this.cells) {
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let j = 0; j < c.indices.length; j++) {
                const b = c.indices[j] * 5;
                const x = this._instances[b], y = this._instances[b + 1], z = this._instances[b + 2];
                if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
                if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
            }
            c.min = [minX - extent, minY - extent, minZ - extent];
            c.max = [maxX + extent, maxY + extent, maxZ + extent];
            c.pmin = [minX, minY, minZ];
            c.pmax = [maxX, maxY, maxZ];
            if (c.lod >= buckets) c.lod = 0;
        }
    }

    /**
     * Draw a fresh scale for every instance from the current range, keeping position and yaw.
     *
     * The narrow case where instance data genuinely has to change without the layout changing: scale
     * IS in the matrix. Re-scattering would achieve the same visual result and throw the placement
     * away with it.
     */
    private _rerollScales(): void {
        const { minScale, maxScale } = this.params;
        for (let i = 0; i < this._instances.length; i += 5)
            this._instances[i + 4] = minScale + Math.random() * (maxScale - minScale);
        this._rebuild();
    }

    /** Append one instance at an exact position without rebuilding: `yaw` (radians) and `scale` as given,
     *  else random (scale from the params' range). Call {@link commit} once after a batch of pushes.
     *  Returns false when the instance ceiling is reached, so callers can report the clipping instead of
     *  silently dropping the request. */
    public pushInstance(x: number, y: number, z: number, yaw?: number, scale?: number): boolean {
        if (this._instances.length / 5 >= MAX_INSTANCES) return false;
        yaw ??= Math.random() * Math.PI * 2;
        scale ??= this.params.minScale + Math.random() * (this.params.maxScale - this.params.minScale);
        this._instances.push(x, y, z, yaw, scale);
        this._dirty = true;
        return true;
    }

    /** Rebuild the spatial grid if any instances were pushed since the last commit. */
    public commit(): boolean {
        if (!this._dirty) return false;
        this._dirty = false;
        this._rebuild();
        return true;
    }

    /** Remove all instances (used before regenerating foliage across the whole terrain). */
    public clear(): void {
        // Must be reset before the early return below, or the next commit() pays a redundant _rebuild().
        this._dirty = false;
        if (this._instances.length === 0) return;
        this._instances = [];
        this._rebuild();
    }

    /** Release this layer's GPU buffers (queued for the renderer to delete) and drop its instances. */
    public dispose(): void {
        for (const list of [...this.batches, ...this.shadowBatches])
            for (const b of list ?? [])
                if (b?.buffer) ORPHANED_FOLIAGE_BUFFERS.push(b.buffer);
        this.batches = [];
        this.shadowBatches = [];
        this.buckets = [];
        this.batchScratch = EMPTY_SCRATCH;
        // Prototype meshes too: the renderer's foliage pass only walks LIVE landscapes, so once this
        // layer is off a terrain nothing else can reach them.
        this._retireMeshes(this.levels.flatMap(l => l.models));
        if (this.billboardModel) this._retireMeshes([this.billboardModel]);
        for (const m of this._retiredMeshes) ORPHANED_FOLIAGE_MESHES.push(m);
        this._retiredMeshes = [];
        this.cells = [];
        this._instances = [];
        this._dirty = false;
        this.count = 0;
        this.initialized = false;
        this.version++;
    }

    /** Scatter new instances within the brush disc; Y is sampled from the terrain surface. */
    public scatter(worldX: number, worldZ: number, radius: number, sampleHeight: (x: number, z: number) => number): boolean {
        if (this.count >= MAX_INSTANCES) return false;
        // density is per m², so the disc area sets the count.
        const n = Math.max(1, Math.round(this.params.density * Math.PI * radius * radius));
        let added = 0;
        for (let i = 0; i < n && this.count + added < MAX_INSTANCES; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * radius;
            const x = worldX + Math.cos(a) * r;
            const z = worldZ + Math.sin(a) * r;
            const y = sampleHeight(x, z);
            const yaw = Math.random() * Math.PI * 2;
            const scale = this.params.minScale + Math.random() * (this.params.maxScale - this.params.minScale);
            this._instances.push(x, y, z, yaw, scale);
            added++;
        }
        if (added > 0) { this._rebuild(); return true; }
        return false;
    }

    /** Remove instances whose base is within `radius` of the brush point. */
    public erase(worldX: number, worldZ: number, radius: number): boolean {
        const r2 = radius * radius;
        const kept: number[] = [];
        let removed = 0;
        for (let i = 0; i < this._instances.length; i += 5) {
            const dx = this._instances[i] - worldX, dz = this._instances[i + 2] - worldZ;
            if (dx * dx + dz * dz <= r2) { removed++; continue; }
            kept.push(this._instances[i], this._instances[i + 1], this._instances[i + 2], this._instances[i + 3], this._instances[i + 4]);
        }
        if (removed === 0) return false;
        this._instances = kept;
        this._rebuild();
        return true;
    }

    /**
     * Re-sample every instance's Y from `sampleHeight`, keeping x/z, yaw and scale.
     *
     * Instance Y is baked at scatter time, so anything that replaces the ground wholesale — a heightmap
     * import — leaves the foliage floating or buried until it is re-seated. Returns whether any instance
     * moved.
     */
    public reseat(sampleHeight: (x: number, z: number) => number): boolean {
        let moved = false;
        for (let i = 0; i < this._instances.length; i += 5) {
            const y = sampleHeight(this._instances[i], this._instances[i + 2]);
            if (y !== this._instances[i + 1]) { this._instances[i + 1] = y; moved = true; }
        }
        if (moved) this._rebuild();
        return moved;
    }

    /** Change the spatial-grid cell size (world units) and re-bucket the instances. No-op if unchanged. */
    public setCellSize(size: number): void {
        if (size > 0 && size !== this.cellSize) {
            this.cellSize = size;
            this._rebuild();
        }
    }

    /**
     * Visit every instance whose base falls within `radius` of world (x, z). `index` is only stable until
     * the next rebuild (any scatter/erase/clear); consumers that cache it must watch {@link version}.
     */
    public forEachInstanceNear(
        x: number, z: number, radius: number,
        cb: (index: number, ix: number, iy: number, iz: number, yaw: number, scale: number) => void,
    ): void {
        const r2 = radius * radius;
        for (const cell of this.cells) {
            // Cheap AABB reject on XZ (the cell's Y extent is irrelevant to a horizontal radius query).
            const dx = x < cell.min[0] ? cell.min[0] - x : x > cell.max[0] ? x - cell.max[0] : 0;
            const dz = z < cell.min[2] ? cell.min[2] - z : z > cell.max[2] ? z - cell.max[2] : 0;
            if (dx * dx + dz * dz > r2) continue;
            for (let j = 0; j < cell.indices.length; j++) {
                const i = cell.indices[j];
                const b = i * 5;
                const ex = this._instances[b] - x, ez = this._instances[b + 2] - z;
                if (ex * ex + ez * ez > r2) continue;
                cb(i, this._instances[b], this._instances[b + 1], this._instances[b + 2],
                    this._instances[b + 3], this._instances[b + 4]);
            }
        }
    }

    /** Read one instance into `out` = [x, y, z, yaw, scale]. False if the index is out of range. */
    public instanceAt(index: number, out: number[]): boolean {
        const b = index * 5;
        if (index < 0 || b + 4 >= this._instances.length) return false;
        out[0] = this._instances[b]; out[1] = this._instances[b + 1]; out[2] = this._instances[b + 2];
        out[3] = this._instances[b + 3]; out[4] = this._instances[b + 4];
        return true;
    }

    /** Largest absolute local-space coordinate of the instance geometry, scaled by the max instance scale.
     *  Expands each cell's AABB so it fully contains the meshes/billboards standing on it. */
    private _instanceExtent(): number {
        let e = 0;
        // A camera-facing octahedral quad sweeps the whole captured sphere, which can reach past LOD0's box.
        const octa = this.billboardOctahedral;
        if (octa) e = Math.max(e, ...octa.center.map(c => Math.abs(c) + octa.radius));
        for (const m of this.levels[0].models) {
            // `boundingBox`, NEVER `bvh.bounds`: reading `bvh` force-builds the whole hierarchy over the
            // prototype's triangles (geometry.ts warns about this twice). For a heavy tree across several
            // prototypes that is a multi-hundred-millisecond hitch, and it is re-paid on every prototype
            // refresh and every brush stroke, because _applyMeshPrototype allocates fresh Model objects
            // and discards the memoised hierarchy. The sibling _prototypeFootprint already does this.
            const b = m.geometry.boundingBox;
            e = Math.max(e,
                Math.abs(b.min[0]), Math.abs(b.max[0]),
                Math.abs(b.min[1]), Math.abs(b.max[1]),
                Math.abs(b.min[2]), Math.abs(b.max[2]),
            );
        }
        return e * this.params.maxScale;
    }

    /** Change how instances stand; rebuilds the matrices (never the placement) when it changes. */
    public setOrientation(orientation: FoliageOrientation): void {
        const next = this.kind === 'mesh' ? orientation : 'up';
        if (next === this.orientation) return;
        this.orientation = next;
        if (this._instances.length > 0) this._rebuild();
    }

    /** Called by the owning terrain. A layer tilted to the ground re-reads it. */
    public setNormalSampler(sampler: ((x: number, z: number) => ArrayLike<number>) | null): void {
        this._normalSampler = sampler;
        if (this.orientation === 'normal' && this._instances.length > 0) this._rebuild();
    }

    /** The rotation of instance `i` (record at `b`) into `out`, per `orientation`. */
    private _instanceRotation(out: quat, i: number, b: number): quat {
        const x = this._instances[b], z = this._instances[b + 2], yaw = this._instances[b + 3];
        quat.setAxisAngle(out, [0, 1, 0], yaw);
        if (this.orientation === 'normal' && this._normalSampler) {
            const n = this._normalSampler(x, z);
            vec3.set(this._n, n[0], n[1], n[2]);
            if (vec3.length(this._n) > 1e-6) {
                vec3.normalize(this._n, this._n);
                // Tilt +Y onto the normal, AFTER the yaw: the instance still turns about its own axis.
                quat.rotationTo(this._tilt, [0, 1, 0], this._n);
                quat.multiply(out, this._tilt, out);
            }
        } else if (this.orientation === 'free') {
            // A uniformly random orientation (Shoemake), seeded by the instance's own record so it is
            // the same every rebuild and on every machine -- nothing extra is stored.
            const u1 = hash01(x, z, yaw, 1), u2 = hash01(x, z, yaw, 2), u3 = hash01(x, z, yaw, 3);
            const a = Math.sqrt(1 - u1), c = Math.sqrt(u1);
            quat.set(out, a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2),
                c * Math.sin(2 * Math.PI * u3), c * Math.cos(2 * Math.PI * u3));
        }
        return out;
    }

    private _rebuild(): void {
        this.count = this._instances.length / 5;

        // Nothing GPU-side to retire: cells hold CPU matrices only, and the merged batch buffers the
        // renderer draws from are reused in place — `version` below is what tells it to repack them.

        // Bucket instance indices into a uniform XZ grid.
        const cs = this.cellSize;
        const buckets = new Map<string, number[]>();
        for (let i = 0; i < this.count; i++) {
            const b = i * 5;
            const key = `${Math.floor(this._instances[b] / cs)},${Math.floor(this._instances[b + 2] / cs)}`;
            let arr = buckets.get(key);
            if (!arr) { arr = []; buckets.set(key, arr); }
            arr.push(i);
        }

        // A tilted instance can reach further from its base along any axis than an upright one: pad the
        // cell bounds by the diagonal, or culling clips rocks lying on their side.
        const extent = this._instanceExtent() * (this.orientation === 'up' ? 1 : Math.SQRT2);
        const cells: FoliageCell[] = [];
        for (const arr of buckets.values()) {
            const matrices = new Float32Array(arr.length * 16);
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let j = 0; j < arr.length; j++) {
                const b = arr[j] * 5;
                const x = this._instances[b], y = this._instances[b + 1], z = this._instances[b + 2];
                this._instanceRotation(this._q, arr[j], b);
                const s = this._instances[b + 4];
                mat4.fromRotationTranslationScale(this._m, this._q, [x, y, z], [s, s, s]);
                matrices.set(this._m, j * 16);
                if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
                if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
            }
            cells.push({
                matrices,
                count: arr.length,
                indices: Int32Array.from(arr),
                min: [minX - extent, minY - extent, minZ - extent],
                max: [maxX + extent, maxY + extent, maxZ + extent],
                pmin: [minX, minY, minZ],
                pmax: [maxX, maxY, maxZ],
                index: cells.length,
                visible: false,
                lod: 0,
            });
        }

        this.cells = cells;
        this.version++;
    }

    public serialize(): any {
        const inst = new Float32Array(this._instances);
        const bytes = new Uint8Array(inst.buffer);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk)
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
        return {
            kind: this.kind,
            name: this.name,
            // Persisted, or a reload would file every layer under its name again and undo the re-key.
            key: this.key !== this.name ? this.key : undefined,
            textureId: this.textureId,
            params: this.params,
            // `params.density` round-trips independently of the terrain material's rule, so it carries
            // its own unit marker (see deserialize).
            densityUnit: FOLIAGE_DENSITY_UNIT,
            collision: this.collision ?? undefined,
            // `model` is the single primary model, for older builds; the full multi-sub-mesh + LOD
            // payload rides in `models`/`lods`.
            model: this.kind === 'mesh' ? this.model.serialize() : undefined,
            models: this.kind === 'mesh' && this.levels[0].models.length > 1
                ? this.levels[0].models.map(m => m.serialize()) : undefined,
            lods: this.kind === 'mesh' && this.levels.length > 1
                ? this.levels.slice(1).map(l => ({ models: l.models.map(m => m.serialize()), distance: l.distance }))
                : undefined,
            billboard: this.kind === 'mesh' && this.billboardModel
                ? {
                    textureId: this.billboardTextureId, distance: this.billboardDistance,
                    // A `textures` slot map, so every texture-reference walker already counts the normals.
                    ...(this.billboardOctahedral ? {
                        octahedral: this.billboardOctahedral, textures: { normal: this.billboardNormalTextureId },
                    } : {}),
                } : undefined,
            cullDistance: this.cullDistance > 0 ? this.cullDistance : undefined,
            castShadows: this.castShadows || undefined,
            cameraDither: this.cameraDither || undefined,
            orientation: this.orientation !== 'up' ? this.orientation : undefined,
            // A mesh layer's wind rides in its models' materials; a billboard's card material is rebuilt
            // on load, so its wind is carried here.
            ...(this.kind === 'billboard' ? (() => {
                const w = windConfigOf(this.model.material);
                return {
                    windStrength: w.windStrength || undefined,
                    windStiffness: w.windStiffness !== 1 ? w.windStiffness : undefined,
                    windFlutter: w.windRole === 'leaves' && w.windFlutter > 0 ? w.windFlutter : undefined,
                };
            })() : {}),
            cellSize: this.cellSize,
            instances: btoa(bin),
        };
    }

    public static deserialize(json: any): FoliageLayer {
        // Migrate the density unit into a COPY: `json.params` is re-read by the editor's resync paths,
        // so mutating it in place would divide a second time on the next load.
        const params = { ...(json.params || {}) };
        if (json.densityUnit !== FOLIAGE_DENSITY_UNIT && params.density !== undefined)
            params.density = Math.max(0, params.density / 100);

        let layer: FoliageLayer;
        if (json.kind === 'billboard') {
            layer = FoliageLayer.Billboard(json.name, json.textureId, params);
            layer.collision = json.collision ?? null;
            layer.cullDistance = Math.max(0, Number(json.cullDistance) || 0);
            layer._applyBillboardWind(json);
        } else {
            layer = FoliageLayer.Mesh(json.name, Model.parse(json.models?.length ? json.models[0] : json.model), params);
            layer._applyMeshPrototype(json);
        }
        layer.castShadows = !!json.castShadows;
        layer.cameraDither = !!json.cameraDither;
        // Restored BEFORE the instance rebuild below: setting it after would bucket every instance at the
        // default size and leave the renderer to notice the mismatch and rebuild the whole grid again on
        // its first frame. A layer saved before this was persisted keeps whatever default it loads with.
        if (Number(json.cellSize) > 0) layer.cellSize = Number(json.cellSize);
        // Absent on anything saved before layers had a stable key; the name is what it was filed under
        // then, and Terrain migrates it onto the rule's key the first time it resolves one.
        layer.key = json.key ?? json.name;
        if (json.instances) {
            const bin = atob(json.instances);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const floats = new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
            layer._instances = Array.from(floats);
            layer._rebuild();
        }
        return layer;
    }
}

/** A rule's or payload's orientation, defaulting anything unknown to upright. */
export function parseFoliageOrientation(v: unknown): FoliageOrientation {
    return v === 'normal' || v === 'free' ? v : 'up';
}

/** A deterministic value in [0, 1) from an instance's record and a salt. */
function hash01(x: number, z: number, yaw: number, salt: number): number {
    let h = Math.imul(Math.round(x * 1000) | 0, 0x9e3779b1) ^ Math.imul(Math.round(z * 1000) | 0, 0x85ebca77)
        ^ Math.imul(Math.round(yaw * 1e5) | 0, 0xc2b2ae3d) ^ Math.imul(salt, 0x27d4eb2f);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}

import { chamferDistance, tileWaterInfo, type WaterInfo } from './waterInfo';
import { JOIN_CHANNELS, JOIN_FAR, JOIN_STEP_MAX, sampleChannel, type JoinGrid } from '../physics/water/joins';

// WHERE A WATER ENDS, finer than its grid (render/water.ts uploads what this returns in place of the grid's
// own surface and wet flag; the CPU grid, which the physics reads, is left as it is).
//
// A grid's cells are a metre or more, and a wet flag per cell drawn by cutting where its filtered value
// crosses a half puts the water's edge on the cells' outline: a staircase along every bank that is not
// square to the grid, and, where the bake carried a dry cell's surface down under the ground beside it, a
// surface that slopes down from the water to the ground within a cell. Here instead:
//
//  - The SURFACE is carried on level into the dry cells from the water's own (the lowest of the own cells about
//    the nearest one: beside a cascade, the step below, never the step above), so nothing drags it down at its
//    edge, and under a bank it stays a few centimetres under the ground.
//  - The DRAW DISTANCE (signed metres, positive inside) says how far inside what is drawn each cell is: the
//    water's own cells, and an APRON a couple of cells on under the banks, where the ground stands over the
//    level surface (or a film's depth under it) at the cell's middle AND at its far corners, so the landscape's
//    own depth test draws the waterline, exactly, wherever it runs. Where the ground falls away instead (the
//    water ends at a lip, a drawn river's edge over low ground, the far side of a ridge), and where another
//    node's water carries on (a river's mouth in its lake), the water ends on a line found BETWEEN the cells:
//    where the drawn shape's edge, the other water's edge, the ground or the blurred outline of the water's
//    cells crosses between them. A level sheet never stands out over ground lower than it. Small dry pockets
//    inside the water are drawn over too where something hides them: a post (the cell round it, which the bake
//    took as a wall), ground standing over the water, or a speck of a cell or two.
//  - A bake's water is CLIPPED to the water's drawn shape and a margin (clipWaterToShape): the simulation runs
//    over a corridor round a river and a basin round a lake, and what it leaves out there (overflow on the
//    outside of a bend, runoff down a cliff beside a cascade) is not this water.
//  - The SHORE DISTANCE (signed metres, positive in the water of the whole system, another node's included)
//    is the same kind of distance to where the water meets the ground: what the shore foam, its surf lines and
//    the waves' fade near the shore follow. Exact within a few cells of the line, the grid's chamfer beyond.
//
// Both distances are true distances to the line within EDGE_BAND_CELLS of it, so filtered linearly between
// cells they put the line where it is, to a small fraction of a cell. Pure; no scene, no GPU.

/** Cells past the water's own an apron reaches, under a bank. */
export const EDGE_APRON_CELLS = 2;
/** Metres under the level surface the ground may lie and still be drawn over (a film, a wet margin). */
export const EDGE_FILM = 0.05;
/** Cells a dry pocket inside the water may hold and still be drawn over. */
export const EDGE_POCKET_CELLS = 16;
/** Cells either side of the line within which the distances are exact. */
export const EDGE_BAND_CELLS = 3;
/**
 * Metres each side of a seam between two waters reaches past it: a sliver of overlap, never a gap. A curved
 * seam drawn from a grid of `cell` metres is off by up to about cell^2 / (8 R) (its radius R a few cells at
 * least): 3% of a cell covers that, and a centimetre more.
 */
export function seamOverlap(cell: number): number {
    return 0.01 + 0.03 * cell;
}
/** Metres a distance is held to at most (a half float holds it; an infinite one would filter to NaN). */
const DISTANCE_MAX = 1e4;
/** Metres a bank cell's surface stands under its ground at least (the bake's own, under a dry cell). */
export const EDGE_BANK_UNDER = 0.03;
/** Cells a dry pocket may hold and be drawn over whatever is there (the cell or two round a post). */
export const EDGE_POST_CELLS = 2;
/** Share of a cell a baked water runs on under a bank past where it meets the ground (hidden by the bank). */
export const EDGE_UNDER_BANK = 0.25;
/** Rise over run between two drawn cells past which a tile is steep (a cascade): drawn at its cells' density. */
export const EDGE_STEEP_SLOPE = 0.5;
/** A bake's water is kept this many of its cells past the water's drawn shape, and at least EDGE_CLIP_MIN metres. */
export const EDGE_CLIP_CELLS = 1.5;
export const EDGE_CLIP_MIN = 1;
/** Metres past its drawn shape a bake's water of `cell`-metre cells is kept (clipWaterToShape). */
export function clipMargin(cell: number): number {
    return Math.max(EDGE_CLIP_MIN, EDGE_CLIP_CELLS * cell);
}

/** Signed metres from a world point to an edge (positive inside); asked only near the water. */
export type EdgeSampler = (x: number, z: number) => number;

/** What is known of the water besides its grid. */
export interface WaterEdgeOptions {
    /**
     * Signed metres to the edge of the water's own drawn shape (positive inside; see
     * physics/water/waterColumn.ts shapesSignedEdge), or null. An unbaked grid ends there; a baked one only
     * where there is no ground (the bake decides where the water stands on the landscape).
     */
    shapeEdge?: EdgeSampler | null;
    /** Signed metres to the edge of the water this one gives way to or runs on into (positive inside it), or null. */
    otherEdge?: EdgeSampler | null;
    /**
     * The ground (world height) at a world point, null where there is none (no landscape). Absent: the grid's
     * bed is taken as the ground everywhere.
     */
    ground?: ((x: number, z: number) => number | null) | null;
    /** The grid is a flow bake's (the simulation decided where the water stands), not the drawn shape's. */
    baked?: boolean;
    /**
     * Per cell of the grid, signed metres to the line a bake's water is clipped to (positive where it is kept:
     * {@link clipWaterToShape}), or null. Nothing past it is drawn, and the water ends on it.
     */
    clipEdge?: Float32Array | null;
    /**
     * Whether a static collider stands through the level `level` at world (x, z): a dry pocket in the water
     * there is the cell round a post, drawn over (the post hides it). Asked only of pockets.
     */
    walls?: ((x: number, z: number, level: number) => boolean) | null;
}

/** What the renderer draws a water's grid with (see the file comment). */
export interface WaterEdges {
    /** World surface height per cell. */
    surface: Float32Array;
    /** Signed metres to the shore per cell (positive in the system's water). */
    shore: Float32Array;
    /** Signed metres to the edge of what this water draws per cell (positive inside). */
    draw: Float32Array;
    /** Per surface tile (`info.tilesX` × `info.tilesZ`): whether any of it is drawn. */
    tileDrawn: Uint8Array;
    /**
     * Per surface tile: whether its drawn surface is steep anywhere (two neighbouring drawn cells further apart
     * in height than EDGE_STEEP_SLOPE of a cell: a cascade). Drawn at its cells' own density, so the mesh does
     * not stretch across a drop.
     */
    tileSteep: Uint8Array;
}

/** The drawn surface, the draw distance and the shore distance of `info` (see the file comment). */
export function refineWaterEdges(info: WaterInfo, options: WaterEdgeOptions = {}): WaterEdges {
    const { nx, nz, cell, info0, info1 } = info;
    const n = nx * nz;
    const clip = options.clipEdge && options.clipEdge.length === n ? options.clipEdge : null;
    const own = new Uint8Array(n), other = new Uint8Array(n), water = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        own[i] = info1[i * 4 + 3] > 0.5 ? 1 : 0;
        // Another node's water (a river's mouth in its lake, the lake beside its river, the held sea): water
        // for the shore, not this node's to draw.
        other[i] = !own[i] && info0[i * 4 + 3] > 0 ? 1 : 0;
        water[i] = own[i] | other[i];
    }
    const ownField = chamferDistance(own, nx, nz, cell);
    // The level a dry cell is carried on at: the lowest of the own cells about its nearest one. Level water is
    // as it was; beside a cascade a dry cell takes the step below it, so the sheet carried under a bank never
    // stands over the water lower down.
    const lowNear = new Float32Array(n);
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const i = z * nx + x;
        if (!own[i]) continue;
        let low = info0[i * 4];
        for (let b = Math.max(0, z - 1); b <= Math.min(nz - 1, z + 1); b++) for (let a = Math.max(0, x - 1); a <= Math.min(nx - 1, x + 1); a++) {
            const k = b * nx + a;
            if (own[k] && info0[k * 4] < low) low = info0[k * 4];
        }
        lowNear[i] = low;
    }
    const surface = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const k = ownField.nearestSet[i];
        surface[i] = own[i] || other[i] || k < 0 ? info0[i * 4] : lowNear[k];
    }

    // What is known near the water (asked there only: a lake's outline is slow to measure against): the
    // ground under each cell and at its corners, the landscape's where there is a sampler, else the bed; the
    // edges of the shapes.
    const groundAt = new Float32Array(n).fill(NaN);
    const shape = options.shapeEdge ? new Float32Array(n).fill(NaN) : null;
    const otherEdge = options.otherEdge ? new Float32Array(n).fill(NaN) : null;
    const near = (EDGE_APRON_CELLS + EDGE_BAND_CELLS + 1) * cell;
    const isNear = (i: number) => !(ownField.dist[i] < -near && !water[i]);
    for (let i = 0; i < n; i++) {
        if (!isNear(i)) continue;
        const x = i % nx, z = (i - x) / nx;
        const wx = info.originX + x * cell, wz = info.originZ + z * cell;
        if (options.ground) {
            const g = options.ground(wx, wz);
            groundAt[i] = g === null || !Number.isFinite(g) ? NaN : g;
        } else {
            groundAt[i] = info1[i * 4 + 2];
        }
        if (shape) shape[i] = options.shapeEdge!(wx, wz);
        if (otherEdge) otherEdge[i] = options.otherEdge!(wx, wz);
    }
    // The ground at the cells' corners (corner (cx, cz) is cell (cx, cz)'s lower-left one), asked once each.
    const cw = nx + 1;
    const corner = new Float32Array(cw * (nz + 1)).fill(NaN);
    const cornerAsked = new Uint8Array(cw * (nz + 1));
    const cornerAt = (cx: number, cz: number): number => {
        const c = cz * cw + cx;
        if (!cornerAsked[c]) {
            cornerAsked[c] = 1;
            if (options.ground) {
                const g = options.ground(info.originX + (cx - 0.5) * cell, info.originZ + (cz - 0.5) * cell);
                corner[c] = g === null || !Number.isFinite(g) ? NaN : g;
            } else {
                // The bed under the cells about the corner.
                let sum = 0, count = 0;
                for (let b = cz - 1; b <= cz; b++) for (let a = cx - 1; a <= cx; a++) {
                    if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
                    sum += info1[(b * nx + a) * 4 + 2]; count++;
                }
                corner[c] = count ? sum / count : NaN;
            }
        }
        return corner[c];
    };
    const touchesOwn = (cx: number, cz: number): boolean => {
        for (let b = cz - 1; b <= cz; b++) for (let a = cx - 1; a <= cx; a++)
            if (a >= 0 && b >= 0 && a < nx && b < nz && own[b * nx + a]) return true;
        return false;
    };
    /**
     * The lowest ground over a dry cell, where it is not the water's own edge: its middle and its corners that
     * no own cell touches (a corner shared with the water is where the bank starts, not the bank).
     */
    const farGround = (i: number): number => {
        let g = groundAt[i];
        if (Number.isNaN(g)) return NaN;
        const x = i % nx, z = (i - x) / nx;
        for (let b = 0; b <= 1; b++) for (let a = 0; a <= 1; a++) {
            if (touchesOwn(x + a, z + b)) continue;
            const c = cornerAt(x + a, z + b);
            if (!Number.isNaN(c) && c < g) g = c;
        }
        return g;
    };
    const baked = !!options.baked;
    const kept = (i: number) => !clip || clip[i] >= 0;

    // What is drawn: the water's own cells, the apron under its banks, the pockets inside it.
    const drawn = new Uint8Array(n);
    const bank = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
        if (own[i]) { drawn[i] = 1; continue; }
        if (other[i] || ownField.dist[i] < -EDGE_APRON_CELLS * cell - 1e-6) continue;
        const g = groundAt[i];
        if (Number.isNaN(g)) {
            // No ground: drawn inside the water's shape only (a pool's walls, not the void past a landscape).
            drawn[i] = shape && shape[i] > 0 && kept(i) ? 1 : 0;
            continue;
        }
        const insideShape = !!shape && shape[i] > 0;
        const film = baked || insideShape ? EDGE_FILM : 0;
        const far = farGround(i);
        bank[i] = far;
        if (far >= surface[i] - film && kept(i)) {
            drawn[i] = 1;
            // Under its bank: a few centimetres under the lowest of it at most.
            surface[i] = Math.min(surface[i], far - EDGE_BANK_UNDER);
        }
    }
    // Small dry pockets inside the water: drawn where something hides them, at the level of the water round them.
    fillPockets(drawn, own, other, nx, nz, (members, rim) => {
        if (members.length <= EDGE_POST_CELLS) return true;
        for (const i of members) {
            if (!kept(i)) return false;
            const x = i % nx, z = (i - x) / nx;
            const far = Number.isNaN(bank[i]) ? farGround(i) : bank[i];
            if (far >= rim - EDGE_FILM) continue;
            if (options.walls && options.walls(info.originX + x * cell, info.originZ + z * cell, rim)) continue;
            return false;
        }
        return true;
    }, info0, surface);

    // The bake's outline of its own cells, smoothed: where the water ends over a drop, the line runs between
    // the cells' corners rather than round them (a one-cell stream stays: its middle sits on the half).
    const smooth = baked ? tentBlur(own, nx, nz) : null;
    // Where a value that is `va` at `a` and `vb` at `b` goes through nought between them, as a share of the way
    // from a; Infinity if it does not (NaN, unknown, compares false). One that is nought at a cell's centre is
    // crossed there.
    const through = (va: number, vb: number): number => (va >= 0 && vb <= 0 && va > vb ? va / (va - vb) : Infinity);
    const crossing = (a: number, b: number, scale: Float32Array | null, sa: number, sb: number): number => {
        // From inside `a` toward outside `b`: where `scale` drops through nought between them, if it does.
        if (!scale) return Infinity;
        return through(scale[a] * sa, scale[b] * sb);
    };
    const depthCross = (a: number, b: number): number => {
        const ga = groundAt[a], gb = groundAt[b];
        if (Number.isNaN(ga) || Number.isNaN(gb)) return Infinity;
        return through(surface[a] - ga, surface[b] - gb);
    };
    const clipCross = (a: number, b: number): number => (clip ? through(clip[a], clip[b]) : Infinity);

    const drawCross = (a: number, b: number): number => {
        let t = Infinity;
        if (other[b]) {
            // A seam: on the other water's own edge where it is known, else between the cells (two crops of
            // one bake meet there exactly). Each side reaches a little past it.
            t = Math.min(crossing(a, b, otherEdge, -1, -1), crossing(a, b, shape, 1, 1));
            if (!Number.isFinite(t)) t = 0.5;
            return Math.min(1, t + seamOverlap(cell) / cell);
        }
        if (!own[a]) {
            // The apron's far side: where the ground comes back down through the level (a ridge with a drop
            // behind it), else between the cells, under the bank.
            const ga = groundAt[a], gb = groundAt[b];
            if (!Number.isNaN(ga) && !Number.isNaN(gb)) t = through(Math.max(0, ga - surface[a]), gb - surface[b]);
            t = Math.min(t, clipCross(a, b));
            return Number.isFinite(t) ? t : 0.5;
        }
        const noGround = Number.isNaN(groundAt[b]);
        if (shape && (!baked || noGround)) t = Math.min(t, crossing(a, b, shape, 1, 1));
        t = Math.min(t, clipCross(a, b));
        if (smooth) {
            let ts = through(smooth[a] - 0.5, smooth[b] - 0.5);
            // Dry ground standing at the water or over it (a crest the bank gate left out, a drop behind it):
            // the water runs on to where it meets that ground, and a little under it.
            if (!noGround && groundAt[b] >= surface[b]) {
                const d = depthCross(a, b);
                if (Number.isFinite(d)) ts = Math.max(Number.isFinite(ts) ? ts : 0, Math.min(1, d + EDGE_UNDER_BANK));
            }
            t = Math.min(t, ts);
        }
        return Number.isFinite(t) ? t : 0.5;
    };
    const shoreCross = (a: number, b: number): number => {
        let t = depthCross(a, b);
        if (!baked) {
            // The drawn shapes', this water's and the one it gives way to: the system's water is their union.
            const ua = Math.max(shape && !Number.isNaN(shape[a]) ? shape[a] : -Infinity, otherEdge && !Number.isNaN(otherEdge[a]) ? otherEdge[a] : -Infinity);
            const ub = Math.max(shape && !Number.isNaN(shape[b]) ? shape[b] : -Infinity, otherEdge && !Number.isNaN(otherEdge[b]) ? otherEdge[b] : -Infinity);
            if (Number.isFinite(ua) && Number.isFinite(ub)) t = Math.min(t, through(ua, ub));
        }
        t = Math.min(t, clipCross(a, b));
        return Number.isFinite(t) ? t : 0.5;
    };

    const draw = signedDistance(drawn, drawCross, nx, nz, cell);
    const shore = signedDistance(water, shoreCross, nx, nz, cell);

    // The surface tiles any of whose cells are drawn, and those whose drawn surface is steep.
    const tilesX = info.tilesX, tilesZ = info.tilesZ, tc = info.tileCells;
    const tileDrawn = new Uint8Array(Math.max(0, tilesX * tilesZ));
    const tileSteep = new Uint8Array(Math.max(0, tilesX * tilesZ));
    const steep = EDGE_STEEP_SLOPE * cell;
    for (let tz = 0; tz < tilesZ; tz++) for (let tx = 0; tx < tilesX; tx++) {
        let any = 0, rough = 0;
        for (let z = tz * tc; z <= Math.min(nz - 1, (tz + 1) * tc); z++)
            for (let x = tx * tc; x <= Math.min(nx - 1, (tx + 1) * tc); x++) {
                const i = z * nx + x;
                if (!(draw[i] > 0)) continue;
                any = 1;
                if (!rough && x + 1 < nx && draw[i + 1] > 0 && Math.abs(surface[i + 1] - surface[i]) > steep) rough = 1;
                if (!rough && z + 1 < nz && draw[i + nx] > 0 && Math.abs(surface[i + nx] - surface[i]) > steep) rough = 1;
            }
        tileDrawn[tz * tilesX + tx] = any;
        tileSteep[tz * tilesX + tx] = rough;
    }
    return { surface, shore, draw, tileDrawn, tileSteep };
}

/**
 * Clips a BAKE's water grid `info` to its water's drawn shape (in place): every cell of the system's water
 * whose `keep` (signed metres to the drawn shape, positive inside: the water's own body, and the bounded waters
 * it joins, so a mouth is kept on both sides) is under `-margin` is made dry, this water's own always, the
 * other members' too when `clipOther` (not where the water it runs into is the endless sea, held at its level
 * all round: that water is not this one's to clip). The simulation ran over a corridor round a river and a
 * basin round a lake; what it left out there is not this water, nor what physics floats on. Returns, per cell,
 * `keep + margin` near the water (positive where kept): where the water now ends, for refineWaterEdges
 * (`clipEdge`). Nothing to clip: the grid is left as it was.
 */
export function clipWaterToShape(info: WaterInfo, keep: EdgeSampler, margin: number, clipOther: boolean): Float32Array {
    const { nx, nz, cell, info0, info1 } = info;
    const n = nx * nz;
    const water = new Uint8Array(n);
    for (let i = 0; i < n; i++) water[i] = info1[i * 4 + 3] > 0.5 || info0[i * 4 + 3] > 0 ? 1 : 0;
    const near = chamferDistance(water, nx, nz, cell).dist;
    const reach = (EDGE_APRON_CELLS + EDGE_BAND_CELLS + 2) * cell;
    const out = new Float32Array(n).fill(-JOIN_FAR);
    let changed = false;
    for (let i = 0; i < n; i++) {
        if (!water[i] && near[i] < -reach) continue;
        const x = i % nx, z = (i - x) / nx;
        const k = keep(info.originX + x * cell, info.originZ + z * cell) + margin;
        out[i] = Number.isFinite(k) ? Math.max(-JOIN_FAR, Math.min(JOIN_FAR, k)) : (k > 0 ? JOIN_FAR : -JOIN_FAR);
        if (!water[i] || out[i] >= 0) continue;
        const mine = info1[i * 4 + 3] > 0.5;
        if (!mine && !clipOther) continue;
        info1[i * 4 + 3] = 0;
        info0[i * 4 + 3] = -0.5 * cell;
        changed = true;
    }
    if (changed) tileWaterInfo(info);
    return out;
}

/** The joined water at a point of the seam, as it draws itself there (see physics/water/joins.ts JOIN_CHANNELS). */
export interface JoinSample {
    /** World height of its resting surface. */
    rest: number;
    /** Its shore distance (m) and depth (m; JOIN_FAR but for an endless sea). */
    edge: number; depth: number;
    /** Its current (m/s), or for an endless sea its surf's travel-time gradient (s/m). */
    ux: number; uz: number;
}

/** What {@link waterJoinField} needs besides the river's grid and edges. */
export interface WaterJoinOptions {
    /** Per cell of the river's grid: which of its joins (slot) the water there is, -1 none (its own, or dry). */
    owner: Int8Array;
    /** Per slot: metres of the band (physics/water/joins.ts joinLength). */
    lengths: readonly number[];
    /** The joined water of `slot` at world (x, z), into `out`. */
    at(slot: number, x: number, z: number, out: JoinSample): void;
    /** As refineWaterEdges takes them: the seam is put where the river is cut. */
    shapeEdge?: EdgeSampler | null;
    otherEdge?: EdgeSampler | null;
}

/** A river's join field (physics/water/joins.ts JoinGrid) over its whole grid, and where its bands are. */
export interface WaterJoinField extends JoinGrid {
    /** Per slot: the world box [x0, z0, x1, z1] of the cells its band reaches (past the seam too), or null. */
    bounds: ([number, number, number, number] | null)[];
    /** Metres the joined water's resting surface stands above the river's at most in a band (0 or more). */
    rise: number;
}

/** Cells past the seam, into the joined water, the field is measured over: under the mesh's widest quads there. */
const JOIN_PAST_CELLS = 6;

/**
 * The join field of a river's grid `info` (edges `edges`, as drawn): for every cell within each mouth's band, the
 * signed distance to the seam with the water it joins there, and that water's surface at the seam's nearest point
 * (physics/water/joins.ts JOIN_CHANNELS). The seam is the line the river is cut on (refineWaterEdges, without the
 * sliver of overlap), and only where the river's own water meets the joined water's, as one surface (within
 * JOIN_STEP_MAX): measured from there through what the river draws, so a river running beside the sea behind a
 * bank, or falling into it off a cliff, takes on nothing. Exact within the band: each cell carries the nearest
 * point of the seam from its neighbours (a vector distance transform). Null when no mouth is found.
 */
export function waterJoinField(info: WaterInfo, edges: WaterEdges, options: WaterJoinOptions): WaterJoinField | null {
    const { nx, nz, cell, info1 } = info;
    const n = nx * nz;
    const { owner, lengths } = options;
    const C = JOIN_CHANNELS;
    const own = new Uint8Array(n), drawnBy = new Uint8Array(n);
    for (let i = 0; i < n; i++) { own[i] = info1[i * 4 + 3] > 0.5 ? 1 : 0; drawnBy[i] = own[i] || edges.draw[i] > 0 ? 1 : 0; }
    // The edges the river is cut on, asked only along a seam (a lake's outline is slow to measure against).
    const lazy = (f: EdgeSampler | null | undefined) => {
        if (!f) return null;
        const cache = new Float32Array(n).fill(NaN);
        return (i: number) => {
            if (Number.isNaN(cache[i])) { const x = i % nx, z = (i - x) / nx; cache[i] = f(info.originX + x * cell, info.originZ + z * cell); }
            return cache[i];
        };
    };
    const shapeAt = lazy(options.shapeEdge), otherAt = lazy(options.otherEdge);
    const through = (va: number, vb: number): number => (va >= 0 && vb <= 0 && va > vb ? va / (va - vb) : Infinity);
    // From the river's side `a` toward the joined water's `b`: refineWaterEdges' drawCross at a seam.
    const cross = (a: number, b: number): number => {
        let t = Infinity;
        if (otherAt) t = Math.min(t, through(-otherAt(a), -otherAt(b)));
        if (shapeAt) t = Math.min(t, through(shapeAt(a), shapeAt(b)));
        return Number.isFinite(t) ? t : 0.5;
    };
    // Doubles: a float distance rounded up would look a hair better every time it is worked out again.
    const best = new Float64Array(n).fill(Infinity), slotOf = new Int8Array(n).fill(-1), pointOf = new Int32Array(n).fill(-1);
    const px: number[] = [], pz: number[] = [];
    const sample: JoinSample = { rest: 0, edge: 0, depth: 0, ux: 0, uz: 0 };
    const near = [0, 0, 0];
    let any = false;
    const seeded = lengths.map(() => false);
    for (let k = 0; k < lengths.length; k++) {
        const reachIn = lengths[k] / cell + 2, reachPast = JOIN_PAST_CELLS;
        const inside = new Uint8Array(n);
        let has = false;
        for (let i = 0; i < n; i++) { inside[i] = owner[i] === k ? 0 : 1; if (!inside[i]) has = true; }
        if (!has) continue;
        const { start, segs } = seamSegments(inside, cross, nx, nz);
        const sx = nx - 1;
        // This slot's distances, in cells: from the seam's squares where the river's own water meets the
        // joined water's as one surface, out through what the river draws and in through the joined water.
        const d = new Float64Array(n).fill(Infinity), pt = new Int32Array(n).fill(-1);
        const heap = new DistanceHeap();
        for (let q = 0; q + 1 < start.length; q++) {
            if (start[q] === start[q + 1]) continue;
            const x = q % sx, z = (q - x) / sx;
            const c00 = z * nx + x, corners = [c00, c00 + 1, c00 + nx, c00 + nx + 1];
            if (!corners.some(c => own[c]) || !corners.some(c => owner[c] === k)) continue;
            // One surface: the river's own water there and the joined water at the seam within a step.
            const mx = (segs[start[q]] + segs[start[q] + 2]) / 2, mz = (segs[start[q] + 1] + segs[start[q] + 3]) / 2;
            options.at(k, info.originX + mx * cell, info.originZ + mz * cell, sample);
            if (!corners.some(c => own[c] && Math.abs(sample.rest - edges.surface[c]) <= JOIN_STEP_MAX)) continue;
            for (let s = start[q]; s < start[q + 1]; s += 4) {
                for (let cz = Math.max(0, z - 1); cz <= Math.min(nz - 1, z + 2); cz++) for (let cx = Math.max(0, x - 1); cx <= Math.min(nx - 1, x + 2); cx++) {
                    const c = cz * nx + cx;
                    closestOnSegment(cx, cz, segs[s], segs[s + 1], segs[s + 2], segs[s + 3], near);
                    if (near[2] >= d[c]) continue;
                    if (owner[c] === k ? near[2] > reachPast : !drawnBy[c] || owner[c] >= 0) continue;
                    d[c] = near[2];
                    seeded[k] = true;
                    px.push(near[0]); pz.push(near[1]);
                    pt[c] = px.length - 1;
                    heap.push(c, near[2]);
                }
            }
        }
        // Out from there, each cell taking the nearest seam point its neighbours know of.
        while (heap.size) {
            const [c, dc] = heap.pop();
            if (dc > d[c]) continue;
            const x = c % nx, z = (c - x) / nx;
            const P = pt[c], Px = px[P], Pz = pz[P];
            for (let bz = Math.max(0, z - 1); bz <= Math.min(nz - 1, z + 1); bz++) for (let bx = Math.max(0, x - 1); bx <= Math.min(nx - 1, x + 1); bx++) {
                const b = bz * nx + bx;
                if (b === c || pt[b] === P) continue;
                const db = Math.hypot(bx - Px, bz - Pz);
                if (!(db < d[b] - 1e-6)) continue;
                if (owner[b] === k ? db > reachPast : !drawnBy[b] || owner[b] >= 0 || db > reachIn) continue;
                d[b] = db; pt[b] = P;
                heap.push(b, db);
            }
        }
        for (let i = 0; i < n; i++) {
            if (!(d[i] < best[i])) continue;
            best[i] = d[i]; slotOf[i] = k; pointOf[i] = pt[i];
            any = true;
        }
    }
    if (!any) return null;
    const data = new Float32Array(n * C);
    const bounds: ([number, number, number, number] | null)[] = lengths.map(() => null);
    // The joined water at each seam point used, and how far it stands above the river's own surface THERE: the
    // step the band eases in (a river falling away from its lake keeps its fall).
    const values = new Map<number, { v: JoinSample; step: number }>();
    const riverAt = (x: number, z: number) => sampleChannel(edges.surface, 1, 0, info.originX, info.originZ, cell, nx, nz, x, z);
    let rise = 0;
    for (let i = 0; i < n; i++) {
        const o = i * C;
        data[o + 6] = edges.draw[i];
        const k = slotOf[i];
        if (k < 0) {
            const past = owner[i];
            if (past >= 0 && seeded[past]) {
                // Deep in the joined water, past where the seam is measured: that water itself.
                const x = i % nx, z = (i - x) / nx;
                options.at(past, info.originX + x * cell, info.originZ + z * cell, sample);
                data[o] = -JOIN_FAR; data[o + 1] = Math.max(-JOIN_STEP_MAX, Math.min(JOIN_STEP_MAX, sample.rest - edges.surface[i]));
                data[o + 2] = Math.min(JOIN_FAR, sample.edge); data[o + 3] = Math.min(JOIN_FAR, sample.depth);
                data[o + 4] = sample.ux; data[o + 5] = sample.uz; data[o + 7] = past;
                continue;
            }
            data[o] = JOIN_FAR; data[o + 2] = JOIN_FAR; data[o + 3] = JOIN_FAR;
            continue;
        }
        const P = pointOf[i];
        let got = values.get(P);
        if (!got) {
            const v = { rest: 0, edge: 0, depth: 0, ux: 0, uz: 0 };
            const qx = info.originX + px[P] * cell, qz = info.originZ + pz[P] * cell;
            options.at(k, qx, qz, v);
            got = { v, step: v.rest - riverAt(qx, qz) };
            values.set(P, got);
        }
        const v = got.v;
        const past = owner[i] === k;
        const dist = best[i] * cell;
        data[o] = past ? -Math.max(dist, 1e-4) : Math.max(dist, 1e-4);
        data[o + 1] = got.step;
        data[o + 2] = Math.min(JOIN_FAR, v.edge);
        data[o + 3] = Math.min(JOIN_FAR, v.depth);
        data[o + 4] = v.ux; data[o + 5] = v.uz;
        data[o + 7] = k;
        if (!past && dist < lengths[k]) rise = Math.max(rise, data[o + 1]);
        const x = i % nx, z = (i - x) / nx;
        const wx = info.originX + x * cell, wz = info.originZ + z * cell;
        const b = bounds[k];
        if (!b) bounds[k] = [wx, wz, wx, wz];
        else { b[0] = Math.min(b[0], wx); b[1] = Math.min(b[1], wz); b[2] = Math.max(b[2], wx); b[3] = Math.max(b[3], wz); }
    }
    return { originX: info.originX, originZ: info.originZ, cell, nx, nz, data, bounds, rise };
}

/** The closest point to (px, pz) on the segment a-b: `out` = [x, z, distance]. */
function closestOnSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number, out: number[]): void {
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
    out[0] = ax + dx * t; out[1] = az + dz * t;
    out[2] = Math.hypot(px - out[0], pz - out[1]);
}

/** A binary min-heap of (cell, distance), for the join field's distance transform. */
class DistanceHeap {
    private readonly _c: number[] = [];
    private readonly _d: number[] = [];
    public get size(): number { return this._c.length; }
    public push(c: number, d: number): void {
        const C = this._c, D = this._d;
        let i = C.length;
        C.push(c); D.push(d);
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (D[p] <= d) break;
            C[i] = C[p]; D[i] = D[p]; i = p;
        }
        C[i] = c; D[i] = d;
    }
    public pop(): [number, number] {
        const C = this._c, D = this._d;
        const top: [number, number] = [C[0], D[0]];
        const c = C.pop()!, d = D.pop()!;
        const n = C.length;
        if (n) {
            let i = 0;
            for (;;) {
                const l = i * 2 + 1, r = l + 1;
                let m = i, md = d;
                if (l < n && D[l] < md) { m = l; md = D[l]; }
                if (r < n && D[r] < md) { m = r; md = D[r]; }
                if (m === i) break;
                C[i] = C[m]; D[i] = D[m]; i = m;
            }
            C[i] = c; D[i] = d;
        }
        return top;
    }
}

/**
 * Marks drawn the small dry pockets wholly inside the water's own cells (none touching the grid's border or
 * another water) that `accept` takes, given its cells and the lowest own surface round it (its rim), and
 * carries that rim's level over them.
 */
function fillPockets(drawn: Uint8Array, own: Uint8Array, other: Uint8Array, nx: number, nz: number,
                     accept: (members: readonly number[], rim: number) => boolean, info0: Float32Array, surface: Float32Array): void {
    const n = nx * nz;
    const seen = new Uint8Array(n);
    const stack: number[] = [], members: number[] = [];
    for (let s = 0; s < n; s++) {
        if (own[s] || drawn[s] || seen[s]) continue;
        stack.length = 0; members.length = 0;
        stack.push(s); seen[s] = 1;
        let enclosed = true, size = 0, rim = Infinity;
        while (stack.length) {
            const i = stack.pop()!;
            // Too big to be a pocket: the rest of it is only marked seen.
            if (++size > EDGE_POCKET_CELLS) enclosed = false;
            else members.push(i);
            if (other[i]) enclosed = false;
            const x = i % nx, z = (i - x) / nx;
            if (x === 0 || z === 0 || x === nx - 1 || z === nz - 1) enclosed = false;
            const visit = (j: number) => {
                if (own[j]) { if (info0[j * 4] < rim) rim = info0[j * 4]; return; }
                if (!drawn[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
            };
            if (x > 0) visit(i - 1);
            if (x < nx - 1) visit(i + 1);
            if (z > 0) visit(i - nx);
            if (z < nz - 1) visit(i + nx);
        }
        if (!enclosed || !Number.isFinite(rim) || !accept(members, rim)) continue;
        for (const i of members) { drawn[i] = 1; surface[i] = rim; }
    }
}

/** A 3 × 3 tent filter of a 0/1 mask (weights 1 2 1 each way), clamped at the border. */
function tentBlur(mask: Uint8Array, nx: number, nz: number): Float32Array {
    const out = new Float32Array(nx * nz);
    const at = (x: number, z: number) => mask[Math.min(nz - 1, Math.max(0, z)) * nx + Math.min(nx - 1, Math.max(0, x))];
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        let s = 0;
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) s += at(x + a, z + b) * (2 - Math.abs(a)) * (2 - Math.abs(b));
        out[z * nx + x] = s / 16;
    }
    return out;
}

/**
 * Signed metres from every cell's centre to the edge of `inside` (positive inside): within EDGE_BAND_CELLS of
 * it the distance to the line through the points `cross` places on the grid's edges (marching squares: from an
 * inside cell `a` toward an outside neighbour `b`, the share 0..1 of the way the line crosses), beyond it the
 * chamfer distance to the cells' outline, joined to it.
 */
export function signedDistance(inside: Uint8Array, cross: (a: number, b: number) => number, nx: number, nz: number, cell: number): Float32Array {
    const n = nx * nz;
    const chamfer = chamferDistance(inside, nx, nz, cell).dist;
    const sx = nx - 1, sz = nz - 1;
    const { start, segs } = seamSegments(inside, cross, nx, nz);
    const out = new Float32Array(n);
    const B = EDGE_BAND_CELLS;
    for (let i = 0; i < n; i++) {
        const sign = inside[i] ? 1 : -1;
        const far = Math.abs(chamfer[i]);
        if (far > (B + 0.5) * cell) { out[i] = sign * Math.min(DISTANCE_MAX, far - 0.5 * cell); continue; }
        const x = i % nx, z = (i - x) / nx;
        let best = Infinity;
        for (let qz = Math.max(0, z - B); qz < Math.min(sz, z + B); qz++) for (let qx = Math.max(0, x - B); qx < Math.min(sx, x + B); qx++) {
            const q = qz * sx + qx;
            for (let s = start[q]; s < start[q + 1]; s += 4) {
                const d = pointSegment(x, z, segs[s], segs[s + 1], segs[s + 2], segs[s + 3]);
                if (d < best) best = d;
            }
        }
        const d = Number.isFinite(best) ? best * cell : far - 0.5 * cell;
        // Never nought on either side: a cell keeps the side it is on.
        out[i] = sign * Math.min(DISTANCE_MAX, Math.max(d, 0.01 * cell));
    }
    return out;
}

/**
 * The edge of `inside` as line segments, square by square (a square's corners are the centres of cells (x, z) ..
 * (x + 1, z + 1); square q = z * (nx - 1) + x): marching squares, each crossing put where `cross` says (from an
 * inside cell `a` toward an outside neighbour `b`, the share 0..1 of the way). In cell units; square q's segments
 * are `segs[start[q] .. start[q + 1])`, four numbers (ax, az, bx, bz) each.
 */
export function seamSegments(inside: Uint8Array, cross: (a: number, b: number) => number, nx: number, nz: number): { start: Int32Array; segs: number[] } {
    const sx = nx - 1, sz = nz - 1;
    const start = new Int32Array(Math.max(0, sx * sz) + 1);
    const segs: number[] = [];
    const pt = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
        const q = z * sx + x;
        start[q] = segs.length;
        const c00 = z * nx + x, c10 = c00 + 1, c01 = c00 + nx, c11 = c01 + 1;
        const i00 = inside[c00], i10 = inside[c10], i01 = inside[c01], i11 = inside[c11];
        if (i00 === i10 && i00 === i01 && i00 === i11) continue;
        // Crossing points on the four edges: 0 bottom (00-10), 1 right (10-11), 2 top (01-11), 3 left (00-01).
        const edge = (k: number, a: number, b: number, ax: number, az: number, bx: number, bz: number): boolean => {
            if (inside[a] === inside[b]) return false;
            const [ia, ib, iax, iaz, ibx, ibz] = inside[a] ? [a, b, ax, az, bx, bz] : [b, a, bx, bz, ax, az];
            const t = Math.min(1, Math.max(0, cross(ia, ib)));
            pt[k * 2] = iax + (ibx - iax) * t; pt[k * 2 + 1] = iaz + (ibz - iaz) * t;
            return true;
        };
        const e0 = edge(0, c00, c10, x, z, x + 1, z), e1 = edge(1, c10, c11, x + 1, z, x + 1, z + 1);
        const e2 = edge(2, c01, c11, x, z + 1, x + 1, z + 1), e3 = edge(3, c00, c01, x, z, x, z + 1);
        const push = (a: number, b: number) => segs.push(pt[a * 2], pt[a * 2 + 1], pt[b * 2], pt[b * 2 + 1]);
        const count = +e0 + +e1 + +e2 + +e3;
        if (count === 4) {
            // A saddle: the inside corners kept apart (each cut off on its own).
            if (i00) { push(3, 0); push(1, 2); } else { push(0, 1); push(2, 3); }
        } else if (count === 2) {
            const ks = [e0, e1, e2, e3].map((e, k) => (e ? k : -1)).filter(k => k >= 0);
            push(ks[0], ks[1]);
        }
    }
    start[Math.max(0, sx * sz)] = segs.length;
    return { start, segs };
}

/** Distance from (px, pz) to the segment a-b. */
function pointSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
    return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

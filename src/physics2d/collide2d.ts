import { slopeHeightAt } from '../core/math';
import { TILE_ONE_WAY, TILE_SLOPE, TILE_SOLID } from './types';
import type { Box2D, CollisionWorld2D, Grid2D } from './types';

// Move-and-slide for a 2D body against tile grids and box colliders: one axis at a time, X then Y, each a
// sweep that cannot tunnel (it walks the cells the moving edge crosses, however far it goes).
//
// The body is an axis-aligned box standing on its FEET: (x, y) is the middle of its bottom edge, so it
// spans [x - halfWidth, x + halfWidth] by [y, y + height]. That is where a character sprite pivots, so the
// two share one origin.
//
// Slopes are floors, never walls: a body walks onto one and is lifted to its surface, the surface under
// the middle of its feet (so a body's edge can overhang a slope's low end without lifting it). Climbing
// onto anything -- a slope, a step, the top of a ramp -- is a lift of at most `stepUp`; more than that is a
// wall. One-way platforms are floors only from above, and only while the body is not dropping through.

/** A body's box, feet-centred. */
export interface Body2DShape {
    x: number;
    y: number;
    halfWidth: number;
    height: number;
}

export interface MoveOptions {
    /** One-way platforms are passed through (the body is dropping down through one). */
    dropThrough: boolean;
    /** The most a body on the ground climbs to stay on it moving sideways: a step, a slope's rise. */
    stepUp: number;
    /** How far below its feet a body that was on the ground looks for ground to stay on (walking down a slope). */
    snapDown: number;
    /** Whether the body stood on the ground at the start of the move. */
    grounded: boolean;
}

export interface MoveResult {
    x: number;
    y: number;
    /** Moving sideways hit a wall: on the left, on the right. */
    hitLeft: boolean;
    hitRight: boolean;
    /** Moving up hit a ceiling. */
    hitCeiling: boolean;
    /** Standing on ground after the move: landed, walked along it, or snapped down onto it. */
    grounded: boolean;
    /** The ground is a slope. */
    onSlope: boolean;
    /** The box collider the body stands on, or null (ground, or air). */
    groundBox: Box2D | null;
}

export function createMoveResult(): MoveResult {
    return { x: 0, y: 0, hitLeft: false, hitRight: false, hitCeiling: false, grounded: false, onSlope: false, groundBox: null };
}

/** A small distance, in world units, below which two edges count as touching. */
const EPS = 1e-4;

const _slope: [number, number] = [0, 0];

/** The column of a world x in `g`. */
function colOf(g: Grid2D, x: number): number { return Math.floor((x - g.originX) / g.cellWidth); }
/** The row of a world y in `g` (rows grow downward). */
function rowOf(g: Grid2D, y: number): number { return Math.floor((g.originY - y) / g.cellHeight); }
/** World y of the top of row `row`. */
function rowTop(g: Grid2D, row: number): number { return g.originY - row * g.cellHeight; }

/**
 * How far a body can move sideways by `dx` before a wall stops it. A wall is a solid cell or a solid box
 * overlapping the body's height from `pad` above its feet to its top: on the ground, `pad` is the step
 * height, so a step or a slope's top is climbed (by {@link liftTo}) rather than hit.
 */
export function sweepX(world: CollisionWorld2D, b: Body2DShape, dx: number, pad: number): { dx: number, hit: boolean } {
    if (dx === 0) return { dx: 0, hit: false };
    const dir = dx > 0 ? 1 : -1;
    const lead = b.x + dir * b.halfWidth;
    let allowed = dx;
    let hit = false;
    const bottom = b.y + Math.max(EPS, pad), top = b.y + b.height - EPS;
    if (top <= bottom) return { dx, hit: false };
    for (const g of world.grids) {
        const r0 = rowOf(g, top), r1 = rowOf(g, bottom);
        // The columns whose near edge the leading edge crosses, in the order it crosses them.
        const start = colOf(g, lead - dir * EPS) + dir;
        const end = colOf(g, lead + allowed);
        for (let c = start; dir > 0 ? c <= end : c >= end; c += dir) {
            let solid = false;
            for (let r = r0; r <= r1 && !solid; r++) solid = g.sample(c, r, _slope) === TILE_SOLID;
            if (!solid) continue;
            const edge = g.originX + (dir > 0 ? c : c + 1) * g.cellWidth;
            const d = edge - lead;
            if (dir > 0 ? d < allowed : d > allowed) { allowed = d; hit = true; }
            break;
        }
    }
    for (const box of world.boxes) {
        if (box.oneWay || box.maxY <= bottom || box.minY >= top) continue;
        const face = dir > 0 ? box.minX : box.maxX;
        const d = face - lead;
        // Ahead of the leading edge (or touching it) and within this move.
        if (dir > 0 ? (d >= -EPS && d < allowed) : (d <= EPS && d > allowed)) { allowed = d; hit = true; }
    }
    if (dir > 0 ? allowed < 0 : allowed > 0) allowed = 0;
    return { dx: allowed, hit };
}

/**
 * The floor under the body's feet between `from` (above, the feet) and `to` (below): the highest surface
 * the feet would come to rest on falling from `from` to `to`, or -Infinity. Solid cells and boxes under
 * any part of the feet; one-way platforms likewise unless dropping through, and only those the feet are
 * at or above; slopes under the MIDDLE of the feet, and in a row where the middle stands on a slope, that
 * slope alone (so the top of a slope runs onto the floor beside it without a bump).
 */
export function floorBetween(world: CollisionWorld2D, b: Body2DShape, from: number, to: number,
                             dropThrough: boolean, out?: { box: Box2D | null, slope: boolean }): number {
    let best = -Infinity;
    let bestBox: Box2D | null = null;
    let bestSlope = false;
    const x0 = b.x - b.halfWidth + EPS, x1 = b.x + b.halfWidth - EPS;
    for (const g of world.grids) {
        const c0 = colOf(g, x0), c1 = colOf(g, x1), cm = colOf(g, b.x);
        const rTop = rowOf(g, from + EPS), rBottom = rowOf(g, to);
        for (let r = rTop; r <= rBottom; r++) {
            const top = rowTop(g, r);
            let rowBest = -Infinity, rowSlope = false;
            const mid = g.sample(cm, r, _slope);
            if (mid === TILE_SLOPE) {
                const left = g.originX + cm * g.cellWidth;
                const s = top - g.cellHeight + slopeHeightAt(_slope[0], _slope[1], (b.x - left) / g.cellWidth) * g.cellHeight;
                if (s <= from + EPS && s >= to) { rowBest = s; rowSlope = true; }
            } else {
                for (let c = c0; c <= c1; c++) {
                    const kind = c === cm ? mid : g.sample(c, r, _slope);
                    if (kind === TILE_SOLID || (kind === TILE_ONE_WAY && !dropThrough)) {
                        if (top <= from + EPS && top >= to && top > rowBest) { rowBest = top; rowSlope = false; }
                    }
                }
            }
            // Rows are walked top down, so the first one with a floor holds the highest.
            if (rowBest > -Infinity) { if (rowBest > best) { best = rowBest; bestSlope = rowSlope; } break; }
        }
    }
    for (const box of world.boxes) {
        if (box.maxX <= x0 || box.minX >= x1) continue;
        if (box.oneWay && dropThrough) continue;
        const top = box.maxY;
        if (top <= from + EPS && top >= to && top >= best) { best = top; bestBox = box; bestSlope = false; }
    }
    if (out) { out.box = bestBox; out.slope = bestSlope; }
    return best;
}

/**
 * The ceiling over the body's head between its top `from` and `to` above it: the lowest underside it
 * would stop at, or +Infinity. Solid cells and slopes (whose undersides are solid) over any part of it, and
 * solid boxes; one-way platforms never.
 */
export function ceilingBetween(world: CollisionWorld2D, b: Body2DShape, from: number, to: number): number {
    let best = Infinity;
    const x0 = b.x - b.halfWidth + EPS, x1 = b.x + b.halfWidth - EPS;
    for (const g of world.grids) {
        const c0 = colOf(g, x0), c1 = colOf(g, x1);
        const rBottom = rowOf(g, from - EPS), rTop = rowOf(g, to);
        for (let r = rBottom; r >= rTop; r--) {
            const underside = rowTop(g, r) - g.cellHeight;
            if (underside < from - EPS || underside > to) continue;
            let hit = false;
            for (let c = c0; c <= c1 && !hit; c++) {
                const kind = g.sample(c, r, _slope);
                hit = kind === TILE_SOLID || kind === TILE_SLOPE;
            }
            if (hit) { if (underside < best) best = underside; break; }
        }
    }
    for (const box of world.boxes) {
        if (box.oneWay || box.maxX <= x0 || box.minX >= x1) continue;
        const under = box.minY;
        if (under >= from - EPS && under <= to && under < best) best = under;
    }
    return best;
}

const _floor = { box: null as Box2D | null, slope: false };

/**
 * Move a body by (dx, dy): sideways first (walls stop it; on the ground it climbs steps and slopes up to
 * `stepUp`), then vertically (floors and ceilings stop it), then, if it was on the ground and is not
 * rising, down onto ground within `snapDown` below it, so it stays on a slope it walks down.
 */
export function moveAndSlide(world: CollisionWorld2D, b: Body2DShape, dx: number, dy: number,
                             opts: MoveOptions, out: MoveResult = createMoveResult()): MoveResult {
    const body: Body2DShape = { x: b.x, y: b.y, halfWidth: b.halfWidth, height: b.height };
    out.hitLeft = out.hitRight = out.hitCeiling = out.grounded = out.onSlope = false;
    out.groundBox = null;

    // --- sideways ---------------------------------------------------------------------------------
    if (dx !== 0) {
        // On the ground a step's height of wall is no wall: it is climbed below. In the air every wall stops it.
        const pad = opts.grounded ? opts.stepUp : 0;
        const sx = sweepX(world, body, dx, pad);
        const startX = body.x;
        body.x += sx.dx;
        if (sx.hit) { if (dx > 0) out.hitRight = true; else out.hitLeft = true; }
        // Climb what the move put the feet inside: a step (only reachable on the ground), a slope's rise. A
        // one-way platform is never climbed this way -- it is a floor only from above. More than `stepUp`
        // above the feet is a wall after all, and the move goes back.
        const floor = floorBetween(world, body, body.y + body.height, body.y, true);
        if (floor > body.y + EPS) {
            if (floor - body.y <= opts.stepUp + EPS) body.y = floor;
            else {
                body.x = startX;
                if (dx > 0) out.hitRight = true; else out.hitLeft = true;
            }
        }
    }

    // --- vertically ------------------------------------------------------------------------------
    if (dy < 0) {
        const floor = floorBetween(world, body, body.y, body.y + dy, opts.dropThrough, _floor);
        if (floor > -Infinity) {
            body.y = floor;
            out.grounded = true; out.onSlope = _floor.slope; out.groundBox = _floor.box;
        } else body.y += dy;
    } else if (dy > 0) {
        const ceiling = ceilingBetween(world, body, body.y + body.height, body.y + body.height + dy);
        if (ceiling < Infinity) { body.y = ceiling - body.height; out.hitCeiling = true; }
        else body.y += dy;
    }

    // --- staying on the ground --------------------------------------------------------------------
    if (!out.grounded && opts.grounded && dy <= 0 && opts.snapDown > 0) {
        const floor = floorBetween(world, body, body.y, body.y - opts.snapDown, opts.dropThrough, _floor);
        if (floor > -Infinity) {
            body.y = floor;
            out.grounded = true; out.onSlope = _floor.slope; out.groundBox = _floor.box;
        }
    }
    // Resting exactly on a floor with no vertical motion this step: still on the ground.
    if (!out.grounded && dy === 0) {
        const floor = floorBetween(world, body, body.y, body.y - EPS * 4, opts.dropThrough, _floor);
        if (floor > -Infinity) { out.grounded = true; out.onSlope = _floor.slope; out.groundBox = _floor.box; }
    }

    out.x = body.x;
    out.y = body.y;
    return out;
}

/**
 * Whether a wall touches the body on side `dir` (-1 left, 1 right): a solid cell or box within `reach` of
 * that side, over the middle of its height (its feet and head left out, so a floor's edge or a ceiling's
 * is not a wall). Slopes are never walls.
 */
export function wallTouching(world: CollisionWorld2D, b: Body2DShape, dir: -1 | 1, reach: number = 0.02): boolean {
    const probe = { x: b.x, y: b.y + b.height * 0.2, halfWidth: b.halfWidth, height: b.height * 0.6 };
    return sweepX(world, probe, dir * reach, 0).hit;
}

/**
 * Whether the box [minX, minY, maxX, maxY] overlaps anything solid: a solid cell, a slope's solid part (taken
 * whole), or a solid box. One-way platforms never.
 */
export function overlapsSolid(world: CollisionWorld2D, minX: number, minY: number, maxX: number, maxY: number): boolean {
    for (const g of world.grids) {
        const c0 = colOf(g, minX + EPS), c1 = colOf(g, maxX - EPS);
        const r0 = rowOf(g, maxY - EPS), r1 = rowOf(g, minY + EPS);
        for (let r = r0; r <= r1; r++)
            for (let c = c0; c <= c1; c++) {
                const k = g.sample(c, r, _slope);
                if (k === TILE_SOLID || k === TILE_SLOPE) return true;
            }
    }
    for (const box of world.boxes)
        if (!box.oneWay && box.minX < maxX && minX < box.maxX && box.minY < maxY && minY < box.maxY) return true;
    return false;
}

/** A hit of {@link raycast2D}. */
export interface RayHit2D {
    x: number;
    y: number;
    distance: number;
    /** What was hit: a box's owner, or null for a tile. */
    owner: unknown;
    /** The unit normal of the surface hit, pointing back out at the ray: a cell or box face, or a slope. */
    normal: [number, number];
}

/**
 * The first solid thing along the ray from (ox, oy) in direction (dx, dy) within `maxDistance`: solid cells,
 * slopes at their surface, solid boxes. Marched in steps of an eighth of a cell, then refined, which is
 * exact enough for line of sight and ledge checks. Null when nothing is hit.
 */
export function raycast2D(world: CollisionWorld2D, ox: number, oy: number, dx: number, dy: number,
                          maxDistance: number): RayHit2D | null {
    const len = Math.hypot(dx, dy);
    if (!(len > 0) || !(maxDistance > 0)) return null;
    const ux = dx / len, uy = dy / len;
    let step = Infinity;
    for (const g of world.grids) step = Math.min(step, g.cellWidth / 8, g.cellHeight / 8);
    if (!Number.isFinite(step)) step = 0.125;
    const solidAt = (x: number, y: number): unknown | undefined => {
        for (const g of world.grids) {
            const c = colOf(g, x), r = rowOf(g, y);
            const k = g.sample(c, r, _slope);
            if (k === TILE_SOLID) return null;
            if (k === TILE_SLOPE) {
                const left = g.originX + c * g.cellWidth, bottom = rowTop(g, r) - g.cellHeight;
                if (y <= bottom + slopeHeightAt(_slope[0], _slope[1], (x - left) / g.cellWidth) * g.cellHeight) return null;
            }
        }
        for (const box of world.boxes)
            if (!box.oneWay && x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY) return box.owner;
        return undefined;
    };
    let prev = 0;
    for (let t = 0; t <= maxDistance + 1e-9; t += step) {
        const d = Math.min(t, maxDistance);
        const owner = solidAt(ox + ux * d, oy + uy * d);
        if (owner !== undefined) {
            // Halve the last step down to the surface.
            let lo = prev, hi = d;
            for (let i = 0; i < 12; i++) {
                const m = (lo + hi) * 0.5;
                if (solidAt(ox + ux * m, oy + uy * m) !== undefined) hi = m; else lo = m;
            }
            const x = ox + ux * hi, y = oy + uy * hi;
            return { x, y, distance: hi, owner, normal: rayNormal(world, ox + ux * lo, oy + uy * lo, x, y, ux, uy) };
        }
        prev = d;
        if (d === maxDistance) break;
    }
    return null;
}

/**
 * The face a ray crossed into solid between (x0, y0), just outside, and (x1, y1), just inside: the side of
 * the box or cell it entered through, or a slope's surface when it hit one inside its cell.
 */
function rayNormal(world: CollisionWorld2D, x0: number, y0: number, x1: number, y1: number,
                   ux: number, uy: number): [number, number] {
    for (const box of world.boxes) {
        if (box.oneWay || x1 < box.minX || x1 > box.maxX || y1 < box.minY || y1 > box.maxY) continue;
        // The face of the box nearest the point the ray entered by.
        const d = [x0 - box.minX, box.maxX - x0, y0 - box.minY, box.maxY - y0];
        const out = [x0 < box.minX, x0 > box.maxX, y0 < box.minY, y0 > box.maxY];
        const normals: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (let i = 0; i < 4; i++) if (out[i]) return normals[i];
        let best = 0;
        for (let i = 1; i < 4; i++) if (Math.abs(d[i]) < Math.abs(d[best])) best = i;
        return normals[best];
    }
    for (const g of world.grids) {
        const c0 = colOf(g, x0), r0 = rowOf(g, y0), c1 = colOf(g, x1), r1 = rowOf(g, y1);
        const k = g.sample(c1, r1, _slope);
        if (k === TILE_SLOPE && c0 === c1 && r0 === r1) {
            // Inside the slope's own cell: its surface, rising from left to right by (right - left) cells.
            const rise = (_slope[1] - _slope[0]) * g.cellHeight / g.cellWidth;
            const len = Math.hypot(rise, 1);
            return [-rise / len, 1 / len];
        }
        if (k !== TILE_SOLID && k !== TILE_SLOPE) continue;
        if (c0 !== c1 && r0 === r1) return [ux > 0 ? -1 : 1, 0];
        if (r0 !== r1 && c0 === c1) return [0, uy > 0 ? -1 : 1];
        // Through a corner: the axis it travelled more along.
        return Math.abs(ux) >= Math.abs(uy) ? [ux > 0 ? -1 : 1, 0] : [0, uy > 0 ? -1 : 1];
    }
    return [-ux, -uy];
}

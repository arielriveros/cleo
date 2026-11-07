import { GI_HIT_PROBES_PER_ROW, giRaySide, hitTileOrigin } from './giLayout';

/**
 * Which probes of a GI volume take part in its lighting, from what their rays hit. Pure.
 *
 * A probe whose rays mostly meet BACK faces stands inside something — a wall, a rock, a closed crate —
 * and what it saw is the inside of that thing: lit, it would leak light into every room round it. DDGI's
 * rule (Majercik et al. 2021): more than a quarter of the rays on back faces and the probe is switched
 * off; the lighting renormalizes over the rest of its cage. A probe under the terrain is never captured
 * at all (it is skipped before its faces are drawn).
 */

/** A probe's state, as the probe-data texture stores it (the `w` of its texel). */
export const GI_PROBE_UNCAPTURED = 0;
export const GI_PROBE_ACTIVE = 1;
export const GI_PROBE_INACTIVE = 2;
export const GI_PROBE_SKIPPED = 3;
export type GiProbeState = typeof GI_PROBE_UNCAPTURED | typeof GI_PROBE_ACTIVE | typeof GI_PROBE_INACTIVE | typeof GI_PROBE_SKIPPED;

/** What a ray met, as hit cache A stores it in its alpha byte. */
export const GI_HIT_MISS = 0;
export const GI_HIT_BACK = 128;
export const GI_HIT_FRONT = 255;

/** Back-face share above which a probe is switched off. */
export const GI_BACKFACE_LIMIT = 0.25;

/** Metres a probe must stand above the terrain to be captured. */
export const GI_UNDERGROUND_MARGIN = 0.05;

export type GiHitKind = 'miss' | 'back' | 'front';

/** Read a hit cache alpha byte, tolerant of anything between the three values it is written as. */
export function hitKind(alpha: number): GiHitKind {
    if (alpha >= 192) return 'front';
    if (alpha >= 64) return 'back';
    return 'miss';
}

/** A probe's state from the share of its rays that met back faces. */
export function classifyProbe(backFraction: number): GiProbeState {
    return backFraction > GI_BACKFACE_LIMIT ? GI_PROBE_INACTIVE : GI_PROBE_ACTIVE;
}

/** Whether a probe at height `y` stands under terrain whose surface below it is at `terrainHeight`. */
export function isUnderground(y: number, terrainHeight: number | null | undefined,
                              margin: number = GI_UNDERGROUND_MARGIN): boolean {
    return terrainHeight != null && Number.isFinite(terrainHeight) && y < terrainHeight + margin;
}

/**
 * Classify probes from an RGBA8 readback of hit cache A.
 *
 * `pixels` holds whole rows of the hit cache (its full width, 64 tiles), in texture row order, starting at
 * texel row `firstRow`. Every probe in [`first`, `first + count`) whose tile lies inside those rows is
 * classified into `out[probe]`; the return is how many were.
 */
export function classifyHitRows(pixels: Uint8Array, firstRow: number, rows: number, rays: number,
                                first: number, count: number, out: Uint8Array): number {
    const side = giRaySide(rays);
    const width = GI_HIT_PROBES_PER_ROW * side;
    let classified = 0;
    for (let p = first; p < first + count; p++) {
        const [ox, oy] = hitTileOrigin(p, rays);
        if (oy < firstRow || oy + side > firstRow + rows) continue;
        let back = 0;
        for (let y = 0; y < side; y++) {
            const row = (oy - firstRow + y) * width;
            for (let x = 0; x < side; x++) {
                if (hitKind(pixels[(row + ox + x) * 4 + 3]) === 'back') back++;
            }
        }
        out[p] = classifyProbe(back / (side * side));
        classified++;
    }
    return classified;
}

/** How many probes are in each state. */
export function countStates(states: ArrayLike<number>): { uncaptured: number; active: number; inactive: number; skipped: number } {
    const c = { uncaptured: 0, active: 0, inactive: 0, skipped: 0 };
    for (let i = 0; i < states.length; i++) {
        switch (states[i]) {
            case GI_PROBE_ACTIVE: c.active++; break;
            case GI_PROBE_INACTIVE: c.inactive++; break;
            case GI_PROBE_SKIPPED: c.skipped++; break;
            default: c.uncaptured++; break;
        }
    }
    return c;
}

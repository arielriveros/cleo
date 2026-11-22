// Where one water runs into another (a river into its lake, its pond, the sea or another river): the MOUTH, and
// how the river's surface becomes the other water's there. Over a band on the river's side of the seam the river
// takes on the joined water's surface: its resting height and its waves (formula waves, swell, the sea's surf),
// all of them at the seam itself, so the two surfaces meet as one instead of crossing. The joined water keeps its
// own waves. Physics floats bodies on the same blend (physics/waterSurface.ts waterSpecColumn) that the surface
// draws (water.wgsl, the join slots), from the same field (water/waterEdges.ts waterJoinField). Worker-safe:
// plain data and arithmetic, nothing to import.

/**
 * Floats per cell of a {@link JoinGrid}, in two groups of four (the two textures the surface reads them from):
 *  0 signed metres to the seam, positive on the river's side (past {@link JOIN_FAR}: no mouth near);
 *  1 metres the joined water's resting surface stands above the river's own at the seam's nearest point: the
 *    step the band eases in, all of it at the seam (a river falling away from its lake keeps its fall);
 *  2 the joined water's shore distance and 3 its depth (an endless sea's; else {@link JOIN_FAR}), each at
 *    the nearest point of the seam: what fades and caps its waves and times its surf;
 *  4, 5 the joined water's current there (m/s), or for the sea its surf's travel-time gradient (s/m);
 *  6 the river's own draw distance (signed metres, positive where it is drawn: water/waterEdges.ts);
 *  7 which of the river's joins (its slot) the cell's mouth is.
 * The joined water's values are taken where the seam is nearest, the waves' phase where the point is: most
 * of the band lies outside that water's own grid, and over land its shore distance would make the river swash.
 */
export const JOIN_CHANNELS = 8;
/** A distance meaning "no mouth near" (held by a half float). */
export const JOIN_FAR = 1e4;
/**
 * Metres the two surfaces may differ by where they meet and still be taken for one water: a river falling into
 * the sea off a cliff is no mouth, it is a waterfall, and takes on nothing.
 */
export const JOIN_STEP_MAX = 1;

/**
 * A join field over (a crop of) the river's grid: `nx` x `nz` cells `cell` metres apart from cell (0, 0)'s
 * centre at (originX, originZ), {@link JOIN_CHANNELS} floats each, read as a texture reads them: linearly
 * between cell centres, the border cells' values held past the edge.
 */
export interface JoinGrid {
    originX: number; originZ: number; cell: number; nx: number; nz: number;
    data: Float32Array;
}

/**
 * One float per cell, laid out as a {@link JoinGrid} with one channel: a joined water's refined shore distance
 * round a river's mouth (WaterVolumeNode.buoyancySpec `shoreFields`).
 */
export interface ScalarField {
    originX: number; originZ: number; cell: number; nx: number; nz: number;
    data: Float32Array;
}

/**
 * Channel `channel` of `stride` per cell of a grid at world (x, z): bilinear between cell centres, clamped at
 * the border like a texture (water.wgsl reads its info and join textures so).
 */
export function sampleChannel(data: ArrayLike<number>, stride: number, channel: number, originX: number, originZ: number,
                              cell: number, nx: number, nz: number, x: number, z: number): number {
    const fx = Math.min(nx - 1, Math.max(0, (x - originX) / cell));
    const fz = Math.min(nz - 1, Math.max(0, (z - originZ) / cell));
    const x0 = Math.min(Math.max(0, nx - 2), Math.floor(fx)), z0 = Math.min(Math.max(0, nz - 2), Math.floor(fz));
    const x1 = Math.min(nx - 1, x0 + 1), z1 = Math.min(nz - 1, z0 + 1);
    const tx = fx - x0, tz = fz - z0;
    const a = data[(z0 * nx + x0) * stride + channel] * (1 - tx) + data[(z0 * nx + x1) * stride + channel] * tx;
    const b = data[(z1 * nx + x0) * stride + channel] * (1 - tx) + data[(z1 * nx + x1) * stride + channel] * tx;
    return a * (1 - tz) + b * tz;
}

/** {@link ScalarField} at world (x, z) (see {@link sampleChannel}). */
export function sampleField(f: ScalarField, x: number, z: number): number {
    return sampleChannel(f.data, 1, 0, f.originX, f.originZ, f.cell, f.nx, f.nz, x, z);
}

/** Every channel of `g` at world (x, z) into `out` (see {@link sampleChannel}). */
export function sampleJoin(g: JoinGrid, x: number, z: number, out: Float32Array | number[]): void {
    const fx = Math.min(g.nx - 1, Math.max(0, (x - g.originX) / g.cell));
    const fz = Math.min(g.nz - 1, Math.max(0, (z - g.originZ) / g.cell));
    const x0 = Math.min(Math.max(0, g.nx - 2), Math.floor(fx)), z0 = Math.min(Math.max(0, g.nz - 2), Math.floor(fz));
    const x1 = Math.min(g.nx - 1, x0 + 1), z1 = Math.min(g.nz - 1, z0 + 1);
    const tx = fx - x0, tz = fz - z0;
    const d = g.data, C = JOIN_CHANNELS;
    const o00 = (z0 * g.nx + x0) * C, o10 = (z0 * g.nx + x1) * C, o01 = (z1 * g.nx + x0) * C, o11 = (z1 * g.nx + x1) * C;
    for (let c = 0; c < C; c++) {
        const a = d[o00 + c] * (1 - tx) + d[o10 + c] * tx;
        const b = d[o01 + c] * (1 - tx) + d[o11 + c] * tx;
        out[c] = a * (1 - tz) + b * tz;
    }
}

/** Metres of the band a river takes on the joined water's surface over, at least and at most. */
export const JOIN_LENGTH_MIN = 4;
export const JOIN_LENGTH_MAX = 24;

/**
 * The band's length for a river `width` metres wide at its mouth and `length` metres long: half again its
 * width, 4 to 24 m, and never more than 0.4 of the river (so a short river's two mouths keep apart).
 */
export function joinLength(width: number, length = Infinity): number {
    const band = Math.min(JOIN_LENGTH_MAX, Math.max(JOIN_LENGTH_MIN, 1.5 * (Number.isFinite(width) ? width : 0)));
    return Math.max(0.5, Math.min(band, 0.4 * (Number.isFinite(length) && length > 0 ? length : Infinity)));
}

/**
 * How much of the joined water's surface the river carries `seam` metres upstream of the seam, over a band of
 * `length` metres: all of it at the seam (and past it), none at the band's far end, eased between
 * (water.wgsl joinWeight).
 */
export function joinWeight(seam: number, length: number): number {
    if (!(seam > 0)) return 1;
    if (!(seam < length)) return 0;
    const t = seam / length;
    return 1 - t * t * (3 - 2 * t);
}

/** A river's mouths, as its spec carries them (WaterVolumeNode.buoyancySpec). */
export interface WaterJoinSpec {
    /** The field, cropped to the bands round its mouths. */
    field: JoinGrid;
    /** Metres the joined water's resting surface stands above the river's at most in a band. */
    rise: number;
    /** Per slot: the joined water's node id (its spec among the step's specs) and the band's length. */
    targets: { id: string; length: number }[];
}

/**
 * A river joined to an endless sea, as the sea's spec carries it: the sea is under every point, the river's
 * channel too where its bed is below sea level, and there it is drawn down and calmed (water.wgsl, the sea
 * under a river) so it never pokes up through the river, the river being the water there; at the mouth it is
 * the sea again, with all its waves, where the river has taken them on.
 */
export interface WaterUnderRiver {
    /** The river's join field (its spec's). */
    field: JoinGrid;
    /** Which of the river's slots is this sea, and its band's length. */
    slot: number;
    length: number;
    /** Metres the sea is taken down under the river (WaterVolumeNode.joinDrop). */
    drop: number;
}

/** Metres of the river's draw distance over which the sea under it gives way to it, at its banks. */
export const JOIN_UNDER_BANK = 0.25;

/**
 * How much of itself the sea is under a river joined to it, at a point where the river's join field reads
 * `seam` (channel 0), `draw` (6) and `slot` (7): all of it outside the river and at the mouth, none under the
 * river upstream of its band (water.wgsl seaUnder).
 */
export function seaUnderRiver(seam: number, draw: number, slot: number, under: Pick<WaterUnderRiver, 'slot' | 'length'>): number {
    const mine = Math.abs(slot - under.slot) < 0.5;
    const w = mine ? joinWeight(seam, under.length) : 0;
    const t = Math.min(1, Math.max(0, draw / JOIN_UNDER_BANK + 0.5));
    const gate = t * t * (3 - 2 * t);
    return 1 - (1 - w) * gate;
}

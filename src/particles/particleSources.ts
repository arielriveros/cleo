// SPAWN SOURCES: an emitter fed by the engine with the points its particles are born at, each frame, instead
// of the one shape round its own transform. What flowing water's spray rises from (water/spray/): the foot of a
// waterfall, the face of a rock in a rapid, a body held in the current. Up to MAX_SPAWN_SOURCES points per
// emitter per frame, each a small ellipse on the ground plane (its axis, its half-length along and across), a
// height to rise through, a velocity with a spread, and how many particles it gives this frame. The step's
// births are dealt out to the points in order, each point's spread over the step on its own
// (chunks/particleSimCore.wgsl `sourceOf`), so ONE emitter draws every point of one look in one dispatch.
//
// Packed into four vec4 per point (u_sources), the last one's w the point's first index in the step's births.
// GL-free and pure: unit tested.

/** Points one emitter is fed per frame at most (chunks/particleSimCore.wgsl `u_sources` holds 4 vec4 each). */
export const MAX_SPAWN_SOURCES = 32;

/** One point particles are born at this frame (world space). */
export interface SpawnSource {
    x: number; y: number; z: number;
    /** The ellipse's along axis on the ground (normalised here; default +X). */
    ax?: number; az?: number;
    /** Half-lengths of the ellipse along and across its axis, metres (0: a point). */
    along?: number; across?: number;
    /** Metres above the point it may be born, at random (a falling curtain). */
    rise?: number;
    /** Velocity at birth, m/s. */
    vx: number; vy: number; vz: number;
    /** Radians: a cone round that velocity; negative, a turn about the vertical only (it stays level). */
    spread?: number;
    /** Share its speed varies by, either way (0..1). */
    jitter?: number;
    /** Multipliers on the emitter's own size and lifetime. */
    size?: number;
    life?: number;
    /** Particles born at it this frame. */
    count: number;
}

/** A frame's sources, packed: `count` points, `total` particles, `data` the uniform array. */
export interface SpawnSourceTable {
    data: Float32Array;
    count: number;
    total: number;
}

/** Floats the packed table holds (u_sources: MAX_SPAWN_SOURCES x 4 vec4). */
export const SPAWN_SOURCE_FLOATS = MAX_SPAWN_SOURCES * 16;

const finite = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * `sources` (the first MAX_SPAWN_SOURCES with particles to give) packed for an emitter of `capacity`: counts
 * scaled down together so a frame never takes more than half the pool (the rest is still alive), each point's
 * first index in the step's births in its last texel's w.
 */
export function packSpawnSources(sources: readonly SpawnSource[], capacity: number, out?: SpawnSourceTable): SpawnSourceTable {
    const table = out ?? { data: new Float32Array(SPAWN_SOURCE_FLOATS), count: 0, total: 0 };
    table.data.fill(0);
    const live = sources.filter(s => s && finite(s.count, 0) >= 1).slice(0, MAX_SPAWN_SOURCES);
    let want = 0;
    for (const s of live) want += Math.floor(finite(s.count, 0));
    const room = Math.max(0, Math.floor(capacity / 2));
    const scale = want > room ? room / want : 1;
    let first = 0, k = 0;
    for (const s of live) {
        const n = Math.floor(Math.floor(finite(s.count, 0)) * scale);
        if (n < 1) continue;
        let ax = finite(s.ax, 1), az = finite(s.az, 0);
        const l = Math.hypot(ax, az);
        if (l > 1e-6) { ax /= l; az /= l; } else { ax = 1; az = 0; }
        const o = k * 16;
        table.data.set([finite(s.x, 0), finite(s.y, 0), finite(s.z, 0), Math.max(0, finite(s.along, 0)),
            ax, az, Math.max(0, finite(s.across, 0)), Math.max(0, finite(s.rise, 0)),
            finite(s.vx, 0), finite(s.vy, 0), finite(s.vz, 0), finite(s.spread, 0),
            Math.min(1, Math.max(0, finite(s.jitter, 0))), Math.max(0, finite(s.size, 1)), Math.max(1e-3, finite(s.life, 1)), first], o);
        first += n;
        k++;
    }
    table.count = k;
    table.total = first;
    return table;
}

/**
 * A rectangular cloth panel — a cape, a banner, a flag — simulated with XPBD (extended position-based
 * dynamics; Macklin, Müller & Chentanez 2016) in the "small steps" form (Macklin et al. 2019): many
 * substeps of ONE constraint iteration each, which converges stiffer and damps less than many iterations
 * of one big step.
 *
 * Pure math over flat Float32Arrays, no engine types: the node (core/scene/nodes/clothNode.ts) owns the
 * pins, colliders and wind, and the mesh. World space throughout, metres and seconds.
 *
 * Constraints, all distance constraints with an XPBD compliance:
 *   - STRUCTURAL: each particle to its right and lower neighbour (the weave).
 *   - SHEAR: both diagonals of each cell (keeps the cells from collapsing sideways).
 *   - BEND: each particle to the one TWO along, in both directions. A skip-one distance constraint is the
 *     cheapest bending model there is, and for a hanging panel indistinguishable from a dihedral one.
 *   - TETHERS (long-range attachments): each free particle may be no farther from its nearest pin than it
 *     is at rest. One-sided, and what stops a heavy cape stretching like rubber when the iterations alone
 *     cannot carry the load from the pinned edge down to the hem in one frame.
 *
 * Collision: capsules and spheres (a body's limbs, a pole), pushed out to the cloth's `thickness`, with
 * friction as a damping of the tangential velocity at contact.
 *
 * Wind: aerodynamic drag per triangle, `F = ½ ρ C A (v·n) n` on the RELATIVE velocity (air minus cloth),
 * split over the triangle's three particles. A panel facing the wind catches it; one edge-on does not —
 * which is what makes a flag ripple instead of standing straight out.
 */

export interface ClothCapsule {
    /** Segment end points (equal for a sphere) and radius, world space. */
    a: [number, number, number];
    b: [number, number, number];
    radius: number;
}

export interface ClothSettings {
    /** Structural/shear compliance, m/N. 0 = inextensible. */
    stretchCompliance: number;
    /** Bend compliance, m/N. Higher = floppier. */
    bendCompliance: number;
    /** Velocity kept per second, 0..1 (1 = no damping). */
    damping: number;
    /** Distance kept from colliders, m. */
    thickness: number;
    /** 0..1: tangential velocity removed at a contact. */
    friction: number;
    /** Drag coefficient times air density, kg/m³ (½ρC folded in). */
    drag: number;
    /** Substeps per step. */
    substeps: number;
    gravity: [number, number, number];
}

export const CLOTH_SOLVER_DEFAULTS: ClothSettings = {
    stretchCompliance: 0,
    bendCompliance: 0.02,
    damping: 0.6,
    thickness: 0.03,
    friction: 0.3,
    drag: 0.6,
    substeps: 10,
    gravity: [0, -9.81, 0],
};

/** What a cloth is made of: any triangle mesh of particles (`XpbdCloth.grid` builds a panel's). */
export interface ClothMesh {
    /** Rest positions, 3 floats per particle. Also the start state. */
    positions: ArrayLike<number>;
    /** Which particles are pinned (moved only by `setPin`). */
    pinned: ArrayLike<boolean>;
    /** Total mass, kg, shared over the free particles. */
    mass: number;
    /** Triangles over the particles, for normals and wind. */
    triangles: Uint32Array;
    /**
     * Distance constraints: `bend` ones take the bend compliance, the rest the stretch compliance. Absent:
     * every triangle edge (stretch) and, across every shared edge, the two opposite corners (bend).
     */
    links?: { i: number; j: number; bend?: boolean }[];
    /** Long-range attachments to the nearest pin (a panel held along an edge). Default true. */
    tethers?: boolean;
}

export class XpbdCloth {
    /** Grid size, in particles, when built by `grid` (0 otherwise). Particle (c, r) is index r * cols + c. */
    public readonly cols: number;
    public readonly rows: number;
    public readonly triangles: Uint32Array;
    public readonly positions: Float32Array;
    public readonly previous: Float32Array;
    public readonly velocities: Float32Array;
    /** Inverse mass per particle; 0 = pinned (moved only by `setPin`). */
    public readonly invMass: Float32Array;
    public readonly normals: Float32Array;
    public settings: ClothSettings;
    /** World-space air velocity, m/s. */
    public readonly wind: [number, number, number] = [0, 0, 0];
    public colliders: ClothCapsule[] = [];

    /** Distance constraints, struct-of-arrays: particles, rest length, compliance, and whether it bends. */
    private _ci = new Uint32Array(0);
    private _cj = new Uint32Array(0);
    private _crest = new Float32Array(0);
    private _ccompliance = new Float32Array(0);
    private _cbend = new Uint8Array(0);
    /** Colliders packed per step (see `_packColliders`): 12 floats each. */
    private _packed = new Float32Array(0);
    private _packedCount = 0;
    private readonly _tethers: { i: number; pin: number; rest: number }[] = [];
    private readonly _lambdas: Float32Array;
    /** Max-distance constraints (skinned cloth): per particle, where it is driven to and how far it may stray. */
    private _targets: Float32Array | null = null;
    private _radii: Float32Array | null = null;
    private _backDirs: Float32Array | null = null;
    private _backDistances: Float32Array | null = null;

    constructor(mesh: ClothMesh, settings: Partial<ClothSettings> = {}, grid: { cols: number; rows: number } | null = null) {
        const n = mesh.positions.length / 3;
        if (!Number.isInteger(n) || n < 2 || mesh.pinned.length !== n) throw new Error('XpbdCloth: positions/pinned do not describe the same particles');
        this.cols = grid?.cols ?? 0;
        this.rows = grid?.rows ?? 0;
        this.triangles = mesh.triangles;
        this.settings = { ...CLOTH_SOLVER_DEFAULTS, ...settings };
        this.positions = Float32Array.from(mesh.positions);
        this.previous = Float32Array.from(mesh.positions);
        this.velocities = new Float32Array(n * 3);
        this.normals = new Float32Array(n * 3);
        this.invMass = new Float32Array(n);
        let free = 0;
        for (let i = 0; i < n; i++) if (!mesh.pinned[i]) free++;
        const w = free > 0 ? free / Math.max(1e-6, mesh.mass) : 0;
        for (let i = 0; i < n; i++) this.invMass[i] = mesh.pinned[i] ? 0 : w;

        const links = (mesh.links ?? meshLinks(mesh.triangles)).filter(({ i, j }) => this.invMass[i] !== 0 || this.invMass[j] !== 0);
        const m = links.length;
        this._ci = new Uint32Array(m); this._cj = new Uint32Array(m);
        this._crest = new Float32Array(m); this._ccompliance = new Float32Array(m); this._cbend = new Uint8Array(m);
        links.forEach(({ i, j, bend }, c) => {
            this._ci[c] = i; this._cj[c] = j; this._crest[c] = this._dist(i, j); this._cbend[c] = bend ? 1 : 0;
        });
        this._applyCompliance();
        this._lambdas = new Float32Array(m);

        // Tethers: each free particle to its nearest pin (by rest distance).
        const pins: number[] = [];
        for (let i = 0; i < n; i++) if (this.invMass[i] === 0) pins.push(i);
        if (mesh.tethers !== false && pins.length) for (let i = 0; i < n; i++) {
            if (this.invMass[i] === 0) continue;
            let best = pins[0], bestD = Infinity;
            for (const p of pins) { const d = this._dist(i, p); if (d < bestD) { bestD = d; best = p; } }
            this._tethers.push({ i, pin: best, rest: bestD });
        }
        this.computeNormals();
    }

    /**
     * A cols x rows panel (row-major, `rest` positions): structural links to the right and below, both
     * cell diagonals (shear), and skip-one links along rows and columns (bend). Tethers to the pins.
     */
    public static grid(cols: number, rows: number, rest: ArrayLike<number>, pinned: ArrayLike<boolean>, mass: number,
                       settings: Partial<ClothSettings> = {}): XpbdCloth {
        if (cols < 2 || rows < 2) throw new Error('XpbdCloth: a panel needs at least 2 x 2 particles');
        if (rest.length !== cols * rows * 3) throw new Error('XpbdCloth: rest does not match cols x rows');
        const idx = (c: number, r: number) => r * cols + c;
        const links: { i: number; j: number; bend?: boolean }[] = [];
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            const i = idx(c, r);
            if (c + 1 < cols) links.push({ i, j: idx(c + 1, r) });
            if (r + 1 < rows) links.push({ i, j: idx(c, r + 1) });
            if (c + 1 < cols && r + 1 < rows) {
                links.push({ i, j: idx(c + 1, r + 1) });
                links.push({ i: idx(c + 1, r), j: idx(c, r + 1) });
            }
            if (c + 2 < cols) links.push({ i, j: idx(c + 2, r), bend: true });
            if (r + 2 < rows) links.push({ i, j: idx(c, r + 2), bend: true });
        }
        return new XpbdCloth({ positions: rest, pinned, mass, triangles: gridIndices(cols, rows), links }, settings, { cols, rows });
    }

    public get particleCount(): number { return this.positions.length / 3; }

    /** Re-read the compliances from `settings` (after changing them). */
    public refreshSettings(): void { this._applyCompliance(); }

    private _applyCompliance(): void {
        for (let c = 0; c < this._ci.length; c++) this._ccompliance[c] = this._cbend[c] ? this.settings.bendCompliance : this.settings.stretchCompliance;
    }

    /**
     * Drive each particle toward `targets` (world positions, 3 floats each), allowing it at most
     * `radii[i]` metres away — the max-distance constraint skinned cloth is held by. Radius 0 locks a
     * particle to its target. The arrays are read every step (the caller rewrites them in place).
     */
    public setTargets(targets: Float32Array | null, radii: Float32Array | null): void {
        this._targets = targets;
        this._radii = radii;
    }

    /**
     * A backstop on top of the targets: each particle may sink at most `distances[i]` metres behind its
     * target along `directions` (unit, 3 floats each: OUT of the body it hangs on). Swinging out and
     * sideways is free; sinking into what is under the cloth is not. Read every step, like the targets.
     */
    public setBackstop(directions: Float32Array | null, distances: Float32Array | null): void {
        this._backDirs = directions;
        this._backDistances = distances;
    }

    /** Move a pinned particle (its velocity follows, so a swung pin drags the cloth with it). */
    public setPin(i: number, x: number, y: number, z: number): void {
        const p = this.positions;
        p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    }

    /** Teleport the whole panel to `positions` (a cut, a respawn): no velocity carried. */
    public reset(positions: ArrayLike<number>): void {
        this.positions.set(positions);
        this.previous.set(positions);
        this.velocities.fill(0);
        this.computeNormals();
    }

    /**
     * Advance by `dt` seconds. Pins must already sit where they belong at the END of the step: they are
     * not interpolated, so a caller stepping several fixed steps per frame lerps them itself.
     */
    public step(dt: number): void {
        if (!(dt > 0)) return;
        const s = this.settings;
        const n = this.particleCount;
        const h = dt / Math.max(1, Math.round(s.substeps));
        const substeps = Math.max(1, Math.round(s.substeps));
        const p = this.positions, prev = this.previous, v = this.velocities, w = this.invMass;
        // Per-substep damping from the per-second figure.
        const keep = Math.pow(Math.min(1, Math.max(0, s.damping)), h);
        this._applyWind(dt);
        this._packColliders();

        for (let step = 0; step < substeps; step++) {
            for (let i = 0; i < n; i++) {
                const k = i * 3;
                prev[k] = p[k]; prev[k + 1] = p[k + 1]; prev[k + 2] = p[k + 2];
                if (w[i] === 0) continue;
                v[k] = v[k] * keep + s.gravity[0] * h;
                v[k + 1] = v[k + 1] * keep + s.gravity[1] * h;
                v[k + 2] = v[k + 2] * keep + s.gravity[2] * h;
                p[k] += v[k] * h; p[k + 1] += v[k + 1] * h; p[k + 2] += v[k + 2] * h;
            }
            this._lambdas.fill(0);
            this._solveDistances(h);
            this._solveTethers();
            this._solveMaxDistance();
            this._solveBackstop();
            this._solveCollisions();
            // The projections above move particles one at a time; a cloth held by them (skinned cloth)
            // would end each substep with them dragged off their neighbours — spikes. A second pass of
            // the links lets the weave win last.
            if (this._targets || this._packedCount > 0) this._solveDistances(h);
            for (let i = 0; i < n; i++) {
                if (w[i] === 0) continue;
                const k = i * 3;
                v[k] = (p[k] - prev[k]) / h; v[k + 1] = (p[k + 1] - prev[k + 1]) / h; v[k + 2] = (p[k + 2] - prev[k + 2]) / h;
            }
        }
        this._applyFriction();
        this.computeNormals();
    }

    /** Area-weighted vertex normals over the triangles (a panel's winding: see `gridIndices`). */
    public computeNormals(): void {
        const p = this.positions, out = this.normals;
        out.fill(0);
        const tri = (a: number, b: number, c: number) => {
            const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
            const e1x = p[b * 3] - ax, e1y = p[b * 3 + 1] - ay, e1z = p[b * 3 + 2] - az;
            const e2x = p[c * 3] - ax, e2y = p[c * 3 + 1] - ay, e2z = p[c * 3 + 2] - az;
            const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
            out[a * 3] += nx; out[a * 3 + 1] += ny; out[a * 3 + 2] += nz;
            out[b * 3] += nx; out[b * 3 + 1] += ny; out[b * 3 + 2] += nz;
            out[c * 3] += nx; out[c * 3 + 1] += ny; out[c * 3 + 2] += nz;
        };
        eachTriangle(this.triangles, tri);
        for (let i = 0; i < this.particleCount; i++) {
            const k = i * 3;
            const l = Math.sqrt((out[k]) * (out[k]) + (out[k + 1]) * (out[k + 1]) + (out[k + 2]) * (out[k + 2])) || 1;
            out[k] /= l; out[k + 1] /= l; out[k + 2] /= l;
        }
    }

    private _dist(i: number, j: number): number {
        const p = this.positions;
        return Math.sqrt((p[i * 3] - p[j * 3]) * (p[i * 3] - p[j * 3]) + (p[i * 3 + 1] - p[j * 3 + 1]) * (p[i * 3 + 1] - p[j * 3 + 1]) + (p[i * 3 + 2] - p[j * 3 + 2]) * (p[i * 3 + 2] - p[j * 3 + 2]));
    }

    private _solveDistances(h: number): void {
        const p = this.positions, w = this.invMass, lambdas = this._lambdas;
        const ci = this._ci, cj = this._cj, rest = this._crest, compliance = this._ccompliance;
        const h2 = h * h;
        for (let c = 0; c < ci.length; c++) {
            const a = ci[c], b = cj[c];
            const wi = w[a], wj = w[b];
            const wSum = wi + wj;
            if (wSum === 0) continue;
            const i = a * 3, j = b * 3;
            const dx = p[i] - p[j], dy = p[i + 1] - p[j + 1], dz = p[i + 2] - p[j + 2];
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len < 1e-9) continue;
            const alpha = compliance[c] / h2;
            const dLambda = (rest[c] - len - alpha * lambdas[c]) / (wSum + alpha);
            lambdas[c] += dLambda;
            const k = dLambda / len;
            const sx = dx * k, sy = dy * k, sz = dz * k;
            p[i] += sx * wi; p[i + 1] += sy * wi; p[i + 2] += sz * wi;
            p[j] -= sx * wj; p[j + 1] -= sy * wj; p[j + 2] -= sz * wj;
        }
    }

    /** Keep each particle within its radius of its target (see `setTargets`). */
    private _solveMaxDistance(): void {
        const t = this._targets, r = this._radii;
        if (!t || !r) return;
        const p = this.positions;
        for (let i = 0; i < r.length; i++) {
            const k = i * 3;
            const dx = p[k] - t[k], dy = p[k + 1] - t[k + 1], dz = p[k + 2] - t[k + 2];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const max = r[i];
            if (d <= max) continue;
            if (max <= 0 || d < 1e-9) { p[k] = t[k]; p[k + 1] = t[k + 1]; p[k + 2] = t[k + 2]; continue; }
            const s = max / d;
            p[k] = t[k] + dx * s; p[k + 1] = t[k + 1] + dy * s; p[k + 2] = t[k + 2] + dz * s;
        }
    }

    private _solveBackstop(): void {
        const t = this._targets, d = this._backDirs, backs = this._backDistances;
        if (!t || !d || !backs) return;
        const p = this.positions, w = this.invMass;
        for (let i = 0; i < w.length; i++) {
            if (w[i] === 0) continue;
            const k = i * 3, back = backs[i];
            const depth = (p[k] - t[k]) * d[k] + (p[k + 1] - t[k + 1]) * d[k + 1] + (p[k + 2] - t[k + 2]) * d[k + 2];
            if (depth >= -back) continue;
            const push = -back - depth;
            p[k] += d[k] * push; p[k + 1] += d[k + 1] * push; p[k + 2] += d[k + 2] * push;
        }
    }

    private _solveTethers(): void {
        const p = this.positions;
        for (const t of this._tethers) {
            const i = t.i * 3, q = t.pin * 3;
            const dx = p[i] - p[q], dy = p[i + 1] - p[q + 1], dz = p[i + 2] - p[q + 2];
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            // A little slack, so the tethers never fight the weave over rounding.
            const max = t.rest * 1.02;
            if (len <= max || len < 1e-9) continue;
            const k = max / len;
            p[i] = p[q] + dx * k; p[i + 1] = p[q + 1] + dy * k; p[i + 2] = p[q + 2] + dz * k;
        }
    }

    /**
     * The colliders as flat floats, once per step: a (3), b - a (3), 1/|b-a|² (1), radius + thickness (1),
     * and a bounding sphere — centre (3) and squared radius (1) — that rejects far particles in four flops.
     */
    private _packColliders(): void {
        const cs = this.colliders, thick = this.settings.thickness;
        if (this._packed.length < cs.length * 12) this._packed = new Float32Array(cs.length * 12);
        const o = this._packed;
        cs.forEach((c, n) => {
            const k = n * 12;
            const abx = c.b[0] - c.a[0], aby = c.b[1] - c.a[1], abz = c.b[2] - c.a[2];
            const len2 = abx * abx + aby * aby + abz * abz;
            const reach = Math.sqrt(len2) / 2 + c.radius + thick * 1.5;
            o[k] = c.a[0]; o[k + 1] = c.a[1]; o[k + 2] = c.a[2];
            o[k + 3] = abx; o[k + 4] = aby; o[k + 5] = abz;
            o[k + 6] = len2 > 1e-12 ? 1 / len2 : 0;
            o[k + 7] = c.radius + thick;
            o[k + 8] = c.a[0] + abx / 2; o[k + 9] = c.a[1] + aby / 2; o[k + 10] = c.a[2] + abz / 2;
            o[k + 11] = reach * reach;
        });
        this._packedCount = cs.length;
    }

    private _solveCollisions(): void {
        const count = this._packedCount;
        if (count === 0) return;
        const p = this.positions, w = this.invMass, o = this._packed;
        for (let i = 0; i < this.particleCount; i++) {
            if (w[i] === 0) continue;
            const k = i * 3;
            for (let c = 0; c < count; c++) {
                const b = c * 12;
                let x = p[k], y = p[k + 1], z = p[k + 2];
                const ex = x - o[b + 8], ey = y - o[b + 9], ez = z - o[b + 10];
                if (ex * ex + ey * ey + ez * ez > o[b + 11]) continue;
                let t = ((x - o[b]) * o[b + 3] + (y - o[b + 1]) * o[b + 4] + (z - o[b + 2]) * o[b + 5]) * o[b + 6];
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const qx = o[b] + o[b + 3] * t, qy = o[b + 1] + o[b + 4] * t, qz = o[b + 2] + o[b + 5] * t;
                const dx = x - qx, dy = y - qy, dz = z - qz;
                const d2 = dx * dx + dy * dy + dz * dz;
                const min = o[b + 7];
                if (d2 >= min * min) continue;
                if (d2 < 1e-18) { p[k + 1] = qy + min; continue; }
                const push = min / Math.sqrt(d2);
                x = qx + dx * push; y = qy + dy * push; z = qz + dz * push;
                p[k] = x; p[k + 1] = y; p[k + 2] = z;
            }
        }
    }

    /** Remove part of the tangential velocity of every particle touching a collider (once per step). */
    private _applyFriction(): void {
        const f = this.settings.friction, count = this._packedCount;
        if (f <= 0 || count === 0) return;
        const p = this.positions, v = this.velocities, w = this.invMass, o = this._packed;
        const touch = this.settings.thickness * 0.5;
        for (let i = 0; i < this.particleCount; i++) {
            if (w[i] === 0) continue;
            const k = i * 3;
            for (let c = 0; c < count; c++) {
                const b = c * 12;
                const x = p[k], y = p[k + 1], z = p[k + 2];
                const ex = x - o[b + 8], ey = y - o[b + 9], ez = z - o[b + 10];
                if (ex * ex + ey * ey + ez * ez > o[b + 11]) continue;
                let t = ((x - o[b]) * o[b + 3] + (y - o[b + 1]) * o[b + 4] + (z - o[b + 2]) * o[b + 5]) * o[b + 6];
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const dx = x - (o[b] + o[b + 3] * t), dy = y - (o[b + 1] + o[b + 4] * t), dz = z - (o[b + 2] + o[b + 5] * t);
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d > o[b + 7] + touch || d < 1e-9) continue;
                const nx = dx / d, ny = dy / d, nz = dz / d;
                const vn = v[k] * nx + v[k + 1] * ny + v[k + 2] * nz;
                v[k] -= (v[k] - vn * nx) * f; v[k + 1] -= (v[k + 1] - vn * ny) * f; v[k + 2] -= (v[k + 2] - vn * nz) * f;
                break;
            }
        }
    }

    /** Aerodynamic drag per triangle on the relative velocity, applied as a velocity change over `dt`. */
    private _applyWind(dt: number): void {
        const drag = this.settings.drag;
        if (drag <= 0) return;
        const p = this.positions, v = this.velocities, w = this.invMass, air = this.wind;
        eachTriangle(this.triangles, (a, b, c) => {
            const e1x = p[b * 3] - p[a * 3], e1y = p[b * 3 + 1] - p[a * 3 + 1], e1z = p[b * 3 + 2] - p[a * 3 + 2];
            const e2x = p[c * 3] - p[a * 3], e2y = p[c * 3 + 1] - p[a * 3 + 1], e2z = p[c * 3 + 2] - p[a * 3 + 2];
            let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
            const twiceArea = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (twiceArea < 1e-12) return;
            nx /= twiceArea; ny /= twiceArea; nz /= twiceArea;
            const area = twiceArea / 2;
            // Relative air velocity at the triangle (air minus its mean particle velocity).
            const rx = air[0] - (v[a * 3] + v[b * 3] + v[c * 3]) / 3;
            const ry = air[1] - (v[a * 3 + 1] + v[b * 3 + 1] + v[c * 3 + 1]) / 3;
            const rz = air[2] - (v[a * 3 + 2] + v[b * 3 + 2] + v[c * 3 + 2]) / 3;
            const vn = rx * nx + ry * ny + rz * nz;
            // Force along the normal, signed with the flow: |vn| vn, so it always pushes downwind.
            const f = drag * area * vn * Math.abs(vn) / 3;
            const sa = f * w[a] * dt, sb = f * w[b] * dt, sc = f * w[c] * dt;
            v[a * 3] += nx * sa; v[a * 3 + 1] += ny * sa; v[a * 3 + 2] += nz * sa;
            v[b * 3] += nx * sb; v[b * 3 + 1] += ny * sb; v[b * 3 + 2] += nz * sb;
            v[c * 3] += nx * sc; v[c * 3 + 1] += ny * sc; v[c * 3 + 2] += nz * sc;
        });
    }
}

/** Every triangle of an index list. */
function eachTriangle(triangles: Uint32Array, fn: (a: number, b: number, c: number) => void): void {
    for (let t = 0; t + 2 < triangles.length; t += 3) fn(triangles[t], triangles[t + 1], triangles[t + 2]);
}

/**
 * The default links of a triangle mesh: every edge once (stretch), and across every edge two triangles
 * share, their two opposite corners (bend — the distance form of a dihedral constraint).
 */
export function meshLinks(triangles: Uint32Array): { i: number; j: number; bend?: boolean }[] {
    const edges = new Map<string, number>();   // "a,b" (a < b) -> the corner opposite it in the first triangle
    const links: { i: number; j: number; bend?: boolean }[] = [];
    const bends = new Set<string>();
    eachTriangle(triangles, (a, b, c) => {
        for (const [u, v, opp] of [[a, b, c], [b, c, a], [c, a, b]]) {
            const key = u < v ? `${u},${v}` : `${v},${u}`;
            const other = edges.get(key);
            if (other === undefined) { edges.set(key, opp); links.push({ i: u, j: v }); continue; }
            if (other === opp) continue;
            const bk = other < opp ? `${other},${opp}` : `${opp},${other}`;
            if (!bends.has(bk)) { bends.add(bk); links.push({ i: other, j: opp, bend: true }); }
        }
    });
    return links;
}

/** Every triangle of a cols x rows grid, two per cell, in `gridIndices` order. */
export function forEachTriangle(cols: number, rows: number, fn: (a: number, b: number, c: number) => void): void {
    for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
        const i = r * cols + c;
        fn(i, i + cols, i + 1);
        fn(i + 1, i + cols, i + cols + 1);
    }
}

/** The index buffer for a cols x rows grid (see `forEachTriangle`). */
export function gridIndices(cols: number, rows: number): Uint32Array {
    const out: number[] = [];
    forEachTriangle(cols, rows, (a, b, c) => out.push(a, b, c));
    return Uint32Array.from(out);
}


/** Smooth 2D value noise in [0, 1]: the gust field `chunks/foliageWind.wgsl` scrolls, ported. */
export function windNoise(x: number, y: number): number {
    const hash = (px: number, py: number) => {
        const s = Math.sin(px * 127.1 + py * 311.7) * 43758.5453;
        return s - Math.floor(s);
    };
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

/**
 * The gust at world (x, z), 0..1, as `windGust` in chunks/foliageWind.wgsl computes it: two octaves of
 * noise scrolled along the wind, so the cloth and the trees around it catch the same gusts.
 */
export function windGust(x: number, z: number, t: number, dirX: number, dirZ: number, gustScale: number, gustSpeed: number): number {
    const wavelength = Math.max(gustScale, 0.5);
    const sx = dirX * (gustSpeed * t / wavelength), sz = dirZ * (gustSpeed * t / wavelength);
    const px = x / wavelength - sx, pz = z / wavelength - sz;
    return windNoise(px, pz) * 0.7 + windNoise(px * 2.13 + 17, pz * 2.13 + 3) * 0.3;
}

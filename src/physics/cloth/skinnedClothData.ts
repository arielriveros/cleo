/**
 * Which parts of a skinned mesh are cloth, as stored on the model (`AnimatedModel.skinnedCloth`).
 *
 * Every listed vertex is simulated (physics/cloth/skinnedCloth.ts) and held to where the skin puts it by
 * a max-distance constraint: `weights[i] * maxDistance` metres of slack. A weight of 0 follows the skin
 * exactly — where the cloth is sewn on (a waistband, a collar); 1 swings the whole `maxDistance` — a hem.
 * Vertices not listed are skinned as ever.
 */
export interface SkinnedClothData {
    /** Mesh vertex indices that take part. */
    vertices: number[];
    /** 0..1 per listed vertex: how free it is of the skin. */
    weights: number[];
    /** Metres a weight-1 vertex may stray from its skinned position. */
    maxDistance: number;
    /** 0..1: resistance to stretching. */
    stiffness?: number;
    /** 0..1: resistance to bending. */
    bend?: number;
    /** 0..1: velocity kept per second. */
    damping?: number;
    /** Kilograms, the whole cloth. Heavier cloth is pushed less by the wind. */
    mass?: number;
    /**
     * Multiplier on gravity (default 1): above 1 the cloth falls faster and settles harder against its
     * constraints — what reads as heavy, wet or thick cloth at game speed.
     */
    gravityScale?: number;
    /** Solver substeps per 60 Hz step (default 6): more is stiffer and smoother, and costs in proportion. */
    substeps?: number;
    /** Metres kept off the body's capsules. */
    thickness?: number;
    /** Multiplier on the scene wind. */
    windResponse?: number;
    /**
     * Metres a vertex may sink BEHIND where the skin holds it (toward the limb it hangs on) — the
     * backstop that keeps cloth outside the armour or body under it. Absent: no backstop.
     */
    backstop?: number;
    /**
     * Per listed vertex, overriding `backstop`: how far THAT vertex may sink — the gap to the armour under
     * it, so cloth lying on a plate barely moves inward while a strap sticking out can swing down past
     * where it was modelled.
     */
    backstops?: number[];
    /**
     * Capsules fitted to the character's own armour or body (bind model space), each riding one joint.
     * Absent: the ragdoll's capsules stand in.
     */
    colliders?: { joint: number; a: [number, number, number]; b: [number, number, number]; radius: number }[];
}

const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);

/** Tolerant reader: anything unusable is null rather than a throw (a model must still load). */
export function parseSkinnedCloth(json: any): SkinnedClothData | null {
    if (!json || !Array.isArray(json.vertices) || !Array.isArray(json.weights)) return null;
    if (json.vertices.length === 0 || json.vertices.length !== json.weights.length) return null;
    const out: SkinnedClothData = {
        vertices: json.vertices.map((v: unknown) => Math.max(0, Math.floor(Number(v) || 0))),
        weights: json.weights.map((w: unknown) => Math.min(1, Math.max(0, Number(w) || 0))),
        maxDistance: Math.max(0, num(json.maxDistance) ?? 0.25),
    };
    for (const key of ['stiffness', 'bend', 'damping', 'mass', 'gravityScale', 'thickness', 'windResponse', 'backstop', 'substeps'] as const) {
        const v = num(json[key]);
        if (v !== undefined) out[key] = v;
    }
    if (Array.isArray(json.backstops) && json.backstops.length === out.vertices.length)
        out.backstops = json.backstops.map((b: unknown) => Math.max(0, num(b) ?? 0));
    const vec = (x: any): [number, number, number] | null =>
        Array.isArray(x) && x.length === 3 && x.every((c: unknown) => num(c) !== undefined) ? [x[0], x[1], x[2]] : null;
    if (Array.isArray(json.colliders)) {
        const colliders = [];
        for (const c of json.colliders) {
            const a = vec(c?.a), b = vec(c?.b), joint = num(c?.joint), radius = num(c?.radius);
            if (a && b && joint !== undefined && joint >= 0 && radius !== undefined && radius > 0)
                colliders.push({ joint: Math.floor(joint), a, b, radius });
        }
        if (colliders.length) out.colliders = colliders;
    }
    return out;
}

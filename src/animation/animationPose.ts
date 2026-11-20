// Poses: a skeleton held still, as per-bone deltas from rest. Pure data, shared by the runtime (animator.ts,
// animationField.ts) and the editor; no GL, no scene.

/** One bone of a pose, as a delta from its REST: the same form a rig pose stores. */
export interface AnimationPoseBone {
    name: string;
    /** Rotation delta, quaternion [x,y,z,w], applied as `delta x rest` (in the bone's parent frame). */
    rotation?: number[];
    /** Translation delta added to the rest translation. */
    translation?: number[];
}

export interface AnimationPose {
    name?: string;
    bones: AnimationPoseBone[];
    /**
     * What an ADDITIVE layer measures this pose from, per bone, in the same delta-from-rest form: for a pose
     * VARIANT, its base pose (the editor embeds it resolved). Absent: rest, so an additive layer adds the
     * stored deltas themselves. A bone not listed counts as at rest. Override layers ignore it.
     *
     * So a blend space of a pose's variants, on an additive layer, adds what each variant changes from that
     * pose: editing the base moves every variant with it, editing a variant changes only that one.
     */
    reference?: AnimationPoseBone[];
    /**
     * In a blend space's pose table only (`AnimationField.poses`): the key of the pose this one is a VARIANT of.
     * Its `bones` are then RELATIVE to that pose's ({@link composePoseBones}), and that pose is its additive
     * reference: how an aim pose and its many directions are embedded once each.
     */
    base?: string;
}

// Plain arrays, not gl-matrix's Float32Array scratch: a pose is doubles.
const rotationOf = (b: AnimationPoseBone | undefined): number[] => b?.rotation ? b.rotation : [0, 0, 0, 1];
const translationOf = (b: AnimationPoseBone | undefined): number[] => b?.translation ? b.translation : [0, 0, 0];

/** `a x b` for quaternions [x,y,z,w] (b applied first), normalised with w >= 0. */
function multiply(a: number[], b: number[]): number[] {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    let x = aw * bx + ax * bw + ay * bz - az * by;
    let y = aw * by - ax * bz + ay * bw + az * bx;
    let z = aw * bz + ax * by - ay * bx + az * bw;
    let w = aw * bw - ax * bx - ay * by - az * bz;
    const len = Math.hypot(x, y, z, w) || 1;
    const s = (w < 0 ? -1 : 1) / len;
    x *= s; y *= s; z *= s; w *= s;
    return [x, y, z, w];
}

/**
 * A pose VARIANT's bones on its base's: per bone `R = rel x base` (the variant's turn applied in the bone's parent
 * frame, after the base's) and `T = base + rel`. A bone missing on either side counts as at rest; the result lists
 * every bone of either, the base's order first. The editor's `composePoseBones` (poseAssets.ts) is the same rule.
 */
export function composePoseBones(base: AnimationPoseBone[], rel: AnimationPoseBone[]): AnimationPoseBone[] {
    const baseBy = new Map(base.map(b => [b.name, b]));
    const relBy = new Map(rel.map(b => [b.name, b]));
    const names = [...base.map(b => b.name), ...rel.map(b => b.name).filter(n => !baseBy.has(n))];
    return names.map(name => {
        const b = baseBy.get(name), r = relBy.get(name);
        const out: AnimationPoseBone = { name };
        if (b?.rotation || r?.rotation) out.rotation = multiply(rotationOf(r), rotationOf(b));
        if (b?.translation || r?.translation) {
            const bt = translationOf(b), rt = translationOf(r);
            out.translation = [bt[0] + rt[0], bt[1] + rt[1], bt[2] + rt[2]];
        }
        return out;
    });
}

// Each table entry resolved once (see `resolveTablePose`).
const RESOLVED = new WeakMap<AnimationPose, AnimationPose>();

/**
 * A blend space's pose-table entry (`AnimationField.poses`) as the runtime holds it: a variant (`base`) composed
 * onto its base's bones, with them as its additive `reference`; any other entry as it is. A base the table lacks
 * leaves the variant's bones as they are, measured from rest. Cached per entry object.
 */
export function resolveTablePose(entry: AnimationPose, table: Record<string, AnimationPose> | undefined): AnimationPose {
    if (!entry.base) return entry;
    const cached = RESOLVED.get(entry);
    if (cached) return cached;
    const base = table?.[entry.base];
    const resolved: AnimationPose = base && base !== entry && !base.base
        ? { name: entry.name, bones: composePoseBones(base.bones, entry.bones), reference: base.bones }
        : { name: entry.name, bones: entry.bones };
    RESOLVED.set(entry, resolved);
    return resolved;
}

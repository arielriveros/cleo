import { ConeTwistConstraint, PointToPointConstraint, Quaternion, Vec3, type Body } from 'cannon-es';

// cannon's cone-twist measures twist between a perpendicular it picks for each body's axis on its own
// (Vec3.tangents), so a joint made in a pose already turned about its axis starts past its twist limit and
// fights to untwist it for as long as it lives: a limb that will not go where it is asked. Jolt and Rapier
// measure twist from the pose a joint is made in (jointFrames.ts matchedFrame); this gives cannon's the same:
// B's perpendicular is A's, as the two bodies stand when the joint is made. Opt-in (JointDesc matchTwist),
// so the joints made before it step exactly as they did.
//
// It also measures TWIST rather than the angle between the two perpendiculars, which a swing changes too: an arm
// swung across the chest read as twisted past its limit, and the limit held it back from where its muscle was
// taking it. B's perpendicular is carried back over the swing (the shortest arc from B's cone axis to A's) before
// it is compared with A's, as a swing-twist decomposition does (Jolt's SwingTwistConstraint).

type Matched = ConeTwistConstraint & { twistAxisA: Vec3; twistAxisB: Vec3 };

/** Measure `c`'s twist from these perpendiculars (A's in A, B's in B) from now on. */
export function matchConeTwist(c: ConeTwistConstraint, twistA: ArrayLike<number>, twistB: ArrayLike<number>): void {
    const m = c as Matched;
    m.twistAxisA = new Vec3(twistA[0], twistA[1], twistA[2]);
    m.twistAxisB = new Vec3(twistB[0], twistB[1], twistB[2]);
    m.update = function (this: Matched): void {
        PointToPointConstraint.prototype.update.call(this);
        const cone = this.coneEquation, twist = this.twistEquation;
        this.bodyA.vectorToWorldFrame(this.axisA, cone.axisA);
        this.bodyB.vectorToWorldFrame(this.axisB, cone.axisB);
        this.bodyA.vectorToWorldFrame(this.twistAxisA, twist.axisA);
        this.bodyB.vectorToWorldFrame(this.twistAxisB, twist.axisB);
        swingBack(cone.axisB, cone.axisA, twist.axisB);
        cone.angle = this.angle;
        twist.maxAngle = this.twistAngle;
    };
}

const _n = new Vec3(), _t = new Vec3();

/** Turn `v` (in place) by the shortest arc that takes unit `from` onto unit `to`. */
function swingBack(from: Vec3, to: Vec3, v: Vec3): void {
    from.cross(to, _n);
    const s = _n.length(), c = from.dot(to);
    // Aligned (nothing to undo), or opposite (no one shortest arc: leave it).
    if (s < 1e-9) return;
    _n.scale(1 / s, _n);
    // Rodrigues: v·c + (n×v)·s + n·(n·v)(1 − c).
    const nv = _n.dot(v);
    _n.cross(v, _t);
    const k = nv * (1 - c);
    v.set(v.x * c + _t.x * s + _n.x * k, v.y * c + _t.y * s + _n.y * k, v.z * c + _t.z * s + _n.z * k);
}

/**
 * The perpendiculars that start a cone-twist untwisted with its bodies as they stand now, or at `rest` (A's
 * rotation in B's frame, JointDesc.rest) when given.
 */
export function matchedTwistAxes(a: Body, b: Body, axisA: Vec3, axisB: Vec3, rest?: ArrayLike<number>): { twistA: number[]; twistB: number[] } {
    const tA = new Vec3();
    axisA.unit(new Vec3()).tangents(tA, new Vec3());
    const inB = rest
        ? new Quaternion(rest[0], rest[1], rest[2], rest[3]).vmult(tA)
        : b.quaternion.conjugate().vmult(a.quaternion.vmult(tA));
    const n = axisB.unit(new Vec3());
    const tB = inB.vsub(n.scale(inB.dot(n)));
    if (tB.length() < 1e-6) n.tangents(tB, new Vec3());
    tB.normalize();
    return { twistA: [tA.x, tA.y, tA.z], twistB: [tB.x, tB.y, tB.z] };
}

/** The perpendiculars `c` measures its twist from, when it was matched; null otherwise. */
export function matchedTwistOf(c: ConeTwistConstraint): { twistA: number[]; twistB: number[] } | null {
    const m = c as Partial<Matched>;
    return m.twistAxisA && m.twistAxisB ? { twistA: [m.twistAxisA.x, m.twistAxisA.y, m.twistAxisA.z], twistB: [m.twistAxisB.x, m.twistAxisB.y, m.twistAxisB.z] } : null;
}

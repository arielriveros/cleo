import { ConeTwistConstraint, PointToPointConstraint, Vec3, type Body } from 'cannon-es';

// cannon's cone-twist measures twist between a perpendicular it picks for each body's axis on its own
// (Vec3.tangents), so a joint made in a pose already turned about its axis starts past its twist limit and
// fights to untwist it for as long as it lives: a limb that will not go where it is asked. Jolt and Rapier
// measure twist from the pose a joint is made in (jointFrames.ts matchedFrame); this gives cannon's the same:
// B's perpendicular is A's, as the two bodies stand when the joint is made. Opt-in (JointDesc matchTwist),
// so the joints made before it step exactly as they did.

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
        cone.angle = this.angle;
        twist.maxAngle = this.twistAngle;
    };
}

/** The perpendiculars that start a cone-twist untwisted with its bodies as they stand now. */
export function matchedTwistAxes(a: Body, b: Body, axisA: Vec3, axisB: Vec3): { twistA: number[]; twistB: number[] } {
    const tA = new Vec3();
    axisA.unit(new Vec3()).tangents(tA, new Vec3());
    const world = a.quaternion.vmult(tA);
    const inB = b.quaternion.conjugate().vmult(world);
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

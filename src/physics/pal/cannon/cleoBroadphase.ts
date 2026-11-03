import { Body, SAPBroadphase, World } from 'cannon-es';

/**
 * cannon's sweep-and-prune, with the pair loop fixed.
 *
 * ## The filter was tested before the bound
 *
 * `SAPBroadphase.collisionPairs` walks the axis-sorted list and, for each body, scans forward until the next
 * body starts past its end. But it asks `needBroadphaseCollision` FIRST and `continue`s on a no, so a static
 * (or sleeping) body skipping another static body never reaches the `break`. Every static body's scan
 * therefore ran to the END of the list: O(statics x bodies) per substep, wherever anything is. With the
 * foliage collider pool (up to 256 static bodies) that was most of the broadphase.
 *
 * Moving the bound first is only valid if the bound IS the sort key, and in cannon it is not: the list is
 * sorted by the cached AABB's lower edge, while `checkBounds` reads position +- bounding radius. The cached
 * AABB is also stale for any static body moved without `aabbNeedsUpdate` — a trigger following its node, a
 * pooled foliage collider re-placed out of the world. So this sorts AND breaks on one key, computed fresh
 * from the body's live position: `position[axis] - boundingRadius`. Once a body starts past our end, every
 * later one does too, and `intersectionTest` (bounding spheres, cannon's default) sees the same positions.
 *
 * ## The axis never adapted
 *
 * The sort axis stays X unless someone calls `autoDetectAxis`, and nothing did; a level spread along Z sorts
 * into one long overlapping run. It is re-picked every {@link AXIS_REDETECT_STEPS} steps from the variance
 * of the body positions (cannon's own heuristic).
 */
export class CleoSAPBroadphase extends SAPBroadphase {
    /** Steps between two re-picks of the sort axis. One pass over the bodies, and axes rarely change. */
    public static readonly AXIS_REDETECT_STEPS = 60;
    private _stepsSinceAxis = CleoSAPBroadphase.AXIS_REDETECT_STEPS;

    constructor(world: World) {
        super(world);
    }

    public collisionPairs(_world: World, p1: Body[], p2: Body[]): void {
        const self = this as any;
        const bodies: Body[] = self.axisList;
        const n = bodies.length;
        if (++this._stepsSinceAxis >= CleoSAPBroadphase.AXIS_REDETECT_STEPS && n > 1) {
            this._stepsSinceAxis = 0;
            this.autoDetectAxis();
        }
        const axis = self.axisIndex as number;
        sortByStart(bodies, axis);
        self.dirty = false;

        for (let i = 0; i !== n; i++) {
            const bi = bodies[i];
            const end = center(bi, axis) + bi.boundingRadius;
            for (let j = i + 1; j < n; j++) {
                const bj = bodies[j];
                // Sorted by start: once one starts past our end, every later one does too.
                if (center(bj, axis) - bj.boundingRadius >= end) break;
                if (!this.needBroadphaseCollision(bi, bj)) continue;
                this.intersectionTest(bi, bj, p1, p2);
            }
        }
    }
}

function center(b: Body, axis: number): number {
    return axis === 0 ? b.position.x : axis === 1 ? b.position.y : b.position.z;
}

/**
 * Insertion sort by `position[axis] - boundingRadius`. Bodies move a little per step, so the list arrives
 * nearly sorted and this is close to linear — the reason SAP uses insertion sort at all.
 */
export function sortByStart(list: Body[], axis: number): void {
    for (let i = 1, l = list.length; i < l; i++) {
        const v = list[i];
        const key = center(v, axis) - v.boundingRadius;
        let j = i - 1;
        for (; j >= 0; j--) {
            const u = list[j];
            if (center(u, axis) - u.boundingRadius <= key) break;
            list[j + 1] = u;
        }
        list[j + 1] = v;
    }
}

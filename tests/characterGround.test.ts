import { describe, it, expect } from 'vitest';
import { Body, Box, Heightfield, Sphere, Vec3 } from 'cannon-es';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { RigidBody } from '../src/physics/body';
import {
    createLocomotionState, locomotionTuning, stepLocomotion,
} from '../src/core/control/locomotion';
import type { LocomotionTuning } from '../src/core/control/locomotion';
import { createIntent, setMoveWorld } from '../src/core/control/intent';
import type { ControlIntent } from '../src/core/control/intent';

// Where a character MEETS the ground, which until now had no test at all: `locomotion.test.ts` drives
// the controller against a hand-written normal, and the physics tests step a world with nothing standing
// on it. The report that prompted this file — "hard to move around slopes and not very responsive" —
// lived exactly in the seam, and both halves passed their own suites throughout.
//
// PhysicsSystem is importable here despite the comment in `physicsRaycast.test.ts` saying otherwise; it
// costs a few seconds of transform to pull the cleo barrel in, which is why the ground-stamping rules are
// exercised directly rather than through `update()` (that needs a Scene, and a Scene needs a renderer).

const FRAME = 1 / 60;
const DOWN = [0, -1, 0] as const;

/** A physics system with a live world and no scene — enough for the world, the stamps and the probe. */
function physics(): PhysicsSystem {
    const p = new PhysicsSystem();
    p.initialize();
    return p;
}

/** The unit normal of a surface tilted `degrees` from level, leaning toward +X. */
const normalAt = (degrees: number): [number, number, number] => {
    const r = degrees * Math.PI / 180;
    return [Math.sin(r), Math.cos(r), 0];
};

const world = (p: PhysicsSystem) => (p as any)._world;
const record = (p: PhysicsSystem, body: Body, dot: number, normal: [number, number, number]) =>
    (p as any)._record(body, dot, normal);
/** The stamping clock. `update()` advances it; nothing else here does, so tests set it by hand. */
const setTime = (p: PhysicsSystem, t: number) => { (p as any)._time = t; };
const stamp = (p: PhysicsSystem) => (p as any)._stampGroundContacts();

describe('ground stamping — which contact becomes the ground', () => {
    /**
     * The rule under test, `PhysicsSystem._record`. A body straddling several surfaces at once gets one
     * stamp, and this decides which contact wins it. `groundNormal` reads that stamp back, and the
     * character controller projects its whole velocity onto it, so choosing wrong does not degrade the
     * movement — it aims it at the wrong plane.
     */
    const anyBody = () => new Body({ mass: 1 });

    it('lets a steeper walkable facet take the stamp from a flatter one', () => {
        // THE FIX. The rule used to be "the most ground-like contact in the last GROUND_GRACE wins",
        // full stop, which quietly redefined the ground normal as *the flattest thing recently touched*.
        // On a step that is right. On terrain it is not: the shipped landscape's collision facets are
        // 1.003 m across (size 400 / resolution 400) against a 0.197 m capsule radius, a 5.1x ratio, so
        // a character straddles two or more facets essentially always and the flattest one wins every
        // frame. The controller then projected onto a plane flatter than the hill it was climbing.
        const p = physics();
        const body = anyBody();
        setTime(p, 1);
        record(p, body, Math.cos(20 * Math.PI / 180), normalAt(20));
        record(p, body, Math.cos(45 * Math.PI / 180), normalAt(45));
        expect(p.groundNormal(body)[0]).toBeCloseTo(normalAt(45)[0], 6);
    });

    it('still refuses a wall that arrives while the floor is fresh', () => {
        // The step edge the max-dot rule was written for, and the half of it that must survive: a
        // vertical face has dot ~0, is not walkable at any slope limit, and must not be mistaken for the
        // floor the body is actually standing on.
        const p = physics();
        const body = anyBody();
        setTime(p, 1);
        record(p, body, 1, [0, 1, 0]);
        record(p, body, 0, [1, 0, 0]);
        expect(p.groundNormal(body)[1]).toBeCloseTo(1, 6);
        expect(p.isGrounded(body)).toBe(true);
    });

    it('lets even a wall take over once the grace window has passed', () => {
        // Unchanged: past GROUND_GRACE the old stamp is stale and anything may replace it. Without this
        // a body that walked off a floor onto a wall would keep reporting the floor for ever.
        const p = physics();
        const body = anyBody();
        setTime(p, 1);
        record(p, body, 1, [0, 1, 0]);
        setTime(p, 1.2);
        record(p, body, 0, [1, 0, 0]);
        expect(p.isGrounded(body)).toBe(false);
    });

    it('refreshes on an equal dot so a body that never moves never expires', () => {
        // Load-bearing and easy to lose while narrowing the rule: a body resting still reports the same
        // dot every frame, and a strict `<=` reject would let the grace expire underneath it.
        const p = physics();
        const body = anyBody();
        setTime(p, 1);
        record(p, body, 1, [0, 1, 0]);
        setTime(p, 1.09);
        record(p, body, 1, [0, 1, 0]);
        setTime(p, 1.15);
        expect(p.isGrounded(body)).toBe(true);
    });

    it('is not confused by a slope steep enough to be unwalkable', () => {
        // The threshold is cos(60 deg), matching `isGrounded`'s default `maxSlopeDegrees`. A 70 deg face
        // is not somewhere you stand, so it is subject to the old rule and cannot displace the floor.
        const p = physics();
        const body = anyBody();
        setTime(p, 1);
        record(p, body, Math.cos(10 * Math.PI / 180), normalAt(10));
        record(p, body, Math.cos(70 * Math.PI / 180), normalAt(70));
        expect(p.groundNormal(body)[0]).toBeCloseTo(normalAt(10)[0], 6);
    });

    it('gives the ground probe the last word over the contacts', () => {
        // Not a separate mechanism — a consequence of the one above. `_stampGroundContacts` runs the
        // contact loop first and the probe last, so once walkable contacts stop out-ranking each other
        // the probe's answer is simply the one still standing. The probe fires a ray from the body's
        // centre and reports what is actually underneath it, which on straddled terrain is the facet
        // bearing the weight rather than the flattest neighbour.
        const p = physics();
        const w = world(p);

        // A level floor under the probe...
        const floor = new Body({ mass: 0 });
        floor.addShape(new Box(new Vec3(10, 0.5, 10)));
        floor.position.set(0, -0.5, 0);
        w.addBody(floor);

        const body = new RigidBody({ mass: 1, groundProbeDistance: 0.2 });
        body.addShape(new Sphere(0.25));
        body.position.set(0, 0.25, 0);
        w.addBody(body);

        setTime(p, 1);
        // ...against a flatter-than-anything contact recorded first, standing in for the neighbouring
        // facet a straddling character also touches.
        record(p, body, Math.cos(30 * Math.PI / 180), normalAt(30));
        stamp(p);
        expect(p.groundNormal(body)[1]).toBeCloseTo(1, 3);
    });
});

describe('a character walking up a heightfield', () => {
    /**
     * The whole chain at once: heightfield contacts -> ground stamp -> `groundNormal` -> `stepLocomotion`
     * -> body velocity -> solver -> the next frame's contacts. Nothing here is hand-fed.
     *
     * The controller bug this was written for is framerate-sensitive and settles over seconds, so this
     * walks for a full simulated second and measures ground actually covered rather than a velocity on
     * any one frame.
     */
    const SLOPE = 20;

    /** A heightfield ramp rising toward +X at `SLOPE`, registered the way Terrain registers terrain. */
    function ramp(p: PhysicsSystem, elementSize: number): void {
        const rise = Math.tan(SLOPE * Math.PI / 180) * elementSize;
        const n = 40;
        // `data[i][j]` is the height at local (i, j); local +X is world +X and local +Z is world +Y once
        // the body is rotated, so a ramp in `i` is a ramp in world X.
        const data = Array.from({ length: n }, (_, i) => new Array(n).fill(i * rise));
        const body = new Body({ mass: 0 });
        body.addShape(new Heightfield(data, { elementSize }));
        body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
        body.position.set(0, 0, ((n - 1) * elementSize) / 2);
        // The terrain's surface, exactly as `Terrain.ensureRegistered` gets it. Load-bearing and easy to
        // leave out: cannon applies a registered ContactMaterial only when BOTH bodies carry a material,
        // so a material-less heightfield silently drags the pair back to the world default - friction 0.3
        // against a character authored at 0, which scales its commanded velocity by 0.62 EVERY frame.
        // Leaving it out does not fail loudly; it just makes the character wade.
        body.material = (p as any)._defaultMaterial;
        world(p).addBody(body);
    }

    /** The Night Shift capsule, near enough: cannon has no capsule, and a sphere slides the same way. */
    function walker(p: PhysicsSystem, x: number, radius: number): RigidBody {
        const body = new RigidBody({
            mass: 60,
            linearDamping: 0,
            angularConstraints: [0, 0, 0],
            friction: 0,
            restitution: 0,
            groundProbeDistance: 0.1,
        });
        body.addShape(new Sphere(radius));
        body.position.set(x, Math.tan(SLOPE * Math.PI / 180) * x + radius + 0.02, 0);
        world(p).addBody(body);
        (p as any)._assignMaterial(body);
        return body;
    }

    /**
     * Walk for `seconds`, driving the body from `stepLocomotion` exactly as CharacterNode does, and
     * report the horizontal ground covered plus whether the walker stayed grounded throughout.
     */
    function walk(t: LocomotionTuning, intent: ControlIntent, seconds: number, dt = FRAME) {
        const p = physics();
        ramp(p, 1);
        const body = walker(p, 4, 0.2);
        const w = world(p);

        // Settle onto the surface first, so the measured run does not include the drop - and then zero
        // the velocity. Both characters are authored `friction: 0`, so a body left alone on a slope slides
        // down it and the run would begin by having to reverse that. The case being measured is the one
        // that was reported: standing on a hill, then walking up it.
        for (let i = 0; i < 30; i++) {
            (p as any)._time += dt;
            w.step(dt, dt, 1);
            stamp(p);
        }
        body.velocity.set(0, 0, 0);

        const startX = body.position.x;
        let state = createLocomotionState();
        let grounded = true;
        for (let i = 0; i < Math.round(seconds / dt); i++) {
            const out = stepLocomotion(intent, {
                dt,
                bodyYaw: 0,
                velocity: [body.velocity.x, body.velocity.y, body.velocity.z],
                grounded: p.isGrounded(body),
                groundNormal: p.groundNormal(body),
                up: [-DOWN[0], -DOWN[1], -DOWN[2]],
            }, t, state);
            state = out.next;
            body.velocity.set(out.velocity[0], out.velocity[1], out.velocity[2]);

            (p as any)._time += dt;
            w.step(dt, dt, 1);
            stamp(p);
            grounded = grounded && p.isGrounded(body);
        }
        return { travelled: body.position.x - startX, grounded };
    }

    const uphill = () => setMoveWorld(createIntent(), 1, 0);

    it('climbs at the pace it was told to, with acceleration on', () => {
        // 4 m/s commanded along a 20 deg surface is 3.76 m/s of horizontal progress; one second of it,
        // less the 0.4 s the ramp itself spends getting there, measures 2.64 m. Before the fix the ramp's
        // fixed point on this slope was 2.76 m/s of a commanded 4 at 60fps, and it managed 1.35 m — so
        // the threshold below sits well clear of both.
        const t = locomotionTuning({ walkSpeed: 4, acceleration: 10 });
        const { travelled, grounded } = walk(t, uphill(), 1);
        expect(travelled).toBeGreaterThan(2.4);
        expect(grounded).toBe(true);
    });

    it('climbs no slower on a faster machine', () => {
        // The signature that identified the bug: its ceiling was `a·dt / (1 - cos θ)`, proportional to
        // dt, so a 144 Hz monitor made the character slower than a 60 Hz one. Any residual of that shows
        // up as these two disagreeing.
        const t = locomotionTuning({ walkSpeed: 4, acceleration: 10 });
        const slow = walk(t, uphill(), 1, 1 / 60).travelled;
        const fast = walk(t, uphill(), 1, 1 / 144).travelled;
        expect(fast).toBeGreaterThan(slow * 0.9);
    });

    it('matches what acceleration 0 covers, which the bug never touched', () => {
        // `acceleration: 0` skips the ramp entirely and was always correct on slopes, so it is the
        // reference the fix has to converge on. What separates them is a fixed cost, not a rate: the
        // ~0.75 m the ramp gives up reaching 4 m/s, paid once. So it is measured over two seconds, where
        // that cost has amortized to a tenth — over one second it is a quarter, and the threshold would
        // be too loose to mean anything. Before the fix this was a RATE difference and the gap grew
        // without limit: 3.71 m against 7.41 m here, and worse the longer the walk.
        const snapped = walk(locomotionTuning({ walkSpeed: 4, acceleration: 0 }), uphill(), 2).travelled;
        const ramped = walk(locomotionTuning({ walkSpeed: 4, acceleration: 10 }), uphill(), 2).travelled;
        expect(ramped).toBeGreaterThan(snapped * 0.85);
        expect(ramped).toBeLessThanOrEqual(snapped + 1e-6);
    });
});

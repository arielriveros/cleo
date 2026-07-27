import { Logger } from "../cleo";
import { Scene } from "../core/scene/scene";
import { ModelNode, Node, unwrapScriptNode } from "../core/scene/node";
import { World, Body, Constraint, Material, ContactMaterial, Vec3, SAPBroadphase } from 'cannon-es';
import { vec3 } from "gl-matrix";
import { RigidBody, DEFAULT_FRICTION, DEFAULT_RESTITUTION } from "./body";
import { Ragdoll, RagdollOptions } from "./ragdoll";
import { skipCameraHit, CameraProbeBody, skipRayHit, RayHitBody, RayFilter } from "./cameraRayFilter";
import { physicsStats, resetPhysicsStats, PhysicsStats } from "./physicsStats";
import { MotionRecord, MotionConfig, createMotionRecord, sampleMotion, motionConfig } from "./motion";

/**
 * A body's forward axis in world space: its local +Z rotated by its orientation.
 *
 * +Z matches the engine's node convention (see `Node.worldForward`), so a turn rate measured from this agrees
 * with the yaw a script reads back. Written into `out` — this runs once per bodied node per frame.
 */
function bodyForward(body: Body, out: vec3): vec3 {
  const q = body.quaternion;
  const x = q.x, y = q.y, z = q.z, w = q.w;
  // The third column of the rotation matrix, expanded from the quaternion.
  out[0] = 2 * (x * z + w * y);
  out[1] = 2 * (y * z - w * x);
  out[2] = 1 - 2 * (x * x + y * y);
  return out;
}

interface PhysicsSystemConfig {
  gravity?: number[];
}

/** A single hit from {@link PhysicsSystem.raycast}. Vectors are world space and freshly allocated. */
export interface PhysicsRaycastHit {
  point: vec3;
  /** Surface normal, pointing back out of the surface towards the ray's origin. */
  normal: vec3;
  /** Distance from the ray's start, in world units. */
  distance: number;
  body: Body;
  /** The Node that owns `body`, or null for bodies with no owner — the terrain heightfield, for instance. */
  node: Node | null;
}

export interface PhysicsRaycastOptions {
  /**
   * Hand cannon's own `collisionResponse` filter to the broad phase. Default true, which is what "solid"
   * normally means. The camera probe turns it off so that a body which is a ghost to the SOLVER still blocks
   * the boom — the two channels are deliberately independent.
   */
  checkCollisionResponse?: boolean;
  /** Bodies to skip. Nearly always the caster's own body, since a ray usually starts inside it. */
  ignore?: Body | Body[] | null;
  /** Let trigger volumes count as hits. Default false — walking through a trigger is not walking into a wall. */
  includeTriggers?: boolean;
  /** Let bodies with `simulatePhysics = false` count as hits. Default false. */
  includeGhosts?: boolean;
  /** Last word on each candidate. Return true to skip it. `owner` is null for a body with no Node. */
  reject?: (owner: Node | null, body: Body) => boolean;
}

/**
 * Seconds {@link PhysicsSystem.isGrounded} keeps reporting true after the last real ground contact.
 *
 * This is not a game-feel knob bolted on for fun — it is load-bearing. cannon drops the contact of a body
 * resting perfectly still: `sphereConvex` only emits one while `penetration < 0` (strictly), so the solver
 * pushes the body out until penetration reaches ~0, the contact vanishes on the next step, gravity presses
 * it back, and the contact returns. `sphereHeightfield` compounds this by abandoning the remaining cells
 * whenever one yields more than 2 contacts, which a sphere on a terrain seam does. Measured: a capsule
 * walking a PERFECTLY FLAT heightfield loses its contact on ~2 frames in 240. The body never left the
 * ground, so answering "false" on those frames is the wrong answer, not a truthful one.
 *
 * The side effect is coyote time — a brief window to still jump after running off a ledge — which is what
 * platformers deliberately implement anyway.
 */
const GROUND_GRACE = 0.1;

export class PhysicsSystem {
  private _scene!: Scene;
  private _world!: World;
  private _gravity: number[];
  private _ragdolls: Ragdoll[] = [];
  /** Unpaused seconds of simulated time; the clock GROUND_GRACE is measured against. */
  private _time = 0;
  /** Per body: the most ground-like contact seen recently, its surface normal, and when. See _record. */
  private _ground = new WeakMap<Body, {
    time: number;
    dot: number;
    normal: [number, number, number];
    /** Gap under the feet, when the stamp came from a ground probe. Undefined for a stamp from a contact —
     *  a contact is by definition touching, but it cannot say how far the ray would have travelled. */
    gap?: number;
  }>();
  /** Per body: measured motion (how fast it ACTUALLY moved), sampled in the write-back pass. See motion.ts. */
  private _motion = new WeakMap<Body, MotionRecord>();
  /**
   * Per body: the resolved motion tuning. Cached because `motionSmoothing` is readonly on the body, so the
   * config can only change when the body does — rebuilding an object per bodied node per frame would be pure
   * garbage.
   */
  private _motionCfg = new WeakMap<Body, MotionConfig>();
  /** Per body: how long it has been continuously airborne / grounded, in unpaused seconds. */
  private _airborne = new WeakMap<Body, { airTime: number; groundedTime: number }>();
  /** Scratch for the per-frame body facing; never escapes the write-back pass. */
  private _forwardScratch = vec3.create();
  /** Cannon materials by `friction|restitution`, with a ContactMaterial for every pair. See _materialFor. */
  private _materials = new Map<string, Material>();
  /**
   * Mirror of the world's body membership. The write-back pass asks "is this body already in the world?"
   * once per node per frame, and `world.bodies.indexOf` answers it with a linear scan — quadratic in the
   * body count, which the pooled foliage colliders push into the hundreds. A Set answers in O(1).
   *
   * Only tracks bodies added THROUGH this system; subsystems that talk to the world directly (the foliage
   * collider pool, ragdoll constraints) manage their own membership and are never tested here.
   */
  private _inWorld = new Set<Body>();

  constructor(config?: PhysicsSystemConfig) {
    this._gravity = config?.gravity ? config.gravity: [0, -9.82, 0]; // y = up
  }

  public initialize(): void {
    try {
      this._world = new World();
      this._world.gravity.set(this._gravity[0], this._gravity[1], this._gravity[2]);
      // Sweep-and-prune instead of cannon's default NaiveBroadphase, which enumerates every body pair:
      // the pooled foliage colliders add hundreds of static bodies, and O(N^2) pair generation over them
      // dominates the step long before the narrowphase does.
      this._world.broadphase = new SAPBroadphase(this._world);
      this._world.allowSleep = false;
      this._world.quatNormalizeSkip = 0;
      // Accurate quaternion normalization. The fast approximation destabilizes orientation-sensitive
      // constraints (cone-twist ragdoll joints blow up to NaN and the mesh flies off-screen).
      this._world.quatNormalizeFast = false;
    } catch (e) {
      Logger.error(e.toString());
    }
  }

  public update(deltaTime: number): void {
    try {
      if (!this._scene) return;
      const frameStart = performance.now();
      resetPhysicsStats();

      // Fixed internal timestep with catch-up substeps: keeps stiff constraints (e.g. ragdoll
      // cone-twist joints) stable and deterministic even when frame delta spikes.
      const stepStart = performance.now();
      this._world?.step(1 / 60, deltaTime, 5);
      physicsStats.stepMs = performance.now() - stepStart;

      // The engine only calls update() while unpaused, so this clock does not tick during a pause and the
      // grace window can't quietly expire behind a paused game.
      this._time += deltaTime;
      this._stampGroundContacts();
      // After the stamps, so the clocks agree with what isGrounded answers this frame rather than last.
      this._updateAirborneTimes(deltaTime);

      // Timed apart from the step on purpose: this pass is scene-graph work that would stay on the
      // main thread even if cannon moved to a worker, so the two costs answer different questions.
      const writeBackStart = performance.now();
      const nodes = this._scene.nodes;
      for (const node of nodes) {
        // Bound once and tested once: the old form tested `node.body || node.trigger` and then recomputed
        // it on the next line, and since both are getters the checker could not carry the narrowing across.
        const bodyToAdd = node.body || node.trigger;
        if (!bodyToAdd || !node.hasStarted) continue;

        // If body is not in the world, add it
        if (!this._inWorld.has(bodyToAdd)) {
          this._assignMaterial(bodyToAdd);
          this._world.addBody(bodyToAdd);
          this._inWorld.add(bodyToAdd);
        }

        // If node is marked for removal, remove it from the world
        if (node.markForRemoval) {
          // Removing the body is what actually stops the callbacks: the 'collide' listener registered
          // in Node.setBody/setTrigger is an anonymous arrow, so it can never be matched by handing
          // `node.onCollision` to removeEventListener — that call was always a no-op and left the
          // listener attached. Dropping the body from the world is sufficient, and the body itself
          // becomes garbage with the node.
          this._world.removeBody(bodyToAdd);
          this._inWorld.delete(bodyToAdd);
        }

        // If node contains a body, update the position and quaternion of itself
        if (node.body) {
          const pos = node.body.position;

          // Measure how far the body ACTUALLY moved this step, before the node is told about it. This is the
          // right moment in the frame: world.step() has run, and Scene.update — every script's onUpdate —
          // does not run until after this whole pass (see Engine._gameLoop), so a script reading
          // node.currentSpeed sees the step that just happened rather than one from last frame.
          let motion = this._motion.get(node.body);
          if (!motion) { motion = createMotionRecord(); this._motion.set(node.body, motion); }
          sampleMotion(
            motion, [pos.x, pos.y, pos.z], deltaTime, this.up,
            // Facing comes from the BODY's orientation, not the node's: the node has not been written yet on
            // this frame, so reading it would differentiate against a value one frame stale.
            bodyForward(node.body, this._forwardScratch),
            this._motionConfigFor(node.body),
          );

          node.setPosition([pos.x, pos.y, pos.z]);

          const quat = node.body.quaternion;
          node.setQuaternion([quat.x, quat.y, quat.z, quat.w]);
        }

        if (node.trigger) {
          // update the position and quaternion of the trigger
          const pos = node.worldPosition;
          node.trigger.position.set(pos[0], pos[1], pos[2]);

          const quat = node.worldQuaternion;
          node.trigger.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
        }
      }
      physicsStats.writeBackMs = performance.now() - writeBackStart;

      // Terrain: register/refresh the static heightfield collider(s) so any mesh walks over the landscape.
      const terrainStart = performance.now();
      for (const landscape of this._scene.landscapes) {
        if (landscape.markForRemoval) { landscape.terrain.dispose(this._world); continue; }
        landscape.terrain.setOrigin(landscape.worldPosition);
        // The terrain body needs a material like everything else — without one, cannon ignores the character's
        // and walks it back to the world default, so a frictionless character would still have friction on the
        // one surface it spends all its time on.
        landscape.terrain.ensureRegistered(this._world, this._defaultMaterial);
        // Pooled static colliders for collidable foliage near the camera. Driven from here rather than
        // Scene.update because that has no world reference — and because the editor never steps physics,
        // which is exactly what keeps foliage bodies out of authoring mode.
        const cam = this._scene.activeCamera;
        landscape.terrain.updateFoliageColliders(
          this._world, cam ? (cam.worldPosition as vec3) : null, this._defaultMaterial);
      }
      physicsStats.terrainMs = performance.now() - terrainStart;

      physicsStats.bodies = this._world?.bodies.length ?? 0;
      physicsStats.contacts = this._world?.contacts.length ?? 0;
      physicsStats.frameMs = performance.now() - frameStart;
    } catch (e) {
      Logger.error(e.toString());
    }
  }

  /**
   * Per-frame timings and counts for the last completed step. Mirrors `renderer.stats`; read by the
   * editor's performance HUD.
   *
   * `rayMs`/`rayCount` cover queries made from anywhere in the frame (camera rigs probe during the
   * scene's late pass, i.e. after `update()` has returned), so they belong to the frame rather than
   * to `frameMs` — do not expect the parts to sum to it exactly.
   */
  public get stats(): PhysicsStats { return physicsStats; }

  // ---- Low-level world access (for bodies/constraints not owned by a scene node, e.g. ragdolls) ----

  /** Add a standalone body to the world (deduplicated). Takes the default surface if it has no material. */
  public addBody(body: Body): void {
    if (!this._world) return;
    if (!this._inWorld.has(body)) {
      this._assignMaterial(body);
      this._world.addBody(body);
      this._inWorld.add(body);
    }
  }

  /** Remove a standalone body from the world if present. */
  public removeBody(body: Body): void {
    if (!this._world) return;
    if (this._inWorld.delete(body))
      this._world.removeBody(body);
  }

  public addConstraint(constraint: Constraint): void {
    this._world?.addConstraint(constraint);
  }

  public removeConstraint(constraint: Constraint): void {
    this._world?.removeConstraint(constraint);
  }

  /**
   * Record how ground-like each body's best contact is this frame. Runs once per step, right after it, while
   * `world.contacts` still describes the step that just ran — the equations are pooled and rewritten in place
   * by the next one, so nothing here may be retained.
   *
   * One pass for the whole world rather than a scan per isGrounded() call: a character script asks several
   * times a frame, and the old per-call scan repeated the same walk of every contact in the scene each time.
   */
  /**
   * The cannon Material for a surface, created on first use and paired with every other known material.
   *
   * cannon has no material *combination* rule — it only looks up a registered ContactMaterial, and ONLY when
   * both bodies carry a material (`if (bi.material && bj.material)`), otherwise it silently falls back to the
   * world default. So every body must get one of these, and every pair must be pre-registered.
   *
   * Combine rule: friction takes the MIN, so a frictionless character stays frictionless whatever it walks
   * on; restitution takes the MAX, so a bouncy ball bounces off a dead wall. In both cases the value someone
   * deliberately set wins, which is what they meant by setting it. With one distinct surface in play (the
   * 0.3/0 default) this registers exactly one ContactMaterial identical to cannon's own default.
   */
  private _materialFor(friction: number, restitution: number): Material {
    const key = `${friction}|${restitution}`;
    const cached = this._materials.get(key);
    if (cached) return cached;

    const material = new Material(key);
    for (const [otherKey, other] of this._materials) {
      const [otherFriction, otherRestitution] = otherKey.split('|').map(Number);
      this._world.addContactMaterial(new ContactMaterial(material, other, {
        friction: Math.min(friction, otherFriction),
        restitution: Math.max(restitution, otherRestitution),
      }));
    }
    this._world.addContactMaterial(new ContactMaterial(material, material, { friction, restitution }));

    this._materials.set(key, material);
    return material;
  }

  /** The surface every body without its own settings uses — matches cannon's own defaults. */
  private get _defaultMaterial(): Material {
    return this._materialFor(DEFAULT_FRICTION, DEFAULT_RESTITUTION);
  }

  /**
   * Give a body its surface, just before it enters the world. Must happen for EVERY body: cannon only reads a
   * ContactMaterial when both sides have a material, so a single one left null quietly drags the whole pair
   * back to the world default — a frictionless character on a material-less floor still has friction.
   * Anything that is not a RigidBody (triggers, ragdoll bones) has no settings to honor and takes the default.
   */
  private _assignMaterial(body: Body): void {
    if (body.material) return;
    body.material = body instanceof RigidBody
      ? this._materialFor(body.friction, body.restitution)
      : this._defaultMaterial;
  }

  private _stampGroundContacts(): void {
    const world = this._world;
    if (!world) return;

    // With no gravity there is no meaningful "down", so nothing can be ground. Leaving the stamps untouched
    // also means they expire on their own rather than freezing whatever was true when gravity was cut.
    const g = world.gravity;
    const gLength = Math.hypot(g.x, g.y, g.z);
    if (gLength === 0) return;
    const downX = g.x / gLength, downY = g.y / gLength, downZ = g.z / gLength;

    for (const contact of world.contacts) {
      // `ni` is the contact normal pointing OUT of body i, i.e. from bi towards bj. Negating it for bj turns
      // it into "the direction from me towards whatever I am touching" for both bodies. We are standing on
      // it when that direction agrees with gravity, so the dot IS the measure of ground-likeness.
      const dot = contact.ni.x * downX + contact.ni.y * downY + contact.ni.z * downZ;
      const n = contact.ni;

      // Trigger volumes reach this list: cannon only discards them later, when the solver builds equations
      // (Narrowphase fills world.contacts first). Walking through one must not let you jump again.
      //
      // The surface normal points the opposite way to "towards the thing I am touching" — it comes back OUT
      // of the ground towards us, as everyone expects a ground normal to. Hence the negation against each
      // body's own view of `ni`.
      if (!contact.bj.isTrigger) this._record(contact.bi, dot, [-n.x, -n.y, -n.z]);
      if (!contact.bi.isTrigger) this._record(contact.bj, -dot, [n.x, n.y, n.z]);
    }

    // Ground probe. A resting contact blinks out for the odd frame (see GROUND_GRACE), which is enough
    // to expire the grace and flip isGrounded to false under a body that never moved — firing an airborne
    // animation on solid ground. Any body that opted in (groundProbeDistance > 0) also gets a short
    // downward raycast from its feet, fed into the SAME stamp via _record. Unlike a contact the ray never
    // vanishes, so the stamp stays fresh and grounded stays true. Off by default (distance 0) so nothing
    // that did not ask for it pays a raycast or changes behavior.
    for (const body of world.bodies) {
      if (!(body instanceof RigidBody) || body.isTrigger || body.groundProbeDistance <= 0) continue;
      const hit = this._probeGround(body, downX, downY, downZ, body.groundProbeDistance);
      if (hit) this._record(body, hit.dot, hit.normal, hit.gap);
    }
  }

  /**
   * Short downward raycast from a body's feet along gravity, used to keep {@link isGrounded} stable for
   * bodies that opted into a groundProbeDistance. Returns the ground-likeness dot (measured against the
   * world "up", 1 on level ground), the surface normal of the nearest SOLID hit within the probe distance
   * below the collider, and the `gap` from the collider's lowest point down to that hit — or null when
   * nothing is under the feet.
   *
   * The ray starts at the body centre and runs to just past the collider's lowest point plus the probe
   * distance, so a hit only counts while the feet are within the threshold of ground. It rejects the body
   * itself (the ray starts inside its own shape), trigger volumes, and non-solid ghosts.
   */
  private _probeGround(
    body: Body, downX: number, downY: number, downZ: number, probeDistance: number
  ): { dot: number; normal: [number, number, number]; gap: number } | null {
    if (!this._world) return null;

    // Distance from the body centre to the collider corner reaching furthest along "down": each AABB axis
    // independently picks the bound that goes further that way, so this holds for any gravity direction.
    body.updateAABB();
    const lo = body.aabb.lowerBound, hi = body.aabb.upperBound, p = body.position;
    const extent =
      Math.max(downX * (lo.x - p.x), downX * (hi.x - p.x)) +
      Math.max(downY * (lo.y - p.y), downY * (hi.y - p.y)) +
      Math.max(downZ * (lo.z - p.z), downZ * (hi.z - p.z));
    const reach = extent + probeDistance;
    if (reach <= 0) return null;

    // The defaults are exactly this probe's rules: only solid bodies are ground, a trigger is not, a ghost is
    // not, and the ray starts inside the body's own shape so the body itself must be skipped.
    const hit = this.raycast(
      [p.x, p.y, p.z],
      [p.x + downX * reach, p.y + downY * reach, p.z + downZ * reach],
      { ignore: body });
    if (!hit) return null;

    // The normal points back up out of the surface toward the ray origin. Its agreement with the world "up"
    // (= -down) IS the ground-likeness, matching the contact path's dot convention.
    const n = hit.normal;
    const dot = -(n[0] * downX + n[1] * downY + n[2] * downZ);
    // The ray starts at the body CENTRE, so subtracting the collider's own reach turns the hit distance into
    // the gap under the feet — which is what "how far off the ground am I" has to mean. Clamped at 0: while
    // the collider is penetrating the surface the arithmetic goes slightly negative.
    return { dot, normal: [n[0], n[1], n[2]], gap: Math.max(0, hit.distance - extent) };
  }

  private _record(body: Body, dot: number, normal: [number, number, number], gap?: number): void {
    if (body.isTrigger) return;
    const prev = this._ground.get(body);

    // A WORSE (less ground-like) contact may not overwrite a better one that is still inside the grace window.
    // Someone walking along a wall has two contacts; on a frame where the floor's blinks out but the wall's
    // survives, letting the wall (dot ~0) replace the floor (dot ~1) would reinstate exactly the flicker this
    // exists to remove. Once the stamp is older than the window it protects nothing, so anything may take over.
    //
    // Anything else refreshes the stamp — including an EQUAL dot, which is the common case: a body resting
    // still reports the same dot every frame, and skipping those would leave the timestamp to go stale and
    // expire the grace out from under a body that never moved.
    if (prev && this._time - prev.time <= GROUND_GRACE && dot < prev.dot) return;

    this._ground.set(body, { time: this._time, dot, normal, gap });
  }

  /**
   * True when `body` is resting on something solid in the CURRENT gravity direction — terrain (which registers
   * its own static heightfield body, see Terrain.ensureRegistered) or any other non-trigger body. Backs
   * {@link Node.isGrounded}; the query lives here because this class owns the world and the gravity vector.
   *
   * Gravity-agnostic on purpose: "down" is the world's gravity vector, not -Y, so inverted or sideways gravity
   * works. With zero gravity there is no meaningful "down" and nothing can be grounded, so it reports false.
   *
   * `maxSlopeDegrees` is how far a surface may tilt away from level and still hold you up — past it you are
   * touching a wall, not standing on a floor. Comparing it against the frame's single most ground-like contact
   * is equivalent to scanning for any contact that clears the threshold: both ask whether the best one does.
   *
   * `graceSeconds` is how long a body keeps counting as grounded after its last real ground contact — see
   * GROUND_GRACE for why answering strictly per-frame is wrong. Passing a value LARGER than GROUND_GRACE is
   * allowed but weaker than it looks: past that window a worse contact may already have replaced the stamp.
   */
  public isGrounded(body: Body, maxSlopeDegrees: number = 60, graceSeconds: number = GROUND_GRACE): boolean {
    const world = this._world;
    // A trigger passes through everything, so it never rests on anything.
    if (!world || !body || body.isTrigger) return false;

    const g = world.gravity;
    if (Math.hypot(g.x, g.y, g.z) === 0) return false;

    const stamp = this._ground.get(body);
    if (!stamp || this._time - stamp.time > graceSeconds) return false;
    return stamp.dot >= Math.cos(maxSlopeDegrees * Math.PI / 180);
  }

  /**
   * Surface normal of the ground `body` is standing on — pointing up out of that surface, so it is [0,1,0] on
   * level ground under normal gravity and tilts with a slope. Backs {@link Node.groundNormal}.
   *
   * Falls back to UP (gravity reversed) when the body is not grounded, has no ground stamp, or gravity is
   * zero. That is deliberate: the point of this is projecting movement onto the ground plane, and projecting
   * a horizontal direction against "up" is a no-op — so a caller can use it unconditionally and gets sensible
   * airborne behavior for free instead of having to branch or guard against a zero vector.
   */
  public groundNormal(body: Body, maxSlopeDegrees: number = 60, graceSeconds: number = GROUND_GRACE): vec3 {
    const up = this.up;
    if (!this.isGrounded(body, maxSlopeDegrees, graceSeconds)) return up;
    const stamp = this._ground.get(body);
    return stamp ? vec3.fromValues(stamp.normal[0], stamp.normal[1], stamp.normal[2]) : up;
  }

  /**
   * Distance from `body`'s feet to the ground below it, in world units, or `-1` when it cannot be answered.
   *
   * Only bodies with a `groundProbeDistance` can answer at all: the number comes from that probe's raycast,
   * and a solver contact — the other source of a ground stamp — knows it is touching but not how far a ray
   * would have travelled. `-1` rather than 0 for "unknown" on purpose: 0 means "resting on the ground", which
   * is the one answer a caller must not be handed by accident.
   *
   * Capped by the probe distance by construction, so this is a near-ground refinement (how close to landing),
   * not a general altimeter.
   */
  public groundDistance(body: Body): number {
    if (!body || body.isTrigger) return -1;
    const stamp = this._ground.get(body);
    if (!stamp || stamp.gap === undefined) return -1;
    // A stale stamp is not an answer: the body may have left the surface entirely since.
    if (this._time - stamp.time > GROUND_GRACE) return -1;
    return stamp.gap;
  }

  /**
   * The world's "up": gravity reversed and normalized, or [0, 1, 0] under zero gravity.
   *
   * Everything gravity-relative goes through this one definition — grounding, the ground normal, and the
   * planar/vertical split of measured motion — so inverted or sideways gravity behaves consistently instead
   * of each site hardcoding Y. Returns a fresh vector.
   */
  public get up(): vec3 {
    const g = this._world?.gravity;
    const length = g ? Math.hypot(g.x, g.y, g.z) : 0;
    if (length === 0) return vec3.fromValues(0, 1, 0);
    return vec3.fromValues(-g!.x / length, -g!.y / length, -g!.z / length);
  }

  /**
   * Measured motion for a body — how fast it ACTUALLY moved, not what was commanded of it. Backs
   * {@link Node.currentSpeed} and the rest of that family.
   *
   * Undefined until the body has been through a write-back pass (it has never been simulated, so there is
   * nothing measured to report). Callers treat that as "at rest".
   */
  public motionOf(body: Body): MotionRecord | undefined {
    return this._motion.get(body);
  }

  /** This body's motion tuning, from its own `motionSmoothing` where it set one. Cached per body. */
  private _motionConfigFor(body: Body): MotionConfig {
    let cfg = this._motionCfg.get(body);
    if (!cfg) {
      const tau = body instanceof RigidBody ? body.motionSmoothing : 0;
      cfg = motionConfig(tau > 0 ? { tau } : null);
      this._motionCfg.set(body, cfg);
    }
    return cfg;
  }

  /**
   * How long a body has been continuously in the air, and continuously on the ground, in seconds.
   *
   * Derived from {@link isGrounded}, so it inherits the grace window: `airTime` does not start climbing until
   * the grace has expired, which is exactly what makes it usable as a fall trigger where raw `isGrounded` is
   * not. Both are 0 for a body that has never been simulated.
   */
  public airborneTimes(body: Body): { airTime: number; groundedTime: number } {
    return this._airborne.get(body) ?? { airTime: 0, groundedTime: 0 };
  }

  /**
   * Advance the per-body air/ground clocks. Runs once per frame, after the ground stamps are in.
   *
   * Only bodies that have a motion record are tracked — that is the set which has been through a write-back
   * pass, i.e. the simulated ones. Walking the world's whole body list would also clock every piece of
   * pooled foliage collider, none of which anything asks about.
   */
  private _updateAirborneTimes(deltaTime: number): void {
    // `initialize` swallows a World construction failure, so every per-frame pass has to tolerate no world.
    if (deltaTime <= 0 || !this._world) return;
    for (const body of this._world.bodies) {
      if (!this._motion.has(body)) continue;
      let rec = this._airborne.get(body);
      if (!rec) { rec = { airTime: 0, groundedTime: 0 }; this._airborne.set(body, rec); }
      if (this.isGrounded(body)) {
        rec.groundedTime += deltaTime;
        rec.airTime = 0;
      } else {
        rec.airTime += deltaTime;
        rec.groundedTime = 0;
      }
    }
  }

  /**
   * Distance from `from` to the nearest solid surface along the segment `from -> to`, or null when
   * nothing blocks it. Backs camera-rig collision, which is why it filters the way it does.
   *
   * `raycastAll` rather than `raycastClosest`, deliberately: cannon's `isTrigger` is consulted only by
   * the solver, and `Ray.intersectBody` filters on `collisionResponse` and collision groups alone — so
   * `raycastClosest` happily returns a trigger volume and there is no way to reject it and continue.
   * Verified: with a trigger 2 units in front of a wall at 4, raycastClosest reports the trigger.
   * Collecting every hit and choosing the nearest survivor is what makes trigger volumes, the
   * per-body camera channel, and the caller's ignore list all expressible in one pass.
   *
   * `checkCollisionResponse: false` so that bodies with `simulatePhysics = false` — ghosts to the
   * solver — are still solid to the camera. That is the whole point of the two channels being
   * independent.
   *
   * Note the ray is a SEGMENT: the boom length must be baked into `to`, not passed as a max distance.
   *
   * @param reject Called with the owning Node of each candidate hit (null for bodies with no owner,
   *               e.g. the terrain heightfield — those should normally be kept). Return true to skip.
   */
  public raycastCamera(from: vec3, to: vec3, reject?: (owner: Node | null) => boolean): number | null {
    // Everything this needs beyond the general form lives in skipCameraHit, so the standard filters are
    // turned OFF and delegated to it wholesale — it has its own opinion about triggers and ghosts, and
    // applying both would silently change which bodies block a camera.
    const hit = this.raycast(from, to, {
      checkCollisionResponse: false,
      includeTriggers: true,
      includeGhosts: true,
      reject: (_owner, body) => skipCameraHit(body as CameraProbeBody | null, reject),
    });
    return hit ? hit.distance : null;
  }

  /**
   * Nearest solid hit along the segment `from -> to`, with the point and surface normal — or null when
   * nothing is in the way.
   *
   * The general form the two specialized rays above and below are built from. It exists because per-bone
   * queries (a foot looking for the ground under ITSELF rather than under the character's capsule) need the
   * hit POINT and NORMAL, and nothing here used to return either: `raycastCamera` gives a bare distance, and
   * `isGrounded`/`groundNormal` answer per body.
   *
   * `raycastAll` rather than `raycastClosest`, deliberately: cannon's `isTrigger` is consulted only by the
   * solver, and `Ray.intersectBody` filters on `collisionResponse` and collision groups alone — so
   * `raycastClosest` happily returns a trigger volume and there is no way to reject it and continue.
   * Verified: with a trigger 2 units in front of a wall at 4, raycastClosest reports the trigger. Collecting
   * every hit and choosing the nearest survivor is what makes trigger volumes, the per-body camera channel
   * and a caller's ignore list all expressible in one pass.
   *
   * The ray is a SEGMENT — bake the length into `to` rather than passing a max distance.
   */
  public raycast(from: vec3, to: vec3, options?: PhysicsRaycastOptions): PhysicsRaycastHit | null {
    const world = this._world;
    if (!world) return null;

    const opts = options ?? {};
    const rayStart = performance.now();
    PhysicsSystem._rayFrom.set(from[0], from[1], from[2]);
    PhysicsSystem._rayTo.set(to[0], to[1], to[2]);

    let nearest: PhysicsRaycastHit | null = null;
    world.raycastAll(
      PhysicsSystem._rayFrom, PhysicsSystem._rayTo,
      // Defaults to cannon's own solidity filter; the camera turns it off so ghosts still block the boom.
      { checkCollisionResponse: opts.checkCollisionResponse ?? true },
      (result) => {
        // `distance` is only meaningful on a hit; it is -1 after a reset.
        if (!result.hasHit) return;
        const body = result.body;
        if (!body) return;
        // Cheapest first: a hit further than the current best cannot win no matter what the filter says.
        if (nearest !== null && result.distance >= nearest.distance) return;
        if (skipRayHit(body as unknown as RayHitBody, opts as RayFilter<RayHitBody>)) return;

        const owner = (body as any).owner instanceof Node ? (body as any).owner as Node : null;
        const p = result.hitPointWorld;
        const n = result.hitNormalWorld;
        nearest = {
          point: vec3.fromValues(p.x, p.y, p.z),
          normal: vec3.fromValues(n.x, n.y, n.z),
          distance: result.distance,
          body,
          node: owner,
        };
      });

    physicsStats.rayMs += performance.now() - rayStart;
    physicsStats.rayCount++;
    return nearest;
  }

  // Reused across the probe's rays so the per-frame path stays allocation-free on our side. (cannon's
  // heightfield intersection still allocates an AABB internally per call.)
  private static readonly _rayFrom = new Vec3();
  private static readonly _rayTo = new Vec3();

  /**
   * Turn a skinned ModelNode into a ragdoll: spawn a rigid body per bone, link them
   * with ball joints, and drive the skeleton from physics. Returns the Ragdoll handle.
   */
  public startRagdoll(modelNode: ModelNode, options?: RagdollOptions): Ragdoll {
    // Scripts reach this through `this.scene.physics`, so the node they hand over is a script proxy.
    // The ragdoll keeps it (and hangs bodies off it), and the engine compares nodes by identity — so it
    // has to be the real one. See unwrapScriptNode in core/scene/node.ts.
    const ragdoll = new Ragdoll(unwrapScriptNode(modelNode), this, options);
    this._ragdolls.push(ragdoll);
    return ragdoll;
  }

  public clear(): void {
    if (!this._world) return;

    // Tear down active ragdolls first (removes their bodies + constraints, resets animators)
    for (const ragdoll of this._ragdolls) ragdoll.destroy();
    this._ragdolls = [];

    // Remove any remaining constraints before clearing bodies
    for (const constraint of [...this._world.constraints])
      this._world.removeConstraint(constraint);

    this._world.bodies.forEach(body => {
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      body.force.set(0, 0, 0);
      body.torque.set(0, 0, 0);
      this._world.removeBody(body);
    });
    this._world.bodies = [];
    this._world.clearForces();
    this._inWorld.clear();
  }

  public set scene(scene: Scene) {
    this.clear();
    this._scene = scene;
    scene.physics = this;
  }

  /** Current gravity vector (m/s^2). Constructor-configured; this lets it change at runtime too. */
  public get gravity(): [number, number, number] {
    return this._world ? [this._world.gravity.x, this._world.gravity.y, this._world.gravity.z] : (this._gravity as [number, number, number]);
  }
  public set gravity(g: [number, number, number]) {
    this._gravity = g;
    this._world?.gravity.set(g[0], g[1], g[2]);
  }
}
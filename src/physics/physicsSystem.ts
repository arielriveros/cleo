import { Logger } from "../cleo";
import { Scene } from "../core/scene/scene";
import { ModelNode, Node, unwrapScriptNode } from "../core/scene/node";
import { World, Body, Constraint, Material, ContactMaterial, Vec3 } from 'cannon-es';
import { vec3 } from "gl-matrix";
import { RigidBody, DEFAULT_FRICTION, DEFAULT_RESTITUTION } from "./body";
import { Ragdoll, RagdollOptions } from "./ragdoll";
import { skipCameraHit, CameraProbeBody } from "./cameraRayFilter";
import { physicsStats, resetPhysicsStats, PhysicsStats } from "./physicsStats";

interface PhysicsSystemConfig {
  gravity?: number[];
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
  private _ground = new WeakMap<Body, { time: number; dot: number; normal: [number, number, number] }>();
  /** Cannon materials by `friction|restitution`, with a ContactMaterial for every pair. See _materialFor. */
  private _materials = new Map<string, Material>();

  constructor(config?: PhysicsSystemConfig) {
    this._gravity = config?.gravity ? config.gravity: [0, -9.82, 0]; // y = up
  }

  public initialize(): void {
    try {
      this._world = new World();
      this._world.gravity.set(this._gravity[0], this._gravity[1], this._gravity[2]);
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
        if (this._world.bodies.indexOf(bodyToAdd) === -1) {
          this._assignMaterial(bodyToAdd);
          this._world.addBody(bodyToAdd);
        }

        // If node is marked for removal, remove it from the world
        if (node.markForRemoval) {
          // Removing the body is what actually stops the callbacks: the 'collide' listener registered
          // in Node.setBody/setTrigger is an anonymous arrow, so it can never be matched by handing
          // `node.onCollision` to removeEventListener — that call was always a no-op and left the
          // listener attached. Dropping the body from the world is sufficient, and the body itself
          // becomes garbage with the node.
          this._world.removeBody(bodyToAdd);
        }

        // If node contains a body, update the position and quaternion of itself
        if (node.body) {
          const pos = node.body.position;
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
    if (this._world.bodies.indexOf(body) === -1) {
      this._assignMaterial(body);
      this._world.addBody(body);
    }
  }

  /** Remove a standalone body from the world if present. */
  public removeBody(body: Body): void {
    if (!this._world) return;
    if (this._world.bodies.indexOf(body) !== -1)
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
  }

  private _record(body: Body, dot: number, normal: [number, number, number]): void {
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

    this._ground.set(body, { time: this._time, dot, normal });
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
    const world = this._world;
    const g = world?.gravity;
    const gLength = g ? Math.hypot(g.x, g.y, g.z) : 0;
    const up: vec3 = gLength === 0 ? vec3.fromValues(0, 1, 0) : vec3.fromValues(-g.x / gLength, -g.y / gLength, -g.z / gLength);

    if (!this.isGrounded(body, maxSlopeDegrees, graceSeconds)) return up;
    const stamp = this._ground.get(body);
    return stamp ? vec3.fromValues(stamp.normal[0], stamp.normal[1], stamp.normal[2]) : up;
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
    const world = this._world;
    if (!world) return null;

    const rayStart = performance.now();
    PhysicsSystem._rayFrom.set(from[0], from[1], from[2]);
    PhysicsSystem._rayTo.set(to[0], to[1], to[2]);

    let nearest: number | null = null;
    world.raycastAll(PhysicsSystem._rayFrom, PhysicsSystem._rayTo, { checkCollisionResponse: false }, (result) => {
      if (skipCameraHit(result.body as CameraProbeBody | null, reject)) return;
      // `distance` is only meaningful on a hit; it is -1 after a reset.
      if (result.hasHit && (nearest === null || result.distance < nearest)) nearest = result.distance;
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
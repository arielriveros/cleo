# Physics backends

Physics runs behind a backend-neutral layer, the physics counterpart of the renderer's RHI, so it can run
on more than one physics engine. Two are implemented: cannon-es, the default, and Rapier. Jolt is listed for
later. The engine's tests pin the cannon step bit for bit, so cannon games behave exactly as before.

## The layer

`src/physics/pal/` (the Physics Abstraction Layer) is laid out like `src/graphics/rhi/`:

| File | What it holds |
|---|---|
| `types.ts` | The vocabulary, as plain data: `ShapeDesc`, `ColliderDesc`, `BodyDesc`, `JointDesc`, `RayOptions`, `RayHit`, event kinds, `BodyHandle` / `JointHandle` |
| `world.ts` | `PhysicsWorld`, the one interface the engine simulates through |
| `capabilities.ts` | `PhysicsCapabilities`, what a backend can do (native capsule, collision group bits, joint limits, …), and the boot log line |
| `createWorld.ts` | The one place that knows every backend: `createPhysicsWorld(kind)`, and the two ends of copying a world into the physics worker |
| `replication.ts` | How a backend copies its world into the physics worker: a `WorldMirror` on the main thread, a `WorldReplica` in the worker |
| `backendSelect.ts` | Every backend a project may ask for, and `resolvePhysicsBackendRequest`: the one to run, and why it is not the one asked for |
| `cannon/` | The cannon-es backend, `CannonWorld`, and everything that only exists because of cannon: its broadphase, the heightfield and convex-SAT patches, the material table, the centre-of-mass bookkeeping |
| `rapier/` | The Rapier backend, `RapierWorld`, and `load.ts`, the one place its package is loaded (on demand) |
| `copy/` | Copying a world into the physics worker by description, for a backend whose world can say what each body and joint was made from (`DescribedWorld`): Rapier's |
| `shapeBounds.ts` | Bounds, parts and quaternion helpers measured from shape descriptions, for any backend |
| `jointFrames.ts` | Joint frames measured from joint descriptions, for a backend that builds joints from frames |

A `PhysicsWorld` is handle-based and immediate, like the RHI's `Device`. The engine keeps its own objects
and refers to the backend's by handle. Its conventions hold for every backend:

- A body's position and rotation are its **node origin's**, not its centre of mass. Colliders are placed
  from that origin. (cannon has no centre of mass of its own, so its backend keeps the offset itself.)
- Velocities are the centre of mass's, in world space.
- The engine cuts each frame into substeps and calls `step(dt)` once per substep, so every backend steps the
  same way. `onPreSubstep` runs before each one (buoyancy adds its forces there). A force lasts one substep.
- What a step produced is read afterwards: `forEachContact` (the last substep's contacts, normal pointing
  out of the first body) and `drainEvents` (sensor begin/end and first contacts, in order, since the last
  drain). Destroying a body drops its queued events.
- A body's collision geometry is read back as `colliderParts`, **as the backend simulates it**: cannon
  reports a capsule as its cylinder and two end spheres, and a cylinder with the polyhedron it collides as.
  The parts are placed in the body's collider frame (`getColliderFrame`: the centre of mass on cannon).
  Overlap queries, the trigger↔trigger pass, buoyancy, particle collision and the editor's live trigger
  overlay all measure bodies this way, so they measure exactly what the simulation sees.

## Engine bodies

`PhysicsBody` (`src/physics/physicsBody.ts`) is the engine's own body on any backend. It holds what the body
is made of (mass, damping, surface, layers, colliders); once `physics.addBody` has put it in a world, where it
is and how it moves live in the world. `position`, `quaternion`, `velocity` and `angularVelocity` are live
views: reading them reads the world, writing them writes it. Before it is added, the body keeps the state it
is given and starts from it.

- `physics.removeBody(body)` takes it out; it keeps its state and can be added again. `removeBody(body, true)`
  keeps it built in the world, disabled, so adding it again costs nothing: what the foliage collider pool does.
- A world clear (a scene change) keeps every body's last state; one added again is made afresh.
- `physics.addJoint(a, b, { kind: 'fixed' | 'ball' | 'hinge' | 'coneTwist', ... })` joins two bodies in the
  world and returns the joint for `physics.removeJoint`.

`RigidBody` (`node.setBody`) and `Trigger` (`node.setTrigger`) are engine bodies, and so are terrain
heightfields, foliage and tilemap colliders, ragdoll bones and `physics.addGroundPlane()`. What changed for
scripts when node bodies stopped being cannon's:

- `body.position` is the node's position, not the centre of mass's. They differ only for a dynamic body
  whose collider is offset and recentred (`recenterMass()`); `body.getColliderFrame(out)` gives the latter.
- First contacts (`onCollision`, `body.onCollide(listener)`) are delivered after the physics step, as the
  worker always delivered them, rather than in the middle of it. With the worker they now arrive in the same
  order as trigger enters and exits as on the main thread.
- A trigger's listeners are `trigger.onContact(listener)` as before; cannon's `addEventListener` is gone.
- `body.getAabb(out)` gives its bounds (min, then max), also before it is in a world.

## Choosing a backend

A game names its backend in **Options ▸ Engine ▸ Runtime ▸ Physics backend**. The choice belongs to the
project, not the machine: two engines do not simulate alike, so a game must play the same everywhere. The
published game's config always carries it (`physics.backend`), so a game keeps its backend even if the
engine's default changes.

The choice is a request, read when the engine starts. A backend this build cannot run (Jolt, listed but
not implemented yet, a name it does not know, or Rapier in a player built without it) falls back to cannon-es. The log says why, and so
does `physics.backendFallbackReason`. `physics.backend` is the backend running, and `physics.requestedBackend`
the one asked for. `?physicsBackend=` in the URL asks for another backend for a comparison, in the editor
and in a web build. Each engine logs its backend at startup:

```
Physics ready — physics cannon · capsule compound · groups 32-bit · cone limit native · f64 · worker capable
```

## Two different "where"s

**Backend** is which physics engine simulates. **Executor** is which thread steps it:
`src/physics/executor/` holds the inline executor (the main thread) and the worker executor (a Web Worker,
see [Physics threading](physics-threading.md)). `physics.executor` reads `'inline'` or `'worker'`.

## Adding a backend

1. Implement `PhysicsWorld` in `src/physics/pal/<name>/`, with its capabilities. Only that folder may import
   the library it wraps; `tests/physicsBackendBoundary.test.ts` holds every other file (and the declarations
   scripts are typed against) to it.
2. Add it to `PhysicsBackendKind`, to `createPhysicsWorld`, and as implemented to `PHYSICS_BACKENDS`. A
   backend whose library must load first (a WASM engine) loads it in `acquirePhysicsBackend`, through a
   dynamic `import()`. The engine starts `physics.load()` with the GPU and awaits it before building the
   world; a backend that fails to load falls back to cannon-es with the reason.
3. To run in the physics worker, implement its `WorldMirror` and `WorldReplica` (`replication.ts`) and add
   them to `createWorldMirror` / `createWorldReplica`. The format between them is its own. A backend that
   can snapshot its whole world may send that; cannon sends bodies and shapes. A backend that keeps what
   each body and joint was made from can implement `DescribedWorld` (`copy/describedWorld.ts`) and use the
   mirror and replica in `copy/`, as Rapier does. Without any of these, set `threadable: false` in its
   capabilities.
4. Add it to the list in `tests/pal/conformance.test.ts` and make that suite pass. It checks behaviour, not
   bits: lifecycle, the node-origin convention, gravity, impulses, one-substep forces, sleep, axis locks,
   every shape kind at rest, contacts, sensor events, rays, every joint kind, and that a copy stepped in
   the worker's place moves and reports like the world itself.

## Status

The layer was moved in by stages. Every stage kept the golden traces passing unchanged
(`tests/physicsGoldenTrace.test.ts`, `tests/physicsGoldenB.test.ts`) and the worker equal to the main thread
bit for bit.

| Stage | State |
|---|---|
| Interface, cannon backend, conformance suite | Done |
| `PhysicsSystem` steps, queries rays, reads contacts and trigger events, sets gravity and solver iterations through the interface | Done |
| Overlap queries, trigger↔trigger pass, buoyancy, particle colliders and the editor's trigger overlay read neutral collider descriptions | Done |
| Terrain, foliage and tilemap colliders, ragdolls and joints on engine bodies | Done |
| `RigidBody`, `Trigger` and `Shape` stop being cannon objects | Done |
| The physics worker copies the world through its backend's mirror and replica | Done |
| A test keeps `cannon-es` inside `src/physics/pal/cannon/`; scripts are typed without it; the project chooses its backend | Done |
| Rapier: the package, the spike, `RapierWorld` passing the conformance suite | Done |
| Rapier: the engine and the Valley on it; published games carry only their backend | Done |
| Rapier in the physics worker | Done |
| Jolt: the package and the spike | Done |
| A Jolt backend | Listed, not started |

## Rapier compared with cannon

A project picks Rapier in Options ▸ Engine ▸ Runtime. What differs from cannon:

- **Characters are capsules.** A capsule collider is one shape on Rapier, not a cylinder with two spheres,
  so a character slides over edges rather than catching on the cylinder's rim.
- **Joints are rigid.** cannon's solver lets a joint give a little; Rapier's holds exactly, and rapier.js
  has no setting to soften it. A ragdoll's limbs carry more of an impact: a body that falls flat whips its
  light limbs harder than on cannon.
- **Cone limits are approximate**: a box of swing on two axes rather than a round cone.
- **Joint `maxForce` is ignored.** A joint holds whatever the load.
- **Single precision.** Positions carry about seven significant digits. That is plenty at the scale of a
  level, but not for bit-for-bit comparisons.
- **Queries cost a little more after things move.** Rapier refits its query tree only inside a step. The
  first ray of a frame in which a body was moved by hand runs two zero-length steps first. In the Valley
  that is about 2 ms of ray time a frame, because triggers follow their characters every frame.
- **In the physics worker** Rapier is copied by description: each body as the description it was made from
  and each joint as the record it was built from (frames measured at creation included). The copy steps
  exactly as the main thread would: every position and velocity is identical, the golden scene's included
  (`tests/rapierWorker.test.ts`). A rotation written back into this thread's world reads one unit in the
  last place off, because Rapier renormalises what it is given.
- **Published size.** A Rapier game's player is about 8.7 MB larger, since the player and its inlined
  physics worker each carry Rapier. `npm run build:player` builds `game.js` (cannon) and `game-rapier.js`,
  and Publish picks the one for the project.

## Rapier: what the spike found

Measured on `@dimforge/rapier3d-compat` 0.21.0, the package the engine uses: its WASM is embedded in the
JavaScript (base64), the only form that runs in a published game, which is a single file on `file://` with
its physics worker inlined. The bundle is about 4.3 MB.

- **Sleep.** With automatic sleep off (`setCanSleep(false)`), a body put to sleep by hand stays asleep,
  `setLinvel(v, false)` does not wake it, and a body that hits it does. That is the engine's freeze.
- **Queries see the last step.** Ray and shape queries run against a tree Rapier refits inside `step`. A
  body added, moved or turned since is invisible to them. Two zero-length steps refit it and change no
  position or velocity bit. The backend runs them before a query when something changed.
- **Events.** Collision events are per collider, so the backend counts collider pairs per body pair (begin
  on the first, end on the last). A begin raised in a zero-length step is not raised again by the next real
  step, so those events are kept. A sensor on a fixed body sees a kinematic one only with
  `KINEMATIC_FIXED` among its active collision types.
- **Contacts.** `contactPairsWith(collider)` lists a collider's pairs, and `contactPair(a, b)` gives the
  manifold. Its normal points from the pair's first collider to its second, and `flipped` says the pair was
  asked the other way round.
- **Heightfield.** The heights are column-major: `heights[col * (nrows + 1) + row]`, where rows run along +Z
  and columns along +X. It is centred on the collider and scaled to its full size. The layer's field starts
  at its corner and runs along +X and −Z, so the backend transposes it, flips Z, and offsets the collider by
  half its size.
- **Forces persist** until `resetForces`, so the backend resets them after every step: a force lasts one
  substep, as on cannon.
- **Damping** is `v *= 1 / (1 + c·dt)`. cannon's `(1 − d)^dt` becomes `c = −ln(1 − d)`.
- **Determinism.** Two worlds built the same way step bit for bit alike, and `takeSnapshot` round-trips.
- **Precision.** Single (f32): conformance tolerances follow `capabilities.precision`.
- **Collision groups** are 16 + 16 bits (membership << 16 | filter). The engine's layers stop at `1 << 10`.
  A ray with groups `0xFFFFFFFF` skips a collider whose filter is 0, as a cannon ray skips a body whose mask
  is 0.
- **Joints.** Fixed, spherical, revolute, and a spherical joint with per-axis angular limits for the cone
  (swing on Y and Z, twist on X: a box rather than a cone, so `coneLimit: 'approximate'`). No `maxForce`.
- **Timings** read 0 unless `profilerEnabled` is set.

## Jolt: what the spike found

Measured on `jolt-physics` 1.1.1 (JoltPhysics.js, the WASM build of Jolt Physics), loaded only by
`pal/jolt/load.ts`.

- **The build.** The package's default, `wasm-compat`, is single-threaded with its WASM embedded (base64,
  about 3.2 MB), so it runs in a published game. The threaded build needs a cross-origin isolated page, and
  it also calls a contact listener written in JavaScript from its job threads, where that JavaScript does not
  exist: a step with job threads and a listener aborts. The backend needs a listener (sensor and contact
  events, contacts, per-contact response and friction), so Jolt runs single-threaded. Threads would need a
  JoltPhysics.js build with a contact recorder written in C++.
- **Memory is fixed.** The WASM heap is 128 MB in both builds and cannot grow: an allocation past it aborts.
  A world costs about 11 MB before its first body (10 MB of it the step's scratch allocator), about 20 MB at
  the sizes the engine asks for. Destroying the world (`JoltInterface`) returns all of it. The backend frees
  its world when it is cleared or disposed, and one dropped without either is freed when it is collected.
- **Lifetimes.** Everything made with `new Jolt.X` is freed with `Jolt.destroy`. Shapes are reference
  counted: one made from settings must be `AddRef`ed before the settings are destroyed and `Release`d once
  a body holds it, or it is freed under the body. Static methods (`sGetObjectLayer`, `sGetFreeMemory`) are
  reached through the class's prototype.
- **Sleep.** With sleeping off (`mAllowSleeping = false`), a body deactivated by hand stays asleep, a
  velocity written through `Body` leaves it asleep, and a body that hits it wakes it: the engine's freeze.
- **Sensors** report through the same callbacks as contacts. A static sensor sees a kinematic body only
  while that body is active; `mCollideKinematicVsNonDynamic` lets a sensor see static and sleeping bodies.
  Kinematic bodies are added active and never sleep, so a hurtbox teleported every frame keeps detecting.
  A body that goes to sleep inside a sensor leaves it, as on cannon. A removed body is reported gone in the
  next step, by its `BodyID`; the backend keys bodies by index and sequence number, so an index reused by a
  new body is never mistaken for the old one.
- **Contacts.** Callbacks come per sub-shape pair, so the backend counts them per body pair, as on Rapier.
  The manifold's normal points from the first body to the second. A callback costs about 1.4 µs: 500
  resting spheres step in 7.6 ms without a listener and 9.3 ms with one (1,261 callbacks a step).
- **Heightfield.** Square, with the sample count rounded up to a multiple of its block size (2); the extra
  samples are holes (`cNoCollisionValue`). Heights are compressed to 8 bits per sample within each block:
  about 1.6 mm off on a sloped field.
- **Rest.** Bodies rest at their exact height; no penetration shows.
- **Rays.** By default a convex shape is solid (a ray from inside hits at 0) and back faces are ignored.
  With `mTreatConvexAsSolid` off and back faces on, a ray meets each body's entry and exit faces, as on
  cannon, and one from inside meets the way out.
- **Damping** is `v *= 1 − c·dt`. cannon's `(1 − d)^dt` becomes `c = −ln(1 − d)`, as on Rapier.
- **Angular velocity** is clamped to `mMaxAngularVelocity`, about 47 rad/s by default; the backend raises it.
  Locking every degree of freedom is allowed: the body stays put.
- **Determinism.** Two worlds built the same way step bit for bit alike, but the simulation depends on the
  bodies' `BodyID`s: the same bodies under other IDs end up half a metre apart within two seconds.
  `CreateBodyWithID` with the original's IDs makes a copy step exactly alike, whatever its own history,
  which is how the physics worker's copy is built.
- **Collision layers.** `ObjectLayerPairFilterMask` packs a 16-bit group and a 16-bit mask into each body's
  object layer and collides two bodies by cannon's rule. Everything shares one broadphase layer.

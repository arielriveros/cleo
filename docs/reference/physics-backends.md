# Physics backends

Physics runs behind a backend-neutral layer, the physics counterpart of the renderer's RHI, so it can run
on engines other than cannon-es. Rapier is the next one planned, and Jolt is listed for later. Today cannon-es is the only backend, and
games behave exactly as before: the engine's tests pin the cannon step bit for bit.

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

The choice is a request, read when the engine starts. A backend this build cannot run (one listed but not
implemented yet, or a name it does not know) falls back to cannon-es. The log says why, and so
does `physics.backendFallbackReason`. `physics.backend` is the backend running, and `physics.requestedBackend`
the one asked for. `?physicsBackend=` in the URL asks for another backend for a comparison, in the editor
and in a web build. Each engine logs its backend at startup:

```
Physics ready — physics cannon · capsule compound · groups 32-bit · cone limit native · worker capable
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
   can snapshot its whole world may send that; cannon sends bodies and shapes. Without them, set
   `threadable: false` in its capabilities.
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
| A Rapier backend | Next, after the checks below |

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

## What a Jolt backend needs to settle

Jolt (JoltPhysics.js, the WASM build of Jolt Physics) is listed for later. Questions for its spike:

- Which build: the single-threaded WASM, or the multithreaded one, which needs SharedArrayBuffer and so
  a cross-origin isolated page (the published desktop game on `file://` is not).
- Memory: every Jolt object made from JavaScript must be `destroy()`ed by hand. The backend owns that,
  including on `clear` and `dispose`.
- Does a build with its WASM embedded exist (or can one be made), for the published player, which runs as a
  single file from `file://` with its physics worker inlined?
- Jolt is double precision optionally and single by default: which build, and the conformance suite's
  `precision` to match.
- Its `CharacterVirtual` is a kinematic character controller. The engine's characters are dynamic bodies,
  so it stays unused unless characters move to it on every backend.
- Collision layers are object layers plus broadphase layers, not group/mask bits: map the engine's 16
  layer bits onto them.
- Its world is stepped with a fixed number of collision steps per update: one per engine substep.
